import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_JOURNEY_SPEC } from "../../scripts/journey-proof.mjs";
import { interpretMintOutput, runMintCommand } from "../adapters/github-mint.ts";
import { noteMint } from "./credential-log.ts";
import { transientReason, transientWaitMs } from "./step-outcome.ts";
import { githubRepoFromUrl, type CompareStatus, type DeliveryState, type DesignCheckProbe, type FetchLike, type ForgeAdapter, type ListedPull, type LinearProgramTracker, type StageVerificationReceipt, type Ticket, type TrackerAdapter, type WorkerAdapter } from "../adapters/types.js";
import { agentHome, holdStatus, repoByName, unblockingStates, workerKeyNames, type ProjectPack, type PromotionStage, type RepoSpec } from "../schema/pack.js";
import {
  designRepairText,
  designRepo,
  designWorkOrderStop,
  figmaReadStop,
  figmaTokenValue,
  ticketFigmaUrls,
} from "./design-gate.ts";
import { releaseVersionFromTag } from "./engine-heal.ts";
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
  journeyEvidenceBlocksBuild,
  journeyEvidenceProven,
  parkStateForVerdict,
  parseJourneyEvidence,
  parseJourneyProofs,
  parseOutsideGrant,
  parsePriorRequest,
  parseVerdict,
  parseWorkOrder,
  priorRequestBlocksBuild,
  repoNames,
  type AcceptanceCriterion,
} from "./packet.js";
import {
  parseHypothesis,
  sameHypothesis,
  type QualityCause,
  type QualitySample,
} from "./quality-cause.js";
import {
  exhaustedFailureType,
  failureTypeForHealKey,
  healCapFor,
  HealExhaustedError,
  HEAL_EXHAUSTED_LABEL,
  healVerdict,
  ownerHealPrompt,
  shipNoSignature,
  type HealVerdict,
} from "./stall.js";

export type LoopDeps = {
  pack: ProjectPack;
  tracker: TrackerAdapter & Partial<LinearProgramTracker>;
  worker: WorkerAdapter;
  forge: ForgeAdapter;
  nowMs?: number;
  pageStartedAtMs?: number | null;
  invariantsMarkdown?: string;
  cwd?: string;
  maxQualityPolls?: number;
  /** Linear project name. Limits intake and loads the sibling snapshot. */
  project?: string | null;
  /** Stop after the ground verdict. The build and land path does not run. */
  until?: "ground";
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
  /** Fix attempts after a red quality check. This override wins, then `DELIVERY_LOOP_CI_FIX_MAX`, then 5. */
  ciFixMax?: number;
  /**
   * Shared with every ticket on this page. An owner edit sets `stop` so the
   * page ends and the next page loads the edited trunk.
   */
  pageControl?: { stop: boolean; healed: string[]; verdicts?: Record<string, HealVerdict> };
  /**
   * An explicit command may open the same owner edit; sweep otherwise uses
   */
  ownerHeal?: (input: { prompt: string; repoUrl: string; baseRef: string }) => Promise<void | string>;
  /** Runs `qualityCommand` when `check` is `command`. Default runs it in the checkout. */
  runCommand?: (
    command: string,
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ) => { status: number | null; stdout?: string; stderr?: string };
  /**
   * Figma REST token. `null` means the token is absent. Unset reads
   * `design.figmaTokenEnv`, which defaults to FIGMA_ACCESS_TOKEN.
   */
  figmaToken?: string | null;
  /** Override for tests. Default is global fetch. The token is not written into prompts. */
  figmaFetch?: FetchLike;
  /** Frame read for the ground prompt. Set for the current ticket only. */
  figmaGroundBlock?: string;
  /**
   * Runs a pack command with stdin. Default is a shell in the checkout.
   * Symbol and journey commands use this.
   */
  runPackCommand?: (
    command: string,
    cwd: string,
    stdin: string,
    env?: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ) => { status: number | null; stdout: string; stderr?: string; timedOut?: boolean } | Promise<{ status: number | null; stdout: string; stderr?: string; timedOut?: boolean }>;
  /**
   * Second read of a red SHA, the trunk tip, and whether the worker image
   * matches the workflow. Null fields mean this install did not measure them.
   * Default is all null, so the cause is read from the log text.
   */
  qualityContext?: (input: {
    repoUrl: string;
    headSha: string;
    detail: string;
  }) => Promise<{
    rerun: QualitySample | null;
    trunk: QualitySample | null;
    commandMatchesWorkflow: boolean | null;
  }>;
  /**
   * True when a route-test proof is on `ref`. Default reads the checkout with git.
   * A recording URL is not a file.
   */
  journeyFileAt?: (input: { repo: string; ref: string; path: string }) => boolean;
  /**
   * Commit on `repo.trunk` whose subject names the ticket. Null means none.
   * Default reads the checkout with git.
   */
  ticketOnTrunk?: (input: { repo: RepoSpec; identifier: string }) => string | null;
  /**
   * True when `ref` already contains `sha`. Default is `git merge-base --is-ancestor`
   * in the checkout. A missing checkout is false, so promote still runs.
   */
  deployRefContains?: (input: { repoUrl: string; ref: string; sha: string }) => boolean;
  /**
   * Receives one event when a ticket enters ground, build, or land, and one
   * when that ticket finishes. Default writes a single line to stdout.
   */
  report?: (event: TicketProgress) => void;
  /**
   * Proof, promote, ship, and land success lines. Default writes to stderr.
   * Credential calls use the process credential log.
   */
  engineLog?: (line: string) => void;
};

const deliveryStateCache = new WeakMap<LoopDeps, Map<string, DeliveryState>>();

async function readDeliveryState(deps: LoopDeps, ticket: Ticket): Promise<DeliveryState> {
  let states = deliveryStateCache.get(deps);
  if (!states) deliveryStateCache.set(deps, (states = new Map()));
  const cached = states.get(ticket.identifier);
  if (cached) return cached;
  const stored = await deps.tracker.stateStore.readDeliveryState(ticket.identifier);
  const workOrder = stored.markers.find((marker) => marker.kind === "work-order");
  let savedRevision: string | null = null;
  if (workOrder) {
    try {
      const parsed: unknown = JSON.parse(workOrder.body);
      if (parsed !== null && typeof parsed === "object" && "criteriaRevision" in parsed && typeof parsed.criteriaRevision === "string") {
        savedRevision = parsed.criteriaRevision;
      }
    } catch {
      savedRevision = null;
    }
  }
  const staleWorkOrder = Boolean(workOrder && savedRevision !== ticket.criteriaRevision);
  const markers = staleWorkOrder
    ? stored.markers.filter((marker) => !["work-order", "land-resume", "landed-commits", "proof-receipt", "active-promotion-stage"].includes(marker.kind))
    : stored.markers;
  const stageReceipts = stored.stageReceipts.filter((receipt) => receipt.criteriaRevision === ticket.criteriaRevision);
  const changed = staleWorkOrder || stageReceipts.length !== stored.stageReceipts.length;
  const state: DeliveryState = changed ? { ...stored, markers, stageReceipts } : stored;
  if (changed) await deps.tracker.stateStore.writeDeliveryState(ticket.identifier, state);
  states.set(ticket.identifier, state);
  return state;
}

async function writeDeliveryState(deps: LoopDeps, ticket: Ticket, state: DeliveryState): Promise<void> {
  await deps.tracker.stateStore.writeDeliveryState(ticket.identifier, state);
  deliveryStateCache.get(deps)?.set(ticket.identifier, state);
}

async function writeMarker(deps: LoopDeps, ticket: Ticket, kind: string, body: string): Promise<void> {
  const state = await readDeliveryState(deps, ticket);
  const markers = state.markers.filter((marker) => marker.kind !== kind);
  markers.push({ kind, body, createdAt: new Date(deps.nowMs ?? Date.now()).toISOString() });
  await writeDeliveryState(deps, ticket, { ...state, markers });
}

async function removeMarker(deps: LoopDeps, ticket: Ticket, kind: string): Promise<void> {
  const state = await readDeliveryState(deps, ticket);
  const markers = state.markers.filter((marker) => marker.kind !== kind);
  if (markers.length !== state.markers.length) await writeDeliveryState(deps, ticket, { ...state, markers });
}

function visibleComments(ticket: Ticket): Ticket["comments"] {
  return ticket.comments.filter(({ body }) => !/<!--\s*delivery-loop-state:v2:/i.test(body));
}

/** ground, build, and land are in progress. done is the ticket result. */
export type TicketProgress =
  | { identifier: string; phase: "ground" | "build" | "land" }
  | {
      identifier: string;
      phase: "done";
      outcome: TicketResult["outcome"];
      detail: string;
    };
export type EligibilityResult = {
  outcome: "eligible" | "blocked" | "already-complete";
  reasonCode: string;
  reason: string;
};

type PolicyResult = EligibilityResult | {
  outcome: "policy-error";
  reasonCode: "policy-error";
  reason: string;
};

type EligibilityAuditResult = { identifier: string } & PolicyResult;
class EligibilityGateError extends Error {
  constructor(readonly decision: PolicyResult) {
    super(`${decision.reasonCode}: ${decision.reason}`);
  }
}



export type TicketResult = {
  identifier: string;
  outcome:
    | "skipped-graph"
    | "skipped-lease"
    | "skipped-page"
    | "verdict"
    | "missing-connector"
    | "missing-credential"
    | "invalid-packet"
    | "landed"
    | "quality-failed"
    | "quality-pending"
    | "quality-unscheduled"
    | "land-blocked"
    | "land-empty"
    | "trunk-waiting"
    | "ship-blocked"
    | "journey-missing"
    | "worker-failed"
    | "worker-running"
    | "heal-exhausted"
    | "blocked"
    | "already-complete"
    | "policy-error";
  detail: string;
  reasonCode?: string;
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

function noteEngine(deps: LoopDeps, line: string): void {
  const text = `[delivery-loop] ${line}`;
  if (deps.engineLog) {
    deps.engineLog(text);
    return;
  }
  process.stderr.write(`${text}\n`);
}

function noteDone(deps: LoopDeps, result: TicketResult): void {
  noteTicket(deps, {
    identifier: result.identifier,
    phase: "done",
    outcome: result.outcome,
    detail: result.detail,
  });
}

function leaseRunToken(runId: string): string {
  try {
    const parsed = JSON.parse(runId) as { agentId?: string };
    if (parsed.agentId && /^[A-Za-z0-9_.-]+$/.test(parsed.agentId)) return parsed.agentId;
  } catch {
    /* plain id */
  }
  if (/^[A-Za-z0-9_.-]+$/.test(runId)) return runId;
  return "pending";
}

async function noteLiveRun(
  deps: LoopDeps,
  ticket: Ticket,
  phase: string,
  runId: string,
): Promise<void> {
  const token = leaseRunToken(runId);
  if (token === "pending") return;
  const now = deps.nowMs ?? Date.now();
  await writeMarker(deps, ticket, "delivery-lease", leaseMarkerBody(now, phase, token));
}

/** 401 and 403 from the forge. Message text is not a signal. */
export function ownerOnlyLandFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { httpStatus?: unknown }).httpStatus;
  return status === 401 || status === 403;
}

function leaseMarkerBody(nowMs: number, phase: string, runId: string): string {
  const gha = process.env.GITHUB_RUN_ID?.trim() ?? "";
  return JSON.stringify({
    schemaVersion: 2,
    expiresAt: new Date(nowMs + DELIVERY_LEASE_TTL_MS).toISOString(),
    ghaRunId: /^\d+$/.test(gha) ? gha : null,
    cursorAgentId: /^bc-[a-z0-9-]+$/i.test(runId) ? runId : null,
    cursorRunId: runId,
    cursorPhase: phase,
  });
}

const RELEASE_LEASE = JSON.stringify({ schemaVersion: 2, released: true });

/** A pending run id is the placeholder written before a child exists. */
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

function criteriaMatrix(criteria: readonly AcceptanceCriterion[]): string {
  const stages = criteria.some((row) => row.stages && row.stages.length > 0);
  const repos = criteria.some((row) => row.repos && row.repos.length > 0);
  const head = ["ID", "Text", "Source", ...(stages ? ["Stages"] : []), ...(repos ? ["Repos"] : [])];
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    "## Acceptance criteria",
    line(head),
    line(head.map(() => "---")),
    ...criteria.map((row) => line([
      row.id,
      row.text.replaceAll("|", "\\|"),
      row.source.replaceAll("|", "\\|"),
      ...(stages ? [row.stages?.join(", ") ?? ""] : []),
      ...(repos ? [row.repos?.join(", ") ?? ""] : []),
    ])),
  ].join("\n");
}

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
    formatGroundingCommentSample(visibleComments(ticket)),
    "",
    "This send is for this issue only. Do not edit files. Do not call the tracker.",
    "Follow the documents above. A verdict is a VERDICT: or **Verdict:** line.",
    "When the verdict is BUILDABLE, put the work order under BUILD_PACKET: inside the handoff.",
    "The invariant id is a heading in the invariants file, or `prefix/slug` from a heading file the install lists.",
    "One **Decision:** sentence that cites that id. **Symbols:** `repo/path#symbol`. **Repos:** in backticks, and only names from the land-repo list.",
    "Normalize every acceptance criterion into one table with stable unique IDs, exact criterion text, and its source. Preserve every distinct requirement from the ticket and linked evidence.",
    "The work order's Acceptance criteria table is authoritative. Build and stage verification reuse the same IDs and text.",
    "Optional columns are Stages and Repos. An empty cell applies the criterion to every stage, or to every repo that stage landed. A stage receipt covers exactly the criteria that apply to it. Evidence from another stage is not reused.",
    "Every BUILDABLE handoff includes **Prior request:** none | kept | replaced <id> | ask.",
    "none means no written rule asked for the current behavior. kept means one did and this ticket keeps it. replaced names the ticket this one undoes. ask means a rule asked for the current behavior and this ticket does not undo it. The runner records ask as kept.",
    "A missing line, or replaced without a ticket id, stays in intake. ask does not. With no symbols, ask closes the ticket as already done. With symbols, the same land path continues. The verdict stays BUILDABLE.",
    "Look only at the install's invariant and decision documents and at commit subjects that already name a ticket. No sentence means none.",
    "Every BUILDABLE handoff includes **Outside grant:** none | open.",
    "none means the done-state is code this repository can land.",
    "open means that anything blocked by the external grant remains incomplete. The runner will not mark the ticket complete; build the code this repository owns.",
    "A missing line stays in intake. Reading a vendor's documentation is not the grant.",
    "Every BUILDABLE handoff includes **Journey evidence:** recorded | not-applicable | blocked.",
    "not-applicable means the done-state is not a journey a person walks.",
    `recorded means the done-state includes journey proof. Web proof is an https recording or screenshot URL (png, jpg, jpeg, webp, gif, mp4, webm, mov, or an /artifacts/ URL) in the build receipt. The build handoff includes that raw URL in backticks and omits the **Journey proof:** prefix; the configured journey command prints the prefix. Mobile proof is **Journey proof:** a route test on the exact landed commit, \`repo/path_test.dart\` or \`repo/path.test.ts\`, whose path matches \`${deps.pack.journeySpec?.trim() || DEFAULT_JOURNEY_SPEC}\`. A sentence that names no token is not proof. A spec outside that pattern stays in intake. If the route test is not on the landed commit, the engine checks configured delivery-stage refs (or the repo trunk when refs are not configured); promotion receipts remain bound to the exact landed SHAs and criteria revision.`,
    "blocked means that proof cannot be produced in this run. A missing line or blocked stays in intake and does not mark the ticket complete.",
    `Enabled connectors: ${deps.pack.connectors.join(", ") || "(none)"}`,
    landRepoLine(deps.pack),
    designPromptLines(ticket, deps),
  ].join("\n\n");
}

function designPromptLines(ticket: Ticket, deps: LoopDeps): string {
  const frames = ticketFigmaUrls(ticket);
  const repos = deps.pack.design?.repos ?? [];
  const lines = [
    "When a Figma frame is listed below, the work order includes **Design source:** naming that URL. The runner stops when the line is missing.",
    "When no Figma frame is listed and a land repo is a UI repo, Validation includes that repo's UI check command. The runner reads the check on the pull request head and stops when it is missing or red.",
  ];
  if (repos.length > 0) {
    lines.push(repos.map((repo) => `${repo.name}: \`${repo.check}\` (check \`${repo.checkName}\`)`).join("\n"));
  }
  if (deps.figmaGroundBlock) lines.push(deps.figmaGroundBlock);
  else if (frames.length > 0) lines.push(frames.map((url) => `- ${url}`).join("\n"));
  return lines.join("\n\n");
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
    `Acceptance matrix for implementation:\n${criteriaMatrix(parseWorkOrder(orderText)?.criteria ?? [])}`,
    branches.length
      ? `Push these branches from each repo trunk: ${branches.join(", ")}. Include repo and branch in the handoff. Do not merge.`
      : "Stay inside the allowlist. Run the validation commands. Push a branch and report the branch name and commit. Do not merge.",
    "Stay inside the allowlist. Run the validation commands.",
    "When the handoff says **Journey evidence:** recorded, capture that journey on the running build and publish its evidence. A web journey is a screenshot or a short video of the done state with an https URL ending in png, jpg, jpeg, webp, gif, mp4, webm, or mov, or containing /artifacts/. Put that raw URL in backticks in BUILD_HANDOFF and omit only the **Journey proof:** prefix; the journey command prints that prefix. A mobile token is the route test on the exact landed commit whose path matches the journey-spec pattern. Use a non-mutating view or test data. The runner does not mark delivery complete without the required proof.",
    retry,
  ].filter((part) => part.length > 0).join("\n\n");
}

/** Fix attempts after a red quality check. A caller override wins, then `DELIVERY_LOOP_CI_FIX_MAX`, then 5. */
export function ciFixLimit(deps: LoopDeps): number {
  if (deps.ciFixMax != null) return deps.ciFixMax;
  const raw = process.env.DELIVERY_LOOP_CI_FIX_MAX ?? "5";
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
}

function causeInstruction(cause: QualityCause): string {
  if (cause === "flake") {
    return "This SHA went green on rerun. The check is a flake. Fix that check. A product patch is not the fix. The land continues after two green runs.";
  }
  if (cause === "environment") {
    return "The worker command or image differs from the workflow. The next edit is the environment. A product patch is rejected until the failure reproduces in the CI image.";
  }
  if (cause === "contract") {
    return "The log is generated-client drift. The next edit is the regen in the repo the log names.";
  }
  return "This failure reproduces on this SHA and is green on trunk. State a new **Hypothesis:** line. A repeat of the previous hypothesis is not a fix.";
}

function fixPrompt(
  ticket: Ticket,
  orderText: string,
  deps: LoopDeps,
  pr: OpenPull,
  attempt: number,
  max: number,
  detail: string,
  cause: QualityCause,
  previousHypothesis: string | null,
): string {
  const cwd = deps.cwd ?? process.cwd();
  const docs = listedDocs(cwd, deps.pack.prompts?.build);
  return [
    universalConduct(),
    ...docs,
    `Fix the failing quality check on \`${pr.repo.name}\` branch \`${pr.branch}\` for ${ticket.identifier}.`,
    `Attempt ${attempt} of ${max}.`,
    `**Cause:** ${cause}`,
    causeInstruction(cause),
    previousHypothesis
      ? `The previous hypothesis was: ${previousHypothesis}. A repeat of that hypothesis is not pushed.`
      : "State a **Hypothesis:** line that names the layer this edit changes.",
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

function commentBodies(ticket: Ticket, deps: LoopDeps): string[] {
  const persisted = deliveryStateCache.get(deps)?.get(ticket.identifier)?.markers.map(({ body }) => body) ?? [];
  return [...visibleComments(ticket).map(({ body }) => body), ...persisted];
}

function programBlock(ticket: Ticket, deps: LoopDeps, phase: "ground" | "build"): string {
  const compiled = deps.program;
  if (!compiled) return "";
  const board = {
    unblocking: unblockingStates(deps.pack),
    backlog: deps.pack.status.backlog ?? null,
    hold: holdStatus(deps.pack),
    complete: deps.pack.status.complete,
    shipped: deps.pack.status.shipped ?? null,
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

function landRepoLine(pack: ProjectPack): string {
  const land = pack.repos.map((repo) => repo.name).join(", ");
  const checkout = agentCheckoutName(pack);
  const checkoutIsLand = pack.repos.some((repo) => repo.name === checkout);
  const extra =
    checkout && !checkoutIsLand
      ? ` The checkout \`${checkout}\` is where this agent starts. It is not a land repo. **Repos:** must not name it.`
      : "";
  return `Land repos: ${land}. **Repos:** names only these.${extra}`;
}

function agentCheckoutName(pack: ProjectPack): string {
  const match = (pack.agent?.url ?? "").match(/github\.com[:/][^/]+\/([^/.]+)/i);
  return match?.[1] ?? "";
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

function trunkCommitSha(dir: string, trunk: string, identifier: string): string | null {
  if (!existsSync(join(dir, ".git"))) return null;
  const result = spawnSync(
    "git",
    ["-C", dir, "log", trunk, "--grep", identifier, "-1", "--format=%H"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  const sha = result.stdout.trim();
  return sha || null;
}

/** Commits for the repos named in the audit. Null means a checkout was missing and none matched. */
function trunkTicketCommits(
  deps: LoopDeps,
  identifier: string,
  text: string,
): { repo: RepoSpec; sha: string }[] | null {
  const named = [...text.matchAll(/\*\*Repos:\*\*\s*(.+)/gi)].flatMap((match) => repoNames(match[1]));
  if (named.length === 0) return [];
  const cwd = deps.cwd ?? process.cwd();
  const rows: { repo: RepoSpec; sha: string }[] = [];
  let unknown = false;
  for (const name of named) {
    const spec = repoByName(deps.pack, name);
    if (!spec) {
      unknown = true;
      continue;
    }
    const sha = deps.ticketOnTrunk
      ? deps.ticketOnTrunk({ repo: spec, identifier })
      : trunkCommitSha(repoCheckoutDir(cwd, spec, deps.pack), spec.trunk, identifier);
    if (sha) {
      rows.push({ repo: spec, sha });
      continue;
    }
    if (!deps.ticketOnTrunk && !existsSync(join(repoCheckoutDir(cwd, spec, deps.pack), ".git"))) {
      unknown = true;
    }
  }
  if (rows.length === 0 && unknown) return null;
  return rows;
}

async function finishWorker(worker: WorkerAdapter, runId: string) {
  const joined = await worker.join(runId);
  if (joined.status === "failed") {
    throw new Error(joined.text || "worker failed");
  }
  return joined;
}

function policyError(reason: string): PolicyResult {
  return { outcome: "policy-error", reasonCode: "policy-error", reason };
}

function parseEligibilityResult(stdout: string): EligibilityResult {
  const value: unknown = JSON.parse(stdout);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid result");
  }
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result).sort();
  if (keys.length !== 3 || keys[0] !== "outcome" || keys[1] !== "reason" || keys[2] !== "reasonCode" ||
    !["eligible", "blocked", "already-complete"].includes(String(result.outcome)) ||
    typeof result.reasonCode !== "string" || !result.reasonCode.trim() ||
    typeof result.reason !== "string" || !result.reason.trim()) {
    throw new Error("invalid result");
  }
  return {
    outcome: result.outcome as EligibilityResult["outcome"],
    reasonCode: result.reasonCode.trim(),
    reason: result.reason.trim(),
  };
}

async function checkEligibility(
  deps: Pick<LoopDeps, "pack" | "cwd" | "runPackCommand">,
  ticket: Ticket,
): Promise<PolicyResult> {
  if (deps.pack.eligibility.mode === "none") {
    return {
      outcome: "eligible",
      reasonCode: "explicit-none",
      reason: "Eligibility policy is explicitly disabled by the project pack.",
    };
  }
  if (ticket.issueType === undefined || ticket.assigneeId === undefined ||
    !ticket.fieldValues || typeof ticket.fieldValues !== "object" || Array.isArray(ticket.fieldValues) ||
    !Array.isArray(ticket.attachments) || typeof ticket.criteriaRevision !== "string") {
    return policyError("Eligibility requires a normalized ticket.");
  }
  try {
    const command = deps.pack.eligibility.command.trim();
    if (!command) return policyError("Eligibility command is missing.");
    const run = deps.runPackCommand ?? defaultRunPackCommand;
    const result = await Promise.resolve(run(command, deps.cwd ?? process.cwd(), `${JSON.stringify(ticket)}\n`, commandEnvironment(deps.pack)));
    if (result.status !== 0) {
      return policyError(`Eligibility command exited with status ${result.status ?? "unknown"}.`);
    }
    return parseEligibilityResult(result.stdout);
  } catch {
    return policyError("Eligibility command returned an invalid result or could not be run.");
  }
}

export async function runTicket(deps: LoopDeps, ticket: Ticket): Promise<TicketResult> {
  const eligibility = await checkEligibility(deps, ticket);
  if (eligibility.outcome !== "eligible") {
    const result: TicketResult = {
      identifier: ticket.identifier,
      outcome: eligibility.outcome,
      detail: eligibility.reason,
      reasonCode: eligibility.reasonCode,
    };
    noteDone(deps, result);
    return result;
  }
  try {
    const result = await executeTicket(deps, ticket);
    noteDone(deps, result);
    return result;
  } catch (error) {
    if (error instanceof EligibilityGateError) {
      const result: TicketResult = {
        identifier: ticket.identifier,
        outcome: error.decision.outcome,
        detail: error.decision.reason,
        reasonCode: error.decision.reasonCode,
      };
      noteDone(deps, result);
      return result;
    }
    if (error instanceof HealExhaustedError) {
      const result: TicketResult = {
        identifier: ticket.identifier,
        outcome: "heal-exhausted",
        detail: error.failureType,
      };
      noteDone(deps, result);
      return result;
    }
    throw error;
  }
}

async function markHealExhausted(deps: LoopDeps, ticket: Ticket, type: string): Promise<void> {
  const labels = new Set(ticket.labels.map((label) => label.toLowerCase()));
  if (!labels.has(HEAL_EXHAUSTED_LABEL)) {
    await deps.tracker.addLabel(ticket.identifier, HEAL_EXHAUSTED_LABEL);
    ticket.labels = [...ticket.labels, HEAL_EXHAUSTED_LABEL];
  }
  if (!labels.has(type.toLowerCase())) {
    await deps.tracker.addLabel(ticket.identifier, type);
    ticket.labels = [...ticket.labels, type];
  }
  if (!deliveryStateCache.get(deps)?.get(ticket.identifier)?.markers.some((marker) => marker.kind === "heal-exhausted")) {
    await writeMarker(deps, ticket, "heal-exhausted", type);
  }
}

async function executeTicket(deps: LoopDeps, ticket: Ticket): Promise<TicketResult> {

  deliveryStateCache.delete(deps);
  await readDeliveryState(deps, ticket);
  const exhausted = exhaustedFailureType({ labels: ticket.labels });
  if (exhausted) {
    await markHealExhausted(deps, ticket, exhausted);
    return { identifier: ticket.identifier, outcome: "heal-exhausted", detail: exhausted };
  }
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

  const leaseMarkers = deliveryStateCache.get(deps)?.get(ticket.identifier)?.markers.filter((marker) => marker.kind === "delivery-lease") ?? [];
  const lease = latestDeliveryLeaseStamp(leaseMarkers);
  if (leaseIsHeld(lease, now, deps)) {
    return { identifier: ticket.identifier, outcome: "skipped-lease", detail: "lease held" };
  }
  if (await alreadyFinished(deps, ticket)) {
    return { identifier: ticket.identifier, outcome: "landed", detail: "already finished" };
  }

  const home = agentHome(deps.pack);
  if (lease.cursorRunId && lease.cursorRunId !== "pending") {
    const joined = await deps.worker.join(
      JSON.stringify({ agentId: lease.cursorRunId, runId: lease.cursorRunId, status: "running" }),
    );
    if (joined.status === "running") {
      return { identifier: ticket.identifier, outcome: "worker-running", detail: lease.cursorRunId };
    }
    if (joined.status === "finished" && joined.text.trim() && journeyProofReceiptState(deps, ticket)?.attempted) {
      await rememberJourneyReceipt(deps, ticket, joined.text);
    }
  }
  await writeMarker(deps, ticket, "delivery-lease", leaseMarkerBody(now, "ground", "pending"));
  let keepLease = false;
  try {
    const result = await runHeldTicket(deps, ticket, home);
    keepLease = result.outcome === "worker-running";
    return result;
  } finally {
    if (!keepLease) await writeMarker(deps, ticket, "delivery-lease", RELEASE_LEASE).catch(() => undefined);
  }
}

async function runHeldTicket(
  deps: LoopDeps,
  ticket: Ticket,
  home: { url: string; trunk: string },
): Promise<TicketResult> {
  const credential = await stopForMissingFigmaToken(deps, ticket);
  if (credential) return credential;
  const marker = deliveryStateCache.get(deps)?.get(ticket.identifier)?.markers.find((item) => item.kind === "land-resume")?.body ?? null;
  const resumed = await resumeMarkedLand(deps, ticket, marker);
  if (resumed) return resumed;
  const existing = await resumeExistingPulls(deps, ticket);
  if (existing) return existing;
  let ground;
  noteTicket(deps, { identifier: ticket.identifier, phase: "ground" });
  try {
    const started = await deps.worker.start({
      prompt: groundPrompt(ticket, deps),
      repoUrl: home.url,
      baseRef: home.trunk,
    });
    await noteLiveRun(deps, ticket, "ground", started.runId);
    ground = await finishWorker(deps.worker, started.runId);
    if (ground.status === "running") {
      return {
        identifier: ticket.identifier,
        outcome: "worker-running",
        detail: `cursor_run=${started.runId}`,
      };
    }
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
      const commits =
        verdict === "ALREADY SHIPPED"
          ? trunkTicketCommits(deps, ticket.identifier, ground.text)
          : null;
      const parked = parkStateForVerdict({
        verdict,
        text: ground.text,
        priorComments: commentBodies(ticket, deps),
        completeStatus: deps.pack.status.complete,
        trunkCommit: verdict === "ALREADY SHIPPED" ? trunkCommitFlag(commits) : null,
        journeyProven:
          verdict === "ALREADY SHIPPED"
            ? await journeyEvidenceOnRefs(
                deps,
                ground.text,
                (repo) => repoByName(deps.pack, repo)?.trunk ?? "",
              )
            : null,
      });
      if (parked === deps.pack.status.complete && commits && commits.length > 0) {
        await writeMarker(deps, ticket, "work-order", JSON.stringify({ ground: ground.text, receipt: ground.text, criteriaRevision: ticket.criteriaRevision }));
        return settleTrunk(
          deps,
          ticket,
          false,
          commits,
          "already on trunk",
          ground.text,
          ground.text,
        );
      }
      if (parked) await deps.tracker.setState(ticket.identifier, parked, ticket.criteriaRevision);
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

  const journey = journeyEvidenceBlocksBuild(ground.text);
  if (journey) {
    const reason =
      journey === "blocked"
        ? "BUILDABLE **Journey evidence:** blocked does not build. The ticket stays in intake."
        : "BUILDABLE requires **Journey evidence:** recorded | not-applicable | blocked. The ticket stays in intake.";
    await deps.tracker.comment(ticket.identifier, reason);
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: `journey-${journey}` };
  }

  const prior = priorRequestBlocksBuild(ground.text);
  if (prior) {
    const reason =
      prior === "replaced"
        ? "BUILDABLE **Prior request:** replaced requires a ticket id. The ticket stays in intake."
        : "BUILDABLE requires **Prior request:** none | kept | replaced <id> | ask. The ticket stays in intake.";
    await deps.tracker.comment(ticket.identifier, reason);
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: `prior-request-${prior}` };
  }
  if (parsePriorRequest(ground.text)?.kind === "ask") {
    const preview = parseWorkOrder(ground.text);
    await deps.tracker.comment(
      ticket.identifier,
      "**Prior request:** kept. A written rule already asked for the current behavior.",
    );
    if (!preview || preview.symbols.length === 0) {
      const commits = trunkTicketCommits(deps, ticket.identifier, ground.text);
      if (commits && commits.length > 0) {
        await writeMarker(deps, ticket, "work-order", JSON.stringify({ ground: ground.text, receipt: ground.text, criteriaRevision: ticket.criteriaRevision }));
        return settleTrunk(deps, ticket, false, commits, "prior request already on trunk", ground.text, ground.text);
      }
      await deps.tracker.setState(ticket.identifier, "Canceled", ticket.criteriaRevision);
      return { identifier: ticket.identifier, outcome: "verdict", detail: "prior-request-kept" };
    }
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
  if (!(await symbolsResolve(deps, order.symbols))) {
    await deps.tracker.comment(
      ticket.identifier,
      "A **Symbols:** line did not resolve. The packet is incomplete. The next page re-grounds. This comment is not a buildable stamp.",
    );
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: "symbols" };
  }
  const unknownRepos = order.repos.filter((name) => !repoByName(deps.pack, name));
  if (unknownRepos.length > 0) {
    const land = deps.pack.repos.map((repo) => `\`${repo.name}\``).join(", ");
    const named = unknownRepos.map((name) => `\`${name}\``).join(", ");
    await deps.tracker.comment(
      ticket.identifier,
      `**Repos:** names ${named}, which is not a land repo. Land repos are ${land}. The ticket stays in intake.`,
    );
    return {
      identifier: ticket.identifier,
      outcome: "invalid-packet",
      detail: `repo ${unknownRepos.join(", ")} is not in the pack`,
    };
  }
  const designStop = designWorkOrderStop({
    ticket,
    orderText: ground.text,
    repos: order.repos,
    design: deps.pack.design,
  });
  if (!designStop.ok) {
    await deps.tracker.comment(ticket.identifier, designStop.comment);
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: designStop.detail };
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

  await writeMarker(deps, ticket, "work-order", JSON.stringify({ ground: ground.text, receipt: "", criteriaRevision: ticket.criteriaRevision }));
  if (deps.tracker.kind !== "jira") await deps.tracker.comment(ticket.identifier, ground.text);
  if (deps.until === "ground") {
    return {
      identifier: ticket.identifier,
      outcome: "verdict",
      detail: verdict ?? "BUILDABLE",
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
  let builtReceipt = "";
  if (landings && deps.pack.landingStrategy === "pull-request") {
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
      await noteLiveRun(deps, ticket, "build", started.runId);
      built = await finishWorker(deps.worker, started.runId);
      if (built.status === "running") {
        return {
          identifier: ticket.identifier,
          outcome: "worker-running",
          detail: `cursor_run=${started.runId}`,
        };
      }
      builtReceipt = built.text;
      await writeMarker(deps, ticket, "work-order", JSON.stringify({ ground: ground.text, receipt: builtReceipt, criteriaRevision: ticket.criteriaRevision }));
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
  if (deps.pack.landingStrategy === "fast-forward") {
    const landed = await landFastForward(deps, ticket, landings, grant === "open", ground.text, builtReceipt);
    if (!Array.isArray(landed)) return landed;
    return finishMerged(deps, ticket, grant === "open", landed, ground.text, builtReceipt);
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
    await writeMarker(deps, ticket, "land-resume", JSON.stringify({ kind: "empty", hold: false, rows: empty, declared: ground.text, receipt: builtReceipt } satisfies LandResume));
    return {
      identifier: ticket.identifier,
      outcome: "land-empty",
      detail: empty.map((row) => `${row.repo} ${row.sha}`).join(" "),
    };
  }
  noteTicket(deps, { identifier: ticket.identifier, phase: "land" });
  const ready: OpenPull[] = [];
  for (const pr of opened) {
    const prepared = await settleLand(deps, ticket, pr, ground.text);
    if ("outcome" in prepared) return prepared;
    ready.push({ ...pr, headSha: prepared.headSha });
  }
  const merged: MergedHead[] = [];
  for (const pr of ready) {
    const landed = await commitLand(deps, ticket, pr);
    if ("outcome" in landed) return landed;
    merged.push({ repo: pr.repo, sha: landed.mergedSha, url: pr.url });
  }
  return finishMerged(deps, ticket, grant === "open", merged, ground.text, builtReceipt);
}

async function settleLand(
  deps: LoopDeps,
  ticket: Ticket,
  pr: OpenPull,
  orderText: string,
): Promise<TicketResult | { headSha: string }> {
  try {
    return await landPull(deps, ticket, pr, orderText);
  } catch (error) {
    if (error instanceof HealExhaustedError) {
      return {
        identifier: ticket.identifier,
        outcome: "heal-exhausted",
        detail: error.failureType,
      };
    }
    const paused = pauseLand(
      ticket.identifier,
      pr.url,
      error instanceof Error ? error.message : String(error),
    );
    await deps.tracker.comment(ticket.identifier, paused.detail);
    return paused;
  }
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

function trunkCommitFlag(commits: { sha: string }[] | null): boolean | null {
  if (commits === null) return null;
  return commits.length > 0;
}

function deployRefContains(deps: LoopDeps, repo: RepoSpec, ref: string, sha: string): boolean {
  if (!ref || !sha) return false;
  if (deps.deployRefContains) return deps.deployRefContains({ repoUrl: repo.url, ref, sha });
  const dir = repoCheckoutDir(deps.cwd ?? process.cwd(), repo, deps.pack);
  if (!existsSync(join(dir, ".git"))) return false;
  return (
    spawnSync("git", ["-C", dir, "merge-base", "--is-ancestor", sha, ref], { encoding: "utf8" })
      .status === 0
  );
}



type JourneyCommit = { repo: string; sha: string };
type JourneyProofReceipt = {
  schemaVersion: 2;
  criteriaRevision: string;
  landed: JourneyCommit[];
  pullRequests: { repo: string; sha: string; url: string }[];
  attempted: boolean;
  validated: boolean;
  receipt: string;
};

function parseJourneyCommits(body: string | undefined): JourneyCommit[] | null {
  if (!body) return null;
  try {
    const value: unknown = JSON.parse(body);
    if (!Array.isArray(value) || !value.every((row) => row && typeof row === "object" && !Array.isArray(row) &&
      typeof (row as Record<string, unknown>).repo === "string" && typeof (row as Record<string, unknown>).sha === "string")) return null;
    return value as JourneyCommit[];
  } catch {
    return null;
  }
}

function sameLandedCommits(left: readonly JourneyCommit[], right: readonly JourneyCommit[]): boolean {
  if (left.length !== right.length) return false;
  const key = (row: JourneyCommit) => `${row.repo} ${row.sha}`;
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.every((value, index) => value === b[index]);
}

function journeyProofReceiptState(deps: LoopDeps, ticket: Ticket): JourneyProofReceipt | null {
  const markers = deliveryStateCache.get(deps)?.get(ticket.identifier)?.markers ?? [];
  const marker = markers.find((item) => item.kind === "proof-receipt");
  const current = parseJourneyCommits(markers.find((item) => item.kind === "landed-commits")?.body);
  if (!marker || !current) return null;
  try {
    const value: unknown = JSON.parse(marker.body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const proof = value as Record<string, unknown>;
    const landed = Array.isArray(proof.landed) ? parseJourneyCommits(JSON.stringify(proof.landed)) : null;
    const pullRequests = Array.isArray(proof.pullRequests) && proof.pullRequests.every((row) => row && typeof row === "object" && !Array.isArray(row) &&
      typeof (row as Record<string, unknown>).repo === "string" && typeof (row as Record<string, unknown>).sha === "string" &&
      typeof (row as Record<string, unknown>).url === "string")
      ? proof.pullRequests as JourneyProofReceipt["pullRequests"]
      : null;
    if (proof.schemaVersion !== 2 || proof.criteriaRevision !== ticket.criteriaRevision || !landed || !pullRequests ||
      typeof proof.attempted !== "boolean" || typeof proof.validated !== "boolean" || typeof proof.receipt !== "string" ||
      !sameLandedCommits(landed, current)) return null;
    return proof as unknown as JourneyProofReceipt;
  } catch {
    return null;
  }
}

function publishedProofReceipt(deps: LoopDeps, ticket: Ticket): string | null {
  const proof = journeyProofReceiptState(deps, ticket);
  return proof?.validated ? proof.receipt : null;
}


async function rememberJourneyReceipt(deps: LoopDeps, ticket: Ticket, receipt: string): Promise<void> {
  const saved = receipt.trim();
  const proof = journeyProofReceiptState(deps, ticket);
  if (!saved || !proof?.attempted || proof.receipt.split("\n").includes(saved)) return;
  await writeMarker(deps, ticket, "proof-receipt", JSON.stringify({
    ...proof,
    receipt: [proof.receipt, saved].filter(Boolean).join("\n"),
  } satisfies JourneyProofReceipt));
}

async function publishProofReceipt(
  deps: LoopDeps,
  ticket: Ticket,
  proof: { receipt: string; rows: { repo: string; sha: string; url?: string }[] } | null,
): Promise<void> {
  if (publishedProofReceipt(deps, ticket) || !proof?.receipt.trim()) return;
  const prior = journeyProofReceiptState(deps, ticket);
  await writeMarker(deps, ticket, "proof-receipt", JSON.stringify({
    schemaVersion: 2,
    criteriaRevision: ticket.criteriaRevision,
    landed: proof.rows.map(({ repo, sha }) => ({ repo, sha })),
    pullRequests: proof.rows.flatMap(({ repo, sha, url }) => url ? [{ repo, sha, url }] : []),
    attempted: prior?.attempted ?? false,
    validated: true,
    receipt: proof.receipt.trim(),
  } satisfies JourneyProofReceipt));
}

function resumeProofTexts(deps: LoopDeps, ticket: Ticket): { declared: string; receipt: string } {
  const body = deliveryStateCache.get(deps)?.get(ticket.identifier)?.markers.find((marker) => marker.kind === "work-order")?.body;
  let ground = "";
  let buildReceipt = "";
  try {
    const parsed: unknown = body ? JSON.parse(body) : null;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
      "criteriaRevision" in parsed && parsed.criteriaRevision === ticket.criteriaRevision &&
      "ground" in parsed && typeof parsed.ground === "string" &&
      "receipt" in parsed && typeof parsed.receipt === "string") {
      ground = parsed.ground;
      buildReceipt = parsed.receipt;
    }
  } catch {
    ground = "";
    buildReceipt = "";
  }
  const receipt = [buildReceipt, journeyProofReceiptState(deps, ticket)?.receipt ?? ""].filter(Boolean).join("\n");
  return { declared: ground, receipt };
}

type LandResume = {
  kind: "wait" | "empty";
  hold: boolean;
  rows: { repo: string; sha: string }[];
  declared: string;
  receipt: string;
};

function parseLandResume(body: string | null): LandResume | null {
  if (!body) return null;
  try {
    const value: unknown = JSON.parse(body);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const marker = value as Record<string, unknown>;
    if ((marker.kind !== "wait" && marker.kind !== "empty") || typeof marker.hold !== "boolean" ||
      !Array.isArray(marker.rows) || !marker.rows.every((row) => row && typeof row === "object" &&
        typeof (row as Record<string, unknown>).repo === "string" && typeof (row as Record<string, unknown>).sha === "string") ||
      typeof marker.declared !== "string" || typeof marker.receipt !== "string") return null;
    return marker as unknown as LandResume;
  } catch {
    return null;
  }
}

type CommandOutput = { status: number | null; stdout?: string; stderr?: string; output: string };

function commandOutput(result: { status: number | null; stdout?: string; stderr?: string }): CommandOutput {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status, stdout, stderr, output: `${stdout}\n${stderr}` };
}

async function runWithTransient<T extends { status: number | null; output: string; timedOut?: boolean }>(
  deps: LoopDeps,
  runOnce: () => Promise<T>,
): Promise<T> {
  const maxAttempts = deps.pack.transient?.maxAttempts ?? 3;
  const maxWaitMs = deps.pack.transient?.maxWaitMs ?? 60_000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let completed = 0;
  let spent = 0;
  let last = { status: 1 as number | null, output: "" } as T;
  for (;;) {
    last = await runOnce();
    completed += 1;
    if (last.timedOut) return last;
    const reason = transientReason(last.status, last.output);
    if (!reason) return last;
    const wait = transientWaitMs({ completedAttempts: completed, spentMs: spent, maxAttempts, maxWaitMs });
    if (wait === null) {
      noteEngine(deps, `transient exhausted: ${reason}`);
      throw new Error(`transient exhausted: ${reason}`);
    }
    spent += wait;
    if (wait > 0) await sleep(wait);
  }
}


type StageProblem = {
  outcome: "blocked" | "parked" | "failed";
  stage: PromotionStage;
  reason: string;
  evidence: string[];
};

type StageRun =
  | { outcome: "complete" }
  | (StageProblem & { problems: StageProblem[] });

type ActivePromotion = {
  stageId: string;
  target: string;
  authorization: "deliver" | "ship";
  criteriaRevision: string;
};

const deliveryQueue = new WeakMap<LoopDeps, Promise<unknown>>();

function enqueueDelivery<T>(deps: LoopDeps, task: () => Promise<T>): Promise<T> {
  const previous = deliveryQueue.get(deps) ?? Promise.resolve();
  const run = previous.then(task, task);
  deliveryQueue.set(deps, run.then(() => undefined, () => undefined));
  return run;
}

async function mutateDelivery(
  deps: LoopDeps,
  ticket: Ticket,
  change: (state: DeliveryState) => DeliveryState,
): Promise<void> {
  await enqueueDelivery(deps, async () => {
    const state = await readDeliveryState(deps, ticket);
    await writeDeliveryState(deps, ticket, change(state));
  });
}

/** JSON on a stage verifier's stdin. `landedShas` is that stage's landed repos only. */
export type StageVerifyInput = {
  ticketId: string;
  stageId: string;
  target: string;
  criteriaRevision: string;
  landedShas: { repo: string; sha: string }[];
  criteria: AcceptanceCriterion[];
};

function sortedLanded(rows: readonly { repo: string; sha: string }[]): { repo: string; sha: string }[] {
  return [...rows].sort((a, b) => a.repo.localeCompare(b.repo));
}

/** Repos this stage lists that the ticket actually landed, in stage order, once each. */
function stageLandedRows(
  stage: PromotionStage,
  landed: readonly { repo: string; sha: string }[],
): { repo: string; sha: string }[] {
  const seen = new Set<string>();
  const rows: { repo: string; sha: string }[] = [];
  for (const name of stage.repos) {
    if (seen.has(name)) continue;
    seen.add(name);
    const row = landed.find((item) => item.repo === name && item.sha);
    if (row) rows.push({ repo: row.repo, sha: row.sha });
  }
  return rows;
}

function criterionApplies(
  criterion: AcceptanceCriterion,
  stage: PromotionStage,
  scoped: readonly { repo: string; sha: string }[],
): boolean {
  if (scoped.length === 0) return false;
  if (criterion.stages && !criterion.stages.includes(stage.id)) return false;
  if (criterion.repos && !criterion.repos.some((repo) => scoped.some((row) => row.repo === repo))) return false;
  return true;
}

/** Criteria this stage must prove. Undeclared stages and repos apply to every stage and every landed repo. */
function criteriaForStage(
  criteria: readonly AcceptanceCriterion[],
  stage: PromotionStage,
  scoped: readonly { repo: string; sha: string }[],
): AcceptanceCriterion[] {
  return criteria.filter((criterion) => criterionApplies(criterion, stage, scoped));
}

function uncoveredCriteria(
  criteria: readonly AcceptanceCriterion[],
  authorizationStages: readonly PromotionStage[],
  allStages: readonly PromotionStage[],
  landed: readonly { repo: string; sha: string }[],
): AcceptanceCriterion[] {
  return criteria.filter((criterion) => {
    if (criterion.stages?.some((id) => !allStages.some((stage) => stage.id === id))) return true;
    const inThis = !criterion.stages || criterion.stages.some((id) => authorizationStages.some((stage) => stage.id === id));
    if (!inThis) return false;
    return !authorizationStages.some((stage) => criterionApplies(criterion, stage, stageLandedRows(stage, landed)));
  });
}

function authorizationSatisfied(
  stages: readonly PromotionStage[],
  allStages: readonly PromotionStage[],
  receipts: readonly StageVerificationReceipt[],
  ticket: { criteriaRevision: string },
  landed: readonly { repo: string; sha: string }[],
  criteria: readonly AcceptanceCriterion[],
): boolean {
  if (stages.length === 0) return true;
  if (stages.every((stage) => stageLandedRows(stage, landed).length === 0)) return false;
  if (!stages.every((stage) => {
    const receipt = receipts.find((item) => item.stageId === stage.id);
    return currentStageReceipt(receipt, stage, ticket, landed, criteria);
  })) return false;
  return uncoveredCriteria(criteria, stages, allStages, landed).length === 0;
}

function notApplicableReceipt(stage: PromotionStage, ticket: { criteriaRevision: string }): StageVerificationReceipt {
  return {
    stageId: stage.id,
    target: stage.target,
    outcome: "not-applicable",
    reason: `stage ${stage.id} does not apply to the landed repos`,
    criteriaRevision: ticket.criteriaRevision,
    deployed: [],
    criteria: [],
  };
}

function currentStageReceipt(
  receipt: StageVerificationReceipt | undefined,
  stage: PromotionStage,
  ticket: { criteriaRevision: string },
  landed: readonly { repo: string; sha: string }[],
  criteria: readonly AcceptanceCriterion[],
): boolean {
  const scoped = stageLandedRows(stage, landed);
  if (scoped.length === 0) {
    return Boolean(
      receipt &&
      receipt.outcome === "not-applicable" &&
      receipt.stageId === stage.id &&
      receipt.target === stage.target &&
      receipt.criteriaRevision === ticket.criteriaRevision &&
      receipt.deployed.length === 0 &&
      receipt.criteria.length === 0 &&
      receipt.reason.trim(),
    );
  }
  return Boolean(receipt && stageReceiptPasses(receipt, stage, ticket, sortedLanded(scoped), criteriaForStage(criteria, stage, scoped)));
}

async function writeStageReceipt(deps: LoopDeps, ticket: Ticket, receipt: StageVerificationReceipt): Promise<void> {
  await mutateDelivery(deps, ticket, (current) => ({
    ...current,
    stageReceipts: [...current.stageReceipts.filter((item) => item.stageId !== receipt.stageId), receipt],
  }));
}

function readActivePromotions(state: DeliveryState): ActivePromotion[] {
  const body = state.markers.find((marker) => marker.kind === "active-promotion-stage")?.body;
  if (!body) return [];
  try {
    const parsed = JSON.parse(body) as { stages?: unknown };
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.stages)) return [];
    return parsed.stages.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as Record<string, unknown>;
      if (typeof row.stageId !== "string" || typeof row.target !== "string" ||
        (row.authorization !== "deliver" && row.authorization !== "ship") ||
        typeof row.criteriaRevision !== "string") return [];
      return [{
        stageId: row.stageId,
        target: row.target,
        authorization: row.authorization,
        criteriaRevision: row.criteriaRevision,
      }];
    });
  } catch {
    return [];
  }
}

function withActivePromotions(state: DeliveryState, active: ActivePromotion[], now: string): DeliveryState {
  const markers = state.markers.filter((marker) => marker.kind !== "active-promotion-stage");
  if (active.length > 0) {
    markers.push({ kind: "active-promotion-stage", body: JSON.stringify({ stages: active }), createdAt: now });
  }
  return { ...state, markers };
}

function receiptEvidence(receipt: StageVerificationReceipt): string[] {
  return receipt.criteria.flatMap((row) => row.evidence.filter((item) => item.trim()).map((item) => `${row.id}: ${item}`));
}

function stageProblemText(problem: StageProblem): string {
  const evidence = problem.evidence.length ? ` Evidence: ${problem.evidence.join("; ")}` : "";
  return `Promotion stage ${problem.stage.id} returned no: ${problem.reason}${evidence}`;
}

function stageRunFrom(problems: StageProblem[]): StageRun {
  if (problems.length === 0) return { outcome: "complete" };
  const rank = { failed: 0, blocked: 1, parked: 2 };
  const primary = [...problems].sort((a, b) => rank[a.outcome] - rank[b.outcome] || a.stage.id.localeCompare(b.stage.id))[0]!;
  return { ...primary, problems };
}

export function validateStageReceipt(
  value: unknown,
  stage: { id: string; target: string },
  ticket: { criteriaRevision: string },
  landed: readonly { repo: string; sha: string }[],
  criteria: readonly { id: string }[],
): StageVerificationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid receipt");
  const receipt = value as Record<string, unknown>;
  const expectedKeys = ["criteria", "criteriaRevision", "deployed", "outcome", "reason", "stageId", "target"];
  if (Object.keys(receipt).sort().join("|") !== expectedKeys.join("|")) throw new Error("invalid receipt fields");
  if (receipt.stageId !== stage.id || receipt.target !== stage.target || receipt.criteriaRevision !== ticket.criteriaRevision) {
    throw new Error("receipt stage, target, or criteria revision does not match");
  }
  if (!["passed", "blocked", "parked"].includes(String(receipt.outcome)) || typeof receipt.reason !== "string") {
    throw new Error("invalid receipt outcome");
  }
  if (receipt.outcome !== "passed" && !receipt.reason.trim()) throw new Error("blocked and parked receipts require a reason");
  if (!Array.isArray(receipt.deployed) || !Array.isArray(receipt.criteria)) throw new Error("invalid receipt arrays");
  const deployed = receipt.deployed as unknown[];
  const expectedDeployed = [...landed].sort((a, b) => a.repo.localeCompare(b.repo));
  if (deployed.length !== expectedDeployed.length) throw new Error("receipt deployed SHA set does not match");
  const seenRepos = new Set<string>();
  for (let index = 0; index < deployed.length; index += 1) {
    const row = deployed[index];
    const expected = expectedDeployed[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid deployed row");
    const item = row as Record<string, unknown>;
    if (Object.keys(item).sort().join("|") !== "repo|sha" || typeof item.repo !== "string" || typeof item.sha !== "string" ||
      item.repo !== expected?.repo || item.sha !== expected.sha || seenRepos.has(item.repo)) {
      throw new Error("receipt deployed SHA set does not match");
    }
    seenRepos.add(item.repo);
  }
  const rows = receipt.criteria as unknown[];
  if (rows.length !== criteria.length) throw new Error("receipt criteria IDs do not match");
  const seenIds = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const expected = criteria[index];
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("invalid criterion row");
    const item = row as Record<string, unknown>;
    if (Object.keys(item).sort().join("|") !== "evidence|id|outcome" || item.id !== expected?.id ||
      !["verified", "blocked"].includes(String(item.outcome)) || !Array.isArray(item.evidence) ||
      !(item.evidence as unknown[]).every((entry) => typeof entry === "string") || seenIds.has(String(item.id))) {
      throw new Error("receipt criteria IDs or rows do not match");
    }
    if (receipt.outcome === "passed" && (item.outcome !== "verified" || (item.evidence as string[]).length === 0)) {
      throw new Error("passed receipt requires evidence for every criterion");
    }
    seenIds.add(String(item.id));
  }
  return receipt as unknown as StageVerificationReceipt;
}

function stageReceiptPasses(
  receipt: StageVerificationReceipt,
  stage: PromotionStage,
  ticket: Ticket,
  landed: { repo: string; sha: string }[],
  criteria: readonly AcceptanceCriterion[],
): boolean {
  try {
    return validateStageReceipt(receipt, stage, ticket, landed, criteria).outcome === "passed";
  } catch {
    return false;
  }
}

async function runStageCommand(
  deps: LoopDeps,
  command: string,
  repo: RepoSpec,
  input: object,
  timeoutMs?: number,
): Promise<{ stdout: string; failed: string | null; timedOut: boolean }> {
  const run = deps.runPackCommand ?? spawnPackCommand;
  try {
    const result = await runWithTransient(deps, async () => {
      const value = await Promise.resolve(run(command, repoCheckoutDir(deps.cwd ?? process.cwd(), repo, deps.pack), `${JSON.stringify(input)}\n`, commandEnvironment(deps.pack, true), timeoutMs));
      return { status: value.status, output: `${value.stdout}\n${value.stderr ?? ""}`, stdout: value.stdout, timedOut: value.timedOut === true };
    });
    if (result.timedOut) return { stdout: result.stdout, failed: null, timedOut: true };
    return result.status === 0
      ? { stdout: result.stdout, failed: null, timedOut: false }
      : { stdout: result.stdout, failed: `${command} exited ${result.status ?? "unknown"}`, timedOut: false };
  } catch (error) {
    return { stdout: "", failed: `${command} ${error instanceof Error ? error.message : String(error)}`, timedOut: false };
  }
}

async function blockTimedOutStage(
  deps: LoopDeps,
  ticket: Ticket,
  stage: PromotionStage,
  kind: "promote" | "verify" | "continue",
  timeoutMs: number,
  landedHere: { repo: string; sha: string }[],
  criteria: readonly AcceptanceCriterion[],
): Promise<StageProblem> {
  const reason = `stage ${stage.id} ${kind} timed out after ${timeoutMs}ms`;
  const receipt = validateStageReceipt({
    stageId: stage.id,
    target: stage.target,
    outcome: "blocked",
    reason,
    criteriaRevision: ticket.criteriaRevision,
    deployed: landedHere,
    criteria: criteria.map((item) => ({ id: item.id, outcome: "blocked", evidence: [] })),
  }, stage, ticket, landedHere, criteria);
  await writeStageReceipt(deps, ticket, receipt);
  return { outcome: "blocked", stage, reason, evidence: [] };
}

async function runOneStage(
  deps: LoopDeps,
  ticket: Ticket,
  stage: PromotionStage,
  authorization: "deliver" | "ship",
  scoped: { repo: string; sha: string }[],
  criteria: readonly AcceptanceCriterion[],
  options: { continueStageId?: string },
): Promise<{ outcome: "passed"; stage: PromotionStage } | StageProblem> {
  const landedHere = sortedLanded(scoped);
  const expected = criteriaForStage(criteria, stage, scoped);
  const repos = scoped.map((row) => ({ name: row.repo, spec: repoByName(deps.pack, row.repo) }));
  const missingSpec = repos.find((row) => !row.spec);
  if (missingSpec) return { outcome: "failed", stage, reason: `stage ${stage.id} has no checkout for ${missingSpec.name}`, evidence: [] };
  const now = new Date(deps.nowMs ?? Date.now()).toISOString();
  const activeStage: ActivePromotion = { stageId: stage.id, target: stage.target, authorization, criteriaRevision: ticket.criteriaRevision };
  await mutateDelivery(deps, ticket, (state) => withActivePromotions(state, [
    ...readActivePromotions(state).filter((item) => item.stageId !== stage.id),
    activeStage,
  ], now));
  await mutateDelivery(deps, ticket, (state) => ({
    ...state,
    stageReceipts: state.stageReceipts.filter((receipt) => receipt.stageId !== stage.id),
  }));
  const continuing = options.continueStageId === stage.id;
  const command = continuing ? stage.continueCommand : stage.promoteCommand;
  const commandKind = continuing ? "continue" : "promote";
  const commandTimeout = continuing ? stage.continue?.timeoutMs : stage.promote?.timeoutMs;
  if (!command) return { outcome: "failed", stage, reason: `stage ${stage.id} has no continueCommand`, evidence: [] };
  for (const row of repos) {
    const repo = row.spec!;
    const source = scoped.find((item) => item.repo === row.name)!;
    const refs = stage.refs?.[row.name] ?? [];
    if (!continuing && refs.length > 0 && refs.every((ref) => deployRefContains(deps, repo, ref, source.sha))) continue;
    const promoted = await runStageCommand(deps, command, repo, {
      ticketId: ticket.identifier,
      stageId: stage.id,
      target: stage.target,
      repo: row.name,
      sourceSha: source.sha,
    }, commandTimeout);
    if (promoted.timedOut) return blockTimedOutStage(deps, ticket, stage, commandKind, commandTimeout!, landedHere, expected);
    if (promoted.failed) return { outcome: "failed", stage, reason: promoted.failed, evidence: [] };
    noteEngine(deps, "promote ok");
  }
  const verifyRepo = repos[0]!.spec!;
  const verifyInput: StageVerifyInput = {
    ticketId: ticket.identifier,
    stageId: stage.id,
    target: stage.target,
    criteriaRevision: ticket.criteriaRevision,
    landedShas: landedHere,
    criteria: expected,
  };
  const verified = await runStageCommand(deps, stage.verifyCommand, verifyRepo, verifyInput, stage.verify?.timeoutMs);
  if (verified.timedOut) return blockTimedOutStage(deps, ticket, stage, "verify", stage.verify!.timeoutMs, landedHere, expected);
  if (verified.failed) return { outcome: "failed", stage, reason: verified.failed, evidence: [] };
  let receipt: StageVerificationReceipt;
  try {
    const parsed: unknown = JSON.parse(verified.stdout.trim());
    receipt = validateStageReceipt(parsed, stage, ticket, landedHere, expected);
  } catch (error) {
    return { outcome: "failed", stage, reason: `invalid stage receipt: ${error instanceof Error ? error.message : String(error)}`, evidence: [] };
  }
  const passed = receipt.outcome === "passed";
  await mutateDelivery(deps, ticket, (state) => {
    const active = readActivePromotions(state).filter((item) => !passed || item.stageId !== stage.id);
    return {
      ...withActivePromotions(state, active, new Date(deps.nowMs ?? Date.now()).toISOString()),
      stageReceipts: [...state.stageReceipts.filter((item) => item.stageId !== stage.id), receipt],
    };
  });
  if (passed) {
    noteEngine(deps, "verify ok");
    return { outcome: "passed", stage };
  }
  const evidence = receiptEvidence(receipt);
  if (authorization === "deliver" && receipt.outcome === "parked") {
    return { outcome: "blocked", stage, reason: receipt.reason, evidence };
  }
  if (receipt.outcome === "not-applicable") {
    return { outcome: "failed", stage, reason: "invalid stage receipt: not-applicable", evidence };
  }
  return { outcome: receipt.outcome, stage, reason: receipt.reason, evidence };
}

async function runPromotionStages(
  deps: LoopDeps,
  ticket: Ticket,
  authorization: "deliver" | "ship",
  landed: { repo: string; sha: string }[],
  criteria: readonly AcceptanceCriterion[],
  options: { continueStageId?: string } = {},
): Promise<StageRun> {
  const stages = deps.pack.promotionStages.filter((stage) => stage.authorization === authorization);
  const allLanded = sortedLanded(landed);
  const done = new Set<string>();
  const pending = new Set(stages.map((stage) => stage.id));
  const problems: StageProblem[] = [];
  let applicable = 0;
  for (const stage of stages) {
    const scoped = stageLandedRows(stage, allLanded);
    const fresh = await readDeliveryState(deps, ticket);
    const old = fresh.stageReceipts.find((receipt) => receipt.stageId === stage.id);
    if (scoped.length === 0) {
      if (!currentStageReceipt(old, stage, ticket, allLanded, criteria)) {
        await writeStageReceipt(deps, ticket, notApplicableReceipt(stage, ticket));
      }
      done.add(stage.id);
      pending.delete(stage.id);
      continue;
    }
    applicable += 1;
    const expected = criteriaForStage(criteria, stage, scoped);
    if (old && stageReceiptPasses(old, stage, ticket, sortedLanded(scoped), expected)) {
      done.add(stage.id);
      pending.delete(stage.id);
    }
  }
  while (pending.size > 0) {
    const ready = stages.filter((stage) => pending.has(stage.id) && (stage.dependsOn ?? []).every((id) => done.has(id)));
    if (ready.length === 0) break;
    const results = await Promise.all(ready.map((stage) => runOneStage(
      deps,
      ticket,
      stage,
      authorization,
      stageLandedRows(stage, allLanded),
      criteria,
      options,
    )));
    for (const result of results) {
      pending.delete(result.stage.id);
      if (result.outcome === "passed") done.add(result.stage.id);
      else problems.push(result);
    }
  }
  const recorded = await readDeliveryState(deps, ticket);
  if (problems.length === 0 && stages.length > 0 && !authorizationSatisfied(stages, deps.pack.promotionStages, recorded.stageReceipts, ticket, allLanded, criteria)) {
    const uncovered = uncoveredCriteria(criteria, stages, deps.pack.promotionStages, allLanded);
    const reason = applicable === 0
      ? "no promotion stage applies to the landed repos"
      : `acceptance criteria not covered: ${uncovered.map((item) => item.id).join(", ")}`;
    problems.push({ outcome: "failed", stage: stages[0]!, reason, evidence: [] });
  }
  return stageRunFrom(problems);
}

function rememberedVerdict(deps: LoopDeps, key: string): HealVerdict | undefined {
  return deps.pageControl?.verdicts?.[key];
}

function rememberVerdict(deps: LoopDeps, key: string, verdict: HealVerdict): void {
  if (!deps.pageControl) deps.pageControl = { stop: false, healed: [] };
  if (!deps.pageControl.verdicts) deps.pageControl.verdicts = {};
  deps.pageControl.verdicts[key] = verdict;
}

export type ShipRun = { exitCode: number; lines: string[]; parked: boolean };

function refreshGithubToken(env: NodeJS.ProcessEnv): boolean {
  const command = env.DELIVERY_LOOP_GITHUB_MINT?.trim();
  if (!command) return false;
  const result = runMintCommand(command);
  const now = Date.now();
  const minted = result.status === 0 ? interpretMintOutput(result.stdout, now) : null;
  const ok = Boolean(minted && minted.expiresAtMs > now);
  noteMint({ exitStatus: result.status, ok });
  if (!minted || !ok) return false;
  env.GH_TOKEN = minted.token;
  env.GITHUB_TOKEN = minted.token;
  process.env.GH_TOKEN = minted.token;
  process.env.GITHUB_TOKEN = minted.token;
  return true;
}


function spawnPackCommand(
  command: string,
  cwd: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, { shell: true, cwd, env, detached: true });
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status, stdout, stderr, timedOut });
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      } else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", () => finish(1));
    child.on("close", (status) => finish(status));
    child.stdin?.on("error", () => {});
    child.stdin?.end(stdin);
  });
}

function defaultRunPackCommand(
  command: string,
  cwd: string,
  stdin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): { status: number | null; stdout: string; stderr: string; timedOut: boolean } {
  const result = spawnSync(command, {
    shell: true,
    cwd,
    input: stdin,
    encoding: "utf8",
    env,
    ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
  });
  const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", timedOut };
}

/** A symbol command that is unset accepts every line. A failing command does not. */
async function symbolsResolve(deps: LoopDeps, symbols: string[]): Promise<boolean> {
  const command = deps.pack.symbolsCommand?.trim();
  if (!command || symbols.length === 0) return true;
  const run = deps.runPackCommand ?? defaultRunPackCommand;
  const result = await Promise.resolve(run(command, deps.cwd ?? process.cwd(), `${symbols.join("\n")}\n`, commandEnvironment(deps.pack)));
  return result.status === 0;
}

type JourneyCommandPrint =
  | { ok: true; stdout: string }
  | { ok: false; reason: "failed"; status: number | null; stdout: string }
  | { ok: false; reason: "empty"; stdout: string };

/**
 * The pack command prints the proof token. An unset command prints nothing
 * and leaves the recorded text to stand on its own. A failing command or
 * stdout with no token is `ok: false`.
 */
async function journeyCommandProof(deps: LoopDeps, stdin: string): Promise<JourneyCommandPrint> {
  const command = deps.pack.journeyCommand?.trim();
  if (!command) return { ok: true, stdout: "" };
  const run = deps.runPackCommand ?? defaultRunPackCommand;
  const result = await Promise.resolve(run(command, deps.cwd ?? process.cwd(), stdin, commandEnvironment(deps.pack)));
  const stdout = result.stdout ?? "";
  if (result.status !== 0) return { ok: false, reason: "failed", status: result.status, stdout };
  if (parseJourneyProofs(stdout, deps.pack.journeySpec).length === 0) {
    return { ok: false, reason: "empty", stdout };
  }
  return { ok: true, stdout };
}

function journeySpecText(deps: LoopDeps): string {
  return deps.pack.journeySpec?.trim() || DEFAULT_JOURNEY_SPEC;
}

/** Names the command, the ticket, and the token the command should print. */
function journeyTokenMissing(deps: LoopDeps, identifier: string, printed: JourneyCommandPrint): string {
  const spec = journeySpecText(deps);
  const command = deps.pack.journeyCommand?.trim() || "";
  const expected = `Expected an https recording or screenshot URL, or a route test \`repo/path\` whose path matches \`${spec}\`.`;
  if (!printed.ok && printed.reason === "failed") {
    return `Journey command \`${command}\` exited ${printed.status ?? "null"} for ${identifier}. ${expected} The ticket stays in intake.`;
  }
  if (command) {
    return `Journey command \`${command}\` printed no **Journey proof:** token for ${identifier}. ${expected} The ticket stays in intake.`;
  }
  return `No journey command is set for ${identifier}. ${expected} The ticket stays in intake.`;
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

async function waitForExactWorkflow(deps: LoopDeps, repo: RepoSpec, sha: string): Promise<QualityWait> {
  const polls = deps.maxQualityPolls ?? 60;
  const sleep = deps.sleep ?? ((ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  });
  for (let index = 0; index < polls; index += 1) {
    const probe = await deps.forge.quality({ repoUrl: repo.url, headSha: sha, workflow: deps.pack.qualityWorkflow });
    if (probe.state === "success" || probe.state === "failure") return { state: probe.state, detail: probe.detail };
    const remainingMs = pageBudgetRemainingMs({ nowMs: deps.nowMs ?? Date.now(), startedAtMs: deps.pageStartedAtMs ?? null });
    if (shouldStopForPageReserve({ remainingMs }) || index === polls - 1) return { state: "pending", detail: probe.detail };
    await sleep(deps.qualityPollMs ?? QUALITY_POLL_MS);
  }
  return { state: "pending", detail: "workflow has no result for exact landed SHA" };
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

type JourneyFileState = "present" | "absent" | "unavailable";

function noteJourneyFile(
  deps: LoopDeps,
  repo: string,
  ref: string,
  path: string,
  reason: string,
): void {
  const clean = reason.replace(/\s+/g, " ").trim() || "unknown";
  noteEngine(
    deps,
    `journey file repo=${repo} ref=${ref} path=${path} result=unavailable reason=${clean}`,
  );
}

/**
 * A route-test file on `ref`. The forge contents API is used when the forge
 * has one. A missing file is `absent`. A check that cannot run is
 * `unavailable` and the reason is logged. The two results stay distinct.
 */
async function journeyFileState(
  deps: LoopDeps,
  repo: string,
  ref: string,
  path: string,
): Promise<{ state: JourneyFileState; reason: string }> {
  if (deps.journeyFileAt) {
    return deps.journeyFileAt({ repo, ref, path })
      ? { state: "present", reason: "" }
      : { state: "absent", reason: "" };
  }
  const spec = repoByName(deps.pack, repo);
  if (!spec || !ref || !path) {
    const reason = "ref missing";
    noteJourneyFile(deps, repo, ref, path, reason);
    return { state: "unavailable", reason };
  }
  if (deps.forge.readTextFile) {
    let slug = "";
    try {
      const parsed = githubRepoFromUrl(spec.url);
      slug = `${parsed.owner}/${parsed.repo}`;
    } catch {
      slug = "";
    }
    if (slug) {
      try {
        const read = await deps.forge.readTextFile({
          repo: slug,
          branch: ref,
          path,
          endpoint: "contents",
        });
        if (read.status === 200) return { state: "present", reason: "" };
        if (read.status === 404) return { state: "absent", reason: "" };
        const reason = `contents status=${read.status}`;
        noteJourneyFile(deps, repo, ref, path, reason);
        return { state: "unavailable", reason };
      } catch {
        const reason = "contents error";
        noteJourneyFile(deps, repo, ref, path, reason);
        return { state: "unavailable", reason };
      }
    }
  }
  const dir = repoCheckoutDir(deps.cwd ?? process.cwd(), spec, deps.pack);
  if (!existsSync(join(dir, ".git"))) {
    const reason = "checkout missing";
    noteJourneyFile(deps, repo, ref, path, reason);
    return { state: "unavailable", reason };
  }
  const present = (at: string) =>
    spawnSync("git", ["-C", dir, "cat-file", "-e", `${at}:${path}`], { encoding: "utf8" }).status === 0;
  const commitHere = (at: string) =>
    spawnSync("git", ["-C", dir, "cat-file", "-e", `${at}^{commit}`], { encoding: "utf8" }).status === 0;
  if (present(ref)) return { state: "present", reason: "" };
  const local = commitHere(ref);
  const fetched = spawnSync("git", ["-C", dir, "fetch", "--depth=1", "origin", ref], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (present(ref)) return { state: "present", reason: "" };
  const fetchedTrunk = spawnSync("git", ["-C", dir, "fetch", "origin", spec.trunk], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (present(ref)) return { state: "present", reason: "" };
  if (commitHere(ref)) return { state: "absent", reason: "" };
  if (!local && fetched.status !== 0 && fetchedTrunk.status !== 0) {
    const reason = `fetch status=${fetched.status ?? "null"}`;
    noteJourneyFile(deps, repo, ref, path, reason);
    return { state: "unavailable", reason };
  }
  if (commitHere(ref)) return { state: "absent", reason: "" };
  const reason = `fetch status=${fetched.status ?? "null"}`;
  noteJourneyFile(deps, repo, ref, path, reason);
  return { state: "unavailable", reason };
}

async function journeyEvidenceOnRefs(
  deps: LoopDeps,
  text: string,
  refFor: (repo: string) => string,
): Promise<boolean> {
  const proofs = parseJourneyProofs(text, deps.pack.journeySpec);
  const present = new Map<string, boolean>();
  for (const proof of proofs) {
    if (proof.kind !== "route-test") continue;
    const ref = refFor(proof.repo);
    const found = await journeyFileState(deps, proof.repo, ref, proof.path);
    present.set(`${proof.repo}\n${ref}\n${proof.path}`, found.state === "present");
  }
  return journeyEvidenceProven(
    text,
    text,
    (repo, path) => present.get(`${repo}\n${refFor(repo)}\n${path}`) === true,
    deps.pack.journeySpec,
  );
}

type JourneyFileLookup = {
  onMerge: (repo: string, path: string) => boolean;
  onTargets: (repo: string, path: string) => boolean;
  unavailable: string[];
};

/** Resolve each route-test proof once against landed and configured delivery refs. */
async function journeyFileLookup(
  deps: LoopDeps,
  evidence: string,
  rows: { repo: RepoSpec; sha: string }[],
): Promise<JourneyFileLookup> {
  const proofs = parseJourneyProofs(evidence, deps.pack.journeySpec);
  const cache = new Map<string, JourneyFileState>();
  const unavailable: string[] = [];
  const load = async (repo: string, ref: string, path: string) => {
    const key = `${repo}\n${ref}\n${path}`;
    if (cache.has(key)) return;
    const found = await journeyFileState(deps, repo, ref, path);
    cache.set(key, found.state);
    if (found.state === "unavailable") unavailable.push(`${repo} ${path} @ ${ref}: ${found.reason}`);
  };
  for (const proof of proofs) {
    if (proof.kind !== "route-test") continue;
    const row = rows.find((item) => item.repo.name === proof.repo);
    if (!row) continue;
    await load(proof.repo, row.sha, proof.path);
    for (const ref of promotionRefs(deps, proof.repo)) await load(proof.repo, ref, proof.path);
  }
  const onMerge = (repo: string, path: string) => {
    const row = rows.find((item) => item.repo.name === repo);
    return Boolean(row && cache.get(`${repo}\n${row.sha}\n${path}`) === "present");
  };
  const onTargets = (repo: string, path: string) => {
    const refs = promotionRefs(deps, repo);
    return refs.length > 0 && refs.every((ref) => cache.get(`${repo}\n${ref}\n${path}`) === "present");
  };
  return { onMerge, onTargets, unavailable };
}

function reposForMarker(
  deps: LoopDeps,
  rows: { repo: string; sha: string }[],
): { repo: RepoSpec; sha: string }[] {
  const out: { repo: RepoSpec; sha: string }[] = [];
  for (const row of rows) {
    const spec = repoByName(deps.pack, row.repo);
    if (spec) out.push({ repo: spec, sha: row.sha });
  }
  return out;
}

type RecordedProof =
  | { ok: true; recorded: boolean; proofReceipt: string }
  | { ok: false; result: TicketResult };

/** Promotion refs when configured. Otherwise the repo trunk. */
function promotionRefs(deps: LoopDeps, repoName: string): string[] {
  const named = deps.pack.promotionStages
    .filter((stage) => stage.authorization === "deliver" && stage.repos.includes(repoName))
    .flatMap((stage) => stage.refs?.[repoName] ?? []);
  if (named.length > 0) return named;
  const trunk = repoByName(deps.pack, repoName)?.trunk;
  return trunk ? [trunk] : [];
}


function proofSatisfies(
  deps: LoopDeps,
  evidence: string,
  receipt: string,
  fileOnCommit: (repo: string, path: string) => boolean,
): boolean {
  return journeyEvidenceProven(evidence, receipt, fileOnCommit, deps.pack.journeySpec);
}

/**
 * Recorded journey proof before completion. A fresh land and a resume both
 * use this; the state-store proof marker is reused when it already suffices.
 * When the merged commit does not contain the route test, configured promotion
 * target refs are checked; absent refs fall back to the repo trunk.
 * A spec outside the journey-spec pattern is not that proof.
 */
function journeyMissComment(
  deps: LoopDeps,
  identifier: string,
  evidence: string,
  receipt: string,
  unavailable: string[],
): string {
  const proofs = parseJourneyProofs(evidence, deps.pack.journeySpec);
  const route = proofs.some((proof) => proof.kind === "route-test");
  const recordingGap = proofs.some(
    (proof) => proof.kind === "recording" && !receipt.includes(proof.url),
  );
  if (unavailable.length > 0 && route && !recordingGap) {
    return `Journey evidence for ${identifier} is recorded. The route-test file check could not run: ${unavailable.join("; ")}. The ticket stays in intake.`;
  }
  return `Journey evidence for ${identifier} is recorded. The route test is absent from the landed commit and configured delivery-stage refs. A web journey needs the recording URL in the build receipt. A mobile journey needs the route test on those refs under \`${journeySpecText(deps)}\`. The ticket stays in intake.`;
}

async function applyRecordedProof(
  deps: LoopDeps,
  ticket: Ticket,
  rows: { repo: RepoSpec; sha: string; url?: string }[],
  declared: string,
  receipt: string,
): Promise<RecordedProof> {
  const recorded =
    parseJourneyEvidence(declared) === "recorded" || parseJourneyEvidence(receipt) === "recorded";
  if (!recorded) return { ok: true, recorded: false, proofReceipt: receipt };
  const evidence = `${declared}\n${receipt}`;
  const existing = publishedProofReceipt(deps, ticket);
  let files = await journeyFileLookup(deps, `${evidence}\n${existing ?? ""}`, rows);
  if (
    existing &&
    (proofSatisfies(deps, `${evidence}\n${existing}`, existing, files.onMerge) ||
      proofSatisfies(deps, `${evidence}\n${existing}`, existing, files.onTargets))
  ) {
    noteEngine(deps, "proof ok");
    return { ok: true, recorded: true, proofReceipt: existing };
  }
  if (proofSatisfies(deps, evidence, receipt, files.onMerge) || proofSatisfies(deps, evidence, receipt, files.onTargets)) {
    noteEngine(deps, "proof ok");
    return { ok: true, recorded: true, proofReceipt: receipt.trim() ? receipt : declared };
  }
  const printed = await journeyCommandProof(deps, evidence);
  if (!printed.ok) {
    await healUnprovenJourney(deps, ticket, printed);
    await deps.tracker.comment(ticket.identifier, journeyTokenMissing(deps, ticket.identifier, printed));
    return {
      ok: false,
      result: {
        identifier: ticket.identifier,
        outcome: "journey-missing",
        detail: "recorded proof missing",
      },
    };
  }
  const combined = [receipt, printed.stdout].filter((part) => part.trim()).join("\n");
  const proofReceipt = combined.trim() ? combined : declared;
  const provenText = `${declared}\n${proofReceipt}`;
  if (printed.stdout.trim()) files = await journeyFileLookup(deps, `${provenText}\n${existing ?? ""}`, rows);
  const proven =
    proofSatisfies(deps, provenText, proofReceipt, files.onMerge) ||
    proofSatisfies(deps, provenText, proofReceipt, files.onTargets);
  const note = proven ? "" : journeyMissComment(deps, ticket.identifier, provenText, proofReceipt, files.unavailable);
  if (!proven) {
    await deps.tracker.comment(ticket.identifier, note);
    return {
      ok: false,
      result: {
        identifier: ticket.identifier,
        outcome: "journey-missing",
        detail: note.includes("could not run") ? "journey file unavailable" : "recorded proof missing",
      },
    };
  }
  noteEngine(deps, "proof ok");
  return { ok: true, recorded: true, proofReceipt };
}

function journeyCommandOutput(printed: Extract<JourneyCommandPrint, { ok: false }>): string {
  const body = printed.stdout.trim();
  if (printed.reason === "failed") return [`exit ${printed.status ?? "null"}`, body].filter(Boolean).join("\n");
  return body;
}

/** A recorded attempt at these landed SHAs, with no proof from the journey command, goes to heal. */
async function healUnprovenJourney(deps: LoopDeps, ticket: Ticket, printed: Extract<JourneyCommandPrint, { ok: false }>): Promise<void> {
  const proof = journeyProofReceiptState(deps, ticket);
  if (!proof?.attempted) return;
  const output = journeyCommandOutput(printed);
  const reason = [
    "A proof was recorded but the journey command returned none.",
    `Command output: ${output || "(none)"}`,
    `Receipt reference: ${proof.receipt.trim() || "(none)"}`,
  ].join("\n");
  const signature = shipNoSignature(reason) || "journey command returned none";
  await applyOwnerHeal(deps, ticket, `heal:proof:${signature}`, reason);
}

async function publishCompletionProof(
  deps: LoopDeps,
  ticket: Ticket,
  recorded: boolean,
  proofReceipt: string,
  rows: { repo: string; sha: string; url?: string }[],
): Promise<void> {
  const existing = publishedProofReceipt(deps, ticket);
  await publishProofReceipt(deps, ticket, recorded ? { receipt: proofReceipt, rows } : existing ? { receipt: existing, rows } : null);
}


async function settleTrunk(
  deps: LoopDeps,
  ticket: Ticket,
  hold: boolean,
  rows: { repo: RepoSpec; sha: string; url?: string }[],
  doneDetail: string,
  declared = "",
  receipt = "",
): Promise<TicketResult> {
  const candidates = rows.map((row) => ({ repo: row.repo.name, sha: row.sha }));
  await writeMarker(deps, ticket, "landed-commits", JSON.stringify(candidates));
  const waiting: { repo: string; sha: string }[] = [];
  for (const row of rows) {
    const sha = deps.pack.landingStrategy === "fast-forward" ? row.sha : await trunkTip(deps, row.repo, row.sha);
    const quality = deps.pack.landingStrategy === "fast-forward"
      ? await waitForExactWorkflow(deps, row.repo, sha)
      : await trunkQuality(deps, { repo: row.repo, sha });
    if (quality.state !== "success") waiting.push({ repo: row.repo.name, sha });
  }
  const carried = [declared, receipt].filter((part) => part.trim()).join("\n");
  if (waiting.length > 0) {
    await writeMarker(deps, ticket, "land-resume", JSON.stringify({ kind: "wait", hold, rows: candidates, declared, receipt: carried } satisfies LandResume));
    return { identifier: ticket.identifier, outcome: "trunk-waiting", detail: waiting.map((row) => `${row.repo} ${row.sha}`).join(" ") };
  }
  const order = parseWorkOrder(declared);
  if (!order) return { identifier: ticket.identifier, outcome: "invalid-packet", detail: "acceptance matrix missing from saved work order" };
  const stages = await runPromotionStages(deps, ticket, "deliver", candidates, order.criteria);
  if (stages.outcome !== "complete") {
    await writeMarker(deps, ticket, "land-resume", JSON.stringify({ kind: "wait", hold, rows: candidates, declared, receipt: carried } satisfies LandResume));
    for (const problem of stages.problems) {
      const signature = shipNoSignature(problem.reason) || problem.reason;
      await applyOwnerHeal(deps, ticket, `heal:promote:${problem.stage.id}:${signature}`, stageProblemText(problem));
      if (problem.outcome === "blocked" || problem.outcome === "parked") {
        await deps.tracker.comment(ticket.identifier, `Promotion stage ${problem.stage.id} is blocked: ${problem.reason}`);
      }
    }
    if (stages.outcome === "failed") {
      return { identifier: ticket.identifier, outcome: "quality-failed", detail: `stage ${stages.stage.id}: ${stages.reason}` };
    }
    if (stages.outcome === "parked") {
      return { identifier: ticket.identifier, outcome: "blocked", detail: `stage ${stages.stage.id} parked: ${stages.reason}` };
    }
    return { identifier: ticket.identifier, outcome: "blocked", detail: stages.reason };
  }
  const gate = await applyRecordedProof(deps, ticket, rows, declared, receipt);
  if (!gate.ok) return gate.result;
  if (!hold) {
    await publishCompletionProof(deps, ticket, gate.recorded, gate.proofReceipt, rows.map((row) => ({ repo: row.repo.name, sha: row.sha, url: row.url })));
  }
  await removeMarker(deps, ticket, "land-resume");
  await writeTicketStatus(deps, ticket, hold ? holdStatus(deps.pack) : deps.pack.status.complete);
  return { identifier: ticket.identifier, outcome: "landed", detail: doneDetail };
}

async function writeTicketStatus(deps: LoopDeps, ticket: Ticket, state: string): Promise<void> {
  if (ticket.stateName === state) return;
  await deps.tracker.setState(ticket.identifier, state, ticket.criteriaRevision);
  ticket.stateName = state;
}

function commandEnvironment(pack: ProjectPack, allowDeploymentCredentials = false): NodeJS.ProcessEnv {
  const workerKeys = Object.values(workerKeyNames(pack));
  const commitActor = pack.commitActorTokenEnv && !(allowDeploymentCredentials && ["GH_TOKEN", "GITHUB_TOKEN"].includes(pack.commitActorTokenEnv))
    ? pack.commitActorTokenEnv
    : undefined;
  const excluded = new Set([
    "LINEAR_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "WORKER_HTTP_TOKEN",
    "GOOGLE_APPLICATION_CREDENTIALS", "AZURE_CLIENT_SECRET", "GIT_ASKPASS", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
    "DOCKER_CONFIG", "DOCKER_AUTH_CONFIG", "NPM_CONFIG_USERCONFIG", "NETRC", "KUBECONFIG",
    pack.jira?.authHeaderEnv,
    pack.design?.figmaTokenEnv ?? "FIGMA_ACCESS_TOKEN",
    commitActor,
    ...workerKeys,
  ].filter((name): name is string => Boolean(name)));
  const credentialName = /(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTHORIZATION|AUTH_HEADER|BEARER)/i;
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    const awsCredential = name.startsWith("AWS_") && name !== "AWS_REGION" && name !== "AWS_DEFAULT_REGION";
    const deploymentCredential = name === "GH_TOKEN" || name === "GITHUB_TOKEN" || awsCredential;
    if (value === undefined || excluded.has(name) || name.startsWith("DELIVERY_LOOP_") || name.startsWith("GIT_CONFIG_") ||
      (deploymentCredential && !allowDeploymentCredentials) || (credentialName.test(name) && !(allowDeploymentCredentials && deploymentCredential))) continue;
    env[name] = value;
  }
  return env;
}

export function candidateFetchEnvironment(pack: ProjectPack, repoUrl: string): NodeJS.ProcessEnv {
  const env = commandEnvironment(pack);
  let url: URL | null = null;
  try {
    url = new URL(repoUrl);
  } catch {
    url = null;
  }
  if (url?.hostname.toLowerCase() === "github.com" && url.protocol === "http:") {
    throw new Error("GitHub candidate fetch requires HTTPS");
  }
  if (url?.hostname.toLowerCase() === "github.com" && url.protocol === "https:") {
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
    const extraHeader = `http.${url.protocol}//${url.host}/.extraheader`;
    Object.assign(env, {
      GIT_CONFIG_COUNT: token ? "4" : "3",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_KEY_2: extraHeader,
      GIT_CONFIG_VALUE_2: "",
      GIT_TERMINAL_PROMPT: "0",
      ...(token ? {
        GIT_CONFIG_KEY_3: extraHeader,
        GIT_CONFIG_VALUE_3: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
      } : {}),
    });
  } else {
    for (const name of ["SSH_AUTH_SOCK", "SSH_AGENT_PID"]) {
      const value = process.env[name];
      if (value) env[name] = value;
    }
  }
  return env;
}

function runQualityAtCommit(
  deps: LoopDeps,
  repo: RepoSpec,
  branch: string,
  expectedSha: string,
): { status: number | null; stdout?: string; stderr?: string } {
  const sourceDir = repoCheckoutDir(deps.cwd ?? process.cwd(), repo, deps.pack);
  if (!existsSync(join(sourceDir, ".git"))) return { status: 1, stderr: `${repo.name} has no git checkout for candidate quality` };
  const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";
  const git = (args: string[], env: NodeJS.ProcessEnv = process.env) =>
    spawnSync("git", ["-C", sourceDir, "-c", `core.hooksPath=${hooksPath}`, ...args], { encoding: "utf8", env });
  const present = git(["cat-file", "-e", `${expectedSha}^{commit}`]);
  if (present.status !== 0) {
    let fetchEnv: NodeJS.ProcessEnv;
    try {
      fetchEnv = candidateFetchEnvironment(deps.pack, repo.url);
    } catch (error) {
      return { status: 1, stderr: error instanceof Error ? error.message : String(error) };
    }
    const fetched = git(["fetch", "--depth=1", "--no-tags", repo.url, branch], fetchEnv);
    if (fetched.status !== 0) return { status: fetched.status, stderr: fetched.stderr ?? `could not fetch ${branch}` };
    const fetchedSha = git(["rev-parse", "FETCH_HEAD^{commit}"]);
    if (fetchedSha.status !== 0 || fetchedSha.stdout?.trim() !== expectedSha) {
      return { status: 1, stderr: `candidate branch ${branch} changed before quality verification` };
    }
  }
  const tempRoot = mkdtempSync(join(tmpdir(), "delivery-loop-quality-"));
  const worktree = join(tempRoot, "checkout");
  let added = false;
  let result: { status: number | null; stdout?: string; stderr?: string } = { status: 1, stderr: "candidate worktree was not created" };
  try {
    const created = git(["worktree", "add", "--detach", worktree, expectedSha]);
    if (created.status !== 0) return { status: created.status, stderr: created.stderr ?? "git worktree add failed" };
    added = true;
    const checked = spawnSync("git", ["-C", worktree, "-c", `core.hooksPath=${hooksPath}`, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (checked.status !== 0 || checked.stdout?.trim() !== expectedSha) {
      return { status: 1, stderr: `isolated worktree does not match candidate ${expectedSha}` };
    }
    const modules = join(sourceDir, "node_modules");
    if (existsSync(modules) && !existsSync(join(worktree, "node_modules"))) {
      symlinkSync(modules, join(worktree, "node_modules"), "dir");
    }
    const run = deps.runCommand ?? defaultRunCommand;
    result = run(deps.pack.qualityCommand, worktree, commandEnvironment(deps.pack));
  } finally {
    if (added) {
      const removed = git(["worktree", "remove", "--force", worktree]);
      if (removed.status !== 0) {
        git(["worktree", "prune"]);
        result = { ...result, status: 1, stderr: `${result.stderr ?? ""}\nfailed to clean candidate worktree: ${removed.stderr ?? "git worktree remove failed"}` };
      }
    }
    rmSync(tempRoot, { recursive: true, force: true });
  }
  return result;
}

async function landFastForward(
  deps: LoopDeps,
  ticket: Ticket,
  landings: { repo: RepoSpec; branch: string; sha?: string }[],
  hold: boolean,
  declared: string,
  receipt: string,
): Promise<MergedHead[] | TicketResult> {
  const lookup = deps.lookupHead ?? lookupRemoteHead;
  const candidates: { repo: RepoSpec; branch: string; head: string; base: string }[] = [];
  for (const landing of sortByPack(deps.pack, landings, (row) => row.repo.name)) {
    const head = lookup(landing.repo.url, landing.branch);
    const base = lookup(landing.repo.url, landing.repo.trunk);
    if (!head || !base || (landing.sha && landing.sha !== head)) {
      return { identifier: ticket.identifier, outcome: "land-blocked", detail: `stale or missing fast-forward head/base for ${landing.repo.name}` };
    }
    const check = runQualityAtCommit(deps, landing.repo, landing.branch, head);
    if (check.status !== 0) {
      return { identifier: ticket.identifier, outcome: "quality-failed", detail: `${landing.repo.name}: ${deps.pack.qualityCommand} exited ${check.status ?? "unknown"}${check.stderr ? `: ${check.stderr}` : ""}` };
    }
    candidates.push({ repo: landing.repo, branch: landing.branch, head, base });
  }
  const merged: MergedHead[] = [];
  for (const candidate of candidates) {
    let relation: CompareStatus = "unknown";
    try {
      relation = await deps.forge.compare({ repoUrl: candidate.repo.url, base: candidate.base, head: candidate.head });
    } catch {
      relation = "unknown";
    }
    const sha = relation === "identical" || relation === "behind"
      ? candidate.head
      : await deps.forge.directLand({
          repoUrl: candidate.repo.url,
          branch: candidate.branch,
          base: candidate.repo.trunk,
          expectedHeadSha: candidate.head,
          expectedBaseSha: candidate.base,
        });
    merged.push({ repo: candidate.repo, sha, url: candidate.branch });
  }
  const landed = merged.map((row) => ({ repo: row.repo.name, sha: row.sha }));
  await writeMarker(deps, ticket, "landed-commits", JSON.stringify(landed));
  for (const row of merged) {
    const quality = await waitForExactWorkflow(deps, row.repo, row.sha);
    if (quality.state !== "success") {
      if (quality.state === "pending") {
        await writeMarker(deps, ticket, "land-resume", JSON.stringify({ kind: "wait", hold, rows: landed, declared, receipt } satisfies LandResume));
        return { identifier: ticket.identifier, outcome: "quality-pending", detail: `${row.repo.name} ${row.sha}: ${quality.detail}` };
      }
      return { identifier: ticket.identifier, outcome: "quality-failed", detail: `${row.repo.name} ${row.sha}: ${quality.detail}` };
    }
  }
  return merged;
}

async function finishMerged(
  deps: LoopDeps,
  ticket: Ticket,
  hold: boolean,
  merged: MergedHead[],
  declared: string,
  receipt: string,
): Promise<TicketResult> {
  return settleTrunk(
    deps,
    ticket,
    hold,
    merged.map((row) => ({ repo: row.repo, sha: row.sha, url: row.url })),
    merged.map((row) => row.url).join(" "),
    declared,
    receipt,
  );
}

type FoundPull = ListedPull & { repo: RepoSpec };

/** Repos named by the current v2 work order. */
function recordedLandRepos(deps: LoopDeps, ticket: Ticket): string[] | null {
  const texts = resumeProofTexts(deps, ticket);
  return parseWorkOrder(texts.declared)?.repos ?? null;
}

/**
 * Pull requests this ticket already has, one head per land repo.
 * Null when nothing has merged, or a named repo still has its own commits and no pull request.
 */
async function findTicketPulls(
  deps: LoopDeps,
  ticket: Ticket,
): Promise<{ merged: FoundPull[]; open: FoundPull[] } | null> {
  const list = deps.forge.listPullRequests;
  const template = deps.pack.branchTemplate;
  if (!list || !template) return null;
  const merged: FoundPull[] = [];
  const open: FoundPull[] = [];
  for (const repo of deps.pack.repos) {
    const branch = renderBranch(template, ticket.identifier, repo.name);
    const rows = await list({ repoUrl: repo.url, head: branch, base: repo.trunk });
    const mine = rows.filter((row) => row.branch === branch && row.base === repo.trunk);
    const mergedRow = mine.find((row) => row.state === "merged" && row.mergedSha);
    const openRow = mine.find((row) => row.state === "open" && row.headSha);
    if (mergedRow?.mergedSha) merged.push({ ...mergedRow, repo });
    if (openRow) open.push({ ...openRow, repo });
  }
  if (merged.length === 0) return null;
  const named = recordedLandRepos(deps, ticket);
  if (named) {
    for (const name of named) {
      const repo = repoByName(deps.pack, name);
      if (!repo) return null;
      const known =
        merged.some((row) => row.repo.name === name) || open.some((row) => row.repo.name === name);
      if (known) continue;
      if (!(await repoAlreadyOnTrunk(deps, ticket, repo))) return null;
    }
  }
  return { merged, open };
}

/** True when the land branch has no commits of its own. A missing branch is not on trunk. */
async function repoAlreadyOnTrunk(deps: LoopDeps, ticket: Ticket, repo: RepoSpec): Promise<boolean> {
  const template = deps.pack.branchTemplate;
  if (!template) return false;
  const branch = renderBranch(template, ticket.identifier, repo.name);
  const lookup = deps.lookupHead ?? lookupRemoteHead;
  const sha = lookup(repo.url, branch);
  if (!sha) return false;
  try {
    const compared = await deps.forge.compare({ repoUrl: repo.url, base: repo.trunk, head: sha });
    return compared === "identical" || compared === "behind";
  } catch {
    return false;
  }
}

async function alreadyFinished(deps: LoopDeps, ticket: Ticket): Promise<boolean> {
  if (ticket.stateName !== deps.pack.status.complete && ticket.stateName !== deps.pack.status.shipped) return false;
  const stages = deps.pack.promotionStages.filter((stage) => stage.authorization === "deliver");
  if (stages.length === 0) return true;
  const state = await readDeliveryState(deps, ticket);
  const rawRows = state.markers.find((marker) => marker.kind === "landed-commits")?.body;
  const texts = resumeProofTexts(deps, ticket);
  const order = parseWorkOrder(texts.declared);
  if (!rawRows || !order) return false;
  let landed: { repo: string; sha: string }[];
  try {
    landed = JSON.parse(rawRows) as { repo: string; sha: string }[];
  } catch {
    return false;
  }
  return authorizationSatisfied(stages, deps.pack.promotionStages, state.stageReceipts, ticket, landed, order.criteria);
}

/**
 * Land the pull requests this ticket already has. Merged ones count as landed.
 * Every open pull request is ready before the first squash. One that is not
 * ready leaves the others unmerged. Missing proof stays on ground.
 */
async function resumeExistingPulls(deps: LoopDeps, ticket: Ticket): Promise<TicketResult | null> {
  const found = await findTicketPulls(deps, ticket);
  if (!found) return null;
  const texts = resumeProofTexts(deps, ticket);
  const journey = parseJourneyEvidence(texts.declared) ?? parseJourneyEvidence(texts.receipt);
  const grant = parseOutsideGrant(texts.declared);
  if ((journey !== "recorded" && journey !== "not-applicable") || !grant) return null;
  noteTicket(deps, { identifier: ticket.identifier, phase: "land" });
  const merged: MergedHead[] = [];
  for (const row of sortByPack(deps.pack, found.merged, (item) => item.repo.name)) {
    if (!row.mergedSha) continue;
    merged.push({ repo: row.repo, sha: row.mergedSha, url: row.url });
  }
  const ready: OpenPull[] = [];
  for (const row of sortByPack(deps.pack, found.open, (item) => item.repo.name)) {
    const pr: OpenPull = {
      repo: row.repo,
      number: row.number,
      url: row.url,
      headSha: row.headSha,
      branch: row.branch,
      created: false,
    };
    const prepared = await settleLand(deps, ticket, pr, texts.declared);
    if ("outcome" in prepared) return prepared;
    ready.push({ ...pr, headSha: prepared.headSha });
  }
  for (const pr of ready) {
    const landed = await commitLand(deps, ticket, pr);
    if ("outcome" in landed) return landed;
    merged.push({ repo: pr.repo, sha: landed.mergedSha, url: pr.url });
  }
  return finishMerged(deps, ticket, grant === "open", merged, texts.declared, texts.receipt);
}

/**
 * A previous land already merged, or already saw there was nothing to merge.
 * Re-check that fact. A coding worker does not start while the recorded commit
 * is unchanged; missing proof remains blocked until valid evidence is supplied.
 */
async function resumeMarkedLand(deps: LoopDeps, ticket: Ticket, body: string | null): Promise<TicketResult | null> {
  const marker = parseLandResume(body);
  if (!marker) return null;
  if (marker.kind === "empty") {
    const template = deps.pack.branchTemplate;
    if (!template || marker.rows.length === 0) return null;
    const lookup = deps.lookupHead ?? lookupRemoteHead;
    for (const row of marker.rows) {
      const repo = repoByName(deps.pack, row.repo);
      if (!repo || lookup(repo.url, renderBranch(template, ticket.identifier, row.repo)) !== row.sha) return null;
    }
    return { identifier: ticket.identifier, outcome: "land-empty", detail: "branch unchanged" };
  }
  const rows = reposForMarker(deps, marker.rows);
  if (rows.length !== marker.rows.length || rows.length === 0) return null;
  noteTicket(deps, { identifier: ticket.identifier, phase: "land" });
  const texts = resumeProofTexts(deps, ticket);
  return settleTrunk(
    deps,
    ticket,
    marker.hold,
    rows,
    "landed commits unchanged",
    marker.declared || texts.declared,
    marker.receipt || texts.receipt,
  );
}

let releaseTagCache: string[] | undefined | null = null;

/** Tags the opener can see with the checkout's existing remote. No new credential. */
function releaseTagsForHeal(): string[] | undefined {
  if (releaseTagCache !== null) return releaseTagCache;
  const listed = spawnSync("git", ["ls-remote", "--tags", "--refs", "origin"], {
    encoding: "utf8",
    timeout: 8000,
  });
  if (listed.status !== 0 || !listed.stdout?.trim()) {
    releaseTagCache = undefined;
    return undefined;
  }
  const tags = listed.stdout
    .split("\n")
    .map((line) => line.trim().split(/\s+/).pop() ?? "")
    .filter((ref) => releaseVersionFromTag(ref) !== null);
  releaseTagCache = tags.length > 0 ? tags : undefined;
  return releaseTagCache;
}

function healAlready(deps: LoopDeps, ticket: Ticket, key: string): boolean {
  void ticket;
  return deps.pageControl?.healed.includes(key) ?? false;
}

/**
 * One edit of the owner of a step that returned no.
 * A second call for the same key does not start a worker.
 * The page stops so the next page checks out the edited trunk.
 */
async function applyOwnerHeal(
  deps: LoopDeps,
  ticket: Ticket,
  key: string,
  reason: string,
): Promise<HealVerdict> {
  if (healAlready(deps, ticket, key)) return "wait";
  const type = failureTypeForHealKey(key);
  const markerBodies = deliveryStateCache.get(deps)?.get(ticket.identifier)?.markers.filter((marker) => marker.kind === "owner-heal").map((marker) => marker.body) ?? [];
  const ownerHealCount = markerBodies.filter((body) => {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && "type" in parsed && parsed.type === type;
    } catch {
      return false;
    }
  }).length;
  if (ownerHealCount >= healCapFor(deps.pack.heal, type)) {
    await markHealExhausted(deps, ticket, type);
    throw new HealExhaustedError(type);
  }
  const home = agentHome(deps.pack);
  const prompt = ownerHealPrompt({
    reason,
    tokenEnv: deps.pack.commitActorTokenEnv,
    issue: ticket.identifier,
    releaseTags: releaseTagsForHeal(),
  });
  const eligibility = await checkEligibility(deps, ticket);
  if (eligibility.outcome !== "eligible") throw new EligibilityGateError(eligibility);
  let text = "";
  if (deps.ownerHeal) {
    text = (await deps.ownerHeal({ prompt, repoUrl: home.url, baseRef: home.trunk })) ?? "";
  } else {
    const started = await deps.worker.start({ prompt, repoUrl: home.url, baseRef: home.trunk });
    await noteLiveRun(deps, ticket, "build", started.runId);
    text = (await finishWorker(deps.worker, started.runId)).text;
  }
  const verdict = healVerdict(text);
  if (verdict !== "edit") {
    rememberVerdict(deps, key, verdict);
    return verdict;
  }
  const state = await readDeliveryState(deps, ticket);
  await writeDeliveryState(deps, ticket, {
    ...state,
    markers: [...state.markers, { kind: "owner-heal", body: JSON.stringify({ key, type, reason }), createdAt: new Date(deps.nowMs ?? Date.now()).toISOString() }],
  });
  rememberVerdict(deps, key, verdict);
  if (!deps.pageControl) deps.pageControl = { stop: false, healed: [] };
  deps.pageControl.healed.push(key);
  deps.pageControl.stop = true;
  return "edit";
}

function pauseLand(identifier: string, url: string, reason: string, tail = "The sweep continues with the next ticket."): TicketResult {
  const detail = tail ? `Land paused on ${url}. ${reason} ${tail}` : `Land paused on ${url}. ${reason}`;
  return {
    identifier,
    outcome: "land-blocked",
    detail,
  };
}

async function explainQuality(
  deps: LoopDeps,
  ticket: Ticket,
  pr: OpenPull,
  quality: QualityWait,
): Promise<TicketResult | null> {
  if (quality.state === "pending" || quality.state === "unscheduled") {
    const signature = shipNoSignature(quality.detail) || quality.state;
    const key = `heal:${quality.state}:${signature}`;
    const reason = `Quality returned no on ${pr.url}. ${quality.detail}`;
    const verdict = rememberedVerdict(deps, key) ?? (await applyOwnerHeal(deps, ticket, key, reason));
    if (verdict === "edit") {
      const paused = pauseLand(
        ticket.identifier,
        pr.url,
        "The procedure owner was edited. The next page resumes this branch.",
        "",
      );
      await deps.tracker.comment(ticket.identifier, paused.detail);
      return paused;
    }
    const body = qualityRunUnscheduled(quality.detail)
      ? `Quality did not start on ${pr.url}. ${quality.detail} The next page requests the workflow run.`
      : `Quality still running on ${pr.url}. The next page merges it when the check is green.`;
    await deps.tracker.comment(ticket.identifier, body);
    return {
      identifier: ticket.identifier,
      outcome: quality.state === "unscheduled" ? "quality-unscheduled" : "quality-pending",
      detail: pr.url,
    };
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
  previousHypothesis: string | null,
  budget: "pause" | "runner" = "pause",
): Promise<{ fixes: number; headSha: string; hypothesis: string | null } | TicketResult> {
  if (fixes >= fixMax) {
    if (budget === "runner") {
      const healed = await applyOwnerHeal(
        deps,
        ticket,
        "runner:conflict",
        `Still blocked after ${fixMax} attempts on \`${current.branch}\`.`,
      );
      const paused = pauseLand(
        ticket.identifier,
        current.url,
        healed === "edit"
          ? "The procedure owner was edited. The next page resumes this branch."
          : "This page already edited that owner. The next page edits it again.",
        "",
      );
      await deps.tracker.comment(ticket.identifier, paused.detail);
      return paused;
    }
    const paused = pauseLand(
      ticket.identifier,
      current.url,
      `Still blocked after ${fixMax} attempts on \`${current.branch}\`. The next page resumes this branch.`,
    );
    await deps.tracker.comment(ticket.identifier, paused.detail);
    return paused;
  }
  const home = agentHome(deps.pack);
  let text = "";
  try {
    const started = await deps.worker.start({
      prompt,
      repoUrl: home.url,
      baseRef: home.trunk,
    });
    text = (await finishWorker(deps.worker, started.runId)).text;
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
  const hypothesis = parseHypothesis(text) ?? previousHypothesis;
  if (sameHypothesis(previousHypothesis, parseHypothesis(text))) {
    await deps.tracker.comment(
      ticket.identifier,
      `Repeated hypothesis is not a fix: ${hypothesis}. The previous commit stays.`,
    );
    return { fixes: fixes + 1, headSha: current.headSha, hypothesis: previousHypothesis };
  }
  const lookup = deps.lookupHead ?? lookupRemoteHead;
  const next = lookup(current.repo.url, current.branch);
  return {
    fixes: fixes + 1,
    headSha: next && next !== current.headSha ? next : current.headSha,
    hypothesis,
  };
}

/**
 * Merge one pull request. A behind branch is updated onto trunk and quality
 * runs again on the new head. A conflict or a refused merge starts the coding
 * worker on that same branch. The caller keeps the rest of the sweep moving.
 * Returns the merge commit when this pull request merged.
 */
async function healNo(
  deps: LoopDeps,
  ticket: Ticket,
  current: OpenPull,
  key: string,
  reason: string,
  sleep: (ms: number) => Promise<void>,
  tries: { waits: number; login: boolean },
): Promise<TicketResult | null> {
  let verdict = rememberedVerdict(deps, key);
  if (!(verdict === "edit" && healAlready(deps, ticket, key))) {
    if (!verdict) verdict = await applyOwnerHeal(deps, ticket, key, reason);
  }
  if (verdict === "edit") {
    const paused = pauseLand(
      ticket.identifier,
      current.url,
      healAlready(deps, ticket, key)
        ? "The procedure owner was edited. The next page resumes this branch."
        : "This page already edited that owner. The next page edits it again.",
      "",
    );
    await deps.tracker.comment(ticket.identifier, paused.detail);
    return paused;
  }
  if (verdict === "login") {
    if (tries.login || !refreshShipGithubToken(process.env)) {
      const paused = pauseLand(
        ticket.identifier,
        current.url,
        "The step still returned no after the login was replaced. The next page heals again.",
        "",
      );
      await deps.tracker.comment(ticket.identifier, paused.detail);
      return paused;
    }
    tries.login = true;
    return null;
  }
  if (tries.waits >= 40) {
    const paused = pauseLand(
      ticket.identifier,
      current.url,
      "The step is still returning no. The next page heals again.",
      "",
    );
    await deps.tracker.comment(ticket.identifier, paused.detail);
    return paused;
  }
  tries.waits += 1;
  await sleep(30_000);
  return null;
}

async function stopForMissingFigmaToken(deps: LoopDeps, ticket: Ticket): Promise<TicketResult | null> {
  deps.figmaGroundBlock = undefined;
  const frames = ticketFigmaUrls(ticket);
  if (frames.length === 0) return null;
  const token = figmaTokenValue({ figmaToken: deps.figmaToken, design: deps.pack.design });
  if (!token) {
    const envName = deps.pack.design?.figmaTokenEnv?.trim() || "FIGMA_ACCESS_TOKEN";
    await deps.tracker.comment(
      ticket.identifier,
      `missing-credential: figma. Set ${envName}. The ticket stays in intake.`,
    );
    return { identifier: ticket.identifier, outcome: "missing-credential", detail: "figma" };
  }
  const block = await designRepairText({
    ticket,
    design: deps.pack.design,
    repoName: "",
    repoDir: deps.cwd ?? process.cwd(),
    figmaToken: deps.figmaToken,
    figmaFetch: deps.figmaFetch,
  });
  const envName = deps.pack.design?.figmaTokenEnv?.trim() || "FIGMA_ACCESS_TOKEN";
  const stop = figmaReadStop(block, envName);
  if (stop) {
    await deps.tracker.comment(ticket.identifier, `${block}\n\n${stop.footer}`);
    return { identifier: ticket.identifier, outcome: stop.outcome, detail: stop.detail };
  }
  deps.figmaGroundBlock = block;
  return null;
}

async function repairContext(deps: LoopDeps, ticket: Ticket, pr: OpenPull): Promise<string> {
  const text = await designRepairText({
    ticket,
    design: deps.pack.design,
    repoName: pr.repo.name,
    repoDir: repoCheckoutDir(deps.cwd ?? process.cwd(), pr.repo, deps.pack),
    figmaToken: deps.figmaToken,
    figmaFetch: deps.figmaFetch,
  });
  return text ? `\n${text}` : "";
}

/** UI check on this head when the ticket has no Figma frame. Null means the check does not apply. */
async function readDesignCheck(
  deps: LoopDeps,
  ticket: Ticket,
  pr: OpenPull,
): Promise<DesignCheckProbe | null> {
  if (ticketFigmaUrls(ticket).length > 0) return null;
  const spec = designRepo(deps.pack.design, pr.repo.name);
  if (!spec) return null;
  if (!deps.forge.designCheck) {
    return {
      state: "missing",
      detail: `design check ${spec.checkName} missing on ${pr.headSha}`,
      headSha: null,
    };
  }
  const probe = await deps.forge.designCheck({
    repoUrl: pr.repo.url,
    headSha: pr.headSha,
    name: spec.checkName,
  });
  if (probe.headSha !== pr.headSha) {
    return {
      state: "missing",
      detail: probe.detail || `stale design check ${spec.checkName} ignored`,
      headSha: null,
    };
  }
  return probe;
}

async function commitLand(
  deps: LoopDeps,
  ticket: Ticket,
  current: OpenPull,
): Promise<TicketResult | { mergedSha: string }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tries = { waits: 0, login: false };
  for (let step = 0; step < 8; step++) {
    try {
      const mergedSha = await deps.forge.squashMerge({
        repoUrl: current.repo.url,
        number: current.number,
        branch: current.branch,
        base: current.repo.trunk,
        headSha: current.headSha,
      });
      if (!mergedSha?.trim()) throw new Error("merge did not return a commit");
      noteEngine(deps, "land ok");
      return { mergedSha };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (ownerOnlyLandFailure(error)) {
        const paused = pauseLand(
          ticket.identifier,
          current.url,
          "Needs the owner. The merge was refused for a token, scope, or protection failure. The next page does not start a coding worker.",
          "",
        );
        await deps.tracker.comment(ticket.identifier, paused.detail);
        return paused;
      }
      const paused = await healNo(
        deps,
        ticket,
        current,
        `heal:merge:${shipNoSignature(reason) || "merge"}`,
        reason,
        sleep,
        tries,
      );
      if (paused) return paused;
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

async function landPull(
  deps: LoopDeps,
  ticket: Ticket,
  pr: OpenPull,
  orderText: string,
): Promise<TicketResult | { headSha: string }> {
  void orderText;
  let current = pr;
  let updates = 0;
  let unknown = 0;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const tries = { waits: 0, login: false };
  for (let step = 0; step < 48; step++) {
    const quality = await waitForQuality(deps, current);
    if (quality.state === "failure") {
      const signature = shipNoSignature(quality.detail) || "quality";
      const repair = await repairContext(deps, ticket, current);
      const paused = await healNo(
        deps,
        ticket,
        current,
        `heal:quality:${current.repo.name}:${signature}`,
        `Quality returned no on \`${current.repo.name}\` branch \`${current.branch}\`.\n${quality.detail}${repair}`,
        sleep,
        tries,
      );
      if (paused) return paused;
      continue;
    }
    const design = await readDesignCheck(deps, ticket, current);
    if (design && design.state !== "success") {
      if (design.state === "pending") {
        const earlyDesign = await explainQuality(deps, ticket, current, {
          state: "pending",
          detail: design.detail,
        });
        if (earlyDesign) return earlyDesign;
      } else {
        const repair = await repairContext(deps, ticket, current);
        const paused = await healNo(
          deps,
          ticket,
          current,
          `heal:quality:${current.repo.name}:design-check`,
          `Design check returned no on \`${current.repo.name}\` branch \`${current.branch}\`.\n${design.detail}${repair}`,
          sleep,
          tries,
        );
        if (paused) return paused;
        continue;
      }
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
      const why = `The branch ${merge.state === "conflict" ? "conflicts with" : "is still behind"} \`${current.repo.trunk}\`. Hand off to heal.`;
      const paused = await healNo(
        deps,
        ticket,
        current,
        `heal:merge:${shipNoSignature(why) || merge.state}`,
        why,
        sleep,
        tries,
      );
      if (paused) return paused;
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
    return { headSha: head };
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

function defaultRunCommand(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(command, { shell: true, cwd, encoding: "utf8", env });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function waitForQuality(
  deps: LoopDeps,
  pr: { repo: RepoSpec; url: string; headSha: string; branch: string; created: boolean },
  opts?: { requestRun?: boolean },
): Promise<QualityWait> {
  if (deps.pack.check === "command") {
    const cwd = repoCheckoutDir(deps.cwd ?? process.cwd(), pr.repo, deps.pack);
    const run = deps.runCommand ?? defaultRunCommand;
    const result = run(deps.pack.qualityCommand, cwd, commandEnvironment(deps.pack));
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
      result.outcome === "ship-blocked" ||
      result.outcome === "skipped-page",
  );
}

async function loadProgram(deps: LoopDeps, projectName?: string | null): Promise<CompileProgramResult | null> {
  if (deps.program) return deps.program;
  const name = (projectName ?? deps.project)?.trim();
  if (!name) return null;
  if (deps.tracker.kind !== "linear" || !deps.tracker.projectSnapshot) return null;
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
async function probeConfiguredCredentials(deps: LoopDeps): Promise<void> {
  if (!deps.forge.probeCredentials) return;
  try {
    await deps.forge.probeCredentials();
  } catch {
    noteEngine(deps, "credential probe failed");
  }
}

export async function sweep(deps: LoopDeps): Promise<TicketResult[]> {
  await probeConfiguredCredentials(deps);
  if (!deps.pageControl) deps.pageControl = { stop: false, healed: [] };
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
      if (deps.pageControl?.stop) return results;
      if (result.outcome === "skipped-graph" || result.outcome === "blocked") {
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

export async function auditEligibility(
  deps: Pick<LoopDeps, "pack" | "project" | "cwd" | "runPackCommand"> & {
    tracker: Pick<TrackerAdapter, "listIntake">;
  },
): Promise<EligibilityAuditResult[]> {
  const tickets = await deps.tracker.listIntake(
    deps.project ? { project: deps.project } : undefined,
  );
  const results: EligibilityAuditResult[] = [];
  for (const ticket of tickets) {
    results.push({ identifier: ticket.identifier, ...await checkEligibility(deps, ticket) });
  }
  return results;
}

export async function deliver(
  deps: LoopDeps,
  identifier: string,
  opts?: { until?: "ground" },
): Promise<TicketResult> {
  await probeConfiguredCredentials(deps);
  const ticket = await deps.tracker.get(identifier);
  const program = await loadProgram(deps, deps.project ?? ticket.projectName ?? null);
  const next = opts?.until ? { ...deps, until: opts.until } : deps;
  return runTicket(program ? { ...next, program } : next, ticket);
}

export async function ship(
  deps: LoopDeps,
  identifier?: string,
  mode: "ship" | "continue" = "ship",
): Promise<ShipRun> {
  const id = identifier?.trim() ?? "";
  if (!id) throw new Error("ship needs a ticket id");
  await probeConfiguredCredentials(deps);
  deliveryStateCache.delete(deps);
  const ticket = await deps.tracker.get(id);
  const state = await readDeliveryState(deps, ticket);
  const stopped = exhaustedFailureType({ labels: ticket.labels });
  if (stopped) throw new HealExhaustedError(stopped);
  const alreadyShipped = Boolean(deps.pack.status.shipped && ticket.stateName === deps.pack.status.shipped);
  if (!alreadyShipped && ticket.stateName !== deps.pack.status.complete) throw new Error(`ship requires ${deps.pack.status.complete}`);
  const deliveryStages = deps.pack.promotionStages.filter((stage) => stage.authorization === "deliver");
  const shipStages = deps.pack.promotionStages.filter((stage) => stage.authorization === "ship");
  const texts = resumeProofTexts(deps, ticket);
  const order = parseWorkOrder(texts.declared);
  const rawLanded = state.markers.find((marker) => marker.kind === "landed-commits")?.body;
  let landed: { repo: string; sha: string }[] = [];
  try {
    if (rawLanded) landed = JSON.parse(rawLanded) as { repo: string; sha: string }[];
  } catch {
    throw new Error("landed commit state is invalid");
  }
  if ((deliveryStages.length > 0 || shipStages.length > 0) && !order) throw new Error("ship requires the saved acceptance matrix");
  if (!authorizationSatisfied(deliveryStages, deps.pack.promotionStages, state.stageReceipts, ticket, landed, order!.criteria)) {
    throw new Error("ship requires every applicable delivery stage to have a current passed receipt");
  }
  if (shipStages.length === 0) return { exitCode: 0, lines: [`${id} ${alreadyShipped ? "already shipped" : "has no ship stages"}`], parked: false };
  if (alreadyShipped) {
    const passed = authorizationSatisfied(shipStages, deps.pack.promotionStages, state.stageReceipts, ticket, landed, order!.criteria);
    if (!passed) throw new Error("shipped ticket lacks current passed ship receipts");
    return { exitCode: 0, lines: [`${id} already shipped`], parked: false };
  }
  let continueStageId: string | undefined;
  if (mode === "continue") {
    const body = state.markers.find((marker) => marker.kind === "active-promotion-stage")?.body;
    const active = readActivePromotions({ schemaVersion: 2, markers: body ? [{ kind: "active-promotion-stage", body, createdAt: "" }] : [], stageReceipts: [] })
      .filter((item) => item.authorization === "ship" && item.criteriaRevision === ticket.criteriaRevision);
    const stage = active.length === 1 ? shipStages.find((candidate) => candidate.id === active[0]?.stageId && candidate.target === active[0]?.target) : undefined;
    if (!stage) throw new Error("ship continue requires one active ship stage for the current criteria revision");
    if (!stage.continueCommand) throw new Error(`stage ${stage.id} has no continueCommand`);
    continueStageId = stage.id;
  }
  let result = await runPromotionStages(deps, ticket, "ship", landed, order?.criteria ?? [], { continueStageId });
  let waits = 0;
  let refreshedLogin = false;
  const sleep = deps.sleep ?? ((ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  });
  const action = mode === "continue" ? "continue" : "promote";
  while (result.outcome === "failed") {
    let waiting = false;
    let login = false;
    for (const problem of result.problems) {
      if (problem.outcome === "parked") continue;
      const signature = shipNoSignature(problem.reason) || problem.reason;
      const key = `install:${action}:${problem.stage.id}:${signature}`;
      let verdict = rememberedVerdict(deps, key);
      if (verdict === "edit" && healAlready(deps, ticket, key)) throw new Error(`stage ${problem.stage.id} failed: ${problem.reason}`);
      if (!verdict) {
        if (healAlready(deps, ticket, key)) throw new Error(`stage ${problem.stage.id} failed: ${problem.reason}`);
        verdict = await applyOwnerHeal(deps, ticket, key, stageProblemText(problem));
      }
      if (verdict === "wait") waiting = true;
      if (verdict === "login") login = true;
    }
    if (login) {
      if (refreshedLogin || !refreshGithubToken(process.env)) throw new Error(`stage ${result.stage.id} failed: ${result.reason}`);
      refreshedLogin = true;
    } else if (waiting) {
      if (waits >= 40) throw new Error(`stage ${result.stage.id} failed: ${result.reason}`);
      waits += 1;
      await sleep(30_000);
    }
    result = await runPromotionStages(deps, ticket, "ship", landed, order?.criteria ?? [], { continueStageId });
  }
  if (result.outcome === "blocked") {
    for (const problem of result.problems) {
      if (problem.outcome === "parked") continue;
      const signature = shipNoSignature(problem.reason) || problem.reason;
      await applyOwnerHeal(deps, ticket, `install:${action}:${problem.stage.id}:${signature}`, stageProblemText(problem));
    }
    return { exitCode: 1, lines: [`${id} BLOCKED ${result.reason}`], parked: false };
  }
  if (result.outcome === "parked") {
    return { exitCode: result.stage.parkSuccess ? 0 : 2, lines: [`${id} PARKED ${result.reason}`], parked: true };
  }
  if (shipStages.some((stage) => stage.writeStatus)) {
    if (!deps.pack.status.shipped) throw new Error("status.shipped is required by ship stages");
    await writeTicketStatus(deps, ticket, deps.pack.status.shipped);
  }
  return { exitCode: 0, lines: [`${id} COMPLETE`], parked: false };
}
