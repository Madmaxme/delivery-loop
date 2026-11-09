import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubForge } from "../adapters/forge-github.ts";
import { INSTALLATION_TOKEN_REFRESH_SKEW_MS, INSTALLATION_TOKEN_TTL_MS } from "../adapters/github-mint.ts";
import { linearTracker } from "../adapters/trackers.ts";
import { cursorWorker } from "../adapters/workers.ts";
import { readFigmaFrame } from "./design-gate.ts";
import {
  createCredentialRecorder,
  credentialLogText,
  formatCredentialLine,
  githubEndpointClass,
} from "./credential-log.ts";

const MINT = "dummy-secret-mint-token";
const FORGE = "dummy-secret-forge-token";
const LINEAR = "dummy-secret-linear-key";
const FIGMA = "dummy-secret-figma-token";
const CURSOR = "dummy-secret-cursor-key";

describe("credential log", () => {
  it("classifies GitHub paths without keeping the path", () => {
    assert.equal(githubEndpointClass("/repos/acme/api/commits/abc/check-runs?per_page=100"), "check-runs");
    assert.equal(githubEndpointClass("/repos/acme/api/contents/README.md"), "contents");
    assert.equal(githubEndpointClass("/repos/acme/api/pulls/4"), "pulls");
    assert.equal(githubEndpointClass("/repos/acme/api/issues/4/comments"), "issues");
    assert.equal(githubEndpointClass("/repos/acme/api/actions/runs?head_sha=abc"), "actions");
    assert.equal(githubEndpointClass("/repos/acme/api/compare/main...abc"), "compare");
    assert.equal(githubEndpointClass("/repos/acme/api/commits/abc"), "commits");
    assert.equal(githubEndpointClass("/repos/acme/api/git/refs/heads/main"), "git");
    assert.equal(githubEndpointClass("/user"), "user");
    assert.equal(githubEndpointClass("https://api.github.com/user"), "user");
    assert.equal(githubEndpointClass("/rate_limit"), "rate-limit");
  });

  it("formats a success line, a re-mint, and a summary", () => {
    assert.equal(
      formatCredentialLine({ slot: "mint", endpoint: "mint", status: 200 }),
      "credential slot=mint endpoint=mint status=200",
    );
    assert.equal(
      formatCredentialLine({ slot: "mint", endpoint: "mint", status: 200, refresh: true }),
      "credential slot=mint endpoint=mint status=200 refresh=1",
    );
    assert.equal(
      credentialLogText("credential slot=mint endpoint=check-runs status=200"),
      "[delivery-loop] credential slot=mint endpoint=check-runs status=200",
    );
    assert.equal(formatCredentialLine({ slot: MINT, endpoint: "https://token", status: 700 }), "credential slot=unknown endpoint=unknown status=0");
  });

  it("logs every call outcome and leaves the secret out of the log", async () => {
    const head = "a".repeat(40);
    const rec = createCredentialRecorder();
    let now = 1_000;
    const expiresAt = now + INSTALLATION_TOKEN_TTL_MS;
    let failCheck = false;
    const forge = githubForge({
      token: FORGE,
      mintCommand: "mint-installation-token",
      nowMs: () => now,
      credentialNote: rec.note,
      runMint: () => ({ status: 0, stdout: `${MINT}\n` }),
      fetch: async (url) => {
        const href = String(url);
        if (href.includes("/check-runs")) {
          if (failCheck) return new Response("no", { status: 403 });
          return Response.json({
            check_runs: [{ name: "ui", status: "completed", conclusion: "success", head_sha: head }],
          });
        }
        if (href.includes("/update-branch")) {
          return new Response(JSON.stringify({ message: "There are no new commits on the base branch." }), {
            status: 422,
          });
        }
        if (href.includes("/pulls")) {
          return Response.json([
            {
              number: 9,
              html_url: "https://github.com/acme/api/pull/9",
              state: "open",
              head: { ref: "cursor/api-1-api", sha: head },
              base: { ref: "main" },
            },
          ]);
        }
        return Response.json({});
      },
    });
    await forge.designCheck?.({
      repoUrl: "https://github.com/acme/api",
      headSha: head,
      name: "ui",
    });
    now = expiresAt - INSTALLATION_TOKEN_REFRESH_SKEW_MS - 1;
    await forge.designCheck?.({
      repoUrl: "https://github.com/acme/api",
      headSha: head,
      name: "ui",
    });
    now = expiresAt - INSTALLATION_TOKEN_REFRESH_SKEW_MS;
    await forge.designCheck?.({
      repoUrl: "https://github.com/acme/api",
      headSha: head,
      name: "ui",
    });
    failCheck = true;
    await assert.rejects(
      () => forge.designCheck?.({ repoUrl: "https://github.com/acme/api", headSha: head, name: "ui" }),
      /credential error:/,
    );
    await forge.updateBranch({
      repoUrl: "https://github.com/acme/api",
      number: 4,
      expectedHeadSha: head,
    });
    await forge.listPullRequests?.({
      repoUrl: "https://github.com/acme/api",
      head: "cursor/api-1-api",
      base: "main",
    });
    const linear = linearTracker({
      apiKey: LINEAR,
      team: "APP",
      intakeState: "Todo",
      credentialNote: rec.note,
      fetch: async () => Response.json({ data: { issues: { nodes: [] } } }),
    });
    await linear.listIntake();
    await readFigmaFrame(
      "https://www.figma.com/design/dummy-secret-figma-key/Frame?node-id=1-2",
      FIGMA,
      async () => Response.json({ document: { name: "Frame", type: "DOCUMENT" } }),
      rec.note,
    );
    const worker = cursorWorker({
      slots: [{ slot: "primary", apiKey: CURSOR }],
      credentialNote: rec.note,
      sdk: {
        async create() {
          return {
            agentId: "agent-1",
            async send() {
              return { id: "run-1", async wait() { return { status: "finished" }; } };
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        messages: { async list() { return []; } },
      },
    });
    await worker.start({ prompt: "ground", repoUrl: "https://github.com/acme/api", baseRef: "main" });

    const lines = rec.lines();
    const text = lines.join("\n");
    for (const secret of [MINT, FORGE, LINEAR, FIGMA, CURSOR, "dummy-secret-figma-key"]) {
      assert.equal(text.includes(secret), false, secret);
    }
    assert.equal(text.includes("Bearer"), false);
    assert.equal(text.includes("Authorization"), false);
    assert.equal(text.includes("https://"), false);
    assert.equal(text.includes("api.github.com"), false);
    assert.equal(text.includes("api.linear.app"), false);
    assert.ok(lines.includes("credential slot=mint endpoint=mint status=200"));
    assert.ok(lines.includes("credential slot=mint endpoint=mint status=200 refresh=1"));
    assert.equal(lines.filter((line) => line === "credential slot=mint endpoint=check-runs status=200").length, 3);
    assert.equal(lines.filter((line) => line === "credential slot=mint endpoint=check-runs status=403").length, 1);
    assert.ok(lines.includes("credential slot=gh-token endpoint=pulls status=422"));
    assert.ok(lines.includes("credential slot=gh-token endpoint=pulls status=200"));
    assert.ok(lines.includes("credential slot=linear endpoint=linear-graphql status=200"));
    assert.ok(lines.includes("credential slot=figma endpoint=figma status=200"));
    assert.ok(lines.includes("credential slot=primary endpoint=cursor-launch status=200"));
    assert.deepEqual(rec.summaryLines(), [
      "credential summary slot=figma endpoint=figma status=200 count=1",
      "credential summary slot=gh-token endpoint=pulls status=200 count=1",
      "credential summary slot=gh-token endpoint=pulls status=422 count=1",
      "credential summary slot=linear endpoint=linear-graphql status=200 count=1",
      "credential summary slot=mint endpoint=check-runs status=200 count=3",
      "credential summary slot=mint endpoint=check-runs status=403 count=1",
      "credential summary slot=mint endpoint=mint status=200 count=2",
      "credential summary slot=primary endpoint=cursor-launch status=200 count=1",
    ]);
  });

  it("logs a Figma 400 with the API reason and without the token", async () => {
    const rec = createCredentialRecorder();
    const text = await readFigmaFrame(
      "https://www.figma.com/design/dummy-secret-figma-key/Frame?node-id=1-2",
      FIGMA,
      async () => Response.json({ err: `bad ${FIGMA} id` }, { status: 400 }),
      rec.note,
    );
    assert.equal(text, "figma read failed: 400 bad id");
    assert.deepEqual(rec.lines(), ["credential slot=figma endpoint=figma status=400 detail=bad id"]);
    assert.deepEqual(rec.summaryLines(), [
      "credential summary slot=figma endpoint=figma status=400 count=1",
    ]);
    assert.equal(rec.lines().join("\n").includes(FIGMA), false);
  });

  it("logs a failed mint without the command output", async () => {
    const rec = createCredentialRecorder();
    const forge = githubForge({
      token: FORGE,
      mintCommand: "mint-installation-token",
      credentialNote: rec.note,
      runMint: () => ({ status: 1, stdout: MINT }),
      fetch: async () => Response.json({}),
    });
    await assert.rejects(
      () => forge.designCheck?.({ repoUrl: "https://github.com/acme/api", headSha: "a".repeat(40), name: "ui" }),
      /credential error:/,
    );
    assert.deepEqual(rec.lines(), ["credential slot=mint endpoint=mint status=1"]);
    assert.equal(rec.lines().join("\n").includes(MINT), false);
  });
});
