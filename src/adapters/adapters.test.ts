import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCredentialRecorder } from "../engine/credential-log.ts";
import { githubForge } from "./forge-github.ts";
import { githubIssuesTracker, jiraTracker, linearTracker } from "./trackers.ts";
import {
  copilotWorker,
  cursorKeySlots,
  cursorReceiptText,
  CURSOR_ACCOUNT_DEFAULT_MODEL,
  CURSOR_LAUNCH_RETRY_MS,
  cursorWorker,
  httpWorker,
  type CursorSdk,
} from "./workers.ts";
import { createCredentialRecorder } from "../engine/credential-log.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const JIRA_AUTH_ENV = "DELIVERY_LOOP_TEST_JIRA_AUTH";
const JIRA_AUTH = "Basic jira-test-secret";
const JIRA_CONFIG = {
  apiBaseUrl: "https://jira.example.test",
  authHeaderEnv: JIRA_AUTH_ENV,
  intakeJql: "project = APP AND status = Open",
  approvalFieldId: "customfield_12345",
};

async function withJiraAuth<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env[JIRA_AUTH_ENV];
  process.env[JIRA_AUTH_ENV] = JIRA_AUTH;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[JIRA_AUTH_ENV];
    else process.env[JIRA_AUTH_ENV] = previous;
  }
}

function jiraIssue(key = "APP-1", changes: {
  summary?: string;
  description?: unknown;
  approval?: unknown;
  issueType?: string;
  issueTypeId?: string;
  statusName?: string;
  linkedKey?: string;
  attachmentId?: string;
  omitApproval?: boolean;
} = {}) {
  return {
    id: key === "APP-1" ? "101" : "102",
    key,
    fields: {
      summary: changes.summary ?? "Apply approved change",
      description: changes.description ?? {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Preserve the current behavior." }] }],
      },
      issuetype: { id: changes.issueTypeId ?? "10001", name: changes.issueType ?? "Task" },
      assignee: { accountId: "account-1" },
      status: { name: changes.statusName ?? "Open" },
      labels: ["delivery"],
      issuelinks: [{
        id: "201",
        type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
        inwardIssue: { key: changes.linkedKey ?? "APP-9", fields: { status: { name: "Done" } } },
      }],
      attachment: [{
        id: changes.attachmentId ?? "301",
        filename: "acceptance.pdf",
        mimeType: "application/pdf",
        content: `https://jira.example.test/secure/attachment/${changes.attachmentId ?? "301"}/acceptance.pdf`,
      }],
      ...(!changes.omitApproval ? { [JIRA_CONFIG.approvalFieldId]: changes.approval ?? { value: "Approved" } } : {}),
    },
  };
}

function jiraCommentPage() {
  return { startAt: 0, total: 1, maxResults: 100, comments: [{
    id: "401",
    created: "2026-10-01T12:00:00.000Z",
    body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "A ticket comment." }] }] },
  }] };
}

describe("adapters", () => {
  it("refuses a pull request when the token is not the commit actor", async () => {
    const calls: string[] = [];
    const forge = githubForge({
      token: "app",
      commitActors: [{ login: "Madmaxme", repos: ["https://github.com/Madmaxme/delivery-loop"] }],
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (String(url).endsWith("/user")) return jsonResponse({ message: "forbidden" }, 403);
        return jsonResponse({});
      },
    });
    await assert.rejects(
      () =>
        forge.openPullRequest({
          repoUrl: "https://github.com/Madmaxme/delivery-loop",
          title: "t",
          body: "b",
          head: "feature",
          base: "main",
        }),
      /commit actor is Madmaxme/,
    );
    assert.equal(calls.some((call) => call.includes("/pulls")), false);
  });

  it("opens a pull request when the token login is the commit actor", async () => {
    const forge = githubForge({
      token: "user",
      commitActors: [{ login: "Madmaxme", repos: ["Madmaxme/delivery-loop"] }],
      fetch: async (url, init) => {
        if (String(url).endsWith("/user")) return jsonResponse({ login: "Madmaxme" });
        if (String(url).endsWith("/pulls") && init?.method === "POST") {
          return jsonResponse({
            number: 4,
            html_url: "https://github.com/Madmaxme/delivery-loop/pull/4",
            head: { sha: "abc", ref: "feature" },
          });
        }
        return jsonResponse({});
      },
    });
    const pr = await forge.openPullRequest({
      repoUrl: "https://github.com/Madmaxme/delivery-loop.git",
      title: "t",
      body: "b",
      head: "feature",
      base: "main",
    });
    assert.equal(pr.number, 4);
  });

  it("opens a pull request and reads a green quality run", async () => {
    const calls: string[] = [];
    const forge = githubForge({
      token: "t",
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (String(url).endsWith("/pulls")) {
          return jsonResponse({
            number: 9,
            html_url: "https://github.com/acme/api/pull/9",
            head: { sha: "abc", ref: "delivery/api-1" },
          });
        }
        if (String(url).includes("/actions/runs")) {
          return jsonResponse({
            workflow_runs: [
              {
                name: "quality",
                status: "completed",
                conclusion: "success",
                head_sha: "abc",
                html_url: "https://example.test/run",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          });
        }
        return jsonResponse({});
      },
    });
    const pr = await forge.openPullRequest({
      repoUrl: "https://github.com/acme/api",
      title: "API-1",
      body: "order",
      head: "delivery/api-1",
      base: "main",
    });
    assert.equal(pr.number, 9);
    const again = githubForge({
      token: "t",
      fetch: async (url, init) => {
        if (String(url).endsWith("/pulls") && init?.method === "POST") {
          return jsonResponse({ message: "exists" }, 422);
        }
        if (String(url).includes("/pulls?")) {
          return jsonResponse([
            { number: 9, html_url: "https://github.com/acme/api/pull/9", head: { sha: "abc", ref: "delivery/api-1" } },
          ]);
        }
        return jsonResponse({});
      },
    });
    const adopted = await again.openPullRequest({
      repoUrl: "https://github.com/acme/api",
      title: "API-1",
      body: "order",
      head: "delivery/api-1",
      base: "main",
    });
    assert.equal(adopted.number, 9);
    assert.equal(adopted.headSha, "abc");
    assert.equal(adopted.created, false);
    assert.equal(pr.created, true);
    const probe = await forge.quality({
      repoUrl: "https://github.com/acme/api",
      headSha: "abc",
      workflow: "quality",
    });
    assert.equal(probe.state, "success");
    assert.match(probe.detail, /quality success/);
    assert.ok(calls.some((c) => c.includes("/pulls")));
  });

  it("requests one empty commit when quality never started", async () => {
    const calls: string[] = [];
    const forge = githubForge({
      token: "t",
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (String(url).includes("/actions/runs")) return jsonResponse({ workflow_runs: [] });
        if (String(url).includes("/commits/abc")) {
          return jsonResponse({
            commit: {
              message: "QUI-1: hide templates",
              tree: { sha: "tree1" },
              committer: { date: "2026-10-24T05:02:06Z" },
            },
          });
        }
        if (String(url).endsWith("/git/commits") && method === "POST") {
          return jsonResponse({ sha: "def" });
        }
        if (String(url).includes("/git/refs/heads/") && method === "PATCH") {
          return jsonResponse({ ref: "refs/heads/cursor/qui-1-api" });
        }
        return jsonResponse({}, 404);
      },
    });
    const probe = await forge.quality({
      repoUrl: "https://github.com/acme/api",
      headSha: "abc",
      workflow: "quality",
    });
    assert.equal(probe.state, "pending");
    assert.match(probe.detail, /no Actions runs yet for abc/);
    assert.equal(probe.committedAt, "2026-10-24T05:02:06Z");
    const next = await forge.requestQualityRun({
      repoUrl: "https://github.com/acme/api",
      branch: "cursor/qui-1-api",
      headSha: "abc",
      message: "rerun quality\n\nThe previous commit had no Actions run.",
    });
    assert.equal(next, "def");
    assert.ok(calls.some((call) => call.startsWith("POST ") && call.endsWith("/git/commits")));
    const again = githubForge({
      token: "t",
      fetch: async (url) => {
        if (String(url).includes("/commits/def")) {
          return jsonResponse({
            commit: {
              message: "rerun quality\n\nThe previous commit had no Actions run.",
              tree: { sha: "tree1" },
              committer: { date: "2026-10-25T17:20:00Z" },
            },
          });
        }
        return jsonResponse({}, 404);
      },
    });
    assert.equal(
      await again.requestQualityRun({
        repoUrl: "https://github.com/acme/api",
        branch: "cursor/qui-1-api",
        headSha: "def",
        message: "rerun quality\n\nThe previous commit had no Actions run.",
      }),
      null,
    );
  });

  it("waits out pending status and returns the finished result", async () => {
    const rec = createCredentialRecorder();
    const sleeps: number[] = [];
    const bodies: unknown[] = [];
    const urls: string[] = [];
    const statuses = ["pending", "pending", "finished"];
    const worker = httpWorker({
      startUrl: "https://host.example/start",
      statusUrl: "https://host.example/status?run={id}",
      model: "model-4.7",
      pollMs: 1000,
      maxWaitMs: 60_000,
      newId: () => "req-1",
      nowMs: () => sleeps.reduce((sum, ms) => sum + ms, 0),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      credentialNote: rec.note,
      env: { START_TOKEN: "start-secret" },
      startHeaders: { Authorization: "START_TOKEN" },
      fetch: async (url, init) => {
        urls.push(String(url));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (init?.method === "POST") {
          assert.equal(headers.Authorization, "Bearer start-secret");
          bodies.push(JSON.parse(String(init.body)));
          return jsonResponse({ runId: "ignored" }, 202);
        }
        const status = statuses.shift();
        return jsonResponse({
          status,
          branch: "cursor/api-1",
          head: "abc",
          text: "done",
          branches: [{ repoUrl: "https://github.com/acme/api", branch: "cursor/api-1" }],
        });
      },
    });
    const started = await worker.start({
      prompt: "ground the ticket",
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
    });
    assert.equal(started.runId, "req-1");
    assert.deepEqual(bodies[0], {
      id: "req-1",
      prompt: "ground the ticket",
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
      model: { id: "model-4.7" },
    });
    const joined = await worker.join(started.runId);
    assert.equal(joined.status, "finished");
    assert.equal(joined.branch, "cursor/api-1");
    assert.equal(joined.head, "abc");
    assert.equal(joined.text, "done");
    assert.equal(joined.branches?.[0]?.branch, "cursor/api-1");
    assert.deepEqual(sleeps, [1000, 1000]);
    assert.equal(urls.at(-1), "https://host.example/status?run=req-1");
    assert.deepEqual(rec.lines(), [
      "credential slot=worker-http endpoint=worker-http-start status=202",
      "credential slot=worker-http endpoint=worker-http-status status=200",
      "credential slot=worker-http endpoint=worker-http-status status=200",
      "credential slot=worker-http endpoint=worker-http-status status=200",
    ]);
    const text = rec.lines().join("\n");
    assert.equal(text.includes("start-secret"), false);
    assert.equal(text.includes("Bearer"), false);
    assert.equal(text.includes("host.example"), false);
    assert.equal(text.includes("run="), false);
  });

  it("fails the join when maxWaitMs passes", async () => {
    let now = 0;
    const worker = httpWorker({
      startUrl: "https://host.example/start",
      statusUrl: "https://host.example/status/{id}",
      pollMs: 1000,
      maxWaitMs: 2500,
      newId: () => "req-2",
      nowMs: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      fetch: async (_url, init) => {
        if (init?.method === "POST") return jsonResponse({}, 200);
        return jsonResponse({ status: "running", text: "" });
      },
    });
    const started = await worker.start({ prompt: "go", repoUrl: "https://github.com/acme/api", baseRef: "main" });
    const joined = await worker.join(started.runId);
    assert.equal(joined.status, "failed");
    assert.equal(joined.text, "http worker join exceeded maxWaitMs");
    assert.equal(now, 2500);
  });

  it("fails a non-2xx start and does not read status or start again", async () => {
    const rec = createCredentialRecorder();
    const calls: string[] = [];
    const worker = httpWorker({
      startUrl: "https://host.example/start?token=start-secret",
      statusUrl: "https://host.example/status/{id}",
      credentialNote: rec.note,
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return jsonResponse({ message: "no" }, 400);
      },
    });
    await assert.rejects(
      () => worker.start({ prompt: "go", repoUrl: "https://github.com/acme/api", baseRef: "main" }),
      /HTTP worker start failed: 400/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.startsWith("POST "), true);
    assert.equal(calls.some((call) => call.startsWith("GET ")), false);
    assert.deepEqual(rec.lines(), ["credential slot=worker-http endpoint=worker-http-start status=400"]);
    assert.equal(rec.lines().join("\n").includes("start-secret"), false);
    assert.equal(rec.lines().join("\n").includes("token="), false);
  });

  it("resolves header env vars and the minted token without writing them", async () => {
    const rec = createCredentialRecorder();
    const seen: Record<string, string>[] = [];
    const worker = httpWorker({
      startUrl: "https://host.example/start",
      statusUrl: "https://host.example/status/{id}",
      newId: () => "req-3",
      credentialNote: rec.note,
      env: { START_TOKEN: "start-secret", STATUS_ACCEPT: "application/vnd.github+json" },
      startHeaders: { Authorization: "START_TOKEN" },
      statusHeaders: { Authorization: "mint", Accept: "STATUS_ACCEPT" },
      tokens: {
        async mint() {
          return { token: "mint-secret", slot: "mint" };
        },
        forge() {
          return { token: "forge-secret", slot: "gh-token" };
        },
      },
      fetch: async (_url, init) => {
        seen.push({ ...(init?.headers as Record<string, string>) });
        if (init?.method === "POST") return jsonResponse({}, 201);
        const file = Buffer.from(
          JSON.stringify({ status: "finished", branch: "b", head: "h", text: "from-file" }),
          "utf8",
        ).toString("base64");
        return jsonResponse({ encoding: "base64", content: `${file.slice(0, 8)}\n${file.slice(8)}` });
      },
    });
    const started = await worker.start({ prompt: "go", repoUrl: "https://github.com/acme/api", baseRef: "main" });
    const joined = await worker.join(started.runId);
    assert.equal(seen[0]?.Authorization, "Bearer start-secret");
    assert.equal(seen[1]?.Authorization, "Bearer mint-secret");
    assert.equal(seen[1]?.Accept, "application/vnd.github+json");
    assert.equal(joined.status, "finished");
    assert.equal(joined.text, "from-file");
    assert.deepEqual(rec.lines(), [
      "credential slot=worker-http endpoint=worker-http-start status=201",
      "credential slot=mint endpoint=worker-http-status status=200",
    ]);
    const text = rec.lines().join("\n");
    for (const secret of ["start-secret", "mint-secret", "forge-secret"]) {
      assert.equal(text.includes(secret), false);
    }
    await assert.rejects(
      () =>
        httpWorker({
          startUrl: "https://host.example/start",
          statusUrl: "https://host.example/status/{id}",
          env: {},
          startHeaders: { Authorization: "START_TOKEN" },
          fetch: async () => jsonResponse({}),
        }).start({ prompt: "go", repoUrl: "https://github.com/acme/api", baseRef: "main" }),
      /missing source START_TOKEN/,
    );
  });

  it("seeds a forge file before start and reads that file", async () => {
    const rec = createCredentialRecorder();
    const calls: string[] = [];
    const reads = ["pending", "running", "finished"];
    let seeded = "";
    let startBody: Record<string, unknown> | undefined;
    const forge = githubForge({
      token: "forge-token",
      mintCommand: "mint-installation-token",
      runMint: () => ({ status: 0, stdout: "mint-token\n" }),
      credentialNote: rec.note,
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        const href = String(url);
        calls.push(`${method} ${href}`);
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer mint-token");
        if (href.includes("/git/matching-refs/heads/results")) return jsonResponse([]);
        if (href.endsWith("/repos/acme/store")) return jsonResponse({ default_branch: "main" });
        if (href.includes("/git/matching-refs/heads/main")) {
          return jsonResponse([{ ref: "refs/heads/main", object: { sha: "abc123" } }]);
        }
        if (method === "POST" && href.endsWith("/git/refs")) {
          assert.deepEqual(JSON.parse(String(init?.body)), { ref: "refs/heads/results", sha: "abc123" });
          return jsonResponse({}, 201);
        }
        if (method === "PUT" && href.includes("/contents/")) {
          seeded = String(init?.body);
          return jsonResponse({}, 201);
        }
        if (method === "GET" && href.includes("/contents/")) {
          assert.match(href, /\/contents\/worker-results\/req-9\.json\?ref=results$/);
          const text = JSON.stringify({ status: reads.shift(), branch: "b", head: "h", text: "done" });
          return jsonResponse({ encoding: "base64", content: Buffer.from(text).toString("base64") });
        }
        return jsonResponse({}, 500);
      },
    });
    const worker = httpWorker({
      startUrl: "https://host.example/start",
      model: "model-4.7",
      pollMs: 1000,
      maxWaitMs: 60_000,
      newId: () => "req-9",
      nowMs: () => Date.parse("2026-11-10T22:00:00.000Z"),
      sleep: async () => {},
      credentialNote: rec.note,
      statusStore: {
        kind: "forge",
        repo: "acme/store",
        branch: "results",
        path: "worker-results/{id}.json",
      },
      files: {
        write: (input) =>
          forge.writeTextFile!({
            ...input,
            message: "record a pending worker result",
            endpoint: "worker-http-seed",
          }),
        read: (input) => forge.readTextFile!({ ...input, endpoint: "worker-http-status" }),
      },
      fetch: async (_url, init) => {
        calls.push("START");
        startBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({}, 202);
      },
    });
    const started = await worker.start({
      prompt: "ground the ticket",
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
    });
    assert.equal(calls.at(-1), "START");
    assert.deepEqual(startBody, {
      id: "req-9",
      prompt: "ground the ticket",
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
      model: { id: "model-4.7" },
      statusStore: { repo: "acme/store", branch: "results", path: "worker-results/req-9.json" },
    });
    assert.equal(calls.some((call) => call.startsWith("START") && calls.indexOf(call) < calls.findIndex((item) => item.startsWith("PUT"))), false);
    const sent = JSON.parse(seeded) as { message: string; content: string; branch: string };
    assert.equal(sent.message, "record a pending worker result");
    assert.equal(sent.branch, "results");
    assert.deepEqual(JSON.parse(Buffer.from(sent.content, "base64").toString("utf8")), {
      status: "pending",
      id: "req-9",
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
      requestedAt: "2026-11-10T22:00:00.000Z",
    });
    const joined = await worker.join(started.runId);
    assert.equal(joined.status, "finished");
    assert.equal(joined.head, "h");
    const endpoints = rec.lines().map((line) => line.split(" endpoint=")[1]?.split(" ")[0]);
    const startAt = endpoints.indexOf("worker-http-start");
    const before = endpoints.slice(0, startAt).filter((name) => name !== "mint");
    assert.ok(before.length > 0);
    assert.ok(before.every((name) => name === "worker-http-seed"));
    assert.ok(endpoints.slice(startAt + 1).every((name) => name === "worker-http-status"));
    const text = rec.lines().join("\n");
    assert.equal(text.includes("mint-token"), false);
    assert.equal(text.includes("forge-token"), false);
    assert.equal(text.includes("ref="), false);
    assert.equal(text.includes("worker-results"), false);
    assert.ok(rec.lines().some((line) => line === "credential slot=mint endpoint=worker-http-seed status=201"));
    assert.ok(rec.lines().some((line) => line === "credential slot=mint endpoint=worker-http-status status=200"));
  });

  it("does not start when the forge seed fails", async () => {
    const calls: string[] = [];
    const worker = httpWorker({
      startUrl: "https://host.example/start",
      newId: () => "req-10",
      statusStore: { kind: "forge", repo: "acme/store", branch: "results", path: "worker-results/{id}.json" },
      files: {
        async write() {
          return { status: 403, actor: "" };
        },
        async read() {
          return { status: 200, text: "" };
        },
      },
      fetch: async () => {
        calls.push("START");
        return jsonResponse({}, 202);
      },
    });
    await assert.rejects(
      () => worker.start({ prompt: "go", repoUrl: "https://github.com/acme/api", baseRef: "main" }),
      /http worker seed failed: 403/,
    );
    assert.deepEqual(calls, []);
  });

  it("opens a forge issue after the seed and assigns it", async () => {
    const rec = createCredentialRecorder();
    const calls: string[] = [];
    const forge = githubForge({
      token: "forge-token",
      mintCommand: "mint-installation-token",
      runMint: () => ({ status: 0, stdout: "mint-token\n" }),
      credentialNote: rec.note,
      fetch: async (url, init) => {
        const method = init?.method ?? "GET";
        const href = String(url);
        calls.push(`${method} ${href.split("?")[0]}`);
        const headers = init?.headers as Record<string, string>;
        assert.equal(headers.Authorization, "Bearer mint-token");
        if (href.includes("/git/matching-refs/")) {
          return jsonResponse([{ ref: "refs/heads/results", object: { sha: "abc123" } }]);
        }
        if (method === "PUT" && href.includes("/contents/")) {
          return jsonResponse(
            {
              commit: { author: { name: "loop", email: "1+loop-bot[bot]@users.noreply.github.com" } },
            },
            201,
          );
        }
        if (method === "POST" && href.endsWith("/issues")) {
          const body = JSON.parse(String(init?.body)) as { title: string; body: string; labels?: string[]; assignees?: string[] };
          assert.equal(body.title, "worker-request req-11");
          assert.deepEqual(body.labels, ["run"]);
          assert.equal(body.assignees, undefined);
          const fenced = body.body.replace(/^```json\n/, "").replace(/\n```$/, "");
          assert.deepEqual(JSON.parse(fenced), {
            id: "req-11",
            prompt: "ground the ticket",
            repoUrl: "https://github.com/acme/api",
            baseRef: "main",
            model: { id: "model-4.7" },
            statusStore: { repo: "acme/store", branch: "results", path: "worker-results/req-11.json" },
            requestedBy: "loop-bot[bot]",
          });
          return jsonResponse({ number: 7 }, 201);
        }
        if (method === "POST" && href.endsWith("/assignees")) {
          assert.equal(href.endsWith("/issues/7/assignees"), true);
          assert.deepEqual(JSON.parse(String(init?.body)), { assignees: ["relay-login"] });
          return jsonResponse({}, 201);
        }
        return jsonResponse({}, 500);
      },
    });
    const worker = httpWorker({
      model: "model-4.7",
      newId: () => "req-11",
      nowMs: () => Date.parse("2026-11-10T22:00:00.000Z"),
      statusStore: { kind: "forge", repo: "acme/store", branch: "results", path: "worker-results/{id}.json" },
      request: { kind: "forge-issue", repo: "acme/signals", assignee: "relay-login", labels: ["run"] },
      files: {
        write: (input) =>
          forge.writeTextFile!({
            repo: input.repo,
            branch: input.branch,
            path: input.path,
            text: input.text,
            message: input.message ?? "record a pending worker result",
            endpoint: "worker-http-seed",
          }),
        read: (input) => forge.readTextFile!({ ...input, endpoint: "worker-http-status" }),
      },
      issues: {
        open: (input) => forge.createIssue!({ ...input, endpoint: "worker-request-issue" }),
        assign: (input) => forge.assignIssue!({ ...input, endpoint: "worker-request-assign" }),
        actor: () => forge.actorLogin!(),
      },
      fetch: async () => {
        calls.push("START");
        return jsonResponse({}, 202);
      },
    });
    const started = await worker.start({
      prompt: "ground the ticket",
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
    });
    assert.equal(started.runId, "req-11");
    assert.equal(calls.includes("START"), false);
    const put = calls.findIndex((call) => call.startsWith("PUT "));
    const issue = calls.findIndex((call) => call.endsWith("/issues"));
    const assign = calls.findIndex((call) => call.endsWith("/assignees"));
    assert.ok(put >= 0 && issue > put && assign > issue);
    assert.ok(rec.lines().includes("credential slot=mint endpoint=worker-request-issue status=201"));
    assert.ok(rec.lines().includes("credential slot=mint endpoint=worker-request-assign status=201"));
    assert.equal(rec.lines().join("\n").includes("mint-token"), false);
  });

  it("does not assign when the forge issue is refused", async () => {
    const steps: string[] = [];
    const worker = httpWorker({
      newId: () => "req-12",
      statusStore: { kind: "forge", repo: "acme/store", branch: "results", path: "worker-results/{id}.json" },
      request: { kind: "forge-issue", repo: "acme/signals", assignee: "relay-login" },
      files: {
        async write() {
          steps.push("seed");
          return { status: 201, actor: "loop-bot[bot]" };
        },
        async read() {
          return { status: 200, text: "{}" };
        },
      },
      issues: {
        async open() {
          steps.push("issue");
          return { status: 422, number: 0 };
        },
        async assign() {
          steps.push("assign");
          return 201;
        },
        async actor() {
          return "";
        },
      },
    });
    await assert.rejects(
      () => worker.start({ prompt: "go", repoUrl: "https://github.com/acme/api", baseRef: "main" }),
      /http worker request failed: 422/,
    );
    assert.deepEqual(steps, ["seed", "issue"]);
  });

  it("stores a large start body beside the record and puts that path on the issue", async () => {
    const writes: { path: string; text: string }[] = [];
    let issueBody = "";
    const steps: string[] = [];
    const worker = httpWorker({
      model: "model-4.7",
      newId: () => "req-13",
      statusStore: { kind: "forge", repo: "acme/store", branch: "results", path: "worker-results/{id}.json" },
      request: { kind: "forge-issue", repo: "acme/signals", assignee: "relay-login" },
      files: {
        async write(input) {
          writes.push({ path: input.path, text: input.text });
          steps.push(input.path.endsWith(".request.json") ? "request-file" : "seed");
          return { status: 201, actor: "loop-bot[bot]" };
        },
        async read() {
          return { status: 200, text: "{}" };
        },
      },
      issues: {
        async open(input) {
          steps.push("issue");
          issueBody = input.body;
          return { status: 201, number: 4 };
        },
        async assign() {
          steps.push("assign");
          return 201;
        },
        async actor() {
          steps.push("actor");
          return "other";
        },
      },
    });
    const prompt = "p".repeat(70_000);
    const started = await worker.start({
      prompt,
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
    });
    assert.equal(started.runId, "req-13");
    assert.deepEqual(steps, ["seed", "request-file", "issue", "assign"]);
    assert.equal(issueBody, "worker-results/req-13.request.json");
    const stored = JSON.parse(writes[1]?.text ?? "") as { prompt: string; requestedBy: string; statusStore: { path: string } };
    assert.equal(stored.prompt, prompt);
    assert.equal(stored.requestedBy, "loop-bot[bot]");
    assert.equal(stored.statusStore.path, "worker-results/req-13.json");
  });

  it("starts a Copilot cloud task", async () => {
    const worker = copilotWorker({
      token: "t",
      owner: "acme",
      repo: "api",
      fetch: async (url, init) => {
        if (init?.method === "POST") return jsonResponse({ id: "task-1" }, 201);
        return jsonResponse({ state: "completed", head_ref: "copilot/task-1", head_sha: "def", summary: "ok" });
      },
    });
    const started = await worker.start({ prompt: "go", repoUrl: "https://github.com/acme/api", baseRef: "main" });
    assert.equal(started.runId, "task-1");
    const joined = await worker.join("task-1");
    assert.equal(joined.status, "finished");
    assert.equal(joined.head, "def");
  });

  it("lists Linear intake and GitHub issues", async () => {
    const linear = linearTracker({
      apiKey: "k",
      team: "APP",
      intakeState: "Todo",
      fetch: async () =>
        jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  id: "uuid",
                  identifier: "APP-3",
                  title: "Fix",
                  description: "body",
                  state: { name: "Todo" },
                  labels: { nodes: [] },
                  comments: { nodes: [] },
                  inverseRelations: { nodes: [] },
                },
              ],
            },
          },
        }),
    });
    const tickets = await linear.listIntake();
    assert.equal(tickets[0]?.identifier, "APP-3");

    const snapshotTracker = linearTracker({
      apiKey: "k",
      team: "APP",
      intakeState: "Todo",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        if (body.query.includes("projects(filter")) {
          return jsonResponse({ data: { projects: { nodes: [{ id: "p1", name: "Billing", url: "https://linear.app/p1" }] } } });
        }
        if (body.query.includes("project(id:")) {
          return jsonResponse({
            data: {
              project: {
                id: "p1",
                name: "Billing",
                url: "https://linear.app/p1",
                projectMilestones: { nodes: [{ id: "m1", name: "Stage 1", description: null, sortOrder: 1 }] },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            issues: {
              nodes: [
                {
                  identifier: "APP-3",
                  labels: { nodes: [] },
                  state: { name: "Todo" },
                  projectMilestone: { id: "m1" },
                  inverseRelations: { nodes: [] },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      },
    });
    const snapshot = await snapshotTracker.projectSnapshot("Billing");
    assert.equal(snapshot?.projectName, "Billing");
    assert.equal(snapshot?.issues[0]?.identifier, "APP-3");
    assert.equal(snapshot?.milestones[0]?.name, "Stage 1");

    const github = githubIssuesTracker({
      token: "t",
      repo: "acme/api",
      intakeLabel: "todo",
      fetch: async (url) => {
        if (String(url).includes("/comments")) return jsonResponse([]);
        return jsonResponse([
          { number: 3, title: "Fix", body: "blocked by API-1", labels: [{ name: "todo" }], state: "open" },
        ]);
      },
    });
    const issues = await github.listIntake();
    assert.equal(issues[0]?.blockedBy[0]?.identifier, "API-1");
  });
  it("pages Jira intake, normalizes issue evidence, and redacts credentials", async () => {
    await withJiraAuth(async () => {
      const searchBodies: Record<string, unknown>[] = [];
      const recorder = createCredentialRecorder();
      const jira = jiraTracker({
        ...JIRA_CONFIG,
        credentialNote: recorder.note,
        fetch: async (url, init) => {
          const request = new URL(String(url));
          assert.equal(new Headers(init?.headers).get("Authorization"), JIRA_AUTH);
          if (request.pathname.endsWith("/search/jql")) {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            searchBodies.push(body);
            return body.nextPageToken
              ? jsonResponse({ issues: [jiraIssue("APP-2")], isLast: true })
              : jsonResponse({ issues: [jiraIssue()], isLast: false, nextPageToken: "page-2" });
          }
          if (request.pathname.endsWith("/comment")) return jsonResponse(jiraCommentPage());
          throw new Error(`Unexpected Jira request ${request.pathname}`);
        },
      });
      const tickets = await jira.listIntake();
      assert.equal(tickets.length, 2);
      assert.equal(searchBodies.length, 2);
      assert.deepEqual(searchBodies[1]?.nextPageToken, "page-2");
      assert.deepEqual(searchBodies[0]?.fields, ["summary", "description", "issuetype", "assignee", "status", "labels", "issuelinks", "attachment", "customfield_12345"]);
      assert.equal(tickets[0]?.body, "Preserve the current behavior.\n");
      assert.equal(tickets[0]?.issueType, "Task");
      assert.equal(tickets[0]?.assigneeId, "account-1");
      assert.deepEqual(tickets[0]?.fieldValues, { customfield_12345: { value: "Approved" } });
      assert.deepEqual(tickets[0]?.blockedBy, [{ identifier: "APP-9", stateName: "Done" }]);
      assert.deepEqual(tickets[0]?.attachments, [{
        id: "301",
        filename: "acceptance.pdf",
        mimeType: "application/pdf",
        sourceUrl: "https://jira.example.test/secure/attachment/301/acceptance.pdf",
      }]);
      assert.equal(tickets[0]?.comments[0]?.body, "A ticket comment.\n");
      assert.match(tickets[0]?.criteriaRevision ?? "", /^[a-f0-9]{64}$/);
      const logs = recorder.lines().join("\n");
      assert.match(logs, /slot=jira endpoint=jira-rest/);
      assert.doesNotMatch(logs, /jira\.example\.test|jira-test-secret|Basic /);
    });
  });

  it("hashes normalized Jira criteria deterministically", async () => {
    await withJiraAuth(async () => {
      let issue = jiraIssue();
      const jira = jiraTracker({
        ...JIRA_CONFIG,
        fetch: async (url) => {
          const request = new URL(String(url));
          if (request.pathname.endsWith("/comment")) return jsonResponse(jiraCommentPage());
          return jsonResponse(issue);
        },
      });
      const first = await jira.get("APP-1");
      assert.equal((await jira.get("APP-1")).criteriaRevision, first.criteriaRevision);
      issue = jiraIssue("APP-1", { summary: "  Apply approved change  " });
      assert.equal((await jira.get("APP-1")).criteriaRevision, first.criteriaRevision);
      issue = jiraIssue("APP-1", { statusName: "Done" });
      assert.equal((await jira.get("APP-1")).criteriaRevision, first.criteriaRevision);
      const changes = [
        { summary: "Changed title" },
        { description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Changed description." }] }] } },
        { approval: { value: "Rejected" } },
        { issueType: "Bug" },
        { issueTypeId: "10002" },
        { linkedKey: "APP-10" },
        { attachmentId: "302" },
      ];
      for (const change of changes) {
        issue = jiraIssue("APP-1", change);
        assert.notEqual((await jira.get("APP-1")).criteriaRevision, first.criteriaRevision);
      }
    });
  });

  it("selects the exact Jira status transition and refuses stale or ambiguous writes", async () => {
    await withJiraAuth(async () => {
      let issue = jiraIssue();
      let ambiguous = false;
      const transitionWrites: Record<string, unknown>[] = [];
      const jira = jiraTracker({
        ...JIRA_CONFIG,
        fetch: async (url, init) => {
          const request = new URL(String(url));
          if (request.pathname.endsWith("/transitions") && init?.method !== "POST") {
            return jsonResponse({ transitions: ambiguous
              ? [{ id: "10", to: { name: "Done" } }, { id: "12", to: { name: "Done" } }]
              : [{ id: "10", to: { name: "Done" } }, { id: "11", to: { name: "Done - Automatic" } }] });
          }
          if (request.pathname.endsWith("/transitions")) {
            transitionWrites.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return new Response(null, { status: 204 });
          }
          if (request.pathname.endsWith("/comment")) return jsonResponse(jiraCommentPage());
          return jsonResponse(issue);
        },
      });
      const ticket = await jira.get("APP-1");
      await jira.setState("APP-1", "Done", ticket.criteriaRevision);
      assert.deepEqual(transitionWrites, [{ transition: { id: "10" } }]);
      ambiguous = true;
      await assert.rejects(() => jira.setState("APP-1", "Done", ticket.criteriaRevision), /ambiguous/);
      ambiguous = false;
      await assert.rejects(() => jira.setState("APP-1", "Done", ""), /expected criteriaRevision/);
      const staleTicket = await jira.get("APP-1");
      issue = jiraIssue("APP-1", { summary: "Changed after review" });
      await assert.rejects(
        () => jira.setState("APP-1", "Done", staleTicket.criteriaRevision),
        /criteria revision changed/,
      );
      assert.equal(transitionWrites.length, 1);
    });
  });

  it("round-trips v2 Jira delivery state through the issue property", async () => {
    await withJiraAuth(async () => {
      let stored: unknown;
      const jira = jiraTracker({
        ...JIRA_CONFIG,
        fetch: async (url, init) => {
          const request = new URL(String(url));
          if (request.pathname.endsWith("/properties") && !request.pathname.endsWith("/delivery-loop.state.v2")) {
            return jsonResponse({ keys: stored ? [{ key: "delivery-loop.state.v2" }] : [] });
          }
          if (request.pathname.endsWith("/delivery-loop.state.v2") && init?.method === "PUT") {
            stored = JSON.parse(String(init.body));
            return new Response(null, { status: 204 });
          }
          if (request.pathname.endsWith("/delivery-loop.state.v2")) {
            return jsonResponse({ key: "delivery-loop.state.v2", value: stored });
          }
          throw new Error(`Unexpected Jira state request ${request.pathname}`);
        },
      });
      assert.deepEqual(await jira.stateStore.readDeliveryState("APP-1"), {
        schemaVersion: 2,
        markers: [],
        stageReceipts: [],
      });
      const state = {
        schemaVersion: 2 as const,
        markers: [{ kind: "LEASE", body: "active", createdAt: "2026-10-01T12:00:00.000Z" }],
        stageReceipts: [{
          stageId: "dev",
          target: "dev",
          outcome: "passed" as const,
          reason: "",
          criteriaRevision: "a".repeat(64),
          deployed: [{ repo: "api", sha: "b".repeat(40) }],
          criteria: [{ id: "one-charge", outcome: "verified" as const, evidence: ["test passed"] }],
        }],
      };
      await jira.stateStore.writeDeliveryState("APP-1", state);
      assert.deepEqual(await jira.stateStore.readDeliveryState("APP-1"), state);
    });
  });
  it("stores v2 snapshots in Linear and GitHub comments", async () => {
    const state = {
      schemaVersion: 2 as const,
      markers: [{ kind: "LEASE", body: "active", createdAt: "2026-10-01T12:00:00.000Z" }],
      stageReceipts: [],
    };
    let linearComment = "";
    const linear = linearTracker({
      apiKey: "k",
      team: "APP",
      intakeState: "Todo",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        if (body.query.includes("commentCreate")) {
          linearComment = String(body.variables.body);
          return jsonResponse({ data: { commentCreate: { success: true } } });
        }
        return jsonResponse({ data: { issues: { nodes: [{
          id: "linear-1",
          identifier: "APP-1",
          title: "Fix",
          description: "",
          state: { name: "Todo" },
          labels: { nodes: [] },
          comments: { nodes: linearComment ? [{ body: linearComment, createdAt: "2026-10-01T12:00:00.000Z" }] : [] },
          attachments: { nodes: [] },
          inverseRelations: { nodes: [] },
        }] } } });
      },
    });
    linearComment = "<!-- delivery-loop-state:v1:old-snapshot -->";
    assert.deepEqual(await linear.stateStore.readDeliveryState("APP-1"), {
      schemaVersion: 2,
      markers: [],
      stageReceipts: [],
    });
    await linear.stateStore.writeDeliveryState("APP-1", state);
    assert.match(linearComment, /^<!-- delivery-loop-state:v2:[A-Za-z0-9_-]+ -->$/);
    assert.deepEqual(await linear.stateStore.readDeliveryState("APP-1"), state);

    const githubComments: { id: string; body: string; created_at: string }[] = [];
    const github = githubIssuesTracker({
      token: "t",
      repo: "acme/api",
      intakeLabel: "todo",
      fetch: async (url, init) => {
        const request = new URL(String(url));
        if (request.pathname.endsWith("/comments")) {
          if (init?.method === "POST") {
            const payload: unknown = JSON.parse(String(init.body));
            if (!payload || typeof payload !== "object" || !("body" in payload) || typeof payload.body !== "string") {
              throw new Error("Unexpected GitHub comment body");
            }
            githubComments.push({ id: String(githubComments.length + 1), body: payload.body, created_at: "2026-10-01T12:00:00.000Z" });
            return jsonResponse({ id: 1 });
          }
          return jsonResponse(githubComments);
        }
        return jsonResponse({ number: 1, title: "Fix", body: "", labels: [], state: "open" });
      },
    });
    await github.stateStore.writeDeliveryState("API-1", state);
    assert.match(githubComments[0]?.body ?? "", /^<!-- delivery-loop-state:v2:[A-Za-z0-9_-]+ -->$/);
    assert.deepEqual(await github.stateStore.readDeliveryState("API-1"), state);
  });

  it("fails closed when Jira pagination cannot advance", async () => {
    await withJiraAuth(async () => {
      const jira = jiraTracker({
        ...JIRA_CONFIG,
        fetch: async () => jsonResponse({ issues: [], isLast: false }),
      });
      await assert.rejects(() => jira.listIntake(), /pagination did not advance/);
    });
  });

  it("fails closed when the configured Jira approval field is absent", async () => {
    await withJiraAuth(async () => {
      const issue = jiraIssue("APP-1", { omitApproval: true });
      const jira = jiraTracker({
        ...JIRA_CONFIG,
        fetch: async (url) => {
          const request = new URL(String(url));
          return request.pathname.endsWith("/comment") ? jsonResponse(jiraCommentPage()) : jsonResponse(issue);
        },
      });
      await assert.rejects(() => jira.get("APP-1"), /missing configured field customfield_12345/);
    });
  });

  it("adds a Linear label and keeps labels already on the issue", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const linear = linearTracker({
      apiKey: "k",
      team: "APP",
      intakeState: "Todo",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
        calls.push(body);
        if (body.query.includes("issues(filter")) {
          return jsonResponse({
            data: {
              issues: {
                nodes: [
                  {
                    id: "uuid",
                    identifier: "APP-3",
                    title: "Fix",
                    description: "",
                    state: { name: "Todo" },
                    labels: { nodes: [] },
                    comments: { nodes: [] },
                    inverseRelations: { nodes: [] },
                  },
                ],
              },
            },
          });
        }
        if (body.query.includes("teams(filter")) {
          return jsonResponse({ data: { teams: { nodes: [{ id: "team-1" }] } } });
        }
        if (body.query.includes("issueLabels")) {
          return jsonResponse({ data: { issueLabels: { nodes: [] } } });
        }
        if (body.query.includes("issueLabelCreate")) {
          return jsonResponse({ data: { issueLabelCreate: { issueLabel: { id: "lab-new" } } } });
        }
        if (body.query.includes("issue(id:")) {
          return jsonResponse({ data: { issue: { labels: { nodes: [{ id: "keep" }] } } } });
        }
        if (body.query.includes("issueUpdate")) {
          return jsonResponse({ data: { issueUpdate: { success: true } } });
        }
        return jsonResponse({ data: {} });
      },
    });
    await linear.addLabel("APP-3", "heal-exhausted");
    const update = calls.find((call) => call.query.includes("issueUpdate"));
    assert.deepEqual(update?.variables.labelIds, ["keep", "lab-new"]);
  });

  it("uses the Cursor run result string, not the run envelope", async () => {
    const receipt = "**Verdict:** WRONG DIAGNOSIS\n\nThe calendar already filters that row.";
    assert.equal(
      cursorReceiptText(
        {
          status: "finished",
          id: "run-1",
          result: receipt,
        } as { status: string; result: string },
        [],
      ),
      receipt,
    );
    const worker = cursorWorker({
      apiKey: "k",
      log: () => undefined,
      sdk: {
        async create() {
          return {
            agentId: "agent-1",
            async send() {
              return {
                async wait() {
                  return {
                    status: "finished",
                    result: receipt,
                    git: {
                      branches: [
                        { repoUrl: "https://github.com/acme/api", branch: "cursor/qui-1" },
                      ],
                    },
                  };
                },
              };
            },
            async [Symbol.asyncDispose]() {},
          };
        },
        messages: {
          async list() {
            return [];
          },
        },
      },
    });
    const started = await worker.start({
      prompt: "ground",
      repoUrl: "https://github.com/acme/workspace",
      baseRef: "main",
    });
    const joined = await worker.join(started.runId);
    assert.equal(joined.text, receipt);
    assert.equal(joined.text.includes('"status":"finished"'), false);
    assert.equal(joined.branches?.[0]?.branch, "cursor/qui-1");
  });
});

const PRIMARY = "primary-slot-value";
const FALLBACK = "fallback-slot-value";
const BALANCE = "[usage_limit_exceeded] Your team's prepaid balance is used up";

function scriptedCursor(opts: {
  keys: string[];
  models?: ({ id: string } | undefined)[];
  onCreate: (apiKey: string) => Error | "ok";
  disposed?: { count: number };
}): CursorSdk {
  return {
    async create(options) {
      opts.keys.push(options.apiKey);
      opts.models?.push(options.model);
      const outcome = opts.onCreate(options.apiKey);
      if (outcome instanceof Error) throw outcome;
      return {
        agentId: `agent-${opts.keys.length}`,
        async send() {
          return {
            id: `run-${opts.keys.length}`,
            async wait() {
              return { status: "finished", result: "done" };
            },
          };
        },
        async [Symbol.asyncDispose]() {
          if (opts.disposed) opts.disposed.count += 1;
        },
      };
    },
    messages: {
      async list() {
        return [];
      },
    },
  };
}

async function launch(input: {
  slots: { slot: "primary" | "fallback"; apiKey: string }[];
  model?: string;
  onCreate: (apiKey: string) => Error | "ok";
}): Promise<{
  lines: string[];
  keys: string[];
  models: ({ id: string } | undefined)[];
  waits: number[];
  runId?: string;
  error?: Error;
}> {
  const lines: string[] = [];
  const keys: string[] = [];
  const models: ({ id: string } | undefined)[] = [];
  const waits: number[] = [];
  const worker = cursorWorker({
    slots: input.slots,
    model: input.model,
    log: (line) => lines.push(line),
    sleep: async (ms) => {
      waits.push(ms);
    },
    sdk: scriptedCursor({ keys, models, onCreate: input.onCreate }),
  });
  try {
    const started = await worker.start({
      prompt: "ground",
      repoUrl: "https://github.com/acme/workspace",
      baseRef: "main",
    });
    return { lines, keys, models, waits, runId: started.runId };
  } catch (error) {
    return {
      lines,
      keys,
      models,
      waits,
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

function httpStatus(status: number): Error {
  const error = new Error(`HTTP ${status}`);
  (error as Error & { status: number }).status = status;
  return error;
}

describe("cursor worker key slots", () => {
  const both = [
    { slot: "primary" as const, apiKey: PRIMARY },
    { slot: "fallback" as const, apiKey: FALLBACK },
  ];

  it("uses the primary slot when that launch succeeds", async () => {
    const result = await launch({ slots: both, onCreate: () => "ok" });
    assert.deepEqual(result.keys, [PRIMARY]);
    assert.deepEqual(result.lines, [
      CURSOR_ACCOUNT_DEFAULT_MODEL,
      "credential slot=primary endpoint=cursor-launch status=200",
    ]);
    assert.deepEqual(result.models, [undefined]);
    assert.equal(result.error, undefined);
    assert.equal(result.lines.join(" ").includes(PRIMARY), false);
    assert.equal(result.lines.join(" ").includes(FALLBACK), false);
  });

  it("retries that launch once on the fallback slot after a balance refusal", async () => {
    const result = await launch({
      slots: both,
      onCreate: (apiKey) => (apiKey === PRIMARY ? new Error(BALANCE) : "ok"),
    });
    assert.deepEqual(result.keys, [PRIMARY, FALLBACK]);
    assert.deepEqual(result.lines, [
      CURSOR_ACCOUNT_DEFAULT_MODEL,
      "credential slot=primary endpoint=cursor-launch status=0",
      "credential slot=fallback endpoint=cursor-launch status=200",
    ]);
    assert.equal(result.error, undefined);
    assert.equal(result.lines.join("\n").includes(PRIMARY), false);
    assert.equal(result.lines.join("\n").includes(FALLBACK), false);
  });

  it("fails when both slots are out of capacity", async () => {
    const result = await launch({
      slots: both,
      onCreate: () => new Error(BALANCE),
    });
    assert.deepEqual(result.keys, [PRIMARY, FALLBACK]);
    assert.match(result.error?.message ?? "", /both key slots are out of capacity/);
    assert.match(result.error?.message ?? "", /usage_limit_exceeded/);
    assert.equal(result.error?.message.includes(PRIMARY), false);
    assert.equal(result.error?.message.includes(FALLBACK), false);
    assert.deepEqual(result.lines, [
      CURSOR_ACCOUNT_DEFAULT_MODEL,
      "credential slot=primary endpoint=cursor-launch status=0",
      "credential slot=fallback endpoint=cursor-launch status=0",
    ]);
  });

  it("retries a 5xx once on the same slot and then succeeds", async () => {
    let attempts = 0;
    const result = await launch({
      slots: both,
      onCreate: () => {
        attempts += 1;
        return attempts === 1 ? httpStatus(502) : "ok";
      },
    });
    assert.equal(attempts, 2);
    assert.deepEqual(result.keys, [PRIMARY, PRIMARY]);
    assert.deepEqual(result.waits, [CURSOR_LAUNCH_RETRY_MS]);
    assert.deepEqual(result.lines, [
      CURSOR_ACCOUNT_DEFAULT_MODEL,
      "credential slot=primary endpoint=cursor-launch status=502",
      "credential slot=primary endpoint=cursor-launch status=200",
    ]);
    assert.equal(result.error, undefined);
  });

  it("uses the fallback slot after two 5xx responses on the primary slot", async () => {
    const result = await launch({
      slots: both,
      onCreate: (apiKey) => (apiKey === PRIMARY ? httpStatus(502) : "ok"),
    });
    assert.deepEqual(result.keys, [PRIMARY, PRIMARY, FALLBACK]);
    assert.deepEqual(result.waits, [CURSOR_LAUNCH_RETRY_MS]);
    assert.deepEqual(result.lines, [
      CURSOR_ACCOUNT_DEFAULT_MODEL,
      "credential slot=primary endpoint=cursor-launch status=502",
      "credential slot=primary endpoint=cursor-launch status=502",
      "credential slot=fallback endpoint=cursor-launch status=200",
    ]);
    assert.equal(result.error, undefined);
  });

  it("passes a configured model id and omits the model when it is unset", async () => {
    const configured = await launch({
      slots: both,
      model: "model-4.7",
      onCreate: () => "ok",
    });
    assert.deepEqual(configured.models, [{ id: "model-4.7" }]);
    assert.deepEqual(configured.lines, [
      "credential slot=primary endpoint=cursor-launch status=200 detail=model-4.7",
    ]);
    assert.equal(configured.lines.join("\n").includes(CURSOR_ACCOUNT_DEFAULT_MODEL), false);
    const unset = await launch({ slots: both, onCreate: () => "ok" });
    assert.deepEqual(unset.models, [undefined]);
    assert.equal(unset.lines[0], CURSOR_ACCOUNT_DEFAULT_MODEL);
  });

  it("stops on an authentication failure without the fallback slot", async () => {
    const result = await launch({
      slots: both,
      onCreate: () => new Error(`[unauthenticated] Invalid API key ${PRIMARY}`),
    });
    assert.deepEqual(result.keys, [PRIMARY]);
    assert.match(result.error?.message ?? "", /primary key slot/);
    assert.match(result.error?.message ?? "", /unauthenticated/);
    assert.equal(result.error?.message.includes(PRIMARY), false);
    assert.match(result.error?.message ?? "", /\[redacted\]/);
    assert.equal(result.lines.some((line) => line.includes("fallback")), false);
  });

  it("stops on a rate limit without the fallback slot", async () => {
    const result = await launch({
      slots: both,
      onCreate: () => new Error("[rate_limit_exceeded] Too many requests"),
    });
    assert.deepEqual(result.keys, [PRIMARY]);
    assert.match(result.error?.message ?? "", /primary key slot/);
    assert.match(result.error?.message ?? "", /rate_limit_exceeded/);
    assert.equal(result.lines.some((line) => line.includes("fallback")), false);
  });

  it("stops on a network failure without the fallback slot", async () => {
    const result = await launch({
      slots: both,
      onCreate: () => new Error("getaddrinfo ENOTFOUND api.cursor.com"),
    });
    assert.deepEqual(result.keys, [PRIMARY]);
    assert.match(result.error?.message ?? "", /primary key slot/);
    assert.match(result.error?.message ?? "", /ENOTFOUND/);
  });

  it("stays on the primary slot when no fallback is configured", async () => {
    const result = await launch({
      slots: [{ slot: "primary", apiKey: PRIMARY }],
      onCreate: () => new Error(BALANCE),
    });
    assert.deepEqual(result.keys, [PRIMARY]);
    assert.match(result.error?.message ?? "", /primary key slot/);
    assert.match(result.error?.message ?? "", /out of capacity/);
    assert.equal(/both key slots/.test(result.error?.message ?? ""), false);
  });

  it("drops a blank or duplicate fallback before the launch", () => {
    assert.deepEqual(cursorKeySlots(PRIMARY, ""), [{ slot: "primary", apiKey: PRIMARY }]);
    assert.deepEqual(cursorKeySlots(PRIMARY, PRIMARY), [{ slot: "primary", apiKey: PRIMARY }]);
    assert.deepEqual(cursorKeySlots("  ", FALLBACK), []);
  });
});
