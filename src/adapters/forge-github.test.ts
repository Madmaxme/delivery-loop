import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { describe, it } from "node:test";

import { createCredentialRecorder } from "../engine/credential-log.ts";
import { githubForge, interpretCompare, interpretMergeability, interpretPullList } from "./forge-github.ts";
import { INSTALLATION_TOKEN_REFRESH_SKEW_MS } from "./github-mint.ts";

describe("github mergeability", () => {
  it("maps the host state onto the land decision", () => {
    assert.equal(
      interpretMergeability({ mergeable: false, mergeable_state: "dirty", head: { sha: "abc" } }).state,
      "conflict",
    );
    assert.equal(interpretMergeability({ mergeable_state: "behind", head: { sha: "abc" } }).state, "behind");
    assert.equal(interpretMergeability({ mergeable_state: "unstable" }).state, "clean");
    assert.equal(interpretMergeability({ mergeable_state: "blocked" }).state, "blocked");
    assert.equal(
      interpretMergeability({ mergeable: null, mergeable_state: "unknown" }).state,
      "unknown",
    );
  });

  it("lands from a temporary bare repo with isolated Git config", async () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const calls: string[][] = [];
    const cwdPaths: string[] = [];
    const envs: (Record<string, string | undefined> | undefined)[] = [];
    const bareRepos: string[] = [];
    const credentialCalls: { slot: string; endpoint: string; status: number }[] = [];
    let pushStatus = 0;
    const forge = githubForge({
      token: "secret-token",
      credentialNote: (call) => credentialCalls.push({ slot: call.slot, endpoint: call.endpoint, status: call.status }),
      runGit: (args, cwd, env) => {
        calls.push(args);
        cwdPaths.push(cwd);
        envs.push(env);
        if (args[0] === "init") {
          const path = args.at(-1) ?? "";
          bareRepos.push(path);
          mkdirSync(path);
        }
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: args[1]?.includes("/feature") ? `${headSha}\n` : `${baseSha}\n` };
        }
        if (args[0] === "push") return { status: pushStatus, stdout: "" };
        return { status: 0, stdout: "" };
      },
    });
    const input = {
      repoUrl: "https://github.com/acme/api",
      branch: "feature",
      base: "main",
      expectedHeadSha: headSha,
      expectedBaseSha: baseSha,
    };
    assert.equal(await forge.directLand(input), headSha);
    const push = calls.at(-1) ?? [];
    assert.deepEqual(push, [
      "push",
      "--atomic",
      "--no-verify",
      "--porcelain",
      `--force-with-lease=refs/heads/main:${baseSha}`,
      "origin",
      `${headSha}:refs/heads/main`,
    ]);
    assert.equal(push.some((arg) => arg.includes("secret-token")), false);
    const pushEnv = envs.at(-1) ?? {};
    const auth = pushEnv.GIT_CONFIG_VALUE_1 ?? "";
    assert.match(auth, /AUTHORIZATION: basic/);
    assert.equal(auth.includes("secret-token"), false);
    assert.equal(pushEnv.GIT_CONFIG_NOSYSTEM, "1");
    assert.equal(pushEnv.GIT_CONFIG_VALUE_0, "");
    assert.ok(pushEnv.GIT_CONFIG_GLOBAL?.includes("delivery-loop-direct-land-"));
    const revParseEnv = envs[calls.findIndex((args) => args[0] === "rev-parse")] ?? {};
    assert.equal(revParseEnv.GIT_CONFIG_COUNT, "1");
    assert.equal(revParseEnv.GIT_CONFIG_KEY_1, undefined);
    for (const [index, args] of calls.entries()) {
      const env = envs[index] ?? {};
      const network = args[0] === "fetch" || args[0] === "push";
      assert.equal(env.GIT_CONFIG_KEY_1, network ? "http.https://github.com/.extraheader" : undefined);
    }
    const template = calls[0]?.find((arg) => arg.startsWith("--template="))?.slice("--template=".length);
    assert.ok(template?.includes("delivery-loop-direct-land-"));
    assert.notEqual(template, "/dev/null");
    const hooksPath = calls.find((args) => args[0] === "config" && args[2] === "core.hooksPath")?.[3];
    assert.ok(hooksPath?.includes("delivery-loop-direct-land-"));
    assert.notEqual(hooksPath, "/dev/null");
    assert.ok(calls.some((args) => args[0] === "config" && args[2] === "credential.helper" && args[3] === ""));
    assert.equal(calls.some((args) => args[0] === "credential" || args[0] === "pre-push"), false);
    assert.ok(cwdPaths.every((cwd) => cwd.includes("delivery-loop-direct-land-") && cwd !== process.cwd()));
    assert.equal(existsSync(bareRepos[0] ?? ""), false);
    assert.deepEqual(credentialCalls.slice(0, 3), [
      { slot: "gh-token", endpoint: "git", status: 200 },
      { slot: "gh-token", endpoint: "git", status: 200 },
      { slot: "gh-token", endpoint: "git", status: 200 },
    ]);

    pushStatus = 1;
    await assert.rejects(forge.directLand(input), /expected base may have changed/);
    assert.equal(existsSync(bareRepos.at(-1) ?? ""), false);
    assert.deepEqual(credentialCalls.at(-1), { slot: "gh-token", endpoint: "git", status: 1 });
  });

  it("treats an already up-to-date branch as updated", async () => {
    const calls: string[] = [];
    const forge = githubForge({
      token: "token",
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(
          JSON.stringify({ message: "There are no new commits on the base branch." }),
          { status: 422 },
        );
      },
    });
    await forge.updateBranch({
      repoUrl: "https://github.com/acme/api",
      number: 4,
      expectedHeadSha: "abc",
    });
    assert.match(calls[0] ?? "", /PUT .*\/pulls\/4\/update-branch$/);
  });

  it("reads the compare status and the squash commit", async () => {
    assert.equal(interpretCompare("ahead"), "ahead");
    assert.equal(interpretCompare("diverged"), "diverged");
    assert.equal(interpretCompare(""), "unknown");
    const forge = githubForge({
      token: "token",
      fetch: async (url, init) => {
        if ((init?.method ?? "GET") === "PUT" && url.includes("/merge")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { sha?: string };
          if (body.sha !== "a".repeat(40)) {
            return new Response("missing sha", { status: 409 });
          }
          return new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "identical" }), { status: 200 });
      },
    });
    assert.equal(
      await forge.compare({
        repoUrl: "https://github.com/acme/api",
        base: "development",
        head: "cursor/qui-1-api",
      }),
      "identical",
    );
    assert.equal(
      await forge.squashMerge({
        repoUrl: "https://github.com/acme/api",
        number: 4,
        headSha: "a".repeat(40),
      }),
      "deadbeef",
    );
  });

  it("keeps a merged pull and drops a different head", () => {
    const head = "cursor/api-1-api";
    const rows = interpretPullList(
      [
        {
          number: 9,
          html_url: "https://github.com/acme/api/pull/9",
          state: "closed",
          merged_at: "2026-01-01T00:00:00Z",
          merge_commit_sha: "m".repeat(40),
          head: { ref: head, sha: "h".repeat(40) },
          base: { ref: "main" },
        },
        {
          number: 4,
          html_url: "https://github.com/acme/api/pull/4",
          state: "open",
          head: { ref: head, sha: "o".repeat(40) },
          base: { ref: "main" },
        },
        {
          number: 3,
          state: "closed",
          head: { ref: "other", sha: "x".repeat(40) },
          base: { ref: "main" },
        },
      ],
      { head, base: "main" },
    );
    assert.deepEqual(
      rows.map((row) => row.state),
      ["merged", "open"],
    );
    assert.equal(rows[0]?.mergedSha, "m".repeat(40));
  });

  it("lists pull requests for one head and base", async () => {
    const head = "cursor/api-1-api";
    let seen = "";
    const forge = githubForge({
      token: "token",
      fetch: async (url) => {
        seen = String(url);
        return Response.json([
          {
            number: 9,
            html_url: "https://github.com/acme/api/pull/9",
            state: "closed",
            merged_at: "2026-01-01T00:00:00Z",
            merge_commit_sha: "m".repeat(40),
            head: { ref: head, sha: "h".repeat(40) },
            base: { ref: "main" },
          },
        ]);
      },
    });
    const rows = await forge.listPullRequests?.({
      repoUrl: "https://github.com/acme/api",
      head,
      base: "main",
    });
    assert.equal(rows?.[0]?.state, "merged");
    assert.match(seen, /\/pulls\?/);
    assert.match(seen, /state=all/);
    assert.match(seen, new RegExp(`head=.*${encodeURIComponent(head)}`));
    assert.match(seen, /base=main/);
  });

  it("surfaces a 403 from check-runs as a credential error", async () => {
    const head = "a".repeat(40);
    const calls: string[] = [];
    const forge = githubForge({
      token: "pat-token",
      mintCommand: "",
      fetch: async (url) => {
        calls.push(String(url));
        if (String(url).includes("/check-runs")) return new Response("no", { status: 403 });
        if (String(url).includes("/jobs")) {
          return Response.json({
            jobs: [{ name: "ui-primitives", status: "completed", conclusion: "success" }],
          });
        }
        return Response.json({});
      },
    });
    await assert.rejects(
      () =>
        forge.designCheck?.({
          repoUrl: "https://github.com/acme/admin-web",
          headSha: head,
          name: "ui-primitives",
        }),
      (error: unknown) => {
        assert.match(String(error), /credential error:/);
        assert.match(String(error), /403/);
        assert.match(String(error), /DELIVERY_LOOP_GITHUB_MINT/);
        assert.equal((error as { httpStatus?: number }).httpStatus, 403);
        return true;
      },
    );
    assert.ok(calls.some((url) => url.includes("/check-runs")));
    assert.equal(calls.some((url) => url.includes("/jobs")), false);
    assert.equal(calls.some((url) => url.includes("/actions/runs")), false);
  });

  it("reads check-runs with the minted installation token and refreshes before expiry", async () => {
    const head = "a".repeat(40);
    const minted = ["checks-token-a", "checks-token-b"];
    const auths: { url: string; authorization: string }[] = [];
    let now = 0;
    let mintCalls = 0;
    const expiresAt = 20 * 60 * 1000;
    const forge = githubForge({
      token: "pat-token",
      mintCommand: "mint-installation-token",
      nowMs: () => now,
      runMint: () => {
        const token = minted[mintCalls] ?? "checks-token-extra";
        mintCalls += 1;
        return {
          status: 0,
          stdout: JSON.stringify({
            token,
            expires_at: new Date(expiresAt).toISOString(),
          }),
        };
      },
      fetch: async (url, init) => {
        auths.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
        });
        if (String(url).includes("/check-runs")) {
          return Response.json({
            check_runs: [
              {
                name: "ui-primitives",
                status: "completed",
                conclusion: "success",
                head_sha: head,
              },
            ],
          });
        }
        if (String(url).includes("/actions/runs")) {
          return Response.json({ workflow_runs: [] });
        }
        return Response.json({});
      },
    });
    const probe = await forge.designCheck?.({
      repoUrl: "https://github.com/acme/admin-web",
      headSha: head,
      name: "ui-primitives",
    });
    assert.equal(probe?.state, "success");
    now = expiresAt - INSTALLATION_TOKEN_REFRESH_SKEW_MS - 1;
    await forge.designCheck?.({
      repoUrl: "https://github.com/acme/admin-web",
      headSha: head,
      name: "ui-primitives",
    });
    assert.equal(mintCalls, 1);
    now = expiresAt - INSTALLATION_TOKEN_REFRESH_SKEW_MS;
    await forge.designCheck?.({
      repoUrl: "https://github.com/acme/admin-web",
      headSha: head,
      name: "ui-primitives",
    });
    assert.equal(mintCalls, 2);
    const checkAuths = auths.filter((call) => call.url.includes("/check-runs")).map((call) => call.authorization);
    assert.deepEqual(checkAuths, [
      "Bearer checks-token-a",
      "Bearer checks-token-a",
      "Bearer checks-token-b",
    ]);
    await forge.quality?.({
      repoUrl: "https://github.com/acme/admin-web",
      headSha: head,
      workflow: "quality",
    });
    const quality = auths.find((call) => call.url.includes("/actions/runs"));
    assert.equal(quality?.authorization, "Bearer pat-token");
  });

  it("mints once at startup and reads the rate limit with that token", async () => {
    const rec = createCredentialRecorder();
    const secret = "mint-secret-value";
    let mints = 0;
    const calls: { url: string; authorization: string }[] = [];
    const forge = githubForge({
      token: "pat-token",
      mintCommand: "mint-installation-token",
      credentialNote: rec.note,
      runMint: () => {
        mints += 1;
        return { status: 0, stdout: secret };
      },
      fetch: async (url, init) => {
        calls.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization") ?? "",
        });
        return Response.json({ resources: { core: { limit: 5000 } } });
      },
    });
    await forge.probeCredentials?.();
    const head = "a".repeat(40);
    await forge.designCheck?.({
      repoUrl: "https://github.com/acme/admin-web",
      headSha: head,
      name: "ui",
    });
    assert.equal(mints, 1);
    const rate = calls.filter((call) => call.url.endsWith("/rate_limit"));
    assert.equal(rate.length, 1);
    assert.equal(rate[0]?.authorization, `Bearer ${secret}`);
    const check = calls.find((call) => call.url.includes("/check-runs"));
    assert.equal(check?.authorization, `Bearer ${secret}`);
    const lines = rec.lines();
    assert.equal(lines.filter((line) => line === "credential slot=mint endpoint=mint status=200").length, 1);
    assert.ok(lines.includes("credential slot=mint endpoint=rate-limit status=200"));
    assert.equal(lines.join("\n").includes(secret), false);
  });

  it("logs a failed startup mint and does not call GitHub", async () => {
    const rec = createCredentialRecorder();
    let fetches = 0;
    const forge = githubForge({
      token: "pat-token",
      mintCommand: "mint-installation-token",
      credentialNote: rec.note,
      runMint: () => ({ status: 1, stdout: "mint-secret-value" }),
      fetch: async () => {
        fetches += 1;
        return Response.json({});
      },
    });
    await forge.probeCredentials?.();
    assert.equal(fetches, 0);
    assert.deepEqual(rec.lines(), ["credential slot=mint endpoint=mint status=1"]);
    assert.equal(rec.lines().join("\n").includes("mint-secret-value"), false);
  });

  it("skips the startup mint when the command is unset", async () => {
    let fetches = 0;
    const forge = githubForge({
      token: "pat-token",
      mintCommand: "",
      fetch: async () => {
        fetches += 1;
        return Response.json({});
      },
    });
    await forge.probeCredentials?.();
    assert.equal(fetches, 0);
  });
});
