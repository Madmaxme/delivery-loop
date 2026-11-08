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
import { OUTBOUND_ADAPTERS, adapterAttempts } from "./registry.ts";
import { awsCaller } from "./aws.ts";
import {
  authorizationHeader,
  CanonicalPathError,
  credentialSecret,
  prepareDispatchCredentials,
  probeGithub,
  probeLinearViewer,
  resolveCredential,
  type CommandSpawn,
} from "./canonical-path.ts";
import { healthFetch, issue, linearPath, mergerPath, openerPath, organizationId, viewerId } from "../testing/canonical-fixtures.ts";
import { githubForge, githubGraphql } from "./forge-github.ts";
import { gitForge } from "./forge-git.ts";
import { githubUserLogin } from "./github-actor.ts";
import { lookupRemoteHead } from "../engine/land-branches.ts";
import { linearTracker } from "./trackers.ts";
import { runGh } from "./gh.ts";

const here = dirname(fileURLToPath(import.meta.url));
const support = new Set(["canonical-path.ts", "github-actor.ts", "types.ts"]);

const oauthLinearPath: CanonicalPath = {
  ...linearPath,
  acquisition: "oauth-client-credentials",
  mintCommand: undefined,
  envRefs: ["LINEAR_OAUTH_CLIENT_ID", "LINEAR_OAUTH_CLIENT_SECRET"],
  oauthUrl: "https://api.linear.app/oauth/token",
  scope: "read,write",
};

function opener(token = "opener-token") {
  return issue(openerPath, token);
}

function merger(token = "merger-token") {
  return issue(mergerPath, token);
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
        resolveCredential(oauthLinearPath, {
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

    const minted = await resolveCredential(oauthLinearPath, {
      env: {
        LINEAR_OAUTH_CLIENT_ID: "id",
        LINEAR_OAUTH_CLIENT_SECRET: "secret",
        LINEAR_API_KEY: "stored-key",
      },
      vaultCopies: { LINEAR_API_KEY: "vault-copy" },
      spawn: () => ({ status: 1, stdout: "" }),
      fetch: async () => json({ access_token: "minted-access", expires_in: 2591999, token_type: "Bearer" }),
    });
    assert.equal(credentialSecret(minted), "minted-access");
    assert.notEqual(credentialSecret(minted), "stored-key");

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
    const credential = issue(linearPath, "Bearer minted-access");
    await assert.rejects(
      () =>
        probeLinearViewer(credential, async (_url, init) => {
          const body = JSON.parse(String(init?.body)) as { query: string };
          calls.push(body.query);
          headersSeen(init);
          return json({ errors: [{ message: "Authentication required" }] }, 401);
        }),
      (error: unknown) =>
        error instanceof CanonicalPathError && error.errorClass === "credential-unhealthy" && error.status === 401,
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0] ?? "", /viewer/);
    assert.equal(seenHeader, "Bearer minted-access");
    const tracker = linearTracker({
      credential,
      team: "APP",
      intakeState: "Todo",
      fetch: async () => {
        calls.push("ticket");
        return json({ data: {} });
      },
    });
    await assert.rejects(() => tracker.listIntake(), /has not passed the health check/);
    assert.equal(calls.includes("ticket"), false);
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
      paths: [oauthLinearPath, openerPath, mergerPath],
      env: {
        LINEAR_OAUTH_CLIENT_ID: "id",
        LINEAR_OAUTH_CLIENT_SECRET: "secret",
        LINEAR_API_KEY: "stored-key",
      },
      vaultCopies: { LINEAR_API_KEY: "vault-copy" },
      spawn,
      linear: true,
      github: true,
      actors: [{ login: "example-owner", id: "1001", repos: ["https://github.com/example/app"] }],
      fetch: async (url, init) => {
        const href = String(url);
        const body = typeof init?.body === "string" ? init.body : "";
        calls.push(`${init?.method ?? "GET"} ${href}${body.includes("viewer") ? " viewer" : ""}`);
        if (href.endsWith("/oauth/token")) return json({ access_token: "minted-access", expires_in: 100, token_type: "Bearer" });
        if (body.includes("viewer")) {
          return json({ data: { viewer: { id: viewerId, name: "Example Delivery", organization: { id: organizationId } } } });
        }
        if (href.endsWith("/user")) return json({ id: 1001, login: "example-owner" });
        if (href.endsWith("/installation")) return json({ id: 2002, app_id: 2001 });
        return json({}, 500);
      },
    });
    assert.equal(credentialSecret(prepared.linear!), "minted-access");
    assert.equal(credentialSecret(prepared.opener!), "opener-token");
    assert.equal(credentialSecret(prepared.merger!), "merger-token");
    assert.deepEqual(calls, [
      "POST https://api.linear.app/oauth/token",
      "POST https://api.linear.app/graphql viewer",
      "spawn mint-github-opener",
      "GET https://api.github.com/user",
      "spawn mint-github-merger",
      "GET https://api.github.com/repos/example/app/installation",
    ]);
  });

  it("does not call github when the linear viewer is not the declared identity", async () => {
    const calls: string[] = [];
    await assert.rejects(
      () =>
        prepareDispatchCredentials({
          paths: [oauthLinearPath, openerPath, mergerPath],
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

  it("binds the installation and rejects a user id that is not allowed", async () => {
    const calls: string[] = [];
    const open = opener();
    const merge = merger();
    await probeGithub(open, healthFetch);
    await probeGithub(merge, healthFetch);
    const forge = githubForge({
      opener: open,
      merger: merge,
      commitActors: [{ login: "example-owner", id: "1001", repos: ["https://github.com/example/app"] }],
      fetch: async (url) => {
        calls.push(String(url));
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
    assert.equal(calls.some((call) => call.includes("/installation")), false);
    await assert.rejects(
      () =>
        probeGithub(opener("other"), async (url) => {
          calls.push(String(url));
          if (String(url).endsWith("/user")) return json({ id: 404, login: "other" });
          return json({}, 404);
        }),
      /not an allowed principal/,
    );
  });

  it("fails a github user health check on 401 before graphql", async () => {
    const calls: string[] = [];
    const credential = opener();
    await assert.rejects(
      () =>
        githubGraphql(credential, "{ viewer { login } }", async (url) => {
          calls.push(String(url));
          return json({ message: "Bad credentials" }, 401);
        }),
      /has not passed the health check/,
    );
    assert.deepEqual(calls, []);
    await assert.rejects(
      () =>
        probeGithub(credential, async (url) => {
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
      const open = opener();
      await probeGithub(open, healthFetch);
      let remote = "";
      let askToken = "";
      let sawStored = false;
      lookupRemoteHead("https://github.com/example/app.git", "main", open, ((...args: unknown[]) => {
        const command = args[1] as string[];
        remote = command?.[1] ?? "";
        const opts = args[2] as { env?: NodeJS.ProcessEnv };
        askToken = opts?.env?.DELIVERY_LOOP_GIT_TOKEN ?? "";
        sawStored = opts?.env?.GH_TOKEN === "stored-github" || opts?.env?.GITHUB_TOKEN === "stored-github";
        return { status: 0, stdout: "abc1234\trefs/heads/main\n" };
      }) as typeof spawnSync);
      assert.equal(remote, "https://github.com/example/app.git");
      assert.equal(remote.includes("opener-token"), false);
      assert.equal(askToken, "opener-token");
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
            accountId: "123456789012",
            expectedArn: "arn:aws:iam::123456789012:user/example",
          },
          {
            api: "aws",
            callerClass: "actions",
            source: "ref:aws-shared",
            acquisition: "mint-per-process",
            refresh: "per-process",
            mintCommand: "mint-aws-actions",
            accountId: "123456789012",
            expectedArn: "arn:aws:iam::123456789012:role/example",
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
        accountId: "123456789012",
        expectedArn: "arn:aws:iam::123456789012:user/example",
        expiresAt: "2099-01-01T00:00:00Z",
      },
      {
        env: {
          AWS_ACCESS_KEY_ID: "AKIA_EXAMPLE",
          AWS_SECRET_ACCESS_KEY: "runtime-secret",
          AWS_SESSION_TOKEN: "session",
        },
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

  it("every registered adapter rejects raw, copied, and unprobed credentials before any call", async () => {
    const files = new Set(readdirSync(here).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts")));
    for (const name of OUTBOUND_ADAPTERS) {
      if (name === "land-branches.ts") continue;
      assert.equal(files.has(name), true, name);
    }
    const calls: string[] = [];
    const fetch: FetchLike = async (url) => {
      calls.push(String(url));
      return json({}, 500);
    };
    const unprobed = {
      linear: issue(linearPath, "linear-token"),
      opener: opener(),
      merger: merger(),
      cursor: issue(
        {
          api: "cursor",
          source: "ref:cursor-mint",
          acquisition: "mint-per-process",
          refresh: "per-process",
          mintCommand: "mint-cursor",
          healthCommand: "probe-cursor",
        },
        "cursor-token",
      ),
      http: issue(
        {
          api: "http",
          source: "ref:http-mint",
          acquisition: "mint-per-process",
          refresh: "per-process",
          mintCommand: "mint-http",
          healthCommand: "probe-http",
        },
        "http-token",
      ),
    };
    const raw = { token: "stored", api: "linear" };
    const copied = { ...unprobed.opener, token: "copied" };
    for (const attempt of adapterAttempts(unprobed)) {
      await assert.rejects(async () => {
        await attempt.run({ raw, copied, unprobed: unprobed.linear, fetch });
      }, undefined, attempt.name);
    }
    assert.deepEqual(calls, []);
    assert.throws(() => {
      const handle = unprobed.opener as { token?: string };
      handle.token = "mutated";
    });
    assert.equal(credentialSecret(unprobed.opener), "opener-token");
  });
});

let seenHeader = "";
function headersSeen(init: RequestInit | undefined): void {
  seenHeader = new Headers(init?.headers).get("authorization") ?? "";
}

function errorClass(error: unknown): string {
  return error && typeof error === "object" && "errorClass" in error ? String(error.errorClass) : "";
}
