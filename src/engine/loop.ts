import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CompareStatus, ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { agentHome, holdStatus, repoByName, unblockingStates, type ProjectPack, type RepoSpec } from "../schema/pack.js";
import { isGithubActionsRunActive } from "./github-run-status.js";
import {
  compileDeliveryProgramFromLinear,
  currentProgramSlice,
  evaluateGraphReady,
  formatDeliveryProgramContext,
  formatGroundingCommentSample,
  latestDeliveryLeaseStamp,
  landingShaNeedsRebuild,
  pageBudgetRemainingMs,
  qualityRunUnscheduled,
  QUALITY_NO_RUN_MS,
  shouldStealDeliveryLease,
  shouldStopForPageReserve,
  unscheduledQualityDue,
  DELIVERY_LEASE_TTL_MS,
  type CompileProgramResult,
  type DeliveryLeaseStamp,
} from "./linear-harness-policy.js";
import { confirmLandBranches, lookupRemoteHead, renderBranch } from "./land-branches.js";
import {
  invariantExists,
  parkStateForVerdict,
  parseOutsideGrant,
  parseVerdict,
  parseWorkOrder,
  priorRequestBlocksBuild,
  type Verdict,
} from "./packet.js";

export type LoopDeps = {
  pack: ProjectPack;
  tracker: TrackerAdapter;
  worker: WorkerAdapter;
  forge: ForgeAdapter;
  nowMs?: number;
  pageStartedAtMs?: number | null;
  invariantsMarkdown?: string;
  cwd?: string;
  maxQualityPolls?: number;
  /** Linear project name. Limits intake and loads the sibling snapshot. */
  project?: string | null;
  /** Compiled once per sweep. Ground and build prompts include it. */
  program?: CompileProgramResult | null;
  /** Override for tests. Default asks `gh` whether the stamped run is still live. */
  githubRunActive?: (runId: string | null) => boolean | null;
  /** Override for tests. Default is `git ls-remote` for refs/heads/<branch>. */
  lookupHead?: (repoUrl: string, branch: string) => string | null;
  /** Override for tests. Default waits 30s between quality checks. */
  sleep?: (ms: number) => Promise<void>;
  qualityPollMs?: number;
  /** How long a missing Actions run stays missing before the lander requests one. */
  qualityNoRunMs?: number;
  /** Fix attempts after a red quality check. Default is `DELIVERY_LOOP_CI_FIX_MAX`, then `QWS_CI_FIX_MAX`, then 5. */
  ciFixMax?: number;
  /** Runs `qualityCommand` when `check` is `command`. Default runs it in the checkout. */
  runCommand?: (command: string, cwd: string) => { status: number | null };
  /**
   * Receives one event when a ticket enters ground, build, or land, and one
   * when that ticket finishes. Default writes a single line to stdout.
   */
  report?: (event: TicketProgress) => void;
};

/** ground, build, and land are in progress. done is the ticket result. */
export type TicketProgress =
  | { identifier: string; phase: "ground" | "build" | "land" }
  | {
      identifier: string;
      phase: "done";
      outcome: TicketResult["outcome"];
      detail: string;
    };

export type TicketResult = {
  identifier: string;
  outcome:
    | "skipped-graph"
    | "skipped-lease"
    | "skipped-page"
    | "verdict"
    | "missing-connector"
    | "invalid-packet"
    | "landed"
    | "quality-failed"
    | "quality-pending"
    | "quality-unscheduled"
    | "land-blocked"
    | "land-empty"
    | "trunk-waiting"
    | "worker-failed";
  detail: string;
};

const PROGRESS_DETAIL_MAX = 200;

/** One log line. Phase lines name the wait. The done line names the result. */
export function formatTicketProgress(event: TicketProgress): string {
  if (event.phase !== "done") return `${event.identifier} ${event.phase}`;
  const detail = event.detail.replace(/\s+/g, " ").trim();
  if (!detail) return `${event.identifier} ${event.outcome}`;
  const short = detail.length > PROGRESS_DETAIL_MAX ? `${detail.slice(0, PROGRESS_DETAIL_MAX - 3)}...` : detail;
  return `${event.identifier} ${event.outcome} ${short}`;
}

function noteTicket(deps: LoopDeps, event: TicketProgress): void {
  if (deps.report) {
    deps.report(event);
    return;
  }
  process.stdout.write(`${formatTicketProgress(event)}\n`);
}

function noteDone(deps: LoopDeps, result: TicketResult): void {
  noteTicket(deps, {
    identifier: result.identifier,
    phase: "done",
    outcome: result.outcome,
    detail: result.detail,
  });
}

function leaseComment(nowMs: number, phase: string, runId: string): string {
  const expires = new Date(nowMs + DELIVERY_LEASE_TTL_MS).toISOString();
  const gha = process.env.GITHUB_RUN_ID?.trim() ?? "";
  const ghaAttr = /^\d+$/.test(gha) ? ` gha_run=${gha}` : "";
  return `<!-- DELIVERY_LEASE expires=${expires}${ghaAttr} cursor_run=${runId} cursor_phase=${phase} -->`;
}

const RELEASE_LEASE = "<!-- DELIVERY_LEASE released=1 -->";

/**
 * A `cursor_run=pending` stamp is the placeholder written before a child
 * exists. With no Actions run id there is nothing to join, so the parent
 * that wrote it is already gone. A real run id without `gha_run` stays
 * fail-closed until `expires`.
 */
function previousOwnerActive(
  stamp: DeliveryLeaseStamp,
  deps: LoopDeps,
): boolean | null {
  if (stamp.ghaRunId) {
    const ask = deps.githubRunActive ?? ((id) => isGithubActionsRunActive(id));
    return ask(stamp.ghaRunId);
  }
  if (stamp.cursorRunId === "pending") return false;
  return null;
}

function leaseIsHeld(stamp: DeliveryLeaseStamp, nowMs: number, deps: LoopDeps): boolean {
  if (stamp.expiresAt === null || nowMs >= stamp.expiresAt) return false;
  return !shouldStealDeliveryLease({
    hasLeaseLabel: true,
    expiresAt: stamp.expiresAt,
    nowMs,
    previousGhaRunActive: previousOwnerActive(stamp, deps),
  });
}

function readIfPresent(cwd: string, rel: string): string {
  const abs = join(cwd, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

function listedDocs(cwd: string, paths: string[] | undefined): string[] {
  return (paths ?? []).map((rel) => readIfPresent(cwd, rel)).filter(Boolean);
}

/** Package-owned law. Install prompt files come after this and do not replace it. */
function universalConduct(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(here, "../../conduct/conduct/SKILL.md"), "utf8");
}

const GENERIC_GROUND = [
  "Check the ticket against the code. Do not edit files. Do not call the tracker.",
  "Reply with one handoff:",
  "<!-- GROUNDING_HANDOFF",
  "VERDICT: BUILDABLE | NEEDS DIAGNOSIS | NEEDS RESCOPE | WRONG DIAGNOSIS | ALREADY SHIPPED",
  "COMMENT:",
  "BUILD_PACKET:",
  "**Repos:** `name`",
  "**Invariant:** `heading-or-prefix/slug`",
  "**Decision:** one sentence that cites the invariant id.",
  "**Symbols:** `path#symbol`",
  "## Allowlist",
  "## Validation",
  "## Stop",
  "GROUNDING_HANDOFF -->",
].join("\n");

function groundPrompt(ticket: Ticket, deps: LoopDeps): string {
  const cwd = deps.cwd ?? process.cwd();
  const docs = listedDocs(cwd, deps.pack.prompts?.ground);
  return [
    universalConduct(),
    ...(docs.length > 0 ? docs : [GENERIC_GROUND]),
    programBlock(ticket, deps, "ground"),
    `Ticket ${ticket.identifier}: ${ticket.title}`,
    ticket.body,
    "",
    "## Existing comments",
    formatGroundingCommentSample(ticket.comments),
    "",
    "This send is for this issue only. Do not edit files. Do not call the tracker.",
    "Follow the documents above. A verdict is a VERDICT: or **Verdict:** line.",
    "When the verdict is BUILDABLE, put the work order under BUILD_PACKET: inside the handoff.",
    "The invariant id is a heading in the invariants file, or `prefix/slug` from a heading file the install lists.",
    "One **Decision:** sentence that cites that id. **Symbols:** `repo/path#symbol`. **Repos:** in backticks.",
    "Every BUILDABLE handoff includes **Prior request:** none | kept | replaced <id> | ask.",
    "none means no written rule asked for the current behavior. kept means one did and this ticket keeps it. replaced names the ticket this one undoes. ask means a rule asked for the current behavior and this ticket does not undo it.",
    "ask, a missing line, or replaced without a ticket id stays in intake. The verdict stays BUILDABLE.",
    "Look only at the install's invariant and decision documents and at commit subjects that already name a ticket. No sentence means none.",
    "Every BUILDABLE handoff includes **Outside grant:** none | open.",
    "none means the done-state is code this repository can land.",
    "open means the done-state is a vendor approval, an account only a person can create, or an engine this repository does not own. Build the code this repository owns. The runner will not mark that ticket dev-done, so anything blocked by it stays blocked.",
    "A missing line stays in intake. Reading a vendor's documentation is not the grant.",
    `Enabled connectors: ${deps.pack.connectors.join(", ") || "(none)"}`,
    `Repos: ${deps.pack.repos.map((r) => r.name).join(", ")}`,
  ].join("\n\n");
}

function buildPrompt(
  ticket: Ticket,
  orderText: string,
  deps: LoopDeps,
  repos: string[],
  retry: string,
): string {
  const cwd = deps.cwd ?? process.cwd();
  const docs = listedDocs(cwd, deps.pack.prompts?.build);
  const template = deps.pack.branchTemplate;
  const branches = template
    ? repos.map((repo) => `${repo}: \`${renderBranch(template, ticket.identifier, repo)}\``)
    : [];
  return [
    universalConduct(),
    ...docs,
    programBlock(ticket, deps, "build"),
    `Implement only this work order for ${ticket.identifier}.`,
    orderText,
    branches.length
      ? `Push these branches from each repo trunk: ${branches.join(", ")}. Include repo and branch in the handoff. Do not merge.`
      : "Stay inside the allowlist. Run the validation commands. Push a branch and report the branch name and commit. Do not merge.",
    "Stay inside the allowlist. Run the validation commands.",
    retry,
  ].filter((part) => part.length > 0).join("\n\n");
}

function ciFixLimit(deps: LoopDeps): number {
  if (deps.ciFixMax != null) return deps.ciFixMax;
  const raw = process.env.DELIVERY_LOOP_CI_FIX_MAX ?? process.env.QWS_CI_FIX_MAX ?? "5";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function fixPrompt(
  ticket: Ticket,
  orderText: string,
  deps: LoopDeps,
  pr: OpenPull,
  attempt: number,
  max: number,
  detail: string,
): string {
  const cwd = deps.cwd ?? process.cwd();
  const docs = listedDocs(cwd, deps.pack.prompts?.build);
  return [
    universalConduct(),
    ...docs,
    `Fix the failing quality check on \`${pr.repo.name}\` branch \`${pr.branch}\` for ${ticket.identifier}.`,
    `Attempt ${attempt} of ${max}.`,
    `The check said: ${detail}`,
    orderText,
    `Checkout \`${pr.branch}\` in \`${pr.repo.name}\`. Fix the failure. Commit and push that same branch.`,
    `Do not open a pull request. Do not merge. Do not push \`${pr.repo.trunk}\`.`,
    "Stay inside the work order allowlist.",
    "If this branch is ahead of trunk, do not replace it with the older trunk copy. Push the fix forward on this branch.",
  ].filter((part) => part.length > 0).join("\n\n");
}

function conflictPrompt(
  ticket: Ticket,
  orderText: string,
  deps: LoopDeps,
  pr: OpenPull,
  attempt: number,
  max: number,
  reason: string,
): string {
  const cwd = deps.cwd ?? process.cwd();
  const docs = listedDocs(cwd, deps.pack.prompts?.build);
  return [
    universalConduct(),
    ...docs,
    `Resolve the merge conflict on \`${pr.repo.name}\` branch \`${pr.branch}\` for ${ticket.identifier}.`,
    `Attempt ${attempt} of ${max}.`,
    reason,
    orderText,
    `Checkout \`${pr.branch}\` in \`${pr.repo.name}\`. Rebase it onto \`${pr.repo.trunk}\` and resolve every conflict.`,
    `Commit and push that same branch. Do not open a pull request. Do not merge. Do not push \`${pr.repo.trunk}\`.`,
    "Keep the branch's own commits. Do not replace the branch with a copy of trunk.",
  ].filter((part) => part.length > 0).join("\n\n");
}

function commentBodies(ticket: Ticket): string[] {
  return ticket.comments.map((comment) => comment.body);
}

function programBlock(ticket: Ticket, deps: LoopDeps, phase: "ground" | "build"): string {
  const compiled = deps.program;
  if (!compiled) return "";
  const board = {
    unblocking: unblockingStates(deps.pack),
    backlog: deps.pack.status.backlog ?? null,
    hold: holdStatus(deps.pack),
    dev: deps.pack.status.dev,
    intake: deps.pack.status.intake,
  };
  const slice = currentProgramSlice(compiled.program, compiled.states, new Set(), board);
  const snapshot = formatDeliveryProgramContext({
    program: compiled.program,
    states: compiled.states,
    cursorSliceId: slice?.id ?? null,
    currentIssueId: ticket.identifier,
    board,
  });
  const conduct =
    phase === "ground"
      ? "When this snapshot is present, include **Program graph:** in the audit (cursor slice, plus the blockers and siblings you relied on). Re-ground unless the latest audit already has **Program graph:** and the ids and states match."
      : "Extend primitives already delivered on other slices. Do not implement sibling tickets.";
  return `${snapshot}\n\n${conduct}`;
}

/** The agent checkout is the process directory. Every other repo is a subdirectory. */
export function repoCheckoutDir(cwd: string, spec: RepoSpec, pack: ProjectPack): string {
  if (pack.agent?.url && githubSlug(pack.agent.url) === githubSlug(spec.url)) return cwd;
  return join(cwd, spec.name);
}

function githubSlug(url: string): string {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : url.toLowerCase();
}

function landingTargets(
  pack: ProjectPack,
  orderRepos: string[],
  branches: { repoUrl: string; branch: string }[] | undefined,
  fallbackBranch: string | undefined,
  fallbackRepo: RepoSpec,
): { repo: RepoSpec; branch: string }[] | null {
  const pushed = (branches ?? []).filter((row) => row.branch);
  if (pushed.length === 0) {
    return fallbackBranch ? [{ repo: fallbackRepo, branch: fallbackBranch }] : null;
  }
  const targets: { repo: RepoSpec; branch: string }[] = [];
  for (const name of orderRepos) {
    const repo = repoByName(pack, name);
    if (!repo) return null;
    const hit = pushed.find((row) => githubSlug(row.repoUrl) === githubSlug(repo.url));
    if (!hit) return null;
    targets.push({ repo, branch: hit.branch });
  }
  return targets.length ? targets : null;
}

function trunkHasTicketCommit(deps: LoopDeps, identifier: string, text: string): boolean | null {
  const named = [...text.matchAll(/\*\*Repos:\*\*\s*(.+)/gi)].flatMap((match) =>
    [...match[1].matchAll(/`([^`]+)`/g)].map((item) => item[1].trim()),
  );
  const repos = named.length ? named : [];
  if (repos.length === 0) return false;
  const cwd = deps.cwd ?? process.cwd();
  let unknown = false;
  for (const name of repos) {
    const spec = repoByName(deps.pack, name);
    if (!spec) {
      unknown = true;
      continue;
    }
    const dir = repoCheckoutDir(cwd, spec, deps.pack);
    if (!existsSync(join(dir, ".git"))) {
      unknown = true;
      continue;
    }
    const result = spawnSync(
      "git",
      ["-C", dir, "log", spec.trunk, "--grep", identifier, "-1", "--format=%H"],
      { encoding: "utf8" },
    );
    if (result.status === 0 && result.stdout.trim()) return true;
  }
  return unknown ? null : false;
}

async function finishWorker(worker: WorkerAdapter, runId: string) {
  const joined = await worker.join(runId);
  if (joined.status === "failed") {
    throw new Error(joined.text || "worker failed");
  }
  return joined;
}

export async function runTicket(deps: LoopDeps, ticket: Ticket): Promise<TicketResult> {
  const result = await executeTicket(deps, ticket);
  noteDone(deps, result);
  return result;
}

async function executeTicket(deps: LoopDeps, ticket: Ticket): Promise<TicketResult> {
  const now = deps.nowMs ?? Date.now();
  const remaining = pageBudgetRemainingMs({
    nowMs: now,
    startedAtMs: deps.pageStartedAtMs ?? null,
  });
  if (shouldStopForPageReserve({ remainingMs: remaining })) {
    return { identifier: ticket.identifier, outcome: "skipped-page", detail: "page reserve" };
  }

  const graph = evaluateGraphReady(
    ticket.identifier,
    ticket.blockedBy,
    unblockingStates(deps.pack),
  );
  if (!graph.ready) {
    return {
      identifier: ticket.identifier,
      outcome: "skipped-graph",
      detail: graph.reasons.join("; "),
    };
  }

  const lease = latestDeliveryLeaseStamp(commentBodies(ticket));
  if (leaseIsHeld(lease, now, deps)) {
    return { identifier: ticket.identifier, outcome: "skipped-lease", detail: "lease held" };
  }

  const home = agentHome(deps.pack);
  await deps.tracker.comment(ticket.identifier, leaseComment(now, "ground", "pending"));
  try {
    return await runHeldTicket(deps, ticket, home);
  } finally {
    await deps.tracker.comment(ticket.identifier, RELEASE_LEASE).catch(() => undefined);
  }
}

async function runHeldTicket(
  deps: LoopDeps,
  ticket: Ticket,
  home: { url: string; trunk: string },
): Promise<TicketResult> {
  const resumed = await resumeMarkedLand(deps, ticket);
  if (resumed) return resumed;
  let ground;
  noteTicket(deps, { identifier: ticket.identifier, phase: "ground" });
  try {
    const started = await deps.worker.start({
      prompt: groundPrompt(ticket, deps),
      repoUrl: home.url,
      baseRef: home.trunk,
    });
    ground = await finishWorker(deps.worker, started.runId);
  } catch (error) {
    return {
      identifier: ticket.identifier,
      outcome: "worker-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const verdict: Verdict | null = parseVerdict(ground.text);
  if (verdict !== "BUILDABLE") {
    await deps.tracker.comment(
      ticket.identifier,
      `**Verdict:** ${verdict ?? "MISSING"}\n\n${ground.text}`,
    );
    if (verdict) {
      const parked = parkStateForVerdict({
        verdict,
        text: ground.text,
        priorComments: commentBodies(ticket),
        devStatus: deps.pack.status.dev,
        holdStatus: holdStatus(deps.pack),
        trunkCommit:
          verdict === "ALREADY SHIPPED"
            ? trunkHasTicketCommit(deps, ticket.identifier, ground.text)
            : null,
      });
      if (parked) await deps.tracker.setState(ticket.identifier, parked);
    }
    return {
      identifier: ticket.identifier,
      outcome: "verdict",
      detail: verdict ?? "missing verdict",
    };
  }

  const grant = parseOutsideGrant(ground.text);
  if (!grant) {
    await deps.tracker.comment(
      ticket.identifier,
      "BUILDABLE requires **Outside grant:** none | open. The ticket stays in intake.",
    );
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: "outside-grant" };
  }

  const prior = priorRequestBlocksBuild(ground.text);
  if (prior) {
    const reason =
      prior === "ask"
        ? "BUILDABLE **Prior request:** ask does not build. The ticket stays in intake."
        : prior === "replaced"
          ? "BUILDABLE **Prior request:** replaced requires a ticket id. The ticket stays in intake."
          : "BUILDABLE requires **Prior request:** none | kept | replaced <id> | ask. The ticket stays in intake.";
    await deps.tracker.comment(ticket.identifier, reason);
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: `prior-request-${prior}` };
  }

  const order = parseWorkOrder(ground.text);
  if (!order) {
    await deps.tracker.comment(
      ticket.identifier,
      `BUILDABLE without a complete work order.\n\n${ground.text.slice(0, 4000)}`,
    );
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: "packet" };
  }
  const invariants =
    deps.invariantsMarkdown ??
    readFileSync(deps.pack.invariantsFile, "utf8");
  if (
    !invariantExists(
      invariants,
      order.invariant,
      deps.cwd ?? process.cwd(),
      deps.pack.invariantHeadings,
    )
  ) {
    return {
      identifier: ticket.identifier,
      outcome: "invalid-packet",
      detail: `unknown invariant ${order.invariant}`,
    };
  }
  for (const name of order.repos) {
    if (!repoByName(deps.pack, name)) {
      return {
        identifier: ticket.identifier,
        outcome: "invalid-packet",
        detail: `repo ${name} is not in the pack`,
      };
    }
  }
  if (order.connector && !deps.pack.connectors.includes(order.connector)) {
    const command = `npx @delivery-loop/cli connector add ${order.connector}`;
    await deps.tracker.comment(
      ticket.identifier,
      `Missing connector \`${order.connector}\`. Add it with \`${command}\`. The rest of the backlog still runs.`,
    );
    return {
      identifier: ticket.identifier,
      outcome: "missing-connector",
      detail: command,
    };
  }

  const target = repoByName(deps.pack, order.repos[0])!;
  const lookup = deps.lookupHead ?? lookupRemoteHead;
  let landings: { repo: RepoSpec; branch: string; sha?: string }[] | null = deps.pack.branchTemplate
    ? confirmLandBranches({
        issue: ticket.identifier,
        repos: order.repos,
        packRepos: deps.pack.repos,
        template: deps.pack.branchTemplate,
        text: ground.text,
        reported: [],
        lookup,
      })
    : null;
  let retry = "";
  if (landings) {
    const probes = await Promise.all(
      landings.map(async (landing) => ({
        landing,
        probe: landing.sha
          ? await deps.forge.quality({
              repoUrl: landing.repo.url,
              headSha: landing.sha,
              workflow: deps.pack.qualityWorkflow,
            })
          : { state: "failure" as const, detail: "no sha" },
      })),
    );
    const failed = probes.filter((row) => landingShaNeedsRebuild(row.probe));
    if (failed.length > 0) {
      landings = null;
      retry = failed
        .map(
          (row) =>
            `Quality failed on \`${row.landing.repo.name}\` branch \`${row.landing.branch}\` at \`${row.landing.sha ?? ""}\`. Push a new commit on that branch. A no-op leaves the red check in place.`,
        )
        .join("\n");
    }
  }
  if (!landings) {
    let built;
    noteTicket(deps, { identifier: ticket.identifier, phase: "build" });
    try {
      const started = await deps.worker.start({
        prompt: buildPrompt(ticket, ground.text, deps, order.repos, retry),
        repoUrl: home.url,
        baseRef: home.trunk,
      });
      built = await finishWorker(deps.worker, started.runId);
    } catch (error) {
      return {
        identifier: ticket.identifier,
        outcome: "worker-failed",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const reported = landingTargets(deps.pack, order.repos, built.branches, built.branch, target);
    landings = reported?.map((row) => ({ repo: row.repo, branch: row.branch })) ?? null;
    if (!landings) {
      landings = confirmLandBranches({
        issue: ticket.identifier,
        repos: order.repos,
        packRepos: deps.pack.repos,
        template: deps.pack.branchTemplate,
        text: `${ground.text}\n${built.text}`,
        reported: built.branches ?? [],
        lookup,
      });
    }
    if (!landings) {
      return { identifier: ticket.identifier, outcome: "worker-failed", detail: "no branch" };
    }
  }

  const opened: OpenPull[] = [];
  const empty: { repo: string; sha: string }[] = [];
  for (const landing of sortByPack(deps.pack, landings, (row) => row.repo.name)) {
    const head = landing.sha || landing.branch;
    let compared: CompareStatus = "unknown";
    try {
      compared = await deps.forge.compare({
        repoUrl: landing.repo.url,
        base: landing.repo.trunk,
        head,
      });
    } catch {
      compared = "unknown";
    }
    if (compared === "identical" || compared === "behind") {
      const lookup = deps.lookupHead ?? lookupRemoteHead;
      const sha = landing.sha || lookup(landing.repo.url, landing.branch) || head;
      empty.push({ repo: landing.repo.name, sha });
      continue;
    }
    const pr = await deps.forge.openPullRequest({
      repoUrl: landing.repo.url,
      title: `${ticket.identifier}: ${order.decision}`,
      body: ground.text,
      head: landing.branch,
      base: landing.repo.trunk,
    });
    opened.push({
      repo: landing.repo,
      number: pr.number,
      url: pr.url,
      headSha: landing.sha || pr.headSha,
      branch: landing.branch,
      created: pr.created,
    });
  }
  if (opened.length === 0) {
    await deps.tracker.comment(ticket.identifier, landEmptyMarker(empty));
    return {
      identifier: ticket.identifier,
      outcome: "land-empty",
      detail: empty.map((row) => `${row.repo} ${row.sha}`).join(" "),
    };
  }
  noteTicket(deps, { identifier: ticket.identifier, phase: "land" });
  const merged: MergedHead[] = [];
  for (const pr of opened) {
    try {
      const landed = await landPull(deps, ticket, pr, ground.text);
      if ("outcome" in landed) return landed;
      merged.push({ repo: pr.repo, sha: landed.mergedSha, url: pr.url });
    } catch (error) {
      const paused = pauseLand(
        ticket.identifier,
        pr.url,
        error instanceof Error ? error.message : String(error),
      );
      await deps.tracker.comment(ticket.identifier, paused.detail);
      return paused;
    }
  }
  return finishMerged(deps, ticket, grant === "open", merged);
}

const QUALITY_POLL_MS = 30_000;
const MERGE_SETTLE_MS = 2_000;
const MAX_BRANCH_UPDATES = 2;

type OpenPull = {
  repo: RepoSpec;
  number: number;
  url: string;
  headSha: string;
  branch: string;
  created: boolean;
};

type MergedHead = { repo: RepoSpec; sha: string; url: string };

type LandPullResult = TicketResult | { mergedSha: string };

/** Pack order. Names the pack does not list sort last. Work-order order does not win. */
export function sortByPack<T>(pack: ProjectPack, rows: readonly T[], name: (row: T) => string): T[] {
  const rank = new Map(pack.repos.map((repo, index) => [repo.name, index]));
  return [...rows].sort((a, b) => {
    const left = rank.get(name(a)) ?? Number.MAX_SAFE_INTEGER;
    const right = rank.get(name(b)) ?? Number.MAX_SAFE_INTEGER;
    return left - right;
  });
}

function devCommands(pack: ProjectPack, landed: string[]): string[] {
  const promote = pack.dev?.promote;
  if (promote?.command) {
    const allowed = new Set(promote.repos ?? []);
    const seen = new Set<string>();
    const commands: string[] = [];
    for (const repo of landed) {
      if (!allowed.has(repo) || seen.has(repo)) continue;
      seen.add(repo);
      commands.push(promote.command.replaceAll("{repo}", repo));
    }
    return commands;
  }
  return pack.dev?.steps ?? [];
}

function landWaitMarker(hold: boolean, rows: { repo: string; sha: string }[]): string {
  const lines = ["<!-- LAND_WAIT", `hold=${hold ? "1" : "0"}`];
  for (const row of rows) lines.push(`${row.repo} ${row.sha}`);
  lines.push("-->");
  return lines.join("\n");
}

function landEmptyMarker(rows: { repo: string; sha: string }[]): string {
  const lines = ["<!-- LAND_EMPTY"];
  for (const row of rows) lines.push(`${row.repo} ${row.sha}`);
  lines.push("-->");
  return lines.join("\n");
}

type LandMarker =
  | { kind: "wait"; hold: boolean; rows: { repo: string; sha: string }[] }
  | { kind: "empty"; rows: { repo: string; sha: string }[] };

function markerRows(body: string): { hold: boolean; rows: { repo: string; sha: string }[] } {
  let hold = false;
  const rows: { repo: string; sha: string }[] = [];
  for (const line of body.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("-->") || trimmed.startsWith("<!--")) break;
    const holdLine = /^hold=([01])$/.exec(trimmed);
    if (holdLine) {
      hold = holdLine[1] === "1";
      continue;
    }
    const [repo, sha] = trimmed.split(/\s+/);
    if (repo && sha) rows.push({ repo, sha });
  }
  return { hold, rows };
}

/** Latest machine marker wins. Comments are oldest first. */
export function latestLandMarker(comments: { body: string }[]): LandMarker | null {
  for (let i = comments.length - 1; i >= 0; i--) {
    const body = comments[i]?.body ?? "";
    const waitAt = body.lastIndexOf("LAND_WAIT");
    const emptyAt = body.lastIndexOf("LAND_EMPTY");
    if (waitAt < 0 && emptyAt < 0) continue;
    if (waitAt > emptyAt) {
      const parsed = markerRows(body.slice(waitAt));
      return { kind: "wait", hold: parsed.hold, rows: parsed.rows };
    }
    return { kind: "empty", rows: markerRows(body.slice(emptyAt)).rows };
  }
  return null;
}

function runDevCommands(deps: LoopDeps, commands: string[]): string | null {
  const cwd = deps.cwd ?? process.cwd();
  const run = deps.runCommand ?? defaultRunCommand;
  for (const command of commands) {
    const result = run(command, cwd);
    if (result.status !== 0) return command;
  }
  return null;
}

async function trunkQuality(
  deps: LoopDeps,
  row: { repo: RepoSpec; sha: string },
): Promise<QualityWait> {
  return waitForQuality(
    deps,
    {
      repo: row.repo,
      url: row.repo.url,
      headSha: row.sha,
      branch: row.repo.trunk,
      created: false,
    },
    { requestRun: false },
  );
}

async function trunkTip(
  deps: LoopDeps,
  repo: RepoSpec,
  mergeSha: string,
): Promise<string> {
  const lookup = deps.lookupHead ?? lookupRemoteHead;
  const tip = lookup(repo.url, repo.trunk) || mergeSha;
  if (tip === mergeSha) return tip;
  try {
    const status = await deps.forge.compare({
      repoUrl: repo.url,
      base: mergeSha,
      head: repo.trunk,
    });
    if (status === "ahead" || status === "identical") return tip;
  } catch {
    return mergeSha;
  }
  return mergeSha;
}

async function settleTrunk(
  deps: LoopDeps,
  ticket: Ticket,
  hold: boolean,
  rows: { repo: RepoSpec; sha: string }[],
  doneDetail: string,
): Promise<TicketResult> {
  const waiting: { repo: string; sha: string }[] = [];
  for (const row of rows) {
    const tip = await trunkTip(deps, row.repo, row.sha);
    const quality = await trunkQuality(deps, { repo: row.repo, sha: tip });
    if (quality.state !== "success") waiting.push({ repo: row.repo.name, sha: tip });
  }
  if (waiting.length > 0) {
    await deps.tracker.comment(ticket.identifier, landWaitMarker(hold, waiting));
    return {
      identifier: ticket.identifier,
      outcome: "trunk-waiting",
      detail: waiting.map((row) => `${row.repo} ${row.sha}`).join(" "),
    };
  }
  const failed = runDevCommands(
    deps,
    devCommands(deps.pack, rows.map((row) => row.repo.name)),
  );
  if (failed) {
    await deps.tracker.comment(
      ticket.identifier,
      landWaitMarker(hold, rows.map((row) => ({ repo: row.repo.name, sha: row.sha }))),
    );
    return {
      identifier: ticket.identifier,
      outcome: "quality-failed",
      detail: `dev step failed: ${failed}`,
    };
  }
  await deps.tracker.setState(ticket.identifier, hold ? holdStatus(deps.pack) : deps.pack.status.dev);
  return {
    identifier: ticket.identifier,
    outcome: "landed",
    detail: doneDetail,
  };
}

async function finishMerged(
  deps: LoopDeps,
  ticket: Ticket,
  hold: boolean,
  merged: MergedHead[],
): Promise<TicketResult> {
  return settleTrunk(
    deps,
    ticket,
    hold,
    merged.map((row) => ({ repo: row.repo, sha: row.sha })),
    merged.map((row) => row.url).join(" "),
  );
}

/**
 * A previous land already merged, or already saw there was nothing to merge.
 * Re-check that fact. Do not start a worker while the recorded commit is unchanged.
 */
async function resumeMarkedLand(deps: LoopDeps, ticket: Ticket): Promise<TicketResult | null> {
  const marker = latestLandMarker(ticket.comments);
  if (!marker) return null;
  if (marker.kind === "empty") {
    const template = deps.pack.branchTemplate;
    if (!template || marker.rows.length === 0) return null;
    const lookup = deps.lookupHead ?? lookupRemoteHead;
    for (const row of marker.rows) {
      const spec = repoByName(deps.pack, row.repo);
      if (!spec) return null;
      const sha = lookup(spec.url, renderBranch(template, ticket.identifier, row.repo));
      if (!sha || sha !== row.sha) return null;
    }
    return { identifier: ticket.identifier, outcome: "land-empty", detail: "branch unchanged" };
  }
  if (marker.rows.length === 0) return null;
  const rows: { repo: RepoSpec; sha: string }[] = [];
  for (const row of marker.rows) {
    const spec = repoByName(deps.pack, row.repo);
    if (!spec) return null;
    rows.push({ repo: spec, sha: row.sha });
  }
  noteTicket(deps, { identifier: ticket.identifier, phase: "land" });
  return settleTrunk(deps, ticket, marker.hold, rows, "trunk green");
}

function pauseLand(identifier: string, url: string, reason: string): TicketResult {
  return {
    identifier,
    outcome: "land-blocked",
    detail: `Land paused on ${url}. ${reason} The sweep continues with the next ticket.`,
  };
}

async function explainQuality(
  deps: LoopDeps,
  ticket: Ticket,
  pr: OpenPull,
  quality: QualityWait,
): Promise<TicketResult | null> {
  if (quality.state === "pending") {
    const body = qualityRunUnscheduled(quality.detail)
      ? `Quality did not start on ${pr.url}. ${quality.detail} The next page requests the workflow run.`
      : `Quality still running on ${pr.url}. The next page merges it when the check is green.`;
    await deps.tracker.comment(ticket.identifier, body);
    return { identifier: ticket.identifier, outcome: "quality-pending", detail: pr.url };
  }
  if (quality.state === "unscheduled") {
    await deps.tracker.comment(
      ticket.identifier,
      `Quality did not start on ${pr.url}. ${quality.detail} Polling this commit cannot create the workflow run.`,
    );
    return { identifier: ticket.identifier, outcome: "quality-unscheduled", detail: pr.url };
  }
  if (quality.state !== "success") {
    await deps.tracker.comment(ticket.identifier, `Quality ${quality.state} on ${pr.url}`);
    return { identifier: ticket.identifier, outcome: "quality-failed", detail: pr.url };
  }
  return null;
}

/**
 * One coding-worker attempt on the open branch. The next page resumes the
 * same branch when this page's budget is spent.
 */
async function spendFix(
  deps: LoopDeps,
  ticket: Ticket,
  current: OpenPull,
  fixes: number,
  fixMax: number,
  prompt: string,
): Promise<{ fixes: number; headSha: string } | TicketResult> {
  if (fixes >= fixMax) {
    const paused = pauseLand(
      ticket.identifier,
      current.url,
      `Still blocked after ${fixMax} attempts on \`${current.branch}\`. The next page resumes this branch.`,
    );
    await deps.tracker.comment(ticket.identifier, paused.detail);
    return paused;
  }
  const home = agentHome(deps.pack);
  try {
    const started = await deps.worker.start({
      prompt,
      repoUrl: home.url,
      baseRef: home.trunk,
    });
    await finishWorker(deps.worker, started.runId);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const paused = pauseLand(
      ticket.identifier,
      current.url,
      `Fix did not finish. ${reason} The next page resumes this branch.`,
    );
    await deps.tracker.comment(ticket.identifier, paused.detail);
    return paused;
  }
  const lookup = deps.lookupHead ?? lookupRemoteHead;
  const next = lookup(current.repo.url, current.branch);
  return {
    fixes: fixes + 1,
    headSha: next && next !== current.headSha ? next : current.headSha,
  };
}

/**
 * Merge one pull request. A behind branch is updated onto trunk and quality
 * runs again on the new head. A conflict or a refused merge starts the coding
 * worker on that same branch. The caller keeps the rest of the sweep moving.
 * Returns the merge commit when this pull request merged.
 */
async function landPull(
  deps: LoopDeps,
  ticket: Ticket,
  pr: OpenPull,
  orderText: string,
): Promise<LandPullResult> {
  let current = pr;
  let updates = 0;
  let unknown = 0;
  let fixes = 0;
  const fixMax = ciFixLimit(deps);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let step = 0; step < 8 + fixMax; step++) {
    const quality = await waitForQuality(deps, current);
    if (quality.state === "failure") {
      const spent = await spendFix(
        deps,
        ticket,
        current,
        fixes,
        fixMax,
        fixPrompt(ticket, orderText, deps, current, fixes + 1, fixMax, quality.detail),
      );
      if ("outcome" in spent) return spent;
      fixes = spent.fixes;
      current = { ...current, headSha: spent.headSha, created: false };
      continue;
    }
    const early = await explainQuality(deps, ticket, current, quality);
    if (early) return early;
    const merge = await deps.forge.mergeability({
      repoUrl: current.repo.url,
      number: current.number,
    });
    const head = merge.headSha || current.headSha;
    if (head !== current.headSha) {
      current = { ...current, headSha: head };
      continue;
    }
    if (merge.state === "conflict" || (merge.state === "behind" && updates >= MAX_BRANCH_UPDATES)) {
      const spent = await spendFix(
        deps,
        ticket,
        current,
        fixes,
        fixMax,
        conflictPrompt(
          ticket,
          orderText,
          deps,
          current,
          fixes + 1,
          fixMax,
          `The branch ${merge.state === "conflict" ? "conflicts with" : "is still behind"} \`${current.repo.trunk}\`.`,
        ),
      );
      if ("outcome" in spent) return spent;
      fixes = spent.fixes;
      current = { ...current, headSha: spent.headSha, created: false };
      continue;
    }
    if (merge.state === "behind") {
      await deps.forge.updateBranch({
        repoUrl: current.repo.url,
        number: current.number,
        expectedHeadSha: head,
      });
      updates += 1;
      await sleep(MERGE_SETTLE_MS);
      continue;
    }
    if (merge.state === "unknown" && unknown < 4) {
      unknown += 1;
      await sleep(MERGE_SETTLE_MS);
      continue;
    }
    try {
      const mergedSha = await deps.forge.squashMerge({
        repoUrl: current.repo.url,
        number: current.number,
        branch: current.branch,
        base: current.repo.trunk,
      });
      if (!mergedSha?.trim()) throw new Error("merge did not return a commit");
      return { mergedSha };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const spent = await spendFix(
        deps,
        ticket,
        current,
        fixes,
        fixMax,
        conflictPrompt(ticket, orderText, deps, current, fixes + 1, fixMax, reason),
      );
      if ("outcome" in spent) return spent;
      fixes = spent.fixes;
      current = { ...current, headSha: spent.headSha, created: false };
    }
  }
  const paused = pauseLand(
    ticket.identifier,
    current.url,
    `Land did not finish on \`${current.branch}\`. The next page resumes this branch.`,
  );
  await deps.tracker.comment(ticket.identifier, paused.detail);
  return paused;
}

const RERUN_QUALITY_MESSAGE = [
  "rerun quality",
  "",
  "The previous commit had no Actions run. This empty commit requests the pull request workflow.",
].join("\n");

type QualityWait = {
  state: "success" | "failure" | "pending" | "unscheduled";
  detail: string;
};

function defaultRunCommand(command: string, cwd: string): { status: number | null } {
  return spawnSync(command, { shell: true, cwd, stdio: "inherit" });
}

async function waitForQuality(
  deps: LoopDeps,
  pr: { repo: RepoSpec; url: string; headSha: string; branch: string; created: boolean },
  opts?: { requestRun?: boolean },
): Promise<QualityWait> {
  if (deps.pack.check === "command") {
    const cwd = repoCheckoutDir(deps.cwd ?? process.cwd(), pr.repo, deps.pack);
    const run = deps.runCommand ?? defaultRunCommand;
    const result = run(deps.pack.qualityCommand, cwd);
    return result.status === 0
      ? { state: "success", detail: deps.pack.qualityCommand }
      : { state: "failure", detail: `${deps.pack.qualityCommand} exited ${result.status ?? "null"}` };
  }
  const polls = deps.maxQualityPolls ?? 60;
  const noRunMs = deps.qualityNoRunMs ?? QUALITY_NO_RUN_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let sha = pr.headSha;
  let nudged = false;
  let noRunSince: number | null = null;
  for (let i = 0; i < polls; i++) {
    const probe = await deps.forge.quality({
      repoUrl: pr.repo.url,
      headSha: sha,
      workflow: deps.pack.qualityWorkflow,
    });
    if (probe.state === "success" || probe.state === "failure") {
      return { state: probe.state, detail: probe.detail };
    }
    const now = deps.nowMs ?? Date.now();
    if (qualityRunUnscheduled(probe.detail)) {
      if (noRunSince === null) noRunSince = now;
      const due = unscheduledQualityDue({
        detail: probe.detail,
        committedAt: pr.created ? undefined : probe.committedAt,
        observedAtMs: noRunSince,
        nowMs: now,
        noRunMs,
      });
      if (due) {
        if (opts?.requestRun === false) {
          return { state: "pending", detail: probe.detail };
        }
        if (!nudged) {
          const next = await deps.forge.requestQualityRun({
            repoUrl: pr.repo.url,
            branch: pr.branch,
            headSha: sha,
            message: RERUN_QUALITY_MESSAGE,
          });
          nudged = true;
          if (next && next !== sha) {
            sha = next;
            noRunSince = null;
            continue;
          }
        }
        return { state: "unscheduled", detail: probe.detail };
      }
    } else {
      noRunSince = null;
    }
    const remaining = pageBudgetRemainingMs({
      nowMs: now,
      startedAtMs: deps.pageStartedAtMs ?? null,
    });
    if (shouldStopForPageReserve({ remainingMs: remaining })) {
      return { state: "pending", detail: probe.detail };
    }
    if (i === polls - 1) return { state: "pending", detail: probe.detail };
    await sleep(deps.qualityPollMs ?? QUALITY_POLL_MS);
  }
  return { state: "pending", detail: "" };
}

export function sweepNeedsAnotherPage(results: TicketResult[]): boolean {
  return results.some(
    (result) =>
      result.outcome === "quality-pending" ||
      result.outcome === "quality-unscheduled" ||
      result.outcome === "quality-failed" ||
      result.outcome === "trunk-waiting" ||
      result.outcome === "land-blocked" ||
      result.outcome === "skipped-page",
  );
}

async function loadProgram(deps: LoopDeps, projectName?: string | null): Promise<CompileProgramResult | null> {
  if (deps.program) return deps.program;
  const name = (projectName ?? deps.project)?.trim();
  if (!name) return null;
  const snapshot = await deps.tracker.projectSnapshot(name);
  if (!snapshot) return null;
  return compileDeliveryProgramFromLinear(snapshot, deps.pack.program?.parkMilestones ?? []);
}

const MAX_SWEEP_PASSES = 50;

/**
 * Read the queue, run what is ready, and read it again when a ticket lands
 * or a verdict moves it. A ticket that was waiting on that one can run in
 * this same page. A pass that only skips blocked tickets stops.
 */
export async function sweep(deps: LoopDeps): Promise<TicketResult[]> {
  const settled = new Set<string>();
  const blocked = new Set<string>();
  const programs = new Map<string, CompileProgramResult | null>();
  const results: TicketResult[] = [];
  for (let pass = 0; pass < MAX_SWEEP_PASSES; pass++) {
    const tickets = await deps.tracker.listIntake(
      deps.project ? { project: deps.project } : undefined,
    );
    const pending = tickets.filter(
      (ticket) => !settled.has(ticket.identifier) && !blocked.has(ticket.identifier),
    );
    if (pending.length === 0) break;
    let moved = false;
    for (const ticket of pending) {
      const remaining = pageBudgetRemainingMs({
        nowMs: deps.nowMs ?? Date.now(),
        startedAtMs: deps.pageStartedAtMs ?? null,
      });
      if (shouldStopForPageReserve({ remainingMs: remaining })) {
        const result: TicketResult = {
          identifier: ticket.identifier,
          outcome: "skipped-page",
          detail: "page reserve",
        };
        noteDone(deps, result);
        results.push(result);
        return results;
      }
      const key = (deps.project ?? ticket.projectName ?? "").trim();
      let program = deps.program ?? null;
      if (!program && key) {
        if (!programs.has(key)) programs.set(key, await loadProgram(deps, key));
        program = programs.get(key) ?? null;
      }
      let result: TicketResult;
      try {
        result = await runTicket(program ? { ...deps, program } : deps, ticket);
      } catch (error) {
        result = {
          identifier: ticket.identifier,
          outcome: "worker-failed",
          detail: error instanceof Error ? error.message : String(error),
        };
        noteDone(deps, result);
      }
      results.push(result);
      if (result.outcome === "skipped-graph") {
        blocked.add(ticket.identifier);
        continue;
      }
      settled.add(ticket.identifier);
      if (result.outcome === "landed" || result.outcome === "verdict") {
        blocked.clear();
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return results;
}

export async function deliver(deps: LoopDeps, identifier: string): Promise<TicketResult> {
  const ticket = await deps.tracker.get(identifier);
  const program = await loadProgram(deps, deps.project ?? ticket.projectName ?? null);
  return runTicket(program ? { ...deps, program } : deps, ticket);
}

export async function ship(deps: LoopDeps, identifier?: string, extraArgs?: string): Promise<void> {
  const env = {
    ...process.env,
    DELIVERY_LOOP_ISSUE: identifier ?? "",
    DELIVERY_LOOP_SHIP_ARGS: extraArgs ?? "",
  };
  for (const step of deps.pack.ship?.steps ?? []) {
    const result = spawnSync(step, {
      shell: true,
      cwd: deps.cwd ?? process.cwd(),
      stdio: "inherit",
      env,
    });
    if (result.status !== 0) throw new Error(`ship step failed: ${step}`);
  }
  if (identifier && deps.pack.ship?.markStatus !== false) {
    await deps.tracker.setState(identifier, deps.pack.status.prod);
  }
}
