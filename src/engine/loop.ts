import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
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
  /** Runs `qualityCommand` when `check` is `command`. Default runs it in the checkout. */
  runCommand?: (command: string, cwd: string) => { status: number | null };
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
    | "worker-failed";
  detail: string;
};

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
  let ground;
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

  const opened: {
    repo: RepoSpec;
    number: number;
    url: string;
    headSha: string;
    branch: string;
    created: boolean;
  }[] = [];
  for (const landing of landings) {
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
  for (const pr of opened) {
    try {
      const paused = await landPull(deps, ticket, pr);
      if (paused) return paused;
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
  for (const step of deps.pack.dev?.steps ?? []) {
    const result = spawnSync(step, { shell: true, cwd: deps.cwd ?? process.cwd(), stdio: "inherit" });
    if (result.status !== 0) {
      return {
        identifier: ticket.identifier,
        outcome: "quality-failed",
        detail: `dev step failed: ${step}`,
      };
    }
  }
  await deps.tracker.setState(
    ticket.identifier,
    grant === "open" ? holdStatus(deps.pack) : deps.pack.status.dev,
  );
  return {
    identifier: ticket.identifier,
    outcome: "landed",
    detail: opened.map((pr) => pr.url).join(" "),
  };
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
 * Merge one pull request. A behind branch is updated onto trunk and quality
 * runs again on the new head. A conflict or a refused merge pauses this
 * ticket. The caller keeps the rest of the sweep moving.
 * Returns null when this pull request merged.
 */
async function landPull(
  deps: LoopDeps,
  ticket: Ticket,
  pr: OpenPull,
): Promise<TicketResult | null> {
  let current = pr;
  let updates = 0;
  let unknown = 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let step = 0; step < 8; step++) {
    const quality = await waitForQuality(deps, current);
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
    if (merge.state === "conflict") {
      const paused = pauseLand(
        ticket.identifier,
        current.url,
        `The branch conflicts with \`${current.repo.trunk}\`.`,
      );
      await deps.tracker.comment(ticket.identifier, paused.detail);
      return paused;
    }
    if (merge.state === "behind") {
      if (updates >= MAX_BRANCH_UPDATES) {
        const paused = pauseLand(
          ticket.identifier,
          current.url,
          `The branch is still behind \`${current.repo.trunk}\` after update-branch.`,
        );
        await deps.tracker.comment(ticket.identifier, paused.detail);
        return paused;
      }
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
    break;
  }
  await deps.forge.squashMerge({
    repoUrl: current.repo.url,
    number: current.number,
    branch: current.branch,
    base: current.repo.trunk,
  });
  return null;
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
    (result) => result.outcome === "quality-pending" || result.outcome === "skipped-page",
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

export async function sweep(deps: LoopDeps): Promise<TicketResult[]> {
  const tickets = await deps.tracker.listIntake(
    deps.project ? { project: deps.project } : undefined,
  );
  const programs = new Map<string, CompileProgramResult | null>();
  const results: TicketResult[] = [];
  for (const ticket of tickets) {
    const remaining = pageBudgetRemainingMs({
      nowMs: deps.nowMs ?? Date.now(),
      startedAtMs: deps.pageStartedAtMs ?? null,
    });
    if (shouldStopForPageReserve({ remainingMs: remaining })) {
      results.push({ identifier: ticket.identifier, outcome: "skipped-page", detail: "page reserve" });
      break;
    }
    const key = (deps.project ?? ticket.projectName ?? "").trim();
    let program = deps.program ?? null;
    if (!program && key) {
      if (!programs.has(key)) programs.set(key, await loadProgram(deps, key));
      program = programs.get(key) ?? null;
    }
    try {
      results.push(await runTicket(program ? { ...deps, program } : deps, ticket));
    } catch (error) {
      results.push({
        identifier: ticket.identifier,
        outcome: "worker-failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
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
