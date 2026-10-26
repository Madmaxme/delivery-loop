import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";
import type { CompileProgramResult } from "./linear-harness-policy.ts";
import { repoCheckoutDir, runTicket, ship, sweep, sweepNeedsAnotherPage } from "./loop.ts";

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
**Prior request:** none
**Outside grant:** none
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
  });

  it("stops the land when the quality command fails", async () => {
    const env = harness(BUILDABLE);
    env.deps.pack = { ...pack, check: "command", runner: "local" };
    env.deps.runCommand = () => ({ status: 1 });
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "quality-failed");
    assert.match(result.detail, /pull\/4/);
    assert.equal(env.merged(), false);
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
    assert.equal(n, 2);
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

  it("rebuilds when the install branch already failed quality", async () => {
    const env = harness(BUILDABLE, { quality: "failure" });
    env.deps.pack = { ...pack, branchTemplate: "cursor/{issue}-{repo}" };
    env.deps.lookupHead = (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null);
    let prompt = "";
    env.deps.worker.start = async (input) => {
      prompt = input.prompt;
      return { runId: "run-1" };
    };
    const result = await runTicket(env.deps, ticket());
    assert.match(prompt, /Quality failed on `api` branch `cursor\/api-1-api`/);
    assert.equal(result.outcome, "quality-failed");
    assert.equal(env.merged(), false);
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
    assert.equal(sweepNeedsAnotherPage([result]), false);
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
