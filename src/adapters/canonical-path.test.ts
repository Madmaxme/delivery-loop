import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parse } from "yaml";

import { assertCanonicalPath, assertCanonicalPaths, type CanonicalPath } from "../bots/canonical.ts";
import { loadBotBundle } from "../bots/load.ts";
import type { BotDefinition } from "../bots/types.ts";
import { awsCaller } from "./aws.ts";
import {
  authorizationHeader,
  CanonicalPathError,
  mintCredential,
  prepareDispatchCredentials,
  resolveCredential,
  type CommandSpawn,
} from "./canonical-path.ts";
import { githubForge, githubGraphql } from "./forge-github.ts";
import { gitForge } from "./forge-git.ts";
import { githubUserLogin } from "./github-actor.ts";
import { lookupRemoteHead } from "../engine/land-branches.ts";
import { linearTracker } from "./trackers.ts";
import { runGh } from "./gh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const support = new Set(["canonical-path.ts", "github-actor.ts", "types.ts"]);

const linearPath: CanonicalPath = {
  api: "linear",
  source: "ref:linear-oauth",
  acquisition: "oauth-client-credentials",
  refresh: "per-process",
  envRefs: ["LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET"],
  oauthUrl: "https://api.linear.app/oauth/token",
  scope: "read,write",
  expectedIdentity: "Example Delivery",
};

const openerPath: CanonicalPath = {
  api: "github",
  role: "opener",
  source: "ref:github-opener",
  acquisition: "mint-per-process",
  refresh: "per-process",
  mintCommand: "mint-github-opener",
  identityKind: "user",
  actorRef: "ref:commit-actor",
};

const mergerPath: CanonicalPath = {
  api: "github",
  role: "merger",
  source: "ref:github-merger",
  acquisition: "mint-per-process",
  refresh: "per-process",
  mintCommand: "mint-github-merger",
  identityKind: "installation",
};

function opener(token = "opener-token") {
  return mintCredential(openerPath, token);
}

function merger(token = "merger-token") {
  return mintCredential(mergerPath, token);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("canonical call path", () => {
  it("sends exactly one authorization scheme", () => {
    assert.equal(authorizationHeader("raw-token"), "Bearer raw-token");
    assert.equal(authorizationHeader("Bearer raw-token"), "Bearer raw-token");
    assert.equal(authorizationHeader("Bearer Bearer raw-token"), "Bearer raw-token");
    assert.equal(authorizationHeader("bearer  Bearer   raw-token"), "Bearer raw-token");
  });

  it("refuses a stored linear key when the path declares a mint", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        resolveCredential(linearPath, {
          env: {
            LINEAR_OAUTH_CLIENT_ID: "id",
            LINEAR_OAUTH_CLIENT_SECRET: "secret",
            LINEAR_API_KEY: "stored-key",
          },
          vaultCopies: { LINEAR_API_KEY: "stored-key" },
          spawn: () => ({ status: 1, stdout: "" }),
          fetch: async (url) => {
            calls.push(String(url));
            return json({ access_token: "stored-key", expires_in: 30, token_type: "Bearer" });
          },
        }),
      (error: unknown) => error instanceof CanonicalPathError && error.errorClass === "non-canonical-credential",
    );
    assert.deepEqual(calls, ["https://api.linear.app/oauth/token"]);

    const minted = await resolveCredential(linearPath, {
      env: {
        LINEAR_OAUTH_CLIENT_ID: "id",
        LINEAR_OAUTH_CLIENT_SECRET: "secret",
        LINEAR_API_KEY: "stored-key",
      },
      vaultCopies: { LINEAR_API_KEY: "vault-copy" },
      spawn: () => ({ status: 1, stdout: "" }),
      fetch: async () => json({ access_token: "minted-access", expires_in: 2591999, token_type: "Bearer" }),
    });
    assert.equal(minted.token, "minted-access");
    assert.equal(minted.expiresIn, 2591999);
    assert.notEqual(minted.token, "stored-key");

    const headers: string[] = [];
    await assert.rejects(
      async () => {
        const tracker = linearTracker({
          credential: { token: "stored-key", api: "linear" } as never,
          team: "APP",
          intakeState: "Todo",
          fetch: async (_url, init) => {
            headers.push(String(new Headers(init?.headers).get("authorization")));
            return json({ data: { viewer: { id: "v", name: "Example Delivery" } } });
          },
        });
        await tracker.get("APP-1");
      },
      (error: unknown) => errorClass(error) === "non-canonical-credential",
    );
    assert.deepEqual(headers, []);
  });

  it("fails the viewer health check on 401 before the ticket query", async () => {
    const calls: string[] = [];
    const credential = mintCredential(
      {
        api: "linear",
        source: "ref:linear-oauth",
        acquisition: "mint-per-process",
        refresh: "per-process",
        mintCommand: "mint-linear",
        expectedIdentity: "Example Delivery",
      },
      "Bearer minted-access",
    );
    const tracker = linearTracker({
      credential,
      team: "APP",
      intakeState: "Todo",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        calls.push(body.query);
        headersSeen(init);
        return json({ errors: [{ message: "Authentication required" }] }, 401);
      },
    });
    await assert.rejects(
      () => tracker.listIntake(),
      (error: unknown) =>
        error instanceof CanonicalPathError && error.errorClass === "credential-unhealthy" && error.status === 401,
    );
    assert.deepEqual(calls, ["{ viewer { id name } }"]);
    assert.equal(seenHeader, "Bearer minted-access");
  });

  it("probes mint, then the linear viewer, then each github identity", async () => {
    const calls: string[] = [];
    const spawn: CommandSpawn = (command) => {
      calls.push(`spawn ${command}`);
      if (command === "mint-github-opener") return { status: 0, stdout: "opener-token\n" };
      if (command === "mint-github-merger") return { status: 0, stdout: "merger-token\n" };
      return { status: 1, stdout: "" };
    };
    const prepared = await prepareDispatchCredentials({
      paths: [linearPath, openerPath, mergerPath],
      env: {
        LINEAR_OAUTH_CLIENT_ID: "id",
        LINEAR_OAUTH_CLIENT_SECRET: "secret",
        LINEAR_API_KEY: "stored-key",
      },
      vaultCopies: { LINEAR_API_KEY: "vault-copy" },
      spawn,
      linear: true,
      github: true,
      expectedLogin: "example-owner",
      fetch: async (url, init) => {
        const href = String(url);
        const body = typeof init?.body === "string" ? init.body : "";
        calls.push(`${init?.method ?? "GET"} ${href}${body.includes("viewer") ? " viewer" : ""}`);
        if (href.endsWith("/oauth/token")) return json({ access_token: "minted-access", expires_in: 100, token_type: "Bearer" });
        if (body.includes("viewer")) return json({ data: { viewer: { id: "v1", name: "Example Delivery" } } });
        if (href.endsWith("/user")) return json({ login: "example-owner" });
        if (href.includes("/installation/repositories")) return json({ repositories: [] });
        return json({}, 500);
      },
    });
    assert.equal(prepared.linear?.token, "minted-access");
    assert.equal(prepared.opener?.token, "opener-token");
    assert.equal(prepared.merger?.token, "merger-token");
    assert.deepEqual(calls, [
      "POST https://api.linear.app/oauth/token",
      "POST https://api.linear.app/graphql viewer",
      "spawn mint-github-opener",
      "GET https://api.github.com/user",
      "spawn mint-github-merger",
      "GET https://api.github.com/installation/repositories?per_page=1",
    ]);
  });

  it("does not call github when the linear viewer is not the declared identity", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        prepareDispatchCredentials({
          paths: [linearPath, openerPath, mergerPath],
          env: { LINEAR_OAUTH_CLIENT_ID: "id", LINEAR_OAUTH_CLIENT_SECRET: "secret" },
          spawn: (command) => {
            calls.push(command);
            return { status: 0, stdout: "token" };
          },
          linear: true,
          github: true,
          fetch: async (url, init) => {
            calls.push(String(url));
            if (String(url).endsWith("/oauth/token")) return json({ access_token: "minted-access", token_type: "Bearer" });
            if (String(init?.body ?? "").includes("viewer")) return json({}, 401);
            return json({ login: "example-owner" });
          },
        }),
      (error: unknown) => error instanceof CanonicalPathError && error.errorClass === "credential-unhealthy",
    );
    assert.equal(calls.some((call) => call.includes("api.github.com")), false);
    assert.equal(calls.some((call) => call.startsWith("mint-github")), false);
  });

  it("uses the installation read for a merger and rejects cursor[bot] as an opener", async () => {
    const calls: string[] = [];
    const forge = githubForge({
      opener: opener(),
      merger: merger(),
      commitActors: [{ login: "example-owner", repos: ["https://github.com/example/app"] }],
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/user")) return json({ login: "example-owner" });
        if (String(url).includes("/installation/repositories")) return json({ repositories: [{ id: 1 }] });
        if (String(url).endsWith("/merge")) return json({ sha: "abc" });
        return json({}, 404);
      },
    });
    assert.equal(
      await forge.squashMerge({
        repoUrl: "https://github.com/example/app",
        number: 4,
        headSha: "a".repeat(40),
      }),
      "abc",
    );
    assert.equal(calls.some((call) => call.endsWith("/user")), false);
    assert.equal(calls.some((call) => call.includes("/installation/repositories")), true);

    const denied = githubForge({
      opener: opener("cursor-token"),
      merger: merger("other-merger"),
      fetch: async (url) => {
        if (String(url).endsWith("/user")) return json({ login: "cursor[bot]" });
        return json({}, 404);
      },
    });
    await assert.rejects(
      () =>
        denied.openPullRequest({
          repoUrl: "https://github.com/example/app",
          title: "t",
          body: "b",
          head: "feature",
          base: "main",
        }),
      (error: unknown) =>
        error instanceof CanonicalPathError &&
        error.errorClass === "non-canonical-credential" &&
        /cursor\[bot\]/.test(error.message),
    );
  });

  it("fails a github user health check on 401 before graphql", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        githubGraphql(opener(), "{ viewer { login } }", async (url) => {
          calls.push(String(url));
          return json({ message: "Bad credentials" }, 401);
        }),
      (error: unknown) => error instanceof CanonicalPathError && error.errorClass === "credential-unhealthy" && error.status === 401,
    );
    assert.deepEqual(calls, ["https://api.github.com/user"]);
  });

  it("refuses an ambient git or gh token that was not minted", async () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "stored-github";
    try {
      let gitError: unknown;
      try {
        await gitForge({ cwd: process.cwd() }).compare({
          repoUrl: "https://example.test/acme/api.git",
          base: "main",
          head: "feature",
        });
      } catch (error) {
        gitError = error;
      }
      assert.equal(errorClass(gitError), "non-canonical-credential");
      let remote = "";
      let sawStored = false;
      lookupRemoteHead("https://github.com/example/app.git", "main", null, ((...args: unknown[]) => {
        const command = args[1] as string[];
        remote = command?.[1] ?? "";
        const opts = args[2] as { env?: NodeJS.ProcessEnv };
        sawStored = opts?.env?.GH_TOKEN === "stored-github" || opts?.env?.GITHUB_TOKEN === "stored-github";
        return { status: 0, stdout: "abc1234\trefs/heads/main\n" };
      }) as typeof spawnSync);
      assert.equal(remote.startsWith("https://github.com/example/app.git"), true);
      assert.equal(remote.includes("stored-github"), false);
      assert.equal(sawStored, false);
      let spawned = false;
      assert.throws(
        () => runGh({ token: "stored-github" } as never, ["api", "user"], () => {
          spawned = true;
          return { status: 0 };
        }),
        (error: unknown) => error instanceof CanonicalPathError && error.errorClass === "non-canonical-credential",
      );
      assert.equal(spawned, false);
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
    await assert.rejects(
      async () => {
        await githubUserLogin(async () => json({ login: "example-owner" }), { token: "stored" } as never);
      },
      (error: unknown) => error instanceof CanonicalPathError && error.errorClass === "non-canonical-credential",
    );
  });

  it("rejects a missing policy, a direct stored path, and a shared aws source", async () => {
    const definitions = [
      {
        role: "delivery-agent",
        tools: [{ adapter: "tracker", operation: "get" }],
        identities: [],
      },
    ] as unknown as BotDefinition[];
    assert.throws(() => assertCanonicalPaths(definitions, [], "inventory.yaml"), /missing canonical path for linear/);
    assert.throws(
      () =>
        assertCanonicalPath(
          {
            api: "linear",
            source: "ref:linear-key",
            acquisition: "stored-static",
            refresh: "static",
            envRefs: ["LINEAR_API_KEY"],
            expectedIdentity: "Example Delivery",
          },
          "inventory.yaml/0",
        ),
      /non-canonical direct path for linear/,
    );
    assert.throws(
      () =>
        assertCanonicalPaths(definitions, [
          linearPath,
          { ...openerPath },
          { ...mergerPath, source: openerPath.source },
        ], "inventory.yaml"),
      /different sources/,
    );
    assert.throws(
      () =>
        assertCanonicalPaths([], [
          {
            api: "aws",
            callerClass: "agent",
            source: "ref:aws-shared",
            acquisition: "mint-per-process",
            refresh: "per-process",
            mintCommand: "mint-aws-agent",
          },
          {
            api: "aws",
            callerClass: "actions",
            source: "ref:aws-shared",
            acquisition: "mint-per-process",
            refresh: "per-process",
            mintCommand: "mint-aws-actions",
          },
        ], "inventory.yaml"),
      /aws caller classes must use different sources/,
    );
    const runtime = await resolveCredential(
      {
        api: "aws",
        callerClass: "runtime",
        source: "ref:aws-runtime",
        acquisition: "stored-static",
        refresh: "static",
        envRefs: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
      },
      {
        env: { AWS_ACCESS_KEY_ID: "AKIA_EXAMPLE", AWS_SECRET_ACCESS_KEY: "runtime-secret" },
        spawn: () => ({ status: 1, stdout: "" }),
        fetch: async () => json({}),
      },
    );
    assert.throws(
      () => awsCaller({ credential: runtime, callerClass: "agent", spawn: () => ({ status: 0, stdout: "" }) }),
      (error: unknown) => error instanceof CanonicalPathError && error.errorClass === "non-canonical-credential",
    );
  });

  it("rejects a template edit that drops the policy or declares a direct path", () => {
    const root = join(here, "../..");
    const dir = join(mkdtempSync(join(tmpdir(), "canonical-")), "bots");
    spawnSync("cp", ["-R", join(root, "bots/templates"), dir]);
    const inventory = readFileSync(join(dir, "inventory.yaml"), "utf8").replace(
      "acquisition: oauth-client-credentials",
      "acquisition: stored-static",
    );
    writeFileSync(join(dir, "inventory.yaml"), inventory);
    assert.throws(() => loadBotBundle(dir), /non-canonical direct path for linear/);

    const dropped = join(mkdtempSync(join(tmpdir(), "canonical-")), "bots");
    spawnSync("cp", ["-R", join(root, "bots/templates"), dropped]);
    writeFileSync(
      join(dropped, "orchestrator.yaml"),
      readFileSync(join(dropped, "orchestrator.yaml"), "utf8")
        .replace("  - canonical-call-path\n", "")
        .replace(/ {4}- id: canonical-call-path\n {6}statement:.*\n/, ""),
    );
    assert.throws(() => loadBotBundle(dropped), /missing policy canonical-call-path/);
  });

  it("loads the example inventory with one source per aws caller class", () => {
    const file = join(here, "../bots/fixtures/canonical-path/inventory.yaml");
    const doc = parse(readFileSync(file, "utf8")) as { canonicalPaths: CanonicalPath[] };
    const aws = doc.canonicalPaths.filter((path) => path.api === "aws");
    assert.deepEqual(
      aws.map((path) => path.callerClass),
      ["agent", "actions", "runtime"],
    );
    assert.equal(new Set(aws.map((path) => path.source)).size, 3);
    const linear = doc.canonicalPaths.find((path) => path.api === "linear");
    assert.equal(linear?.acquisition, "oauth-client-credentials");
    assert.equal(linear?.expectedIdentity, "Example Delivery");
    const roles = doc.canonicalPaths.filter((path) => path.api === "github").map((path) => path.role);
    assert.deepEqual(roles, ["opener", "merger"]);
    assert.notEqual(
      doc.canonicalPaths.find((path) => path.role === "opener")?.source,
      doc.canonicalPaths.find((path) => path.role === "merger")?.source,
    );
  });

  it("every adapter module rejects a raw credential", async () => {
    const files = readdirSync(here).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"));
    assert.ok(files.length > support.size);
    for (const file of files) {
      if (support.has(file)) continue;
      const mod = (await import(pathToFileURL(join(here, file)).href)) as {
        rejectRawCredential?: () => unknown;
      };
      assert.equal(typeof mod.rejectRawCredential, "function", `${file} has no canonical-path enforcement`);
      await assert.rejects(
        async () => {
          await mod.rejectRawCredential?.();
        },
        (error: unknown) => errorClass(error) === "non-canonical-credential",
        file,
      );
    }
  });
});

let seenHeader = "";
function headersSeen(init: RequestInit | undefined): void {
  seenHeader = new Headers(init?.headers).get("authorization") ?? "";
}

function errorClass(error: unknown): string {
  return error && typeof error === "object" && "errorClass" in error ? String(error.errorClass) : "";
}
