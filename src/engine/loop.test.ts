import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";
import { runTicket, ship, sweep } from "./loop.ts";

const pack: ProjectPack = {
  tracker: "github",
  worker: "http",
  repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main" }],
  qualityCommand: "npm test",
  qualityWorkflow: "quality",
  invariantsFile: "invariants.md",
  status: { intake: "Todo", dev: "Dev", prod: "Prod" },
  connectors: ["sentry"],
};

const invariants = "## charges-are-idempotent\n";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "1",
    identifier: "API-1",
    title: "Double charge",
    body: "The charge ran twice.",
    stateName: "Todo",
    labels: [],
    blockedBy: [],
    comments: [],
    ...overrides,
  };
}

function harness(text: string, opts?: { quality?: "success" | "failure" | "pending"; branch?: string }) {
  const comments: string[] = [];
  let state = "Todo";
  const tracker: TrackerAdapter = {
    kind: "github",
    async listIntake() {
      return [ticket()];
    },
    async get(id) {
      return ticket({ identifier: id, comments: [...comments] });
    },
    async comment(_id, body) {
      comments.push(body);
    },
    async setState(_id, next) {
      state = next;
    },
    async addLabel() {},
    async removeLabel() {},
  };
  const worker: WorkerAdapter = {
    kind: "http",
    async start() {
      return { runId: "run-1" };
    },
    async join() {
      return { status: "finished", branch: opts?.branch ?? "delivery/api-1", head: "abc", text };
    },
  };
  let merged = false;
  const forge: ForgeAdapter = {
    async openPullRequest() {
      return { number: 4, url: "https://github.com/acme/api/pull/4", headSha: "abc", branch: "delivery/api-1" };
    },
    async quality() {
      return opts?.quality ?? "success";
    },
    async squashMerge() {
      merged = true;
    },
    async dispatch() {},
  };
  return {
    comments,
    merged: () => merged,
    state: () => state,
    deps: { pack, tracker, worker, forge, invariantsMarkdown: invariants, maxQualityPolls: 1 },
  };
}

const BUILDABLE = `
**Verdict:** BUILDABLE
<!-- BUILD_PACKET
**Repos:** \`api\`
**Allowlist:** \`api/src/pay.ts\`
**Invariant:** \`charges-are-idempotent\`
**Decision:** Extend the charge handler.
**Symbols:** \`api/src/pay.ts#charge\`
**Validation:** \`npm test\`
**Stop:** One charge path remains.
BUILD_PACKET -->
`;

describe("loop", () => {
  it("lands a buildable ticket after quality is green", async () => {
    const env = harness(BUILDABLE);
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Dev");
  });

  it("does not build when the verdict is not BUILDABLE", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("cancels a wrong diagnosis and starts the agent on the workspace", async () => {
    const env = harness("**Verdict:** WRONG DIAGNOSIS\n\nThe code already does this.");
    const starts: string[] = [];
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      starts.push(input.repoUrl);
      return start(input);
    };
    env.deps.pack = {
      ...env.deps.pack,
      agent: { url: "https://github.com/acme/workspace", trunk: "main" },
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.equal(env.state(), "Canceled");
    assert.deepEqual(starts, ["https://github.com/acme/workspace"]);
    assert.equal(env.comments.some((body) => body.includes('"id":')), false);
  });

  it("moves a packet-cited needs-rescope to shaping", async () => {
    const env = harness("**Verdict:** NEEDS RESCOPE\n\n**Harness packet:** no safe default remains.");
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.equal(env.state(), "Shaping");
  });

  it("stops one ticket when a connector is missing and continues the sweep", async () => {
    const text = BUILDABLE.replace(
      "**Stop:**",
      "**Connector:** `database`\n**Stop:**",
    );
    const env = harness(text);
    const results = await sweep(env.deps);
    assert.equal(results[0]?.outcome, "missing-connector");
    assert.match(results[0]?.detail ?? "", /connector add database/);
    assert.equal(env.merged(), false);
  });

  it("skips a ticket whose blocker is not done", async () => {
    const env = harness(BUILDABLE);
    const result = await runTicket(
      env.deps,
      ticket({ blockedBy: [{ identifier: "API-2", stateName: "Todo" }] }),
    );
    assert.equal(result.outcome, "skipped-graph");
  });

  it("steals a pending lease from a finished parent and releases it", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await runTicket(
      env.deps,
      ticket({
        comments: [
          `<!-- DELIVERY_LEASE expires=${future} cursor_run=pending cursor_phase=ground -->`,
        ],
      }),
    );
    assert.equal(result.outcome, "verdict");
    assert.equal(env.comments.at(-1), "<!-- DELIVERY_LEASE released=1 -->");
  });

  it("keeps a lease whose Actions run is still live", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.githubRunActive = () => true;
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const result = await runTicket(
      env.deps,
      ticket({
        comments: [
          `<!-- DELIVERY_LEASE expires=${future} gha_run=42 cursor_run=run-9 cursor_phase=ground -->`,
        ],
      }),
    );
    assert.equal(result.outcome, "skipped-lease");
    assert.equal(env.comments.length, 0);
  });

  it("leaves prod status to the pack when markStatus is false", async () => {
    const env = harness(BUILDABLE);
    let state = "Dev";
    env.deps.tracker.setState = async (_id, next) => {
      state = next;
    };
    env.deps.pack = {
      ...env.deps.pack,
      ship: { steps: ["true"], markStatus: false },
    };
    await ship(env.deps, "API-1");
    assert.equal(state, "Dev");
  });
});
