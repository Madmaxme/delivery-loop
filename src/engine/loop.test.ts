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
  status: { intake: "Todo", dev: "Deployed to Dev", prod: "Deployed to Prod" },
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
    assert.equal(env.state(), "Deployed to Dev");
  });

  it("does not build when the verdict is not BUILDABLE", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.equal(env.merged(), false);
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

  it("leaves prod status to the pack when markStatus is false", async () => {
    const env = harness(BUILDABLE);
    let state = "Deployed to Dev";
    env.deps.tracker.setState = async (_id, next) => {
      state = next;
    };
    env.deps.pack = {
      ...env.deps.pack,
      ship: { steps: ["true"], markStatus: false },
    };
    await ship(env.deps, "API-1");
    assert.equal(state, "Deployed to Dev");
  });
});
