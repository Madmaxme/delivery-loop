import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";
import type { CompileProgramResult } from "./linear-harness-policy.ts";
import { formatTicketProgress, latestLandMarker, repoCheckoutDir, runTicket, ship, sortByPack, sweep, sweepNeedsAnotherPage } from "./loop.ts";

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
      return ticket({ identifier: id, comments: comments.map((body) => ({ body })) });
    },
    async comment(_id, body) {
      comments.push(body);
    },
    async setState(_id, next) {
      state = next;
    },
    async addLabel() {},
    async removeLabel() {},
    async projectSnapshot() {
      return null;
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
    merged: () => merged,
    state: () => state,
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
BUILD_PACKET -->
`;

describe("loop", () => {
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
    assert.doesNotMatch(prompt, /money\//);
    assert.match(prompt, /every caller uses that owner/);
    assert.match(prompt, /Prior request/);
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
      if (input.prompt.includes("Resolve the merge conflict")) {
        conflicts += 1;
        moved = true;
      }
      return start(input);
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(conflicts, 1);
    assert.equal(env.merged(), true);
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

  it("continues the sweep after one ticket cannot merge", async () => {
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
      ["land-blocked", "landed"],
    );
    assert.equal(merged, 1);
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
        blockedBy: [{ identifier: "API-1", stateName: reads === 1 ? "Todo" : "Dev" }],
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
    assert.match(build, /The install owns the concrete proof/);
    assert.ok(build.indexOf("The install owns the concrete proof") < build.indexOf("INSTALL BUILD DOC"));
  });

  it("marks comments before the latest handoff as historical and includes the program", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    const program: CompileProgramResult = {
      warnings: [],
      states: { "API-1": "Todo", "API-2": "Dev" },
      program: {
        id: "billing",
        spec: "https://example.test/project",
        projectName: "Billing",
        slices: [
          {
            id: "stage-1",
            title: "Stage 1",
            afkTo: "dev",
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
    const fix = prompts.find((text) => text.includes("Fix the failing quality check"));
    assert.ok(fix);
    assert.match(fix ?? "", /cursor\/api-1-api/);
    assert.match(fix ?? "", /do not replace it with the older trunk copy/);
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
      if (input.prompt.includes("Fix the failing quality check")) head = "def";
      return { runId: "run-1" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Dev");
  });

  it("keeps a running check on the install branch for the next page", async () => {
    const env = harness(BUILDABLE, { quality: "pending" });
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null);
    let builds = 0;
    env.deps.worker.start = async (input) => {
      if (input.prompt.includes("Push these branches")) builds += 1;
      return { runId: "run-1" };
    };
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
    assert.equal(result.outcome, "quality-unscheduled");
    assert.equal(env.comments.some((body) => /did not start/.test(body)), true);
    assert.equal(env.comments.some((body) => /still running/.test(body)), false);
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

  it("stays in intake when a buildable handoff says ask", async () => {
    const env = harness(BUILDABLE.replace("**Prior request:** none", "**Prior request:** ask"));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "prior-request-ask");
    assert.equal(env.merged(), false);
    assert.equal(env.state(), "Todo");
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
    assert.equal(env.state(), "Dev");
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

  it("marks dev-done when the recording URL is in the build receipt", async () => {
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
    assert.equal(env.state(), "Dev");
  });

  it("leaves the ticket in intake when the recording URL never reaches the build receipt", async () => {
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
    assert.equal(env.comments.some((body) => /LAND_WAIT/.test(body)), false);
  });

  it("marks dev-done when the route test is on the merge commit", async () => {
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      "**Journey evidence:** recorded\n**Journey proof:** `api/test/signup_route_test.dart`",
    );
    const env = harness(ground);
    env.deps.journeyFileAt = ({ repo, ref, path }) =>
      repo === "api" && ref === "trunk" && path === "test/signup_route_test.dart";
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.equal(env.state(), "Dev");
  });

  it("leaves the ticket in intake when the route test is not on the merge commit", async () => {
    const ground = BUILDABLE.replace(
      "**Journey evidence:** not-applicable",
      "**Journey evidence:** recorded\n**Journey proof:** `api/test/signup_route_test.dart`",
    );
    const env = harness(ground);
    env.deps.journeyFileAt = () => false;
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "journey-missing");
    assert.equal(env.merged(), true);
    assert.equal(env.state(), "Todo");
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
    assert.equal(env.state(), "Hold");
  });

  it("loads each ticket's project into the ground prompt", async () => {
    const env = harness("**Verdict:** NEEDS DIAGNOSIS");
    env.deps.tracker.listIntake = async () => [ticket({ projectName: "Billing" })];
    let saw = "";
    env.deps.tracker.projectSnapshot = async (name) => {
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
    assert.match(prompt, /Hold \/ Dev/);
    assert.doesNotMatch(prompt, /Shaping|Soon|qws-workspace|QuickWash/);
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
          { body: `<!-- DELIVERY_LEASE expires=${future} cursor_run=pending cursor_phase=ground -->` },
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
          { body: `<!-- DELIVERY_LEASE expires=${future} gha_run=42 cursor_run=run-9 cursor_phase=ground -->` },
        ],
      }),
    );
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

  it("does not open a pull request when the branch is already on trunk", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = () => "abc1234";
    env.deps.forge.compare = async () => "identical";
    let opened = 0;
    env.deps.forge.openPullRequest = async () => {
      opened += 1;
      return {
        number: 1,
        url: "https://github.com/acme/api/pull/1",
        headSha: "abc1234",
        branch: "cursor/api-1-api",
        created: true,
      };
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
    const marker = env.comments.find((body) => body.includes("LAND_EMPTY")) ?? "";
    assert.match(marker, /api abc1234/);
    starts = 0;
    const second = await runTicket(
      env.deps,
      ticket({ comments: [{ body: marker }] }),
    );
    assert.equal(second.outcome, "land-empty");
    assert.equal(starts, 0);
    assert.equal(env.state(), "Todo");
  });

  it("waits for trunk quality before marking dev", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    env.deps.forge.quality = async (input) =>
      input.headSha === "trunk"
        ? { state: "failure", detail: "trunk red" }
        : { state: "success", detail: "quality success" };
    const result = await runTicket(env.deps, ticket());
    assert.equal(starts, 2);
    assert.equal(result.outcome, "trunk-waiting");
    assert.equal(env.state(), "Todo");
    assert.equal(env.merged(), true);
    assert.match(env.comments.join("\n"), /LAND_WAIT/);
    assert.match(env.comments.join("\n"), /hold=0/);
    assert.match(env.comments.join("\n"), /api trunk/);
    assert.equal(sweepNeedsAnotherPage([result]), true);
  });

  it("accepts a green trunk tip that contains the merge", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    env.deps.lookupHead = () => "green";
    env.deps.forge.compare = async () => "ahead";
    env.deps.forge.quality = async (input) =>
      input.headSha === "green"
        ? { state: "success", detail: "quality success" }
        : { state: "failure", detail: "old red" };
    const result = await runTicket(
      env.deps,
      ticket({ comments: [{ body: "<!-- LAND_WAIT\nhold=0\napi oldred\n-->" }] }),
    );
    assert.equal(result.outcome, "landed");
    assert.equal(starts, 0);
    assert.equal(env.state(), "Dev");
  });

  it("marks dev on the next sweep when the recorded trunk commit is green", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    const waiting = await runTicket(
      env.deps,
      ticket({ comments: [{ body: "<!-- LAND_WAIT\nhold=0\napi trunk\n-->" }] }),
    );
    assert.equal(waiting.outcome, "landed");
    assert.equal(starts, 0);
    assert.equal(env.state(), "Dev");
    assert.equal(env.comments.some((body) => body.includes("LAND_WAIT")), false);
  });

  it("leaves the trunk marker in place while quality is still red", async () => {
    const env = harness(BUILDABLE);
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    const lines: string[] = [];
    env.deps.report = (event) => {
      lines.push(formatTicketProgress(event));
    };
    env.deps.forge.quality = async () => ({ state: "pending", detail: "quality in_progress" });
    const result = await runTicket(
      env.deps,
      ticket({ comments: [{ body: "<!-- LAND_WAIT\nhold=1\napi trunk\n-->" }] }),
    );
    assert.equal(starts, 0);
    assert.equal(result.outcome, "trunk-waiting");
    assert.deepEqual(lines, ["API-1 land", "API-1 trunk-waiting api trunk"]);
    assert.equal(env.state(), "Todo");
    assert.equal(sweepNeedsAnotherPage([result]), true);
  });

  it("promotes only the mobile repos this ticket landed", async () => {
    const env = harness(
      BUILDABLE.replace("**Repos:** `api`", "**Repos:** `customer-app, api`"),
    );
    const api = { name: "api", url: "https://github.com/acme/api", trunk: "development" };
    const client = { name: "customer-app", url: "https://github.com/acme/customer-app", trunk: "main" };
    const commands: string[] = [];
    env.deps.pack = {
      ...pack,
      repos: [api, client],
      branchTemplate: "cursor/{issue}-{repo}",
      dev: {
        promote: {
          command: "./scripts/promote.sh dev --repo {repo}",
          repos: ["customer-app", "operator-app"],
        },
      },
    };
    env.deps.lookupHead = () => "abc1234";
    env.deps.runCommand = (command) => {
      commands.push(command);
      return { status: 0 };
    };
    env.deps.forge.openPullRequest = async (input) => ({
      number: commands.length + 1,
      url: `${input.repoUrl}/pull/1`,
      headSha: "abc1234",
      branch: input.head,
      created: true,
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "landed");
    assert.deepEqual(commands, ["./scripts/promote.sh dev --repo customer-app"]);
    assert.equal(env.state(), "Dev");
  });

  it("retries promote on the next sweep without grounding again", async () => {
    const env = harness(BUILDABLE);
    let fail = true;
    const commands: string[] = [];
    env.deps.pack = {
      ...pack,
      dev: {
        promote: {
          command: "./scripts/promote.sh dev --repo {repo}",
          repos: ["api"],
        },
      },
    };
    env.deps.runCommand = (command) => {
      commands.push(command);
      return { status: fail ? 1 : 0 };
    };
    const first = await runTicket(env.deps, ticket());
    assert.equal(first.outcome, "quality-failed");
    assert.equal(env.state(), "Todo");
    const marker = env.comments.find((body) => body.includes("LAND_WAIT")) ?? "";
    assert.equal(latestLandMarker([{ body: marker }])?.kind, "wait");
    fail = false;
    commands.length = 0;
    let starts = 0;
    env.deps.worker.start = async () => {
      starts += 1;
      return { runId: "run-1" };
    };
    const second = await runTicket(env.deps, ticket({ comments: [{ body: marker }] }));
    assert.equal(second.outcome, "landed");
    assert.equal(starts, 0);
    assert.deepEqual(commands, ["./scripts/promote.sh dev --repo api"]);
    assert.equal(env.state(), "Dev");
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
