import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { DeliveryState, ForgeAdapter, LinearProgramTracker, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.ts";
import type { ProjectPack, PromotionStage } from "../schema/pack.ts";
import type { CompileProgramResult } from "./linear-harness-policy.ts";
import { proofLinesFor } from "../../scripts/journey-proof.mjs";
import { auditEligibility, candidateFetchEnvironment, ciFixLimit, formatTicketProgress, repoCheckoutDir, runTicket, ship, sortByPack, sweep, sweepNeedsAnotherPage, type LoopDeps, type StageVerifyInput } from "./loop.ts";
import { classifyQualityCause } from "./quality-cause.ts";

const pack: ProjectPack = {
  schemaVersion: 2,
  tracker: "github",
  worker: "http",
  repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main" }],
  qualityCommand: "npm test",
  qualityWorkflow: "quality",
  invariantsFile: "invariants.md",
  eligibility: { mode: "none" },
  landingStrategy: "pull-request",
  promotionStages: [],
  status: { intake: "Todo", complete: "Dev Complete" },
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
    issueType: null,
    assigneeId: null,
    fieldValues: {},
    attachments: [],
    criteriaRevision: "a".repeat(64),
    blockedBy: [],
    comments: [],
    ...overrides,
  };
}

function harness(text: string, opts?: { quality?: "success" | "failure" | "pending"; branch?: string }) {
  const comments: string[] = [];
  const labels: string[] = [];
  const statusRevisions: string[] = [];
  let state = "Todo";
  let deliveryState: DeliveryState = { schemaVersion: 2, markers: [], stageReceipts: [] };
  const tracker: TrackerAdapter = {
    kind: "github",
    async listIntake() {
      return [ticket({ stateName: state })];
    },
    async get(id) {
      return ticket({ identifier: id, stateName: state, comments: comments.map((body) => ({ body })) });
    },
    async comment(_id, body) {
      comments.push(body);
    },
    async setState(_id, next, expectedCriteriaRevision) {
      statusRevisions.push(expectedCriteriaRevision);
      state = next;
    },
    async addLabel(_id, label) {
      labels.push(label);
    },
    async removeLabel() {},
    stateStore: {
      async readDeliveryState() {
        return deliveryState;
      },
      async writeDeliveryState(_id, next) {
        deliveryState = next;
      },
    },
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
    async directLand({ expectedHeadSha }) { return expectedHeadSha; },
    async openPullRequest() {
      return {
        number: 4,
        url: "https://github.com/acme/api/pull/4",
        headSha: "abc",
        branch: "delivery/api-1",
        created: true,
      };
    },
    async quality() {
      const state = opts?.quality ?? "success";
      return {
        state,
        detail:
          state === "pending"
            ? "quality in_progress https://example.test/run"
            : `quality ${state}`,
      };
    },
    async requestQualityRun() {
      return null;
    },
    async mergeability() {
      return { state: "clean", headSha: "abc" };
    },
    async updateBranch() {},
    async compare() {
      return "ahead";
    },
    async squashMerge() {
      merged = true;
      return "trunk";
    },
    async dispatch() {},
  };
  return {
    comments,
    labels,
    merged: () => merged,
    state: () => state,
    deliveryState: () => deliveryState,
    statusRevisions,
    deps: {
      pack,
      tracker,
      worker,
      forge,
      invariantsMarkdown: invariants,
      maxQualityPolls: 1,
      report() {},
    },
  };
}

async function seedLandResume(
  env: { deps: { tracker: TrackerAdapter } },
  hold: boolean,
  rows: { repo: string; sha: string }[],
  ground = BUILDABLE,
  receipt = "",
): Promise<void> {
  const state = await env.deps.tracker.stateStore.readDeliveryState("API-1");
  const createdAt = new Date(0).toISOString();
  await env.deps.tracker.stateStore.writeDeliveryState("API-1", {
    ...state,
    markers: [
      ...state.markers.filter((marker) => marker.kind !== "work-order" && marker.kind !== "land-resume"),
      { kind: "work-order", body: JSON.stringify({ ground, receipt, criteriaRevision: ticket().criteriaRevision }), createdAt },
      { kind: "land-resume", body: JSON.stringify({ kind: "wait", hold, rows, declared: ground, receipt }), createdAt },
    ],
  });
}

async function seedWorkOrder(
  env: { deps: { tracker: TrackerAdapter } },
  ground: string,
  receipt = "",
): Promise<void> {
  const state = await env.deps.tracker.stateStore.readDeliveryState("API-1");
  await env.deps.tracker.stateStore.writeDeliveryState("API-1", {
    ...state,
    markers: [
      ...state.markers.filter((marker) => marker.kind !== "work-order"),
      { kind: "work-order", body: JSON.stringify({ ground, receipt, criteriaRevision: ticket().criteriaRevision }), createdAt: new Date(0).toISOString() },
    ],
  });
}

const MERGED_SHA = "m".repeat(40);
const OPEN_SHA = "o".repeat(40);

function audit(repos: string, journey = "**Journey evidence:** not-applicable"): string {
  return BUILDABLE.replace("**Repos:** `api`", `**Repos:** \`${repos}\``).replace(
    "**Journey evidence:** not-applicable",
    journey,
  );
}

function listedPull(input: {
  number: number;
  branch: string;
  base: string;
  state: "open" | "merged";
  headSha?: string;
}) {
  return {
    number: input.number,
    url: `https://github.com/acme/repo/pull/${input.number}`,
    headSha: input.headSha ?? "h".repeat(40),
    branch: input.branch,
    base: input.base,
    state: input.state,
    mergedSha: input.state === "merged" ? MERGED_SHA : null,
  };
}

function surfaceBoard(env: { deps: LoopDeps }) {
  const api = { name: "api", url: "https://github.com/acme/api", trunk: "main" };
  const mobile = { name: "mobile", url: "https://github.com/acme/mobile", trunk: "main" };
  env.deps.pack = {
    ...pack,
    repos: [api, mobile],
    branchTemplate: "cursor/{issue}-{repo}",
  };
  env.deps.lookupHead = () => MERGED_SHA;
  env.deps.sleep = async () => {};
  return {
    api,
    mobile,
    watch(events: string[]) {
      const setState = env.deps.tracker.setState.bind(env.deps.tracker);
      env.deps.tracker.setState = async (id, next, revision) => {
        events.push(`state:${next}`);
        await setState(id, next, revision);
      };
    },
  };
}

const BUILDABLE = `
**Verdict:** BUILDABLE
**Prior request:** none
**Outside grant:** none
**Journey evidence:** not-applicable
<!-- BUILD_PACKET
**Repos:** \`api\`
**Allowlist:** \`api/src/pay.ts\`
**Invariant:** \`charges-are-idempotent\`
**Decision:** Extend the charge handler.
**Symbols:** \`api/src/pay.ts#charge\`
**Validation:** \`npm test\`
**Stop:** One charge path remains.
## Acceptance criteria
| ID | Text | Source |
| --- | --- | --- |
| single-charge | Preserve one charge path. | Issue description |
BUILD_PACKET -->
`;

function receiptFor(input: {
  stageId: string;
  target: string;
  criteriaRevision: string;
  deployed: { repo: string; sha: string }[];
  outcome?: "passed" | "blocked" | "parked";
  reason?: string;
}): string {
  const outcome = input.outcome ?? "passed";
  return JSON.stringify({
    stageId: input.stageId,
    target: input.target,
    outcome,
    reason: input.reason ?? "",
    criteriaRevision: input.criteriaRevision,
    deployed: input.deployed,
    criteria: [{
      id: "single-charge",
      outcome: outcome === "passed" ? "verified" : "blocked",
      evidence: outcome === "passed" ? ["verified on the deployed build"] : [],
    }],
  });
}

function commitCheckout(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  spawnSync("git", ["init", dir], { encoding: "utf8" });
  git("config", "user.email", "dev@example.test");
  git("config", "user.name", "Dev");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git("add", ".");
  const committed = git("commit", "-m", "init");
  if (committed.status !== 0) throw new Error(committed.stderr || "git commit failed");
  git("branch", "-M", "main");
  return git("rev-parse", "HEAD").stdout.trim();
}

function routeGround(): string {
  return BUILDABLE.replace(
    "**Journey evidence:** not-applicable",
    "**Journey evidence:** recorded\n**Journey proof:** `api/e2e/signup.spec.ts`",
  );
}

describe("loop", () => {
  it("runs policy with normalized input but no mutation credentials before the lease and worker", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.pack = {
      ...pack,
      eligibility: { mode: "command", command: "node policy.mjs" },
      workerKeys: { primary: "CURSOR_API_KEY", fallback: "CURSOR_API_KEY_FALLBACK" },
      jira: { apiBaseUrl: "https://jira.example", authHeaderEnv: "JIRA_AUTH_HEADER", intakeJql: "project = APP", approvalFieldId: "customfield_1" },
    };
    const secretNames = ["GH_TOKEN", "GITHUB_TOKEN", "LINEAR_API_KEY", "JIRA_AUTH_HEADER", "CURSOR_API_KEY", "CURSOR_API_KEY_FALLBACK", "WORKER_HTTP_TOKEN", "AWS_ACCESS_KEY_ID"];
    const previous = new Map(secretNames.map((name) => [name, process.env[name]]));
    for (const name of secretNames) process.env[name] = "must-not-leak";
    try {
      const events: string[] = [];
      env.deps.runPackCommand = (command, _cwd, stdin, childEnv) => {
        events.push("policy");
        assert.equal(command, "node policy.mjs");
        assert.deepEqual(JSON.parse(stdin), ticket());
        for (const name of secretNames) assert.equal(childEnv?.[name], undefined);
        assert.ok(childEnv?.PATH);
        return {
          status: 0,
          stdout: JSON.stringify({ outcome: "eligible", reasonCode: "approved", reason: "approved" }),
        };
      };
      const writeState = env.deps.tracker.stateStore.writeDeliveryState.bind(env.deps.tracker.stateStore);
      env.deps.tracker.stateStore.writeDeliveryState = async (id, state) => {
        if (state.markers.some((marker) => marker.kind === "delivery-lease")) events.push("lease");
        await writeState(id, state);
      };
      const start = env.deps.worker.start.bind(env.deps.worker);
      env.deps.worker.start = async (input) => {
        events.push("worker");
        return start(input);
      };
      const result = await runTicket(env.deps, ticket());
      assert.equal(result.outcome, "verdict");
      assert.deepEqual(events.slice(0, 3), ["policy", "lease", "worker"]);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("does not lease or start a worker for blocked and complete decisions", async () => {
    for (const decision of [
      { outcome: "blocked", reasonCode: "off-lane", reason: "ticket is off lane" },
      { outcome: "already-complete", reasonCode: "done", reason: "ticket is complete" },
    ]) {
      const env = harness("**Verdict:** NEEDS DIAGNOSIS");
      env.deps.pack = { ...pack, eligibility: { mode: "command", command: "policy" } };
      env.deps.runPackCommand = () => ({ status: 0, stdout: JSON.stringify(decision) });
      let starts = 0;
      env.deps.worker.start = async () => {
        starts += 1;
        return { runId: "run-1" };
      };

      const result = await runTicket(env.deps, ticket());
      assert.equal(result.outcome, decision.outcome);
      assert.equal(result.reasonCode, decision.reasonCode);
      assert.equal(starts, 0);
      assert.deepEqual(env.comments, []);
    }
  });

  it("fails closed on malformed, nonzero, or reasonless policy output", async () => {
    const failures = [
      { status: 0, stdout: "not json" },
      { status: 2, stdout: JSON.stringify({ outcome: "eligible", reasonCode: "ok", reason: "ok" }) },
      { status: 0, stdout: JSON.stringify({ outcome: "eligible", reasonCode: "ok" }) },
      { status: 0, stdout: JSON.stringify({ outcome: "eligible", reasonCode: "ok", reason: "ok", extra: true }) },
    ];
    for (const failure of failures) {
      const env = harness("**Verdict:** NEEDS DIAGNOSIS");
      env.deps.pack = { ...pack, eligibility: { mode: "command", command: "policy" } };
      env.deps.runPackCommand = () => failure;
      let starts = 0;
      env.deps.worker.start = async () => {
        starts += 1;
        return { runId: "run-1" };
      };

      const result = await runTicket(env.deps, ticket());
      assert.equal(result.outcome, "policy-error");
      assert.equal(result.reasonCode, "policy-error");
      assert.equal(starts, 0);
      assert.deepEqual(env.comments, []);
    }
  });

  it("audits intake without calling tracker writes, state, or workers", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.pack = { ...pack, eligibility: { mode: "command", command: "policy" } };
    const tickets = [ticket(), ticket({ id: "2", identifier: "API-2" })];
    let intakeReads = 0;
    let policyRuns = 0;
    let trackerReads = 0;
    let trackerWrites = 0;
    let workerStarts = 0;
    let stateStoreCalls = 0;
    env.deps.tracker.listIntake = async () => {
      intakeReads += 1;
      return tickets;
    };
    env.deps.tracker.get = async (identifier) => {
      trackerReads += 1;
      return ticket({ identifier });
    };
    env.deps.tracker.comment = async () => { trackerWrites += 1; };
    env.deps.tracker.setState = async () => { trackerWrites += 1; };
    env.deps.tracker.addLabel = async () => { trackerWrites += 1; };
    env.deps.tracker.removeLabel = async () => { trackerWrites += 1; };
    env.deps.tracker.stateStore.readDeliveryState = async () => {
      stateStoreCalls += 1;
      return { schemaVersion: 2, markers: [], stageReceipts: [] };
    };
    env.deps.tracker.stateStore.writeDeliveryState = async () => { stateStoreCalls += 1; };
    env.deps.worker.start = async () => {
      workerStarts += 1;
      return { runId: "run-1" };
    };
    env.deps.runPackCommand = (_command: string, _cwd: string, stdin: string) => {
      policyRuns += 1;
      const identifier = (JSON.parse(stdin) as Ticket).identifier;
      const result = identifier === "API-1"
        ? { outcome: "eligible", reasonCode: "ok", reason: "ready" }
        : { outcome: "blocked", reasonCode: "off-lane", reason: "off lane" };
      return { status: 0, stdout: JSON.stringify(result) };
    };

    const results = await auditEligibility({
      pack: env.deps.pack,
      tracker: env.deps.tracker,
      runPackCommand: env.deps.runPackCommand,
    });
    assert.deepEqual(results, [
      { identifier: "API-1", outcome: "eligible", reasonCode: "ok", reason: "ready" },
      { identifier: "API-2", outcome: "blocked", reasonCode: "off-lane", reason: "off lane" },
    ]);
    assert.equal(intakeReads, 1);
    assert.equal(policyRuns, 2);
    assert.equal(trackerReads, 0);
    assert.equal(trackerWrites, 0);
    assert.equal(stateStoreCalls, 0);
    assert.equal(workerStarts, 0);
  });

  it("treats explicit mode none as eligible without running a command", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.pack = { ...pack, eligibility: { mode: "none" } };
    env.deps.tracker.listIntake = async () => [ticket()];
    let commands = 0;
    env.deps.runPackCommand = () => {
      commands += 1;
      return { status: 1, stdout: "" };
    };

    const results = await auditEligibility(env.deps);
    assert.deepEqual(results, [{
      identifier: "API-1",
      outcome: "eligible",
      reasonCode: "explicit-none",
      reason: "Eligibility policy is explicitly disabled by the project pack.",
    }]);
    assert.equal(commands, 0);
  });
  it("uses the checkout root for the agent repo and a subdirectory for the others", () => {
    const home = { name: "workspace", url: "https://github.com/acme/workspace", trunk: "main" };
    const child = { name: "api", url: "https://github.com/acme/api", trunk: "main" };
    const board = { ...pack, agent: { url: home.url, trunk: "main" }, repos: [home, child] };
    assert.equal(repoCheckoutDir("/work", home, board), "/work");
    assert.equal(repoCheckoutDir("/work", child, board), join("/work", "api"));
  });

  it("sends the install's prompt files and does not name a project's prefixes", async () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-loop-"));
    writeFileSync(join(root, "ground.md"), "INSTALL GROUND DOC");
    writeFileSync(join(root, "build.md"), "INSTALL BUILD DOC");
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.cwd = root;
    env.deps.pack = {
      ...pack,
      prompts: { ground: ["ground.md"], build: ["build.md"] },
      invariantHeadings: [],
    };
    let prompt = "";
    env.deps.worker.start = async (input) => {
      prompt = input.prompt;
      return { runId: "run-1" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.match(prompt, /INSTALL GROUND DOC/);
    assert.doesNotMatch(prompt, /INSTALL BUILD DOC/);
    assert.match(prompt, /prefix\/slug/);
    assert.match(prompt, /every caller uses that owner/);
    assert.match(prompt, /Prior request/);
    assert.match(prompt, /Normalize every acceptance criterion into one table/);
    assert.match(prompt, /Build and stage verification reuse the same IDs and text/);
    assert.match(prompt, /Journey evidence/);
    assert.match(prompt, /Land repos: api/);
    assert.match(prompt, /directory the agent was started in is not a land repo/);
    assert.match(prompt, /The install owns the concrete proof/);
    assert.ok(
      prompt.indexOf("The install owns the concrete proof") < prompt.indexOf("INSTALL GROUND DOC"),
    );
  });

  it("runs the quality command in the checkout instead of a workflow", async () => {
    const env = harness(BUILDABLE);
    let workflow = false;
    env.deps.forge.quality = async () => {
      workflow = true;
      return { state: "failure", detail: "workflow should not be polled" };
    };
    env.deps.pack = { ...pack, check: "command", runner: "local", forge: "git" };
    let ran = "";
    env.deps.runCommand = (command) => {
      ran = command;
      return { status: 0 };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(ran, "npm test");
    assert.equal(workflow, false);
    assert.equal(env.merged(), true);
    assert.equal(env.comments.some((body) => body.includes("Extend the charge handler.")), true);
  });

  it("stops the land when the quality command fails", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 1;
    env.deps.lookupHead = () => null;
    env.deps.pack = { ...pack, check: "command", runner: "local" };
    env.deps.runCommand = () => ({ status: 1 });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /next page resumes/);
    assert.equal(sweepNeedsAnotherPage([result]), true);
    assert.equal(env.merged(), false);
  });

  it("resolves a conflict on the same branch and merges", async () => {
    const env = harness(BUILDABLE);
    env.deps.sleep = async () => {};
    let moved = false;
    env.deps.lookupHead = () => (moved ? "def" : "abc");
    let reads = 0;
    env.deps.forge.mergeability = async () => {
      reads += 1;
      if (reads === 1) return { state: "conflict", headSha: "abc" };
      return { state: "clean", headSha: "def" };
    };
    let conflicts = 0;
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      if (input.prompt.includes("Fix that owner") && input.prompt.includes("conflicts with")) {
        conflicts += 1;
        moved = true;
      }
      return start(input);
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.equal(conflicts, 1);
    assert.equal(env.deps.pageControl?.stop, true);
    assert.equal(env.merged(), false);
  });

  it("resumes a conflict on the next page when this page's budget is spent", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 1;
    env.deps.sleep = async () => {};
    env.deps.forge.mergeability = async () => ({ state: "conflict", headSha: "abc" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /next page resumes/);
    assert.equal(sweepNeedsAnotherPage([result]), true);
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("updates a behind branch and waits for quality on the new head", async () => {
    const env = harness(BUILDABLE);
    env.deps.sleep = async () => {};
    let reads = 0;
    env.deps.forge.mergeability = async () => {
      reads += 1;
      if (reads === 1) return { state: "behind", headSha: "abc" };
      return { state: "clean", headSha: "def" };
    };
    let updated = false;
    env.deps.forge.updateBranch = async () => {
      updated = true;
    };
    const shas: string[] = [];
    env.deps.forge.quality = async (input) => {
      shas.push(input.headSha);
      return { state: "success", detail: "quality success" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(updated, true);
    assert.ok(shas.includes("def"));
    assert.equal(env.merged(), true);
  });

  it("pauses the ticket when the merge is refused", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 1;
    env.deps.forge.squashMerge = async () => {
      throw new Error(
        'GitHub /repos/acme/api/pulls/4/merge failed: 405 {"message":"Pull Request has merge conflicts"}',
      );
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /next page resumes/);
    assert.equal(sweepNeedsAnotherPage([result]), true);
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("stops the page after a refused merge edits the runner", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 1;
    env.deps.tracker.listIntake = async () => [ticket(), ticket({ identifier: "API-2", id: "2" })];
    let opened = 0;
    env.deps.forge.openPullRequest = async (input) => {
      opened += 1;
      return {
        number: opened,
        url: `https://github.com/acme/api/pull/${opened}`,
        headSha: "abc",
        branch: input.head,
        created: true,
      };
    };
    let merged = 0;
    env.deps.forge.squashMerge = async (input) => {
      if (input.number === 1) {
        throw new Error("405 Pull Request has merge conflicts");
      }
      merged += 1;
      return "trunk";
    };
    const results = await sweep(env.deps);
    assert.deepEqual(
      results.map((row) => row.outcome),
      ["land-blocked"],
    );
    assert.equal(env.deps.pageControl?.stop, true);
    assert.equal(merged, 0);
    assert.equal(sweepNeedsAnotherPage(results), true);
  });

  it("probes configured credentials once at the start of a sweep", async () => {
    const env = harness(BUILDABLE);
    let probes = 0;
    env.deps.forge.probeCredentials = async () => {
      probes += 1;
    };
    env.deps.tracker.listIntake = async () => [];
    await sweep(env.deps);
    assert.equal(probes, 1);
  });

  it("runs a dependent in the same sweep after its blocker lands", async () => {
    const env = harness(BUILDABLE);
    let reads = 0;
    env.deps.tracker.listIntake = async () => {
      reads += 1;
      const blocker = ticket({ identifier: "API-1" });
      const waiting = ticket({
        identifier: "API-2",
        id: "2",
        blockedBy: [{ identifier: "API-1", stateName: reads === 1 ? "Todo" : "Dev Complete" }],
      });
      return reads === 1 ? [waiting, blocker] : [waiting];
    };
    const results = await sweep(env.deps);
    assert.deepEqual(
      results.map((row) => `${row.identifier}:${row.outcome}`),
      ["API-2:skipped-graph", "API-1:landed", "API-2:landed"],
    );
    assert.ok(reads >= 2);
  });

  it("puts universal conduct ahead of the install build doc", async () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-loop-"));
    writeFileSync(join(root, "build.md"), "INSTALL BUILD DOC");
    const env = harness(BUILDABLE);
    env.deps.cwd = root;
    env.deps.pack = { ...pack, prompts: { build: ["build.md"] } };
    const prompts: string[] = [];
    env.deps.worker.start = async (input) => {
      prompts.push(input.prompt);
      return { runId: "run-1" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    const build = prompts.find((text) => text.includes("INSTALL BUILD DOC"));
    assert.ok(build);
    assert.match(build, /Acceptance matrix for implementation/);
    assert.match(build, /\| single-charge \| Preserve one charge path\. \| Issue description \|/);
    assert.match(build, /The install owns the concrete proof/);
    assert.ok(build.indexOf("The install owns the concrete proof") < build.indexOf("INSTALL BUILD DOC"));
  });

  it("marks comments before the latest handoff as historical and includes the program", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    const program: CompileProgramResult = {
      warnings: [],
      states: { "API-1": "Todo", "API-2": "Dev Complete" },
      program: {
        id: "billing",
        spec: "https://example.test/project",
        projectName: "Billing",
        slices: [
          {
            id: "stage-1",
            title: "Stage 1",
            afkTo: "complete",
            intake: "auto",
            park: [],
            issues: [
              { id: "API-1", blockedBy: [] },
              { id: "API-2", blockedBy: ["API-1"] },
            ],
          },
        ],
      },
    };
    env.deps.program = program;
    let prompt = "";
    env.deps.worker.start = async (input) => {
      prompt = input.prompt;
      return { runId: "run-1" };
    };
    await runTicket(
      env.deps,
      ticket({
        comments: [
          { createdAt: "2025-12-01T00:00:00Z", body: "OLD PACKET from a canceled sweep" },
          {
            createdAt: "2026-01-01T00:00:00Z",
            body: "<!-- GROUNDING_HANDOFF\nVERDICT: BUILDABLE\nGROUNDING_HANDOFF -->",
          },
          { createdAt: "2026-02-01T00:00:00Z", body: "Please look again." },
        ],
      }),
    );
    assert.match(prompt, /\[HISTORICAL\] 2025-12-01T00:00:00Z/);
    assert.match(prompt, /\[CURRENT\] 2026-01-01T00:00:00Z/);
    assert.match(prompt, /\[CURRENT\] 2026-02-01T00:00:00Z/);
    assert.match(prompt, /## Delivery program \(full project\)/);
    assert.match(prompt, /API-2/);
    assert.match(prompt, /\*\*Program graph:\*\*/);
  });

  it("lands a branch the install named when it is already on origin", async () => {
    const env = harness(BUILDABLE, { branch: "" });
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null);
    let builds = 0;
    env.deps.worker.start = async (input) => {
      if (input.prompt.includes("Push these branches")) builds += 1;
      return { runId: "run-1" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(builds, 0);
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
  });

  it("waits out a pending quality check and then merges", async () => {
    const env = harness(BUILDABLE);
    const seen = ["pending", "success"] as const;
    let n = 0;
    env.deps.forge.quality = async () => {
      const state = seen[Math.min(n++, seen.length - 1)];
      return {
        state,
        detail:
          state === "pending"
            ? "quality in_progress https://example.test/run"
            : "quality success",
      };
    };
    env.deps.maxQualityPolls = 4;
    env.deps.qualityPollMs = 1;
    env.deps.sleep = async () => {};
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(n, 3);
    assert.equal(sweepNeedsAnotherPage([result]), false);
  });

  it("hands a still-pending quality check to the next page", async () => {
    const env = harness(BUILDABLE, { quality: "pending" });
    let healing = false;
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      healing = input.prompt.includes("Fix that owner");
      return start(input);
    };
    env.deps.worker.join = async () => ({
      status: "finished",
      branch: "delivery/api-1",
      head: "abc",
      text: healing ? "**Heal:** wait" : BUILDABLE,
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "quality-pending");
    assert.equal(env.comments.some((body) => /still running/.test(body)), true);
    assert.equal(env.merged(), false);
    assert.equal(sweepNeedsAnotherPage([result]), true);
  });

  it("fixes a red landing on the same branch and does not rebuild from trunk", async () => {
    const env = harness(BUILDABLE, { quality: "failure" });
    env.deps.ciFixMax = 1;
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null);
    const prompts: string[] = [];
    env.deps.worker.start = async (input) => {
      prompts.push(input.prompt);
      return { runId: "run-1" };
    };
    const result = await runTicket(env.deps, ticket());
    const fix = prompts.find((text) => text.includes("Fix that owner"));
    assert.ok(fix);
    assert.match(fix ?? "", /cursor\/api-1-api/);
    assert.equal(prompts.some((text) => text.includes("Push these branches")), false);
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /next page resumes/);
    assert.equal(env.merged(), false);
  });

  it("merges after a quality fix pushes a new head", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 2;
    let head = "abc";
    env.deps.lookupHead = () => head;
    env.deps.forge.mergeability = async () => ({ state: "clean", headSha: "" });
    env.deps.forge.quality = async (input) => {
      const state = input.headSha === "def" || input.headSha === "trunk" ? "success" : "failure";
      return { state, detail: `quality ${state}` };
    };
    env.deps.worker.start = async (input) => {
      if (input.prompt.includes("Fix that owner")) head = "def";
      return { runId: "run-1" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.equal(env.deps.pageControl?.stop, true);
    assert.equal(env.merged(), false);
  });

  it("keeps a running check on the install branch for the next page", async () => {
    const env = harness(BUILDABLE, { quality: "pending" });
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null);
    let builds = 0;
    let healing = false;
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      healing = input.prompt.includes("Fix that owner");
      if (input.prompt.includes("Push these branches")) builds += 1;
      return start(input);
    };
    env.deps.worker.join = async () => ({
      status: "finished",
      branch: "delivery/api-1",
      head: "abc",
      text: healing ? "**Heal:** wait" : BUILDABLE,
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(builds, 0);
    assert.equal(result.outcome, "quality-pending");
    assert.equal(env.comments.some((body) => /still running/.test(body)), true);
  });

  it("requests a workflow run when an existing branch never started quality", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null);
    env.deps.qualityNoRunMs = 0;
    env.deps.maxQualityPolls = 4;
    env.deps.qualityPollMs = 1;
    env.deps.sleep = async () => {};
    let builds = 0;
    env.deps.worker.start = async (input) => {
      if (input.prompt.includes("Push these branches")) builds += 1;
      return { runId: "run-1" };
    };
    env.deps.forge.openPullRequest = async () => ({
      number: 4,
      url: "https://github.com/acme/api/pull/4",
      headSha: "abc1234",
      branch: "cursor/api-1-api",
      created: false,
    });
    env.deps.forge.quality = async ({ headSha }) =>
      headSha === "abc1234"
        ? {
            state: "pending",
            detail: "no Actions runs yet for abc1234",
            committedAt: "2020-01-01T00:00:00.000Z",
          }
        : { state: "success", detail: "quality success" };
    env.deps.forge.requestQualityRun = async () => "def5678";
    const result = await runTicket(env.deps, ticket());
    assert.equal(builds, 0);
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
  });

  it("stops when a missing quality run was already requested", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null);
    env.deps.qualityNoRunMs = 0;
    env.deps.forge.openPullRequest = async () => ({
      number: 4,
      url: "https://github.com/acme/api/pull/4",
      headSha: "abc1234",
      branch: "cursor/api-1-api",
      created: false,
    });
    env.deps.forge.quality = async () => ({
      state: "pending",
      detail: "no Actions runs yet for abc1234",
      committedAt: "2020-01-01T00:00:00.000Z",
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.equal(env.deps.pageControl?.stop, true);
    assert.equal(sweepNeedsAnotherPage([result]), true);
    assert.equal(env.merged(), false);
  });

  it("lands owned code and holds the ticket when the grant is still outside the repo", async () => {
    const env = harness(BUILDABLE.replace("**Outside grant:** none", "**Outside grant:** open"));
    env.deps.pack = { ...pack, status: { ...pack.status, hold: "Waiting" } };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Waiting");
  });

  it("stays in intake and names the land repos when the handoff names the checkout", async () => {
    const env = harness(BUILDABLE.replace("**Repos:** `api`", "**Repos:** `workspace`"));
    env.deps.pack = {
      ...pack,
      agent: { url: "https://github.com/acme/workspace", trunk: "main" },
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "repo workspace is not in the pack");
    assert.equal(env.state(), "Todo");
    assert.equal(env.merged(), false);
    assert.match(env.comments.join("\n"), /`workspace`/);
    assert.match(env.comments.join("\n"), /Land repos are `api`/);
  });

  it("tells ground that the checkout is not a land repo", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.pack = {
      ...pack,
      agent: { url: "https://github.com/acme/workspace", trunk: "main" },
    };
    let prompt = "";
    env.deps.worker.start = async (input) => {
      prompt = input.prompt;
      return { runId: "run-1" };
    };
    await runTicket(env.deps, ticket());
    assert.match(prompt, /The checkout `workspace` is where this agent starts/);
    assert.match(prompt, /Land repos: api/);
  });

  it("lands when ask names symbols and records the request as kept", async () => {
    const env = harness(BUILDABLE.replace("**Prior request:** none", "**Prior request:** ask"));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
    assert.match(env.comments.join("\n"), /\*\*Prior request:\*\* kept/);
  });

  it("closes an ask with no symbols as already done", async () => {
    const env = harness(
      BUILDABLE.replace("**Prior request:** none", "**Prior request:** ask").replace(
        "**Symbols:** `api/src/pay.ts#charge`",
        "**Symbols:**",
      ),
    );
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.equal(result.detail, "prior-request-kept");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Canceled");
  });

  it("stays in intake when replaced names no ticket", async () => {
    const env = harness(BUILDABLE.replace("**Prior request:** none", "**Prior request:** replaced"));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "prior-request-replaced");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("lands when replaced names a ticket", async () => {
    const env = harness(BUILDABLE.replace("**Prior request:** none", "**Prior request:** replaced ACME-100"));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), "Dev Complete");
  });

  it("stays in intake when a buildable handoff omits the prior request line", async () => {
    const env = harness(BUILDABLE.replace("**Prior request:** none\n", ""));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "prior-request-missing");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("stays in intake when a buildable handoff omits the journey line", async () => {
    const env = harness(BUILDABLE.replace("**Journey evidence:** not-applicable\n", ""));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "journey-missing");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("stays in intake when journey evidence is blocked", async () => {
    const env = harness(BUILDABLE.replace("**Journey evidence:** not-applicable", "**Journey evidence:** blocked"));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "journey-blocked");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("marks completion when the recording URL is in the build receipt", async () => {
    const url = "https://example.test/artifacts/signup.mp4";
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      `**Journey evidence:** recorded\n**Journey proof:** \`${url}\``,
    );
    const env = harness(ground);
    let joins = 0;
    env.deps.worker.join = async () => {
      joins += 1;
      const text = joins === 1 ? ground : `**Journey evidence:** recorded\n**Journey proof:** \`${url}\``;
      return { status: "finished", branch: "delivery/api-1", head: "abc", text };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Dev Complete");
  });

  it("leaves a recorded journey in intake when the build receipt omits the recording URL", async () => {
    const url = "https://example.test/artifacts/signup.mp4";
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      `**Journey evidence:** recorded\n**Journey proof:** \`${url}\``,
    );
    const env = harness(ground);
    let joins = 0;
    env.deps.worker.join = async () => {
      joins += 1;
      const text = joins === 1 ? ground : "**Journey evidence:** recorded\nThe journey was walked.";
      return { status: "finished", branch: "delivery/api-1", head: "abc", text };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "journey-missing");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Todo");
    assert.match(env.comments.join("\n"), /recording URL in the build receipt/);
    assert.equal(env.comments.some((body) => /LAND_WAIT|JOURNEY_RECEIPT|PROOF_ATTEMPT/.test(body)), false);
  });

  it("marks completion when the route test is on the merge commit", async () => {
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      "**Journey evidence:** recorded\n**Journey proof:** `api/integration_test/signup_route_test.dart`",
    );
    const env = harness(ground);
    env.deps.journeyFileAt = ({ repo, ref, path }) =>
      repo === "api" && ref === "trunk" && path === "integration_test/signup_route_test.dart";
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), "Dev Complete");
  });

  it("leaves the ticket in intake when the route test is not on the merge commit", async () => {
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      "**Journey evidence:** recorded\n**Journey proof:** `api/integration_test/signup_route_test.dart`",
    );
    const env = harness(ground);
    env.deps.journeyFileAt = () => false;
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "journey-missing");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Todo");
  });

  it("tells the build worker to publish the journey URL and omit only the proof prefix", async () => {
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      "**Journey evidence:** recorded",
    );
    const env = harness(ground);
    const prompts: string[] = [];
    env.deps.worker.start = async (input) => {
      prompts.push(input.prompt);
      return { runId: "run-1" };
    };
    env.deps.worker.join = async () => ({
      status: "finished" as const,
      branch: "delivery/api-1",
      head: "abc",
      text: prompts.length < 2 ? ground : "Walked `https://example.test/artifacts/signup.png`",
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "journey-missing");
    const build = prompts[1] ?? "";
    assert.match(build, /screenshot or a short video of the done state/);
    assert.match(build, /\/artifacts\//);
    assert.match(build, /Put that raw URL in backticks in BUILD_HANDOFF/);
    assert.match(build, /omit only the \*\*Journey proof:\*\* prefix/i);
    assert.match(build, /non-mutating view or test data/);
    assert.doesNotMatch(build, /real booking/);
  });

  it("blocks missing post-land journey proof without starting an extra worker", async () => {
    const ground = audit("api", "**Journey evidence:** recorded");
    const env = harness(ground);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: `run-${starts}` };
    };

    const result = await runTicket(env.deps, ticket());

    assert.equal(result.outcome, "journey-missing");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Todo");
    assert.equal(starts, 2);
    assert.equal(env.deliveryState().markers.some((marker) => marker.kind === "proof-receipt"), false);
  });

  it("treats missing proof on a resumed land as blocked, without a capture marker", async () => {
    const env = harness(BUILDABLE);
    env.deps.lookupHead = () => "trunk";
    env.deps.pack = { ...pack, journeyCommand: "node scripts/journey-proof.mjs" };
    env.deps.runPackCommand = () => ({ status: 0, stdout: "**Journey proof:** `api/test/pay.spec.ts`" });
    env.deps.journeyFileAt = () => true;
    await seedLandResume(env, false, [{ repo: "api", sha: "trunk" }], audit("api", "**Journey evidence:** recorded\n**Journey proof:** `api/test/pay.spec.ts`"));
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: `run-${starts}` };
    };

    const waiting = await runTicket(env.deps, ticket());

    assert.equal(waiting.outcome, "journey-missing");
    assert.equal(env.state(), "Todo");
    assert.equal(starts, 0);
    assert.equal(env.deliveryState().markers.some((marker) => marker.kind === "proof-receipt"), false);
  });
  it("treats a contents 200 as the route test and a 404 as a missing file", async () => {
    const present = harness(routeGround());
    const seen: { repo: string; branch: string; path: string; endpoint: string }[] = [];
    present.deps.forge.readTextFile = async (input) => {
      seen.push(input);
      return { status: 200, text: "test\n" };
    };
    const landed = await runTicket(present.deps, ticket());
    assert.equal(landed.outcome, "landed");
    assert.equal(present.state(), pack.status.complete);
    assert.equal(seen[0]?.repo, "acme/api");
    assert.equal(seen[0]?.branch, "trunk");
    assert.equal(seen[0]?.path, "e2e/signup.spec.ts");
    assert.equal(seen[0]?.endpoint, "contents");

    const missing = harness(routeGround());
    const logs: string[] = [];
    missing.deps.engineLog = (line) => logs.push(line);
    missing.deps.forge.readTextFile = async () => ({ status: 404, text: "" });
    const absent = await runTicket(missing.deps, ticket());
    assert.equal(absent.outcome, "journey-missing");
    assert.equal(absent.detail, "recorded proof missing");
    assert.match(missing.comments.join("\n"), /route test is absent/);
    assert.equal(logs.some((line) => line.includes("result=unavailable")), false);
  });

  it("logs a contents status that is not a file result", async () => {
    const env = harness(routeGround());
    const logs: string[] = [];
    env.deps.engineLog = (line) => logs.push(line);
    env.deps.forge.readTextFile = async () => ({ status: 403, text: "" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "journey-missing");
    assert.equal(result.detail, "journey file unavailable");
    assert.match(env.comments.join("\n"), /could not run/);
    assert.match(env.comments.join("\n"), /contents status=403/);
    assert.ok(logs.some((line) => line.includes("result=unavailable") && line.includes("reason=contents status=403")));
  });

  it("logs a failed checkout fetch instead of calling the file missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "journey-file-"));
    const sha = commitCheckout(join(root, "api"));
    const unavailable = harness(routeGround());
    unavailable.deps.cwd = root;
    const missingRef = "c".repeat(40);
    unavailable.deps.forge.squashMerge = async () => missingRef;
    const logs: string[] = [];
    unavailable.deps.engineLog = (line) => logs.push(line);
    const failed = await runTicket(unavailable.deps, ticket());
    assert.equal(failed.outcome, "journey-missing");
    assert.equal(failed.detail, "journey file unavailable");
    assert.match(unavailable.comments.join("\n"), /could not run/);
    assert.ok(logs.some((line) => /result=unavailable reason=fetch status=/.test(line)));

    const absent = harness(routeGround());
    absent.deps.cwd = root;
    absent.deps.forge.squashMerge = async () => sha;
    const absentLogs: string[] = [];
    absent.deps.engineLog = (line) => absentLogs.push(line);
    const missingFile = await runTicket(absent.deps, ticket());
    assert.equal(missingFile.outcome, "journey-missing");
    assert.equal(missingFile.detail, "recorded proof missing");
    assert.match(absent.comments.join("\n"), /route test is absent/);
    assert.equal(absentLogs.some((line) => line.includes("result=unavailable")), false);
  });

  it("stays in intake when a buildable handoff omits the outside grant line", async () => {
    const env = harness(BUILDABLE.replace("**Outside grant:** none\n", ""));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "outside-grant");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
  });

  it("holds an already-shipped ticket when the grant is still open", async () => {
    const env = harness(
      "**Verdict:** ALREADY SHIPPED\n**Repos:** `api`\n**Outside grant:** open\n",
    );
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.equal(env.state(), "Hold");
  });

  it("lands a buildable ticket after quality is green", async () => {
    const env = harness(BUILDABLE);
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Dev Complete");
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

  it("moves a packet-cited needs-rescope to the hold status", async () => {
    const env = harness("**Verdict:** NEEDS RESCOPE\n\n**Harness packet:** no safe default remains.");
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    assert.equal(env.state(), "Hold");
  });

  it("loads each ticket's project into the ground prompt", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.tracker.listIntake = async () => [ticket({ projectName: "Billing" })];
    let saw = "";
    const linearTracker = env.deps.tracker as TrackerAdapter & LinearProgramTracker;
    linearTracker.kind = "linear";
    linearTracker.projectSnapshot = async (name) => {
      saw = name;
      return {
        projectId: "p1",
        projectName: "Billing",
        projectUrl: "https://example.test/p",
        milestones: [{ id: "m1", name: "Stage 1", description: null, sortOrder: 1 }],
        issues: [
          {
            identifier: "API-1",
            stateName: "Todo",
            labels: [],
            milestoneId: "m1",
            blockedBy: [],
          },
        ],
      };
    };
    let prompt = "";
    env.deps.worker.start = async (input) => {
      prompt = input.prompt;
      return { runId: "run-1" };
    };
    const results = await sweep(env.deps);
    assert.equal(results[0]?.outcome, "verdict");
    assert.equal(saw, "Billing");
    assert.match(prompt, /## Delivery program \(full project\)/);
    assert.match(prompt, /API-1 Todo/);
    assert.match(prompt, /Project: Billing/);
    assert.match(prompt, /Hold \/ Dev Complete/);
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

  it("steals a pending v2 lease from a finished parent and releases it", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await env.deps.tracker.stateStore.writeDeliveryState("API-1", {
      ...env.deliveryState(),
      markers: [{
        kind: "delivery-lease",
        body: JSON.stringify({ schemaVersion: 2, expiresAt: future, ghaRunId: null, cursorAgentId: null, cursorRunId: "pending", cursorPhase: "ground" }),
        createdAt: new Date(0).toISOString(),
      }],
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "verdict");
    const lease = env.deliveryState().markers.filter((marker) => marker.kind === "delivery-lease").at(-1);
    assert.equal(JSON.parse(lease?.body ?? "{}").released, true);
    assert.equal(env.comments.some((body) => body.includes("DELIVERY_LEASE")), false);
  });

  it("keeps a v2 lease whose Actions run is still live", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.githubRunActive = () => true;
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await env.deps.tracker.stateStore.writeDeliveryState("API-1", {
      ...env.deliveryState(),
      markers: [{
        kind: "delivery-lease",
        body: JSON.stringify({ schemaVersion: 2, expiresAt: future, ghaRunId: "42", cursorAgentId: null, cursorRunId: "run-9", cursorPhase: "ground" }),
        createdAt: new Date(0).toISOString(),
      }],
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "skipped-lease");
    assert.equal(env.comments.length, 0);
  });

  it("sorts landings by pack repo order", () => {
    const board: ProjectPack = {
      ...pack,
      repos: [
        { name: "api", url: "https://github.com/acme/api", trunk: "development" },
        { name: "customer-app", url: "https://github.com/acme/customer-app", trunk: "main" },
        { name: "infra", url: "https://github.com/acme/infra", trunk: "main" },
      ],
    };
    const sorted = sortByPack(
      board,
      [{ name: "customer-app" }, { name: "other" }, { name: "api" }],
      (row) => row.name,
    );
    assert.deepEqual(
      sorted.map((row) => row.name),
      ["api", "customer-app", "other"],
    );
  });

  it("merges api before a client that the work order listed first", async () => {
    const env = harness(
      BUILDABLE.replace("**Repos:** `api`", "**Repos:** `customer-app, api`"),
    );
    const api = { name: "api", url: "https://github.com/acme/api", trunk: "development" };
    const client = { name: "customer-app", url: "https://github.com/acme/customer-app", trunk: "main" };
    env.deps.pack = { ...pack, repos: [api, client], branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = () => "abc1234";
    const opened: string[] = [];
    env.deps.forge.openPullRequest = async (input) => {
      opened.push(input.repoUrl);
      return {
        number: opened.length,
        url: `${input.repoUrl}/pull/${opened.length}`,
        headSha: "abc1234",
        branch: input.head,
        created: true,
      };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.deepEqual(opened, [api.url, client.url]);
  });

  it("waits until every surface is ready before merging the first", async () => {
    const env = harness(
      BUILDABLE.replace("**Repos:** `api`", "**Repos:** `api, admin-web`"),
    );
    const api = { name: "api", url: "https://github.com/acme/api", trunk: "development" };
    const web = { name: "admin-web", url: "https://github.com/acme/admin-web", trunk: "development" };
    env.deps.pack = {
      ...pack,
      repos: [api, web],
      branchTemplate: "cursor/{issue}-{repo}",
      design: {
        repos: [
          {
            name: "admin-web",
            check: "npm test",
            checkName: "ui-primitives",
            tokenFile: "tokens.css",
          },
        ],
      },
    };
    env.deps.lookupHead = () => "abc1234";
    env.deps.sleep = async () => {};
    env.deps.forge.designCheck = async (input) => {
      if (input.repoUrl.includes("admin-web")) {
        throw new Error(
          "GitHub /repos/acme/admin-web/commits/abc1234/check-runs?per_page=100 failed: 403",
        );
      }
      return { state: "success", detail: "ui-primitives success", headSha: input.headSha };
    };
    const merged: string[] = [];
    env.deps.forge.squashMerge = async (input) => {
      merged.push(input.repoUrl);
      return "c".repeat(40);
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(merged.length, 0);
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /check-runs\?per_page=100 failed: 403/);
  });

  it("does not open a pull request when the branch is already on trunk", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = () => "abc1234";
    env.deps.forge.compare = async () => "identical";
    let opened = 0;
    env.deps.forge.openPullRequest = async () => {
      opened += 1;
      return { number: 1, url: "https://github.com/acme/api/pull/1", headSha: "abc1234", branch: "cursor/api-1-api", created: true };
    };
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    const first = await runTicket(env.deps, ticket());
    assert.equal(first.outcome, "land-empty");
    assert.equal(opened, 0);
    assert.equal(starts, 1);
    assert.equal(env.state(), "Todo");
    assert.equal(sweepNeedsAnotherPage([first]), false);
    const marker = JSON.parse(env.deliveryState().markers.find((item) => item.kind === "land-resume")!.body) as { kind: string; rows: { repo: string; sha: string }[] };
    assert.equal(marker.kind, "empty");
    assert.deepEqual(marker.rows, [{ repo: "api", sha: "abc1234" }]);
    starts = 0;
    const second = await runTicket(env.deps, ticket());
    assert.equal(second.outcome, "land-empty");
    assert.equal(starts, 0);
    assert.equal(env.state(), "Todo");
  });

  it("waits for trunk quality before writing completion", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    env.deps.forge.quality = async (input) => input.headSha === "trunk"
      ? { state: "failure", detail: "trunk red" }
      : { state: "success", detail: "quality success" };
    const result = await runTicket(env.deps, ticket());
    assert.equal(starts, 2);
    assert.equal(result.outcome, "trunk-waiting");
    assert.equal(env.state(), "Todo");
    assert.equal(env.merged(), true);
    const marker = JSON.parse(env.deliveryState().markers.find((item) => item.kind === "land-resume")!.body) as { hold: boolean; rows: { repo: string; sha: string }[] };
    assert.equal(marker.hold, false);
    assert.deepEqual(marker.rows, [{ repo: "api", sha: "trunk" }]);
    assert.equal(sweepNeedsAnotherPage([result]), true);
  });

  it("accepts a green trunk tip that contains the merge", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    await seedLandResume(env, false, [{ repo: "api", sha: "oldred" }]);
    env.deps.lookupHead = () => "green";
    env.deps.forge.compare = async () => "ahead";
    env.deps.forge.quality = async (input) => input.headSha === "green"
      ? { state: "success", detail: "quality success" }
      : { state: "failure", detail: "old red" };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(starts, 0);
    assert.equal(env.state(), pack.status.complete);
  });

  it("writes completion when the recorded trunk commit is green", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    await seedLandResume(env, false, [{ repo: "api", sha: "trunk" }]);
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(starts, 0);
    assert.equal(env.state(), pack.status.complete);
    assert.equal(env.deliveryState().markers.some((marker) => marker.kind === "land-resume"), false);
  });

  it("keeps the v2 resume marker while quality is still pending", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    await seedLandResume(env, true, [{ repo: "api", sha: "trunk" }]);
    const lines: string[] = [];
    env.deps.report = (event) => lines.push(formatTicketProgress(event));
    env.deps.forge.quality = async () => ({ state: "pending", detail: "quality in_progress" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(starts, 0);
    assert.equal(result.outcome, "trunk-waiting");
    assert.deepEqual(lines, ["API-1 land", "API-1 trunk-waiting api trunk"]);
    assert.equal(env.state(), "Todo");
    assert.equal(env.deliveryState().markers.some((marker) => marker.kind === "land-resume"), true);
    assert.equal(sweepNeedsAnotherPage([result]), true);
  });

  it("refuses an HTTP GitHub candidate URL before creating auth config", () => {
    const previous = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "candidate-fetch-test-token";
    try {
      assert.throws(() => candidateFetchEnvironment(pack, "http://github.com/acme/api"), /HTTPS/);
      const env = candidateFetchEnvironment(pack, "https://github.com/acme/api");
      assert.equal(env.GIT_CONFIG_KEY_2, "http.https://github.com/.extraheader");
      assert.ok(env.GIT_CONFIG_VALUE_3);
    } finally {
      if (previous === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previous;
    }
  });

  it("runs credential-scrubbed fast-forward quality in an exact candidate worktree", async () => {
    const env = harness(BUILDABLE);
    const root = mkdtempSync(join(tmpdir(), "delivery-loop-fast-forward-"));
    const seed = join(root, "seed");
    const checkout = join(root, "api");
    mkdirSync(seed);
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: seed, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    const names = [
      "GH_TOKEN", "GITHUB_TOKEN", "LINEAR_API_KEY", "JIRA_AUTH_HEADER", "CUSTOM_WORKER_KEY", "CUSTOM_WORKER_FALLBACK",
      "WORKER_HTTP_TOKEN", "CUSTOM_PUSH_TOKEN", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DELIVERY_LOOP_GITHUB_MINT",
      "CI", "QUALITY_EVENT_FILE", "QUALITY_CWD_FILE",
    ];
    const previous = new Map(names.map((name) => [name, process.env[name]]));
    try {
      git(["init", "-b", "main"]);
      git(["config", "user.name", "Delivery Loop Test"]);
      git(["config", "user.email", "delivery-loop-test@example.test"]);
      writeFileSync(join(seed, "candidate.txt"), "base\n");
      git(["add", "candidate.txt"]);
      git(["commit", "-m", "base"]);
      const baseSha = git(["rev-parse", "HEAD"]);
      git(["checkout", "-b", "delivery/api-1"]);
      writeFileSync(join(seed, "candidate.txt"), "candidate\n");
      git(["add", "candidate.txt"]);
      git(["commit", "-m", "candidate"]);
      const candidateSha = git(["rev-parse", "HEAD"]);
      const remote = join(root, "remote.git");
      const bare = spawnSync("git", ["clone", "--bare", seed, remote], { encoding: "utf8" });
      assert.equal(bare.status, 0, bare.stderr);
      const cloned = spawnSync("git", ["clone", "--branch", "main", "--single-branch", remote, checkout], { encoding: "utf8" });
      assert.equal(cloned.status, 0, cloned.stderr);
      const rewrite = spawnSync("git", ["-C", checkout, "config", `url.file://${remote}.insteadOf`, "https://github.com/acme/api"], { encoding: "utf8" });
      assert.equal(rewrite.status, 0, rewrite.stderr);
      const qualityEventFile = join(root, "quality-events");
      const qualityCwdFile = join(root, "quality-cwd");
      for (const name of names) process.env[name] = "must-not-leak";
      process.env.CI = "1";
      process.env.QUALITY_EVENT_FILE = qualityEventFile;
      process.env.QUALITY_CWD_FILE = qualityCwdFile;
      const qualityCommand = [
        'test -z "$GH_TOKEN"',
        'test -z "$GITHUB_TOKEN"',
        'test -z "$LINEAR_API_KEY"',
        'test -z "$JIRA_AUTH_HEADER"',
        'test -z "$CUSTOM_WORKER_KEY"',
        'test -z "$CUSTOM_WORKER_FALLBACK"',
        'test -z "$WORKER_HTTP_TOKEN"',
        'test -z "$CUSTOM_PUSH_TOKEN"',
        'test -z "$AWS_ACCESS_KEY_ID"',
        'test -z "$AWS_SECRET_ACCESS_KEY"',
        'test -z "$DELIVERY_LOOP_GITHUB_MINT"',
        'test "$CI" = "1"',
        'test -n "$PATH"',
        'test "$(cat candidate.txt)" = "candidate"',
        'printf "quality\\n" >> "$QUALITY_EVENT_FILE"',
        'pwd > "$QUALITY_CWD_FILE"',
      ].join(" && ");
      env.deps.pack = {
        ...pack,
        qualityCommand,
        landingStrategy: "fast-forward",
        workerKeys: { primary: "CUSTOM_WORKER_KEY", fallback: "CUSTOM_WORKER_FALLBACK" },
        commitActorTokenEnv: "CUSTOM_PUSH_TOKEN",
        jira: { apiBaseUrl: "https://jira.example", authHeaderEnv: "JIRA_AUTH_HEADER", intakeJql: "project = APP", approvalFieldId: "customfield_1" },
        promotionStages: [
          { id: "delivery", target: "opaque-target", authorization: "deliver", promoteCommand: "promote", repos: ["api"], verifyCommand: "verify" },
        ],
      };
      env.deps.cwd = root;
      const events: string[] = [];
      let base = baseSha;
      let workflowReads = 0;
      env.deps.lookupHead = (_url, ref) => ref === "delivery/api-1" ? candidateSha : base;
      env.deps.forge.compare = async () => "ahead";
      env.deps.forge.directLand = async (input) => {
        events.push("quality-command");
        assert.equal(input.expectedBaseSha, baseSha);
        assert.equal(input.expectedHeadSha, candidateSha);
        assert.equal(readFileSync(qualityEventFile, "utf8"), "quality\n");
        base = "newer-trunk-tip";
        events.push(`land:${input.expectedBaseSha}:${input.expectedHeadSha}`);
        return candidateSha;
      };
      env.deps.forge.quality = async ({ headSha }) => {
        events.push(`workflow:${headSha}`);
        if (headSha !== candidateSha) return { state: "failure", detail: `unexpected SHA ${headSha}` };
        workflowReads += 1;
        return workflowReads === 1
          ? { state: "pending", detail: "workflow running" }
          : { state: "success", detail: "workflow green" };
      };
      env.deps.runPackCommand = (command, _cwd, stdin) => {
        const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
        events.push(command);
        return command === "verify"
          ? { status: 0, stdout: receiptFor({ stageId: input.stageId, target: input.target, criteriaRevision: input.criteriaRevision ?? "", deployed: input.landedShas ?? [] }) }
          : { status: 0, stdout: "" };
      };
      const first = await runTicket(env.deps, ticket());
      assert.equal(first.outcome, "quality-pending");
      assert.deepEqual(events.slice(0, 3), ["quality-command", `land:${baseSha}:${candidateSha}`, `workflow:${candidateSha}`]);
      assert.equal(events.includes("promote"), false);
      const qualityCwd = readFileSync(qualityCwdFile, "utf8").trim();
      assert.notEqual(qualityCwd, checkout);
      assert.equal(existsSync(qualityCwd), false);
      assert.equal(env.state(), "Todo");
      const second = await runTicket(env.deps, ticket());
      assert.equal(second.outcome, "landed");
      assert.equal(env.state(), pack.status.complete);
      assert.equal(events.includes("workflow:newer-trunk-tip"), false);
      assert.ok(events.indexOf("promote") > events.lastIndexOf(`workflow:${candidateSha}`));
      assert.equal(env.deliveryState().stageReceipts[0]?.deployed[0]?.sha, candidateSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("runs ordered opaque delivery stages with only stage-authorized credentials", async () => {
    const env = harness(BUILDABLE);
    const stages: PromotionStage[] = [
      { id: "stage-one", target: "green-ring", authorization: "deliver", promoteCommand: "promote-one", repos: ["api"], verifyCommand: "verify-one" },
      { id: "stage-two", target: "west-cluster", authorization: "deliver", promoteCommand: "promote-two", repos: ["api"], verifyCommand: "verify-two" },
    ];
    env.deps.pack = {
      ...pack,
      promotionStages: stages,
      workerKeys: { primary: "CURSOR_API_KEY", fallback: "CURSOR_API_KEY_FALLBACK" },
      commitActorTokenEnv: "COMMIT_ACTOR_TOKEN",
      jira: { apiBaseUrl: "https://jira.example", authHeaderEnv: "JIRA_AUTH_HEADER", intakeJql: "project = APP", approvalFieldId: "customfield_1" },
    };
    const credentialNames = ["GH_TOKEN", "GITHUB_TOKEN", "AWS_ACCESS_KEY_ID", "LINEAR_API_KEY", "JIRA_AUTH_HEADER", "CURSOR_API_KEY", "CURSOR_API_KEY_FALLBACK", "WORKER_HTTP_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "COMMIT_ACTOR_TOKEN"];
    const previous = new Map(credentialNames.map((name) => [name, process.env[name]]));
    for (const name of credentialNames) process.env[name] = "stage-authorized-test-value";
    const events: string[] = [];
    env.deps.runPackCommand = (command, _cwd, stdin, childEnv) => {
      assert.equal(childEnv?.GH_TOKEN, "stage-authorized-test-value");
      assert.equal(childEnv?.GITHUB_TOKEN, "stage-authorized-test-value");
      assert.equal(childEnv?.AWS_ACCESS_KEY_ID, "stage-authorized-test-value");
      assert.equal(childEnv?.LINEAR_API_KEY, undefined);
      assert.equal(childEnv?.JIRA_AUTH_HEADER, undefined);
      assert.equal(childEnv?.CURSOR_API_KEY, undefined);
      assert.equal(childEnv?.CURSOR_API_KEY_FALLBACK, undefined);
      assert.equal(childEnv?.WORKER_HTTP_TOKEN, undefined);
      assert.equal(childEnv?.ANTHROPIC_API_KEY, undefined);
      assert.equal(childEnv?.OPENAI_API_KEY, undefined);
      assert.equal(childEnv?.COMMIT_ACTOR_TOKEN, undefined);
      const input = JSON.parse(stdin) as {
        stageId: string;
        target: string;
        repo?: string;
        criteriaRevision?: string;
        landedShas?: { repo: string; sha: string }[];
      };
      if (command.startsWith("promote-")) {
        events.push(`${command}:${input.stageId}:${input.repo}`);
        return { status: 0, stdout: "" };
      }
      events.push(`${command}:${input.stageId}`);
      return {
        status: 0,
        stdout: receiptFor({ stageId: input.stageId, target: input.target, criteriaRevision: input.criteriaRevision ?? "", deployed: input.landedShas ?? [] }),
      };
    };
    try {
      const result = await runTicket(env.deps, ticket());
      assert.equal(result.outcome, "landed");
      assert.deepEqual(events, ["promote-one:stage-one:api", "verify-one:stage-one", "promote-two:stage-two:api", "verify-two:stage-two"]);
      assert.deepEqual(env.deliveryState().stageReceipts.map((receipt) => [receipt.stageId, receipt.target, receipt.outcome]), [
        ["stage-one", "green-ring", "passed"],
        ["stage-two", "west-cluster", "passed"],
      ]);
      assert.equal(env.state(), pack.status.complete);
      assert.deepEqual(env.statusRevisions, [ticket().criteriaRevision]);
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("verifies a stage against the landed repos it lists and skips the rest", async () => {
    const env = harness(BUILDABLE);
    const mobile = { name: "mobile", url: "https://github.com/acme/mobile", trunk: "main" };
    env.deps.pack = {
      ...pack,
      repos: [...pack.repos, mobile],
      promotionStages: [
        { id: "shared", target: "shared-ring", authorization: "deliver", promoteCommand: "promote-shared", repos: ["api", "mobile"], verifyCommand: "verify-shared" },
        { id: "handset", target: "handset-ring", authorization: "deliver", promoteCommand: "promote-handset", repos: ["mobile"], verifyCommand: "verify-handset" },
      ],
    };
    const commands: string[] = [];
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      commands.push(command);
      const input = JSON.parse(stdin) as StageVerifyInput;
      if (!command.startsWith("verify")) return { status: 0, stdout: "" };
      assert.deepEqual(input.landedShas, [{ repo: "api", sha: "trunk" }]);
      return {
        status: 0,
        stdout: receiptFor({
          stageId: input.stageId,
          target: input.target,
          criteriaRevision: input.criteriaRevision,
          deployed: input.landedShas,
        }),
      };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.deepEqual(commands, ["promote-shared", "verify-shared"]);
    const receipts = env.deliveryState().stageReceipts;
    assert.equal(receipts.find((item) => item.stageId === "shared")?.outcome, "passed");
    assert.deepEqual(receipts.find((item) => item.stageId === "shared")?.deployed, [{ repo: "api", sha: "trunk" }]);
    assert.equal(receipts.find((item) => item.stageId === "handset")?.outcome, "not-applicable");
    assert.deepEqual(receipts.find((item) => item.stageId === "handset")?.deployed, []);
    assert.deepEqual(receipts.find((item) => item.stageId === "handset")?.criteria, []);
    assert.equal(env.state(), pack.status.complete);
  });

  it("records a stage with no landed repos as not applicable", async () => {
    const env = harness(BUILDABLE);
    env.deps.ownerHeal = async () => "**Heal:** wait";
    env.deps.pack = {
      ...pack,
      promotionStages: [
        { id: "handset", target: "handset-ring", authorization: "deliver", promoteCommand: "promote-handset", repos: ["mobile"], verifyCommand: "verify-handset" },
      ],
    };
    const commands: string[] = [];
    env.deps.runPackCommand = (command) => {
      commands.push(command);
      return { status: 0, stdout: "" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "quality-failed");
    assert.match(result.detail, /no promotion stage applies/);
    assert.deepEqual(commands, []);
    assert.equal(env.deliveryState().stageReceipts[0]?.outcome, "not-applicable");
    assert.equal(env.state(), "Todo");
  });

  it("retries a transient v2 delivery-stage promotion within its budget", async () => {
    const env = harness(BUILDABLE);
    const stage: PromotionStage = {
      id: "deliver-stage",
      target: "opaque-target",
      authorization: "deliver",
      promoteCommand: "promote",
      repos: ["api"],
      verifyCommand: "verify",
    };
    env.deps.pack = { ...pack, promotionStages: [stage], transient: { maxAttempts: 2, maxWaitMs: 250 } };
    const events: string[] = [];
    let promotions = 0;
    env.deps.sleep = async (ms) => { events.push(`sleep:${ms}`); };
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      events.push(command);
      if (command === "promote" && ++promotions === 1) return { status: 75, stdout: "", stderr: "" };
      if (command === "promote") return { status: 0, stdout: "" };
      const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
      return { status: 0, stdout: receiptFor({ stageId: input.stageId, target: input.target, criteriaRevision: input.criteriaRevision ?? "", deployed: input.landedShas ?? [] }) };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.deepEqual(events, ["promote", "sleep:250", "promote", "verify"]);
    assert.equal(env.state(), pack.status.complete);
  });

  it("does not run a later delivery stage after a blocked receipt", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = {
      ...pack,
      promotionStages: [
        { id: "first", target: "alpha", authorization: "deliver", promoteCommand: "promote-first", repos: ["api"], verifyCommand: "verify-first" },
        { id: "later", target: "beta", authorization: "deliver", promoteCommand: "promote-later", repos: ["api"], verifyCommand: "verify-later" },
      ],
    };
    const commands: string[] = [];
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      commands.push(command);
      const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
      if (command !== "verify-first") return { status: 0, stdout: "" };
      return {
        status: 0,
        stdout: receiptFor({
          stageId: input.stageId,
          target: input.target,
          criteriaRevision: input.criteriaRevision ?? "",
          deployed: input.landedShas ?? [],
          outcome: "blocked",
          reason: "live evidence is unavailable",
        }),
      };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "blocked");
    assert.deepEqual(commands, ["promote-first", "verify-first"]);
    assert.equal(env.state(), "Todo");
    assert.deepEqual(env.deliveryState().stageReceipts.map((receipt) => receipt.stageId), ["first"]);
  });

  it("rejects stage receipts bound to another stage, target, revision, SHA, or matrix", async () => {
    const invalidators: ((receipt: Record<string, unknown>) => void)[] = [
      (receipt) => { receipt.stageId = "other-stage"; },
      (receipt) => { receipt.target = "other-target"; },
      (receipt) => { receipt.criteriaRevision = "b".repeat(64); },
      (receipt) => { (receipt.deployed as { repo: string; sha: string }[])[0]!.sha = "other-sha"; },
      (receipt) => { (receipt.criteria as { id: string }[])[0]!.id = "other-criterion"; },
    ];
    for (const invalidate of invalidators) {
      const env = harness(BUILDABLE);
      const stage: PromotionStage = {
        id: "delivery",
        target: "opaque-target",
        authorization: "deliver",
        promoteCommand: "promote",
        repos: ["api"],
        verifyCommand: "verify",
      };
      env.deps.pack = { ...pack, promotionStages: [stage] };
      env.deps.ownerHeal = async () => "**Heal:** wait";
      env.deps.runPackCommand = (command, _cwd, stdin) => {
        if (command !== "verify") return { status: 0, stdout: "" };
        const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
        const parsed = JSON.parse(receiptFor({
          stageId: input.stageId,
          target: input.target,
          criteriaRevision: input.criteriaRevision ?? "",
          deployed: input.landedShas ?? [],
        })) as Record<string, unknown>;
        invalidate(parsed);
        return { status: 0, stdout: JSON.stringify(parsed) };
      };
      const result = await runTicket(env.deps, ticket());
      assert.equal(result.outcome, "quality-failed");
      assert.equal(env.state(), "Todo");
      assert.equal(env.deliveryState().stageReceipts.length, 0);
    }
  });

  it("invalidates receipts when the criteria revision changes", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = {
      ...pack,
      promotionStages: [
        { id: "single", target: "blue-ring", authorization: "deliver", promoteCommand: "promote", repos: ["api"], verifyCommand: "verify" },
      ],
    };
    let verifies = 0;
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
      if (command !== "verify") return { status: 0, stdout: "" };
      verifies += 1;
      return {
        status: 0,
        stdout: receiptFor({
          stageId: input.stageId,
          target: input.target,
          criteriaRevision: input.criteriaRevision ?? "",
          deployed: input.landedShas ?? [],
        }),
      };
    };
    assert.equal((await runTicket(env.deps, ticket())).outcome, "landed");
    const changed = ticket({ criteriaRevision: "b".repeat(64) });
    assert.equal((await runTicket(env.deps, changed)).outcome, "landed");
    assert.equal(verifies, 2);
    assert.deepEqual(env.deliveryState().stageReceipts.map((receipt) => receipt.criteriaRevision), [changed.criteriaRevision]);
  });
  it("reports each phase before the wait and the result when the ticket finishes", async () => {
    const env = harness(BUILDABLE);
    const lines: string[] = [];
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      lines.push(input.prompt.includes("Implement only this work order") ? "worker-build" : "worker-ground");
      return start(input);
    };
    env.deps.report = (event) => {
      lines.push(formatTicketProgress(event));
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.deepEqual(lines, [
      "API-1 ground",
      "worker-ground",
      "API-1 build",
      "worker-build",
      "API-1 land",
      "API-1 landed https://github.com/acme/api/pull/4",
    ]);
  });

  it("reports a blocked ticket without starting a phase", async () => {
    const env = harness(BUILDABLE);
    const lines: string[] = [];
    env.deps.report = (event) => {
      lines.push(formatTicketProgress(event));
    };
    const result = await runTicket(
      env.deps,
      ticket({ blockedBy: [{ identifier: "API-2", stateName: "Todo" }] }),
    );
    assert.equal(result.outcome, "skipped-graph");
    assert.deepEqual(lines, ["API-1 skipped-graph blocked by API-2 (Todo)"]);
  });

  it("reports worker-failed when the worker start is refused and does not start again", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      throw new Error("HTTP worker start failed: 400");
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "worker-failed");
    assert.match(result.detail ?? "", /HTTP worker start failed: 400/);
    assert.equal(starts, 1);
  });

  it("reports worker-failed when the worker join exceeds its wait", async () => {
    const env = harness(BUILDABLE);
    env.deps.worker.join = async () => ({ status: "failed", text: "http worker join exceeded maxWaitMs" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "worker-failed");
    assert.match(result.detail ?? "", /exceeded maxWaitMs/);
  });

  it("keeps a progress line on one line", () => {
    assert.equal(formatTicketProgress({ identifier: "API-1", phase: "ground" }), "API-1 ground");
    assert.equal(
      formatTicketProgress({
        identifier: "API-1",
        phase: "done",
        outcome: "worker-failed",
        detail: "boom\nnext",
      }),
      "API-1 worker-failed boom next",
    );
    const line = formatTicketProgress({
      identifier: "API-1",
      phase: "done",
      outcome: "worker-failed",
      detail: "x".repeat(250),
    });
    assert.equal(line, `API-1 worker-failed ${"x".repeat(197)}...`);
  });

  it("classifies a red quality run before another product edit", () => {
    const rows: {
      cause: ReturnType<typeof classifyQualityCause>;
      detail: string;
      rerun: "success" | "failure" | null;
      trunk: "success" | "failure" | null;
      commandMatchesWorkflow: boolean | null;
    }[] = [
      { cause: "flake", detail: "quality failure", rerun: "success", trunk: "success", commandMatchesWorkflow: true },
      { cause: "trunk", detail: "quality failure", rerun: "failure", trunk: "failure", commandMatchesWorkflow: true },
      { cause: "environment", detail: "quality failure", rerun: "failure", trunk: "success", commandMatchesWorkflow: false },
      { cause: "contract", detail: "api-types drift", rerun: null, trunk: null, commandMatchesWorkflow: null },
      { cause: "change", detail: "npm test exited 1", rerun: null, trunk: "success", commandMatchesWorkflow: true },
    ];
    for (const row of rows) {
      assert.equal(
        classifyQualityCause({
          detail: row.detail,
          rerun: row.rerun ? { state: row.rerun, detail: row.detail } : null,
          trunk: row.trunk ? { state: row.trunk, detail: row.detail } : null,
          commandMatchesWorkflow: row.commandMatchesWorkflow,
        }),
        row.cause,
      );
    }
  });

  it("does not patch the product branch when trunk is already red", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 5;
    let starts = 0;
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      starts += 1;
      return start(input);
    };
    env.deps.qualityContext = async () => ({
      rerun: { state: "failure", detail: "quality failure" },
      trunk: { state: "failure", detail: "quality failure" },
      commandMatchesWorkflow: true,
    });
    env.deps.forge.quality = async () => ({ state: "failure", detail: "quality failure" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /next page resumes/);
    assert.equal(env.deliveryState().markers.some((marker) => marker.kind === "owner-heal"), true);
    assert.equal(starts, 3);
    assert.equal(env.merged(), false);
  });

  it("does not adopt a commit that repeats the previous hypothesis", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 3;
    env.deps.sleep = async () => {};
    let reads = 0;
    env.deps.forge.quality = async (input) => {
      reads += 1;
      if (reads > 3) return { state: "success", detail: "quality success" };
      return { state: "failure", detail: `quality failure ${input.headSha}` };
    };
    let lookups = 0;
    env.deps.lookupHead = (_url, branch) => {
      if (branch === "main") return "trunk";
      lookups += 1;
      return `sha-${lookups}`;
    };
    let joins = 0;
    env.deps.worker.join = async () => {
      joins += 1;
      return {
        status: "finished",
        branch: "delivery/api-1",
        head: "abc",
        text: joins <= 2 ? BUILDABLE : "**Hypothesis:** retry the suite",
      };
    };
    const heads: string[] = [];
    const quality = env.deps.forge.quality.bind(env.deps.forge);
    env.deps.forge.quality = async (input) => {
      if (input.headSha.startsWith("sha-")) heads.push(`${input.headSha}`);
      return quality(input);
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.equal(env.deps.pageControl?.stop, true);
    assert.equal(joins, 3);
    assert.equal(env.merged(), false);
  });

  it("refuses a packet whose symbols do not resolve", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = { ...pack, symbolsCommand: "node scripts/code-graph.mjs --check" };
    env.deps.runPackCommand = () => ({ status: 1, stdout: "" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "symbols");
    assert.equal(env.merged(), false);
    assert.equal(env.comments.some((body) => body.includes("BUILD_PACKET")), false);
  });

  it("appends the journey command token and does not require the author to write it", async () => {
    const url = "https://example.test/artifacts/signup.mp4";
    const env = harness(BUILDABLE.replace("**Journey evidence:** not-applicable", "**Journey evidence:** recorded"));
    env.deps.pack = { ...pack, journeyCommand: "node scripts/journey-proof.mjs" };
    env.deps.runPackCommand = () => ({ status: 0, stdout: `**Journey proof:** \`${url}\`` });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), "Dev Complete");
  });

  it("persists the validated proof receipt before the completion status", async () => {
    const url = "https://example.test/artifacts/signup.mp4";
    const env = harness(BUILDABLE.replace("**Journey evidence:** not-applicable", "**Journey evidence:** recorded"));
    env.deps.pack = { ...pack, journeyCommand: "node scripts/journey-proof.mjs" };
    env.deps.runPackCommand = () => ({ status: 0, stdout: `**Journey proof:** \`${url}\`` });
    env.deps.lookupHead = () => "trunk";
    const order: string[] = [];
    const writeState = env.deps.tracker.stateStore.writeDeliveryState.bind(env.deps.tracker.stateStore);
    const setState = env.deps.tracker.setState.bind(env.deps.tracker);
    env.deps.tracker.stateStore.writeDeliveryState = async (id, value) => {
      if (value.markers.some((marker) => marker.kind === "proof-receipt")) order.push("proof");
      await writeState(id, value);
    };
    env.deps.tracker.setState = async (id, next, revision) => {
      order.push(`state:${next}`);
      await setState(id, next, revision);
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), pack.status.complete);
    const proof = env.deliveryState().markers.find((marker) => marker.kind === "proof-receipt")?.body ?? "";
    assert.equal(proof.includes(url), true);
    assert.match(proof, /"sha":"trunk","url":"https:\/\/github\.com\/acme\/api\/pull\/4"/);
    assert.ok(order.indexOf("proof") >= 0);
    assert.ok(order.indexOf("proof") < order.indexOf(`state:${pack.status.complete}`));
    const again = await runTicket(env.deps, ticket());
    assert.equal(again.outcome, "landed");
    assert.equal(env.deliveryState().markers.filter((marker) => marker.kind === "proof-receipt").length, 1);
  });

  it("does not accept an api unit spec as journey proof", async () => {
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      "**Journey evidence:** recorded\n**Journey proof:** `api/test/pay.spec.ts`",
    );
    const env = harness(ground);
    env.deps.journeyFileAt = () => true;
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "journey-missing");
    assert.equal(result.detail, "recorded proof missing");
    assert.equal(env.state(), "Todo");
  });


  it("records route proof on an exact-SHA-verified delivery ref", async () => {
    const env = harness(BUILDABLE);
    const stage: PromotionStage = {
      id: "delivery-stage",
      target: "opaque-target",
      authorization: "deliver",
      promoteCommand: "promote",
      repos: ["api"],
      refs: { api: ["canary-ref"] },
      verifyCommand: "verify",
    };
    env.deps.pack = { ...pack, journeyCommand: "node scripts/journey-proof.mjs", promotionStages: [stage] };
    const sequence: string[] = [];
    env.deps.deployRefContains = ({ ref, sha }) => {
      assert.equal(sha, "abc");
      assert.equal(ref, "canary-ref");
      return true;
    };
    env.deps.journeyFileAt = ({ ref, path }) => {
      sequence.push(`file:${ref}`);
      return ref === "canary-ref" && path === "e2e/signup.spec.ts";
    };
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      if (command !== "verify") return { status: 0, stdout: "**Journey proof:** `api/e2e/signup.spec.ts`" };
      sequence.push("verify");
      const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
      return {
        status: 0,
        stdout: receiptFor({
          stageId: input.stageId,
          target: input.target,
          criteriaRevision: input.criteriaRevision ?? "",
          deployed: input.landedShas ?? [],
        }),
      };
    };
    await seedLandResume(env, false, [{ repo: "api", sha: "abc" }], audit("api", "**Journey evidence:** recorded"));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), pack.status.complete);
    assert.deepEqual(sequence, ["verify", "file:abc", "file:canary-ref"]);
    assert.deepEqual(env.deliveryState().stageReceipts[0]?.deployed, [{ repo: "api", sha: "abc" }]);
    const proof = JSON.parse(env.deliveryState().markers.find((marker) => marker.kind === "proof-receipt")?.body ?? "{}") as { landed: { repo: string; sha: string }[]; validated: boolean; receipt: string };
    assert.deepEqual(proof.landed, [{ repo: "api", sha: "abc" }]);
    assert.equal(proof.validated, true);
    assert.match(proof.receipt, /api\/e2e\/signup\.spec\.ts/);
  });

  it("reuses recorded proof that already matches the completion target", async () => {
    const env = harness(BUILDABLE);
    env.deps.lookupHead = () => "main-tip";
    let runs = 0;
    env.deps.pack = { ...pack, journeyCommand: "node scripts/journey-proof.mjs" };
    env.deps.runPackCommand = () => {
      runs += 1;
      return { status: 1, stdout: "" };
    };
    env.deps.journeyFileAt = ({ ref, path }) => ref === "main" && path === "e2e/signup.spec.ts";
    const ground = audit("api", "**Journey evidence:** recorded\n**Journey proof:** `api/e2e/signup.spec.ts`");
    await seedLandResume(env, false, [{ repo: "api", sha: "abc" }], ground);
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), pack.status.complete);
    assert.equal(runs, 0);
  });

  it("reuses a validated proof receipt for its exact landed SHA and criteria", async () => {
    const url = "https://example.test/artifacts/signup.png";
    const env = harness(BUILDABLE);
    const ground = audit("api", `**Journey evidence:** recorded\n**Journey proof:** \`${url}\``);
    await seedLandResume(env, false, [{ repo: "api", sha: "abc" }], ground);
    const state = await env.deps.tracker.stateStore.readDeliveryState("API-1");
    const receipt = ground;
    await env.deps.tracker.stateStore.writeDeliveryState("API-1", {
      ...state,
      markers: [
        ...state.markers.filter((marker) => marker.kind !== "proof-receipt"),
        {
          kind: "proof-receipt",
          body: JSON.stringify({
            schemaVersion: 2,
            criteriaRevision: ticket().criteriaRevision,
            landed: [{ repo: "api", sha: "abc" }],
            pullRequests: [],
            attempted: false,
            validated: true,
            receipt,
          }),
          createdAt: new Date(0).toISOString(),
        },
      ],
    });
    env.deps.pack = { ...pack, journeyCommand: "node scripts/journey-proof.mjs" };
    let verifierRuns = 0;
    env.deps.runPackCommand = () => {
      verifierRuns += 1;
      return { status: 1, stdout: "" };
    };
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: `run-${starts}` };
    };

    const result = await runTicket(env.deps, ticket());

    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), pack.status.complete);
    assert.equal(verifierRuns, 0);
    assert.equal(starts, 0);
    const proof = JSON.parse(env.deliveryState().markers.find((marker) => marker.kind === "proof-receipt")?.body ?? "{}") as { criteriaRevision: string; landed: { repo: string; sha: string }[]; validated: boolean };
    assert.equal(proof.criteriaRevision, ticket().criteriaRevision);
    assert.deepEqual(proof.landed, [{ repo: "api", sha: "abc" }]);
    assert.equal(proof.validated, true);
  });

  it("names the journey command when it prints no token", async () => {
    const env = harness(BUILDABLE);
    env.deps.lookupHead = () => "main-tip";
    env.deps.pack = {
      ...pack,
      journeyCommand: "node scripts/journey-proof.mjs",
      journeySpec: "{e2e,integration_test,journey}/**",
    };
    env.deps.runPackCommand = () => ({ status: 0, stdout: "no token\n" });
    await seedLandResume(env, false, [{ repo: "api", sha: "abc" }], audit("api", "**Journey evidence:** recorded"));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "journey-missing");
    assert.equal(result.detail, "recorded proof missing");
    assert.equal(env.state(), "Todo");
    const note = env.comments.find((body) => body.includes("Journey command"));
    assert.ok(note);
    assert.match(note, /API-1/);
    assert.match(note, /node scripts\/journey-proof\.mjs/);
    assert.match(note, /\{e2e,integration_test,journey\}\/\*\*/);
  });

  it("advances a v2 resume after recording journey proof once", async () => {
    const env = harness(BUILDABLE);
    env.deps.lookupHead = () => "trunk";
    env.deps.journeyFileAt = ({ path }) => path === "e2e/signup.spec.ts";
    env.deps.pack = { ...pack, journeyCommand: "node scripts/journey-proof.mjs" };
    env.deps.runPackCommand = () => ({ status: 0, stdout: "**Journey proof:** `api/e2e/signup.spec.ts`" });
    await seedLandResume(env, false, [{ repo: "api", sha: "trunk" }], audit("api", "**Journey evidence:** recorded"));
    const first = await runTicket(env.deps, ticket());
    assert.equal(first.outcome, "landed");
    assert.equal(env.state(), pack.status.complete);
    const proof = env.deliveryState().markers.find((marker) => marker.kind === "proof-receipt")?.body ?? "";
    assert.match(proof, /api\/e2e\/signup\.spec\.ts/);
    env.deps.runPackCommand = () => ({ status: 1, stdout: "" });
    const again = await runTicket(env.deps, ticket({ stateName: pack.status.complete }));
    assert.equal(again.outcome, "landed");
    assert.equal(env.deliveryState().markers.filter((marker) => marker.kind === "proof-receipt").length, 1);
  });


  it("edits the install once when the quality check does not match the workflow", async () => {
    const env = harness(BUILDABLE);
    const prompts: string[] = [];
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      prompts.push(input.prompt);
      return start(input);
    };
    env.deps.qualityContext = async () => ({
      rerun: { state: "failure", detail: "quality failure" },
      trunk: { state: "success", detail: "quality success" },
      commandMatchesWorkflow: false,
    });
    env.deps.forge.quality = async () => ({ state: "failure", detail: "quality failure" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /procedure owner was edited/);
    assert.equal(env.deps.pageControl?.stop, true);
    const heals = prompts.filter((prompt) => prompt.includes("Fix that owner"));
    assert.equal(heals.length, 1);
    assert.match(heals[0], /owner of the behavior/);
    assert.equal(prompts.some((prompt) => prompt.includes("Checkout")), false);
    assert.equal(env.merged(), false);
  });

  it("edits the runner once when a conflict is still stuck after the fix budget", async () => {
    const env = harness(BUILDABLE);
    env.deps.ciFixMax = 0;
    const prompts: string[] = [];
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      prompts.push(input.prompt);
      return start(input);
    };
    env.deps.forge.mergeability = async () => ({ state: "conflict", headSha: "abc" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "land-blocked");
    assert.equal(env.deps.pageControl?.stop, true);
    const heals = prompts.filter((prompt) => prompt.includes("Fix that owner"));
    assert.equal(heals.length, 1);
    assert.match(heals[0], /package that executes this loop/);
    assert.equal(env.merged(), false);
  });

  it("stops a red quality check at the heal cap and does not chain another page", async () => {
    const env = harness(BUILDABLE);
    const prompts: string[] = [];
    const start = env.deps.worker.start.bind(env.deps.worker);
    env.deps.worker.start = async (input) => {
      prompts.push(input.prompt);
      return start(input);
    };
    env.deps.pack = { ...pack, heal: { caps: { "quality-red": 0 } } };
    env.deps.forge.quality = async () => ({ state: "failure", detail: "quality failure" });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "heal-exhausted");
    assert.equal(result.detail, "quality-red");
    assert.equal(sweepNeedsAnotherPage([result]), false);
    assert.equal(prompts.some((prompt) => prompt.includes("Fix that owner")), false);
    assert.deepEqual(env.labels, ["heal-exhausted", "quality-red"]);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "later" };
    };
    const again = await runTicket(
      env.deps,
      ticket({ comments: env.comments.map((body) => ({ body })), labels: ["heal-exhausted", "quality-red"] }),
    );
    assert.equal(again.outcome, "heal-exhausted");
    assert.equal(starts, 0);
  });

  it("lands an open pull request when another repo is already merged", async () => {
    const env = harness(BUILDABLE);
    const board = surfaceBoard(env);
    const events: string[] = [];
    board.watch(events);
    let behind = true;
    env.deps.forge.mergeability = async (input) => {
      if (input.number === 2 && behind) {
        behind = false;
        return { state: "behind", headSha: OPEN_SHA };
      }
      return { state: "clean", headSha: OPEN_SHA };
    };
    env.deps.forge.updateBranch = async () => {
      events.push("update");
    };
    env.deps.forge.squashMerge = async () => {
      events.push("merge");
      return MERGED_SHA;
    };
    env.deps.forge.listPullRequests = async (input) =>
      input.repoUrl.endsWith("/api")
        ? [listedPull({ number: 1, branch: input.head, base: input.base, state: "merged" })]
        : [listedPull({ number: 2, branch: input.head, base: input.base, state: "open", headSha: OPEN_SHA })];
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    const engine: string[] = [];
    env.deps.engineLog = (line) => engine.push(line);
    await seedWorkOrder(env, audit("api, mobile"));
    const result = await runTicket(
      env.deps,
      ticket({ comments: [{ body: audit("api, mobile") }] }),
    );
    assert.equal(result.outcome, "landed");
    assert.equal(starts, 0);
    assert.deepEqual(events, ["update", "merge", "state:Dev Complete"]);
    assert.ok(engine.includes("[delivery-loop] land ok"));
    assert.equal(engine.some((line) => line === "[delivery-loop] promote ok"), false);
    assert.equal(env.state(), pack.status.complete);
  });

  it("does not merge a ready pull request while another open surface is not ready", async () => {
    const env = harness(BUILDABLE);
    const api = { name: "api", url: "https://github.com/acme/api", trunk: "main" };
    const web = { name: "web", url: "https://github.com/acme/web", trunk: "main" };
    const mobile = { name: "mobile", url: "https://github.com/acme/mobile", trunk: "main" };
    env.deps.pack = {
      ...pack,
      repos: [api, web, mobile],
      branchTemplate: "cursor/{issue}-{repo}",
    };
    env.deps.sleep = async () => {};
    let merges = 0;
    env.deps.forge.squashMerge = async () => {
      merges += 1;
      return "c".repeat(40);
    };
    env.deps.forge.listPullRequests = async (input) => {
      if (input.repoUrl.endsWith("/api")) {
        return [listedPull({ number: 1, branch: input.head, base: input.base, state: "merged" })];
      }
      return [
        listedPull({
          number: input.repoUrl.endsWith("/web") ? 2 : 3,
          branch: input.head,
          base: input.base,
          state: "open",
          headSha: OPEN_SHA,
        }),
      ];
    };
    env.deps.forge.quality = async (input) => {
      if (input.repoUrl.endsWith("/mobile")) throw new Error("mobile quality unread");
      return { state: "success", detail: "quality success" };
    };
    env.deps.forge.mergeability = async () => ({ state: "clean", headSha: OPEN_SHA });
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    await seedWorkOrder(env, audit("api, web, mobile"));
    const result = await runTicket(
      env.deps,
      ticket({ comments: [{ body: audit("api, web, mobile") }] }),
    );
    assert.equal(merges, 0);
    assert.equal(starts, 0);
    assert.equal(result.outcome, "land-blocked");
    assert.match(result.detail, /mobile quality unread/);
  });

  it("leaves a named repo that still has its own commits on the ground path", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    surfaceBoard(env);
    env.deps.forge.compare = async () => "ahead";
    env.deps.forge.listPullRequests = async (input) =>
      input.repoUrl.endsWith("/api")
        ? [listedPull({ number: 1, branch: input.head, base: input.base, state: "merged" })]
        : [];
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    await seedWorkOrder(env, audit("api, mobile"));
    const result = await runTicket(
      env.deps,
      ticket({ comments: [{ body: audit("api, mobile") }] }),
    );
    assert.equal(result.outcome, "verdict");
    assert.equal(starts, 1);
    assert.equal(env.state(), "Todo");
  });

  it("requires completed delivery before invoking a ship stage", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = {
      ...pack,
      status: { ...pack.status, complete: "Delivery Complete", shipped: "Shipped" },
      promotionStages: [
        { id: "publish", target: "artifact-zone", authorization: "ship", promoteCommand: "promote", repos: ["api"], verifyCommand: "verify", continueCommand: "continue", parkSuccess: true, writeStatus: true },
      ],
    };
    let commands = 0;
    env.deps.runPackCommand = () => {
      commands += 1;
      return { status: 0, stdout: "" };
    };
    await assert.rejects(() => ship(env.deps, "API-1"), /ship requires Delivery Complete/);
    assert.equal(commands, 0);
  });

  it("uses continueCommand for the active ship stage and writes shipped after every receipt passes", async () => {
    const env = harness(BUILDABLE);
    const stage: PromotionStage = {
      id: "publish",
      target: "artifact-zone",
      authorization: "ship",
      promoteCommand: "promote",
      continueCommand: "continue",
      repos: ["api"],
      verifyCommand: "verify",
      parkSuccess: false,
      writeStatus: true,
    };
    env.deps.pack = {
      ...pack,
      status: { ...pack.status, complete: "Delivery Complete", shipped: "Shipped" },
      promotionStages: [stage],
    };
    assert.equal((await runTicket(env.deps, ticket())).outcome, "landed");
    const state = await env.deps.tracker.stateStore.readDeliveryState("API-1");
    await env.deps.tracker.stateStore.writeDeliveryState("API-1", {
      ...state,
      markers: [...state.markers, {
        kind: "active-promotion-stage",
        body: JSON.stringify({ stageId: stage.id, target: stage.target, authorization: "ship", criteriaRevision: ticket().criteriaRevision }),
        createdAt: new Date(0).toISOString(),
      }],
    });
    const events: string[] = [];
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
      events.push(command);
      return command === "verify"
        ? { status: 0, stdout: receiptFor({ stageId: input.stageId, target: input.target, criteriaRevision: input.criteriaRevision ?? "", deployed: input.landedShas ?? [] }) }
        : { status: 0, stdout: "" };
    };
    const result = await ship(env.deps, "API-1", "continue");
    assert.equal(result.exitCode, 0);
    assert.equal(result.parked, false);
    assert.deepEqual(events, ["continue", "verify"]);
    assert.equal(env.state(), "Shipped");
    assert.deepEqual(env.statusRevisions, [ticket().criteriaRevision, ticket().criteriaRevision]);
  });

  it("does not write shipped for a parked stage even when parkSuccess is true", async () => {
    const env = harness(BUILDABLE);
    const stage: PromotionStage = {
      id: "approval",
      target: "approval-gate",
      authorization: "ship",
      promoteCommand: "promote",
      repos: ["api"],
      verifyCommand: "verify",
      parkSuccess: true,
      writeStatus: true,
    };
    env.deps.pack = {
      ...pack,
      status: { ...pack.status, complete: "Delivery Complete", shipped: "Shipped" },
      promotionStages: [stage],
    };
    assert.equal((await runTicket(env.deps, ticket())).outcome, "landed");
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      if (command !== "verify") return { status: 0, stdout: "" };
      const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
      return {
        status: 0,
        stdout: receiptFor({
          stageId: input.stageId,
          target: input.target,
          criteriaRevision: input.criteriaRevision ?? "",
          deployed: input.landedShas ?? [],
          outcome: "parked",
          reason: "awaiting separate authority",
        }),
      };
    };
    const result = await ship(env.deps, "API-1");
    assert.equal(result.exitCode, 0);
    assert.equal(result.parked, true);
    assert.equal(env.state(), "Delivery Complete");
    assert.equal(env.deliveryState().stageReceipts[0]?.outcome, "parked");
    assert.deepEqual(env.statusRevisions, [ticket().criteriaRevision]);
    stage.parkSuccess = false;
    const notSuccessful = await ship(env.deps, "API-1");
    assert.equal(notSuccessful.exitCode, 2);
    assert.equal(notSuccessful.parked, true);
    assert.equal(env.state(), "Delivery Complete");
  });
  it("does not write shipped when every ship stage disables writeStatus", async () => {
    const env = harness(BUILDABLE);
    const stage: PromotionStage = {
      id: "manual-record",
      target: "completion-record",
      authorization: "ship",
      promoteCommand: "promote",
      repos: ["api"],
      verifyCommand: "verify",
      parkSuccess: false,
      writeStatus: false,
    };
    env.deps.pack = {
      ...pack,
      status: { intake: "Todo", complete: "Delivery Complete" },
      promotionStages: [stage],
    };
    assert.equal((await runTicket(env.deps, ticket())).outcome, "landed");
    env.deps.runPackCommand = (command, _cwd, stdin) => {
      if (command !== "verify") return { status: 0, stdout: "" };
      const input = JSON.parse(stdin) as { stageId: string; target: string; criteriaRevision?: string; landedShas?: { repo: string; sha: string }[] };
      return { status: 0, stdout: receiptFor({ stageId: input.stageId, target: input.target, criteriaRevision: input.criteriaRevision ?? "", deployed: input.landedShas ?? [] }) };
    };
    const result = await ship(env.deps, "API-1");
    assert.equal(result.exitCode, 0);
    assert.equal(result.parked, false);
    assert.equal(env.state(), "Delivery Complete");
    assert.deepEqual(env.statusRevisions, [ticket().criteriaRevision]);
  });
});

describe("ci fix limit", () => {
  function withFixMax(value: string | undefined, run: () => void) {
    const previous = process.env.DELIVERY_LOOP_CI_FIX_MAX;
    if (value === undefined) delete process.env.DELIVERY_LOOP_CI_FIX_MAX;
    else process.env.DELIVERY_LOOP_CI_FIX_MAX = value;
    try {
      run();
    } finally {
      if (previous === undefined) delete process.env.DELIVERY_LOOP_CI_FIX_MAX;
      else process.env.DELIVERY_LOOP_CI_FIX_MAX = previous;
    }
  }

  it("reads DELIVERY_LOOP_CI_FIX_MAX", () => {
    const env = harness(BUILDABLE);
    withFixMax("3", () => {
      assert.equal(ciFixLimit({ ...env.deps, ciFixMax: undefined }), 3);
    });
  });

  it("uses 5 when the variable is unset or not a positive integer", () => {
    const env = harness(BUILDABLE);
    withFixMax(undefined, () => {
      assert.equal(ciFixLimit({ ...env.deps, ciFixMax: undefined }), 5);
    });
    for (const raw of ["0", "-2", "no", ""]) {
      withFixMax(raw, () => {
        assert.equal(ciFixLimit({ ...env.deps, ciFixMax: undefined }), 5);
      });
    }
  });

  it("uses the caller override before the environment", () => {
    const env = harness(BUILDABLE);
    withFixMax("3", () => {
      assert.equal(ciFixLimit({ ...env.deps, ciFixMax: 1 }), 1);
      assert.equal(ciFixLimit({ ...env.deps, ciFixMax: 0 }), 0);
    });
  });
});
