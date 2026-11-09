import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubForge } from "./forge-github.ts";
import { githubIssuesTracker, linearTracker } from "./trackers.ts";
import {
  copilotWorker,
  cursorKeySlots,
  cursorReceiptText,
  cursorWorker,
  httpWorker,
  type CursorSdk,
} from "./workers.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

  it("starts and joins a self-hosted worker", async () => {
    const worker = httpWorker({
      startUrl: "https://host.example/start",
      statusUrl: "https://host.example/status",
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
  onCreate: (apiKey: string) => Error | "ok";
  disposed?: { count: number };
}): CursorSdk {
  return {
    async create(options) {
      opts.keys.push(options.apiKey);
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
  onCreate: (apiKey: string) => Error | "ok";
}): Promise<{ lines: string[]; keys: string[]; runId?: string; error?: Error }> {
  const lines: string[] = [];
  const keys: string[] = [];
  const worker = cursorWorker({
    slots: input.slots,
    log: (line) => lines.push(line),
    sdk: scriptedCursor({ keys, onCreate: input.onCreate }),
  });
  try {
    const started = await worker.start({
      prompt: "ground",
      repoUrl: "https://github.com/acme/workspace",
      baseRef: "main",
    });
    return { lines, keys, runId: started.runId };
  } catch (error) {
    return { lines, keys, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

describe("cursor worker key slots", () => {
  const both = [
    { slot: "primary" as const, apiKey: PRIMARY },
    { slot: "fallback" as const, apiKey: FALLBACK },
  ];

  it("uses the primary slot when that launch succeeds", async () => {
    const result = await launch({ slots: both, onCreate: () => "ok" });
    assert.deepEqual(result.keys, [PRIMARY]);
    assert.deepEqual(result.lines, ["worker key slot=primary"]);
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
      "worker key slot=primary refused for capacity",
      "worker key slot=fallback",
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
      "worker key slot=primary refused for capacity",
      "worker key slot=fallback refused for capacity",
    ]);
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
