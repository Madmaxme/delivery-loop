import assert from "node:assert/strict";
import { describe, it } from "node:test";

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
});
