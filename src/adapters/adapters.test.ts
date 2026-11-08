import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeGithub, probeLinearViewer } from "./canonical-path.ts";
import { githubForge } from "./forge-github.ts";
import { githubIssuesTracker, linearTracker } from "./trackers.ts";
import type { FetchLike } from "./types.ts";
import { actors, healthFetch, issue, linearPath, openerPath, readyExtension, readyMerger, readyOpener } from "../testing/canonical-fixtures.ts";
import { copilotWorker, cursorReceiptText, cursorWorker, httpWorker } from "./workers.ts";

function opener(token = "t") {
  return issue(openerPath, token);
}

function merger() {
  return readyMerger();
}

async function linearCredential(token = "k") {
  const credential = issue(linearPath, token);
  await probeLinearViewer(credential, healthFetch);
  return credential;
}

async function openedForge(fetch: FetchLike, commitActors = actors) {
  const open = opener();
  const merge = await merger();
  await probeGithub(open, healthFetch);
  await probeGithub(merge, healthFetch);
  return githubForge({ opener: open, merger: merge, fetch, commitActors });
}

function withGithubHealth(fetchImpl: FetchLike, login = "example-owner"): FetchLike {
  return async (url, init) => {
    const href = String(url);
    if (href.endsWith("/user")) return jsonResponse({ login });
    if (href.includes("/installation/repositories")) return jsonResponse({ repositories: [] });
    if (href.endsWith("/rate_limit")) return jsonResponse({ rate: {} });
    return fetchImpl(url, init);
  };
}

function withViewer(fetchImpl: FetchLike): FetchLike {
  return async (url, init) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("viewer")) return jsonResponse({ data: { viewer: { id: "v1", name: "Example Delivery" } } });
    return fetchImpl(url, init);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("adapters", () => {
  it("refuses a pull request when the token is not the commit actor", async () => {
    const calls: string[] = [];
    const open = opener("app");
    const merge = await merger();
    await probeGithub(open, healthFetch);
    await probeGithub(merge, healthFetch);
    const forge = githubForge({
      opener: open,
      merger: merge,
      commitActors: [{ login: "Madmaxme", id: "9999", repos: ["https://github.com/Madmaxme/delivery-loop"] }],
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
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
      /commit actor id/,
    );
    assert.equal(calls.some((call) => call.includes("/pulls")), false);
  });

  it("opens a pull request when the token login is the commit actor", async () => {
    const open = opener("user");
    const merge = await merger();
    await probeGithub(open, healthFetch);
    await probeGithub(merge, healthFetch);
    const forge = githubForge({
      opener: open,
      merger: merge,
      commitActors: [{ login: "Madmaxme", id: "1001", repos: ["Madmaxme/delivery-loop"] }],
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
    const forge = await openedForge(async (url, init) => {
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
    });
    const pr = await forge.openPullRequest({
      repoUrl: "https://github.com/acme/api",
      title: "API-1",
      body: "order",
      head: "delivery/api-1",
      base: "main",
    });
    assert.equal(pr.number, 9);
    const again = await openedForge(async (url, init) => {
        if (String(url).endsWith("/pulls") && init?.method === "POST") {
          return jsonResponse({ message: "exists" }, 422);
        }
        if (String(url).includes("/pulls?")) {
          return jsonResponse([
            { number: 9, html_url: "https://github.com/acme/api/pull/9", head: { sha: "abc", ref: "delivery/api-1" } },
          ]);
        }
        return jsonResponse({});
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
    const forge = await openedForge(async (url, init) => {
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
    const again = await openedForge(async (url) => {
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

  it("starts and joins a self-hosted worker", async () => {
    const worker = httpWorker({
      credential: await readyExtension("http"),
      startUrl: "https://http.example/start",
      statusUrl: "https://http.example/status",
      fetch: async (url) => {
        if (String(url).endsWith("/start")) return jsonResponse({ runId: "r1" });
        return jsonResponse({ status: "finished", branch: "b", head: "h", text: "done" });
      },
    });
    const started = await worker.start({
      prompt: "go",
      repoUrl: "https://github.com/acme/api",
      baseRef: "main",
    });
    assert.equal(started.runId, "r1");
    const joined = await worker.join("r1");
    assert.equal(joined.branch, "b");
  });

  it("starts a Copilot cloud task", async () => {
    const worker = copilotWorker({
      credential: await readyOpener(),
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
      credential: await linearCredential(),
      team: "APP",
      intakeState: "Todo",
      fetch: withViewer(async () =>
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
      ),
    });
    const tickets = await linear.listIntake();
    assert.equal(tickets[0]?.identifier, "APP-3");

    const snapshotTracker = linearTracker({
      credential: await linearCredential(),
      team: "APP",
      intakeState: "Todo",
      fetch: withViewer(async (_url, init) => {
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
      }),
    });
    const snapshot = await snapshotTracker.projectSnapshot("Billing");
    assert.equal(snapshot?.projectName, "Billing");
    assert.equal(snapshot?.issues[0]?.identifier, "APP-3");
    assert.equal(snapshot?.milestones[0]?.name, "Stage 1");

    const github = githubIssuesTracker({
      credential: await readyOpener(),
      repo: "acme/api",
      intakeLabel: "todo",
      fetch: withGithubHealth(async (url) => {
        if (String(url).includes("/comments")) return jsonResponse([]);
        return jsonResponse([
          { number: 3, title: "Fix", body: "blocked by API-1", labels: [{ name: "todo" }], state: "open" },
        ]);
      }),
    });
    const issues = await github.listIntake();
    assert.equal(issues[0]?.blockedBy[0]?.identifier, "API-1");
  });

  it("adds a Linear label and keeps labels already on the issue", async () => {
    const calls: { query: string; variables: Record<string, unknown> }[] = [];
    const linear = linearTracker({
      credential: await linearCredential(),
      team: "APP",
      intakeState: "Todo",
      fetch: withViewer(async (_url, init) => {
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
      }),
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
      credential: await readyExtension("cursor"),
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
