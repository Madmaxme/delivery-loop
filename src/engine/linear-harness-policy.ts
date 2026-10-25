/**
 * Delivery-loop policy: intake, graph readiness, leases, and the page budget.
 * Status names come from the project file. These defaults apply when a caller
 * does not pass its own.
 */

/** `/sweep` intake — archived mid-states (In Progress, Ready for Dev) are not restored. */
export const SWEEP_INTAKE_STATES = ["Todo"] as const;

export type SweepIntakeState = (typeof SWEEP_INTAKE_STATES)[number];

export function isSweepIntakeState(stateName: string | null | undefined): boolean {
  const n = (stateName ?? "").trim().toLowerCase();
  return SWEEP_INTAKE_STATES.some((s) => s.toLowerCase() === n);
}

export const TERMINAL_DEV_STATE = "Dev";
export const TERMINAL_PROD_STATE = "Prod";

/**
 * `blockedBy` is satisfied when the blocker is a delivery/closed terminal.
 * Linear stores the edge as inverse `blocks` (this issue is relatedIssue).
 * Resolved blockers often move to `related` — missing edge also means unblocked.
 */
export const GRAPH_UNBLOCKING_STATES = [
  TERMINAL_DEV_STATE,
  TERMINAL_PROD_STATE,
  "Canceled",
  "Duplicate",
] as const;

export type GraphUnblockingState = (typeof GRAPH_UNBLOCKING_STATES)[number];

export function isGraphUnblockingState(
  stateName: string | null | undefined,
): boolean {
  const n = (stateName ?? "").trim().toLowerCase();
  return GRAPH_UNBLOCKING_STATES.some((s) => s.toLowerCase() === n);
}

export type IssueBlocker = {
  identifier: string;
  stateName: string;
  /** Linear `IssueRelation` id (inverse `blocks`) — required to delete the edge. */
  relationId?: string;
};

export type RelatedTicketKind =
  | "parent"
  | "blocked-by"
  | "blocks"
  | "related"
  | "duplicate";

export type RelatedTicket = {
  identifier: string;
  title: string;
  stateName: string;
  kind: RelatedTicketKind;
};

function relatedKindFromLinearType(
  type: string,
  side: "outgoing" | "inverse",
): RelatedTicketKind | null {
  const t = type.trim().toLowerCase();
  if (t === "blocks") return side === "outgoing" ? "blocks" : null;
  if (t === "related") return "related";
  if (t === "duplicate") return "duplicate";
  return null;
}

function pushRelated(
  out: RelatedTicket[],
  seen: Set<string>,
  currentId: string,
  ticket: RelatedTicket,
): void {
  const id = ticket.identifier.trim().toUpperCase();
  if (!id || id === currentId.trim().toUpperCase()) return;
  const key = `${ticket.kind}:${id}`;
  if (seen.has(key) || seen.has(`id:${id}`)) return;
  seen.add(key);
  seen.add(`id:${id}`);
  out.push({ ...ticket, identifier: ticket.identifier.trim() });
}

/** Declared Linear cousins only — not leftover chat from another ticket. */
export function collectDeclaredRelatedTickets(opts: {
  currentIssueId: string;
  parent?: { identifier: string; title?: string | null; stateName: string } | null;
  blockedBy?: readonly IssueBlocker[];
  outgoing?: readonly {
    type: string;
    relatedIssue?: {
      identifier: string;
      title?: string | null;
      state: { name: string } | null;
    };
  }[];
  inverse?: readonly {
    type: string;
    issue?: {
      identifier: string;
      title?: string | null;
      state: { name: string } | null;
    };
  }[];
}): RelatedTicket[] {
  const current = opts.currentIssueId;
  const out: RelatedTicket[] = [];
  const seen = new Set<string>();
  if (opts.parent?.identifier) {
    pushRelated(out, seen, current, {
      identifier: opts.parent.identifier,
      title: (opts.parent.title ?? "").trim(),
      stateName: opts.parent.stateName,
      kind: "parent",
    });
  }
  for (const b of opts.blockedBy ?? []) {
    pushRelated(out, seen, current, {
      identifier: b.identifier,
      title: "",
      stateName: b.stateName,
      kind: "blocked-by",
    });
  }
  for (const n of opts.outgoing ?? []) {
    const kind = relatedKindFromLinearType(n.type, "outgoing");
    const other = n.relatedIssue;
    if (!kind || !other?.identifier) continue;
    pushRelated(out, seen, current, {
      identifier: other.identifier,
      title: (other.title ?? "").trim(),
      stateName: other.state?.name ?? "",
      kind,
    });
  }
  for (const n of opts.inverse ?? []) {
    const kind = relatedKindFromLinearType(n.type, "inverse");
    const other = n.issue;
    if (!kind || !other?.identifier) continue;
    pushRelated(out, seen, current, {
      identifier: other.identifier,
      title: (other.title ?? "").trim(),
      stateName: other.state?.name ?? "",
      kind,
    });
  }
  return out;
}

export function formatRelatedTicketContext(
  tickets: readonly RelatedTicket[],
): string {
  const header = [
    "## Related tickets (Linear links — read, do not build)",
    "These are declared cousins of this issue. Use them as story context. Execute **only this issue**. Do not treat leftover chat from another ticket as relatedness.",
  ];
  if (!tickets.length) {
    return [...header, "(none declared)"].join("\n");
  }
  const lines = tickets.map((t) => {
    const title = t.title.trim() ? ` — ${t.title.trim()}` : "";
    const state = t.stateName.trim() ? ` (${t.stateName.trim()})` : "";
    return `- ${t.kind}: ${t.identifier}${title}${state}`;
  });
  return [...header, ...lines].join("\n");
}

export type GraphReadyVerdict = {
  ready: boolean;
  reasons: string[];
};

/**
 * Grounding agents write a one-sentence `**Harness packet:**` on the audit.
 * That line is execution SSOT for this ticket — not a per-project identifier
 * allowlist. The sequencer stays project-agnostic: Linear project + milestones
 * + declared `blockedBy` + parks.
 */
export function groundingCitedHarnessPacket(
  body: string | null | undefined,
): boolean {
  return /\*\*Harness packet:\*\*/i.test(body ?? "");
}

/**
 * Scheduler primitive: a ticket may ground/build/land only when every
 * declared blocker is graph-unblocking. Empty `blockedBy` = unconstrained.
 * Self-edges are cycles (fail closed). `@agent proceed despite` must not skip this.
 */
export function evaluateGraphReady(
  identifier: string,
  blockedBy: readonly IssueBlocker[] | null | undefined,
  unblockingStates: readonly string[] = GRAPH_UNBLOCKING_STATES,
): GraphReadyVerdict {
  const self = identifier.trim().toUpperCase();
  const reasons: string[] = [];
  const seen = new Set<string>();
  const unblocking = new Set(
    unblockingStates.map((s) => s.trim().toLowerCase()),
  );
  for (const b of blockedBy ?? []) {
    const id = (b.identifier ?? "").trim().toUpperCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (id === self) {
      reasons.push(`blockedBy cycle: ${self} lists itself`);
      continue;
    }
    if (!unblocking.has((b.stateName ?? "").trim().toLowerCase())) {
      reasons.push(
        `blocked by ${id} (${(b.stateName ?? "").trim() || "unknown state"})`,
      );
    }
  }
  return { ready: reasons.length === 0, reasons };
}

export const MACHINE_LABELS = {
  buildable: "buildable",
  groundedReady: "grounded-ready",
  deliveryLease: "delivery-lease",
  shipLease: "ship-lease",
  storeGated: "store-gated",
  releaseBlocked: "release-blocked",
  needsProduct: "needs-product",
} as const;

const DEV_CLEAR = [
  MACHINE_LABELS.deliveryLease,
  MACHINE_LABELS.buildable,
  MACHINE_LABELS.groundedReady,
] as const;

const PROD_CLEAR = [
  ...DEV_CLEAR,
  MACHINE_LABELS.shipLease,
  MACHINE_LABELS.storeGated,
  MACHINE_LABELS.releaseBlocked,
] as const;

function hasLabel(labels: string[], name: string): boolean {
  const n = name.toLowerCase();
  return labels.some((l) => l.toLowerCase() === n);
}

function normState(stateName: string | null | undefined): string {
  return (stateName ?? "").trim().toLowerCase();
}

/**
 * Machine labels that must not linger after a terminal status write.
 * Does not touch `surface:*`, `source:*`, or `needs-product`.
 * Does not clear `store-gated` / `ship-lease` on Dev (live `/ship` park).
 */
export function machineLabelsToClearOnTerminal(
  stateName: string | null | undefined,
  labels: string[],
): string[] {
  const state = normState(stateName);
  const names =
    state === TERMINAL_PROD_STATE.toLowerCase()
      ? PROD_CLEAR
      : state === TERMINAL_DEV_STATE.toLowerCase()
        ? DEV_CLEAR
        : [];
  return names.filter((n) => hasLabel(labels, n));
}

export function sprawlLabelsPresent(
  labels: string[],
  archivedExact: readonly string[],
): string[] {
  const exact = new Set(archivedExact.map((n) => n.toLowerCase()));
  return labels.filter((l) => {
    const n = l.toLowerCase();
    if (exact.has(n)) return true;
    return /^(bug|feature|improvement)\s*\(retired/i.test(l);
  });
}

export type QualityRunLite = {
  name: string;
  status: string;
  conclusion: string | null;
  headSha: string;
  url: string;
  createdAt: string;
};

/**
 * Interpret GitHub Actions runs for a PR/tip SHA.
 * Only a workflow named `quality` counts. Another green workflow on the same
 * SHA is not this gate. No quality run yet → pending. Completed non-success → failure.
 */
export function interpretQualityActions(
  runs: QualityRunLite[],
  headSha: string,
): { state: "success" | "failure" | "pending"; detail: string } {
  const forSha = runs.filter((r) => r.headSha === headSha);
  const quality = forSha.filter(
    (r) => r.name === "quality" || /quality/i.test(r.name),
  );
  if (!quality.length) {
    const short = headSha.slice(0, 7);
    return {
      state: "pending",
      detail: forSha.length
        ? `no quality run for ${short} (${forSha.length} other run(s))`
        : `no Actions runs yet for ${short}`,
    };
  }
  quality.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const active = quality.find((r) => r.status !== "completed");
  if (active) {
    return {
      state: "pending",
      detail: `${active.name} ${active.status} ${active.url}`,
    };
  }
  const latest = quality[0];
  const conclusion = (latest.conclusion ?? "").toLowerCase();
  if (
    conclusion === "success" ||
    conclusion === "skipped" ||
    conclusion === "neutral"
  ) {
    return {
      state: "success",
      detail: `${latest.name} ${conclusion || "ok"} ${latest.url}`,
    };
  }
  return {
    state: "failure",
    detail: `${latest.name} ${conclusion || "failed"} ${latest.url}`,
  };
}

/**
 * A pending quality probe that will never start. Polling the same SHA cannot
 * create the Actions run. Distinct from a timeout, a token error, or red CI.
 */
export function qualityRunUnscheduled(detail: string): boolean {
  return /no Actions runs yet|no quality run/i.test(detail);
}

/** How long a missing run may stay missing before the lander requests one. */
export const QUALITY_NO_RUN_MS = 8 * 60 * 1000;

/**
 * A red quality run needs a new commit from the build worker.
 * A missing run does not: the commit is already the landing, and polling it
 * cannot create the workflow. An in-progress or green run is the landing.
 */
export function landingShaNeedsRebuild(probe: { state: string }): boolean {
  return probe.state === "failure";
}

/**
 * A missing run is due for a request. A commit that already sat past the
 * budget is due on the first look. A run we just opened still gets the
 * budget, because `created` is handled by the caller passing no committedAt.
 */
export function unscheduledQualityDue(input: {
  detail: string;
  committedAt?: string;
  observedAtMs: number;
  nowMs: number;
  noRunMs: number;
}): boolean {
  if (!qualityRunUnscheduled(input.detail)) return false;
  if (input.committedAt) {
    const at = Date.parse(input.committedAt);
    if (Number.isFinite(at) && input.nowMs - at >= input.noRunMs) return true;
  }
  return input.nowMs - input.observedAtMs >= input.noRunMs;
}

export type ProdWorkflowGate = {
  kind: "skip" | "workflows" | "quality-fallback";
  workflows: string[];
  note: string;
};

/**
 * Branch-to-workflow filter for store deploys.
 * `ios-*` keeps workflow names starting with `iOS`. `android-*` keeps names
 * starting with `Android`. Any other branch keeps the list.
 * Callers fail closed when a platform branch filters to an empty list.
 */
export function filterDeployWorkflowsForBranch(
  branch: string,
  workflows: readonly string[],
): string[] {
  const listed = workflows.filter((w) => w && w !== "None" && w !== "null");
  if (branch.startsWith("ios-")) {
    return listed.filter((w) => w.startsWith("iOS"));
  }
  if (branch.startsWith("android-")) {
    return listed.filter((w) => w.startsWith("Android"));
  }
  return listed;
}

export function isMobileStoreDeployBranch(branch: string): boolean {
  return branch.startsWith("ios-") || branch.startsWith("android-");
}

/** Empty prod deploy list falls back to the quality workflow. */
export function prodWorkflowsToObserve(cfg: {
  prod_branches?: string[];
  quality_workflow?: string | null;
  deploy_workflows?: { prod?: string[] };
}): ProdWorkflowGate {
  if (!cfg.prod_branches?.length) {
    return { kind: "skip", workflows: [], note: "no prod branches" };
  }
  const listed = (cfg.deploy_workflows?.prod ?? []).filter(
    (w) => w && w !== "None" && w !== "null",
  );
  if (listed.length) {
    return { kind: "workflows", workflows: listed, note: listed.join(", ") };
  }
  const qw = (cfg.quality_workflow ?? "").trim();
  if (qw && qw !== "null") {
    return {
      kind: "quality-fallback",
      workflows: [qw],
      note: "empty prod deploy_workflows — require quality_workflow (fail-closed)",
    };
  }
  return {
    kind: "skip",
    workflows: [],
    note: "no prod deploy_workflows and no quality_workflow — git tip only",
  };
}

export type ContinueRepoFact = {
  repo: string;
  neverLanded: boolean;
  alreadyOnProd: boolean;
};

/** Continue promotes one repo at a time: skip, already on prod, or selective. */
export function classifyContinueWebApi(rows: ContinueRepoFact[]): {
  toPromote: string[];
  alreadyOnProd: string[];
  missingTicketEvidence: string[];
  notes: string[];
} {
  const toPromote: string[] = [];
  const alreadyOnProd: string[] = [];
  const missingTicketEvidence: string[] = [];
  const notes: string[] = [];
  for (const row of rows) {
    if (row.neverLanded) {
      missingTicketEvidence.push(row.repo);
      notes.push(`${row.repo}: no ticket on trunk — skip`);
    } else if (row.alreadyOnProd) {
      alreadyOnProd.push(row.repo);
      notes.push(`${row.repo}: already on prod tip`);
    } else {
      toPromote.push(row.repo);
      notes.push(`${row.repo}: pending ticket commits → selective promote`);
    }
  }
  return { toPromote, alreadyOnProd, missingTicketEvidence, notes };
}

/** ASC / Fastlane: marketing must be strictly greater than released floor. */
export function marketingBeatsReleasedFloor(
  marketing: string,
  releasedFloor: string,
): { ok: boolean; reason: string } {
  const toParts = (v: string) => v.split(".").map((n) => parseInt(n, 10));
  const a = toParts(marketing);
  const b = toParts(releasedFloor);
  if (
    a.length !== 3 ||
    b.length !== 3 ||
    [...a, ...b].some((n) => Number.isNaN(n))
  ) {
    return { ok: false, reason: `bad version ${marketing} vs ${releasedFloor}` };
  }
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i]
        ? { ok: true, reason: `${marketing} > ${releasedFloor}` }
        : {
            ok: false,
            reason: `marketing ${marketing} ≤ released floor ${releasedFloor} — early-exit must not green`,
          };
    }
  }
  return {
    ok: false,
    reason: `marketing ${marketing} equals released floor ${releasedFloor} — early-exit must not green`,
  };
}

/** States that still belong to an open delivery, including dev-landed work. */
export const DELIVERY_TRAIN_STATES = [
  TERMINAL_DEV_STATE,
  "In Review",
  "Todo",
] as const;

/** Matches Linear `<!-- DELIVERY_LEASE expires=… [gha_run=…] [cursor_*] -->`. */
export const DELIVERY_LEASE_COMMENT_RE =
  /<!--\s*DELIVERY_LEASE\b([^>]*)-->/i;

export type CursorLeasePhase = "ground" | "build" | "cifix";

export type DeliveryLeaseStamp = {
  expiresAt: number | null;
  ghaRunId: string | null;
  cursorAgentId: string | null;
  cursorRunId: string | null;
  cursorPhase: CursorLeasePhase | null;
};

const CURSOR_LEASE_PHASES = new Set<CursorLeasePhase>([
  "ground",
  "build",
  "cifix",
]);

function attrValue(attrs: string, name: string): string {
  const m = attrs.match(new RegExp(`\\b${name}=([^\\s>]+)`, "i"));
  return (m?.[1] ?? "").trim();
}

function parseCursorLeasePhase(raw: string): CursorLeasePhase | null {
  const p = raw.trim().toLowerCase();
  if (CURSOR_LEASE_PHASES.has(p as CursorLeasePhase)) {
    return p as CursorLeasePhase;
  }
  return null;
}

export function parseDeliveryLeaseStamp(
  body: string,
): DeliveryLeaseStamp | null {
  if (/^\s*\[HISTORICAL\]/i.test(body)) return null;
  const m = body.match(DELIVERY_LEASE_COMMENT_RE);
  if (!m) return null;
  const attrs = m[1] ?? "";
  const released = attrValue(attrs, "released") === "1";
  const expiresAt = Date.parse(attrValue(attrs, "expires"));
  const ghaRaw = attrValue(attrs, "gha_run");
  const cursorAgentRaw = attrValue(attrs, "cursor_agent");
  const cursorRunRaw = attrValue(attrs, "cursor_run");
  return {
    expiresAt: released || !Number.isFinite(expiresAt) ? null : expiresAt,
    ghaRunId: /^\d+$/.test(ghaRaw) ? ghaRaw : null,
    cursorAgentId: /^bc-[a-z0-9-]+$/i.test(cursorAgentRaw)
      ? cursorAgentRaw
      : null,
    cursorRunId: cursorRunRaw.length > 0 ? cursorRunRaw : null,
    cursorPhase: parseCursorLeasePhase(attrValue(attrs, "cursor_phase")),
  };
}

export function emptyDeliveryLeaseStamp(): DeliveryLeaseStamp {
  return {
    expiresAt: null,
    ghaRunId: null,
    cursorAgentId: null,
    cursorRunId: null,
    cursorPhase: null,
  };
}

/** Live lease TTL — must stay in lockstep with the comment `expires=` write. */
export const DELIVERY_LEASE_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * One SDK `send` must not outlive the delivery lease we advertised on Linear.
 * This is lease enforcement, not “the log went quiet.” `@cursor/sdk` `wait()`
 * is implemented as drain-the-SSE (`streamPromise`); silence ≠ terminal.
 * Join SSOT is GetRun / `run.status` — see `agent-run-join.ts`.
 */
export const AGENT_RUN_HARD_TIMEOUT_MS = DELIVERY_LEASE_TTL_MS;

/** `/deliver` poll interval while another orchestrator holds `delivery-lease`. */
export const PIPELINE_LEASE_POLL_MS = 15_000;

/**
 * Steal (clear + re-acquire) a labelled lease when the previous owner is
 * gone. A dead/cancelled GHA parent (6h cap, human cancel, or a leftover
 * from the old cancel-in-progress group) leaves Linear TTL (~2h); GitHub
 * run status is the lock SSOT, not the comment clock.
 *
 * - Live previous GHA run: steal only after `expires=` (same as today).
 * - Dead/cancelled previous GHA run: steal immediately.
 * - Unknown run (legacy stamp with no `gha_run=`): steal on expiry, or
 *   when land is waiting on origin heads (`LAND_PREFLIGHT_BLOCKED` / partial).
 * - Label with no expiry and no steal signal: fail closed.
 * A live `cursor_run=` is not a steal blocker: the successor GHA page
 * restamps `gha_run=` and **joins** that run (does not `send` a second child).
 */
export function shouldStealDeliveryLease(input: {
  hasLeaseLabel: boolean;
  expiresAt: number | null;
  nowMs: number;
  previousGhaRunActive?: boolean | null;
  resumeLandFromPartial?: boolean;
}): boolean {
  if (!input.hasLeaseLabel) return false;
  const expired =
    input.expiresAt !== null && input.nowMs >= input.expiresAt;
  if (input.previousGhaRunActive === true) return expired;
  if (input.previousGhaRunActive === false) return true;
  if (input.resumeLandFromPartial) return true;
  return expired;
}

export type ShipLeaseStamp = {
  expiresAt: number | null;
  ghaRunId: string | null;
};

export const SHIP_LEASE_COMMENT_RE =
  /<!--\s*SHIP_LEASE\s+expires=([^\s>]+)(?:\s+gha_run=(\d+))?\s*-->/i;

export function parseShipLeaseStamp(body: string): ShipLeaseStamp | null {
  const m = body.match(SHIP_LEASE_COMMENT_RE);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return {
    expiresAt: Number.isFinite(t) ? t : null,
    ghaRunId: m[2] && /^\d+$/.test(m[2]) ? m[2] : null,
  };
}

export function latestShipLeaseStamp(
  commentBodies: readonly string[],
): ShipLeaseStamp {
  let best: ShipLeaseStamp = { expiresAt: null, ghaRunId: null };
  for (const body of commentBodies) {
    const s = parseShipLeaseStamp(body);
    if (!s) continue;
    if (
      s.expiresAt !== null &&
      (best.expiresAt === null || s.expiresAt > best.expiresAt)
    ) {
      best = s;
    }
  }
  return best;
}

/**
 * Steal a leftover `ship-lease` when the previous holder is dead or this is
 * `/ship continue` on the same ticket (parked tickets must not skip continue
 * for 4h because park/crash left the label). Never steal while a live GHA
 * ship parent still holds the lease.
 */
export function shouldStealShipLease(input: {
  hasLeaseLabel: boolean;
  expiresAt: number | null;
  nowMs: number;
  previousGhaRunActive?: boolean | null;
  sameTicketContinue?: boolean;
}): boolean {
  if (!input.hasLeaseLabel) return false;
  const expired =
    input.expiresAt !== null && input.nowMs >= input.expiresAt;
  if (input.previousGhaRunActive === true) return expired;
  if (input.previousGhaRunActive === false) return true;
  if (input.sameTicketContinue) return true;
  return expired;
}

export type TimedComment = {
  body: string;
  createdAt?: string | null;
};

function isGroundingGeneration(body: string): boolean {
  if (/^\s*\[HISTORICAL\]/i.test(body)) return false;
  return (
    /<!--\s*GROUNDING_HANDOFF\b/i.test(body) ||
    /\*\*Codebase audit\b/i.test(body)
  );
}

/**
 * Newest-first sample. Comments older than the latest grounding handoff are
 * historical: a canceled sweep's work order is not this generation.
 */
export function formatGroundingCommentSample(
  comments: readonly TimedComment[],
): string {
  const dated = comments.map((comment, index) => ({
    body: comment.body,
    createdAt: comment.createdAt ?? "",
    index,
  }));
  const sorted = [...dated].sort((a, b) => {
    if (a.createdAt && b.createdAt && a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return b.index - a.index;
  });
  const floor = sorted.find((comment) => isGroundingGeneration(comment.body))?.createdAt ?? "";
  const lines = sorted.slice(0, 10).map((comment) => {
    const historical = Boolean(floor && comment.createdAt && comment.createdAt < floor);
    const cap = historical ? 220 : 900;
    const tag = historical ? "HISTORICAL" : "CURRENT";
    const when = comment.createdAt || "(undated)";
    const text = comment.body.length > cap ? `${comment.body.slice(0, cap)}…` : comment.body;
    return `- [${tag}] ${when}\n${text}`;
  });
  return [
    "Comments are newest-first. `[HISTORICAL]` means before the latest grounding handoff. Do not reuse those work orders. Re-read trunk and emit a fresh handoff for this generation.",
    ...(lines.length ? lines : ["(none)"]),
  ].join("\n");
}

/** Last stamp in chronological comment order. A later release supersedes a longer TTL. */
export function latestDeliveryLeaseStamp(
  commentBodies: readonly string[],
): DeliveryLeaseStamp {
  let best: DeliveryLeaseStamp = emptyDeliveryLeaseStamp();
  for (const body of commentBodies) {
    const s = parseDeliveryLeaseStamp(body);
    if (s) best = s;
  }
  return best;
}

export function latestDeliveryLeaseExpiryMs(
  commentBodies: readonly string[],
): number | null {
  return latestDeliveryLeaseStamp(commentBodies).expiresAt;
}

export type PipelineLeaseDecision =
  | { action: "proceed" }
  | { action: "already_complete"; stateName: string }
  | { action: "wait"; expiresAt: number; waitedMs: number }
  | { action: "timeout"; waitedMs: number; expiresAt: number | null };

/**
 * `/deliver` (pipeline) waits on a live lease instead of SKIPPED.
 * Sweep/ground/build stay fail-fast so one leased ticket cannot stall a wave.
 * Terminal Dev/Prod while waiting = the other run finished the loop.
 */
export function decidePipelineLeaseAction(input: {
  stateName?: string | null;
  hasLeaseLabel: boolean;
  leaseExpiresAt: number | null;
  nowMs: number;
  waitStartedAtMs: number;
  maxWaitMs?: number;
  previousGhaRunActive?: boolean | null;
  resumeLandFromPartial?: boolean;
}): PipelineLeaseDecision {
  const state = (input.stateName ?? "").trim();
  if (
    state.toLowerCase() === TERMINAL_DEV_STATE.toLowerCase() ||
    state.toLowerCase() === TERMINAL_PROD_STATE.toLowerCase()
  ) {
    return { action: "already_complete", stateName: state };
  }
  if (
    shouldStealDeliveryLease({
      hasLeaseLabel: input.hasLeaseLabel,
      expiresAt: input.leaseExpiresAt,
      nowMs: input.nowMs,
      previousGhaRunActive: input.previousGhaRunActive,
      resumeLandFromPartial: input.resumeLandFromPartial,
    })
  ) {
    return { action: "proceed" };
  }
  const maxWait = input.maxWaitMs ?? DELIVERY_LEASE_TTL_MS;
  const waitedMs = Math.max(0, input.nowMs - input.waitStartedAtMs);
  const leaseLive =
    input.hasLeaseLabel &&
    input.leaseExpiresAt !== null &&
    input.nowMs < input.leaseExpiresAt;
  if (!leaseLive) return { action: "proceed" };
  if (waitedMs >= maxWait) {
    return {
      action: "timeout",
      waitedMs,
      expiresAt: input.leaseExpiresAt,
    };
  }
  return {
    action: "wait",
    expiresAt: input.leaseExpiresAt as number,
    waitedMs,
  };
}

/**
 * Program runner — same ground/build/land factory, a slice cursor instead of
 * “every Todo.” SSOT is a Linear **project**: milestones = slices, issue
 * `blockedBy` = graph, `park:*` labels (+ milestone copy) = parks.
 * `--file` JSON is a test/debug escape hatch, not the authoring surface.
 */
export const PROGRAM_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Escape hatch only (`sweep --file`). Do not author new program JSON. */
export function programFileRelPath(id: string): string {
  const n = id.trim();
  if (!PROGRAM_ID_RE.test(n)) {
    throw new Error(
      `Invalid program file id "${id}". Use kebab-case [a-z0-9-]+.`,
    );
  }
  return `.cursor/dispatch/fixtures/programs/${n}.json`;
}

export function slugifyProgramId(name: string): string {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!PROGRAM_ID_RE.test(s)) {
    throw new Error(`Cannot slugify "${name}" to a program id`);
  }
  return s;
}

/** Opaque gate — not a harness enum of product domains. */
export type ProgramPark = {
  kind: string;
  before: "ship" | "intake";
};

export type ProgramBlockedByEdge = {
  blocker: string;
  relationId: string;
};

export type ProgramIssue = {
  id: string;
  blockedBy: string[];
  /** Present when compiled from Linear — used to prune stale fill edges. */
  blockedByRelations?: ProgramBlockedByEdge[];
};

export type ProgramSlice = {
  id: string;
  title: string;
  /** How far the factory may go unattended for this slice. */
  afkTo: "dev" | "none";
  intake: "auto" | "park";
  park: ProgramPark[];
  issues: ProgramIssue[];
};

export type DeliveryProgram = {
  id: string;
  spec: string;
  projectName: string | null;
  slices: ProgramSlice[];
};

export type LinearProgramMilestoneSnapshot = {
  id: string;
  name: string;
  description: string | null;
  sortOrder: number;
};

export type LinearProgramIssueSnapshot = {
  identifier: string;
  stateName: string;
  labels: string[];
  milestoneId: string | null;
  blockedBy: IssueBlocker[];
};

export type LinearProgramSnapshot = {
  projectId: string;
  projectName: string;
  projectUrl: string;
  milestones: LinearProgramMilestoneSnapshot[];
  issues: LinearProgramIssueSnapshot[];
};

export type CompileProgramResult = {
  program: DeliveryProgram;
  states: Record<string, string>;
  warnings: string[];
};

const PARK_LABEL_RE =
  /^park:(?:(ship|intake):)?([a-z0-9][a-z0-9-]*)$/i;

export function parseParkLabels(
  labels: readonly string[],
): ProgramPark[] {
  const out: ProgramPark[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    const m = raw.trim().toLowerCase().match(PARK_LABEL_RE);
    if (!m) continue;
    const kind = m[2];
    if (!m[1] && (kind === "ship" || kind === "intake")) continue;
    const before: ProgramPark["before"] = m[1] === "ship" ? "ship" : "intake";
    const key = `${before}:${kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind, before });
  }
  return out;
}

export function mergeProgramParks(
  ...groups: readonly (readonly ProgramPark[])[]
): ProgramPark[] {
  const out: ProgramPark[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const p of group) {
      const key = `${p.before}:${p.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

export function shouldSkipProgramMilestone(name: string): boolean {
  const n = name.trim();
  if (/^legacy\b/i.test(n)) return true;
  if (/\bdo not use\b/i.test(n)) return true;
  return false;
}

export type ParkMilestoneRule = {
  match: string;
  kind: string;
  /** `name` matches the milestone title. `text` matches the title and description. */
  where?: "name" | "text";
};

function milestoneRuleHits(match: string, hay: string): boolean {
  const words = match
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return false;
  return new RegExp(`\\b${words.join("[\\s-]+")}\\b`, "i").test(hay);
}

/** Parks come from the install's rules. No rules means a milestone title does not park. */
export function parksFromMilestoneCopy(
  name: string,
  description: string | null | undefined,
  rules: readonly ParkMilestoneRule[] = [],
): ProgramPark[] {
  const parks: ProgramPark[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const kind = rule.kind.trim();
    const match = rule.match.trim();
    if (!kind || !match || seen.has(kind)) continue;
    const hay = rule.where === "name" ? name : `${name}\n${description ?? ""}`;
    if (!milestoneRuleHits(match, hay)) continue;
    seen.add(kind);
    parks.push({ kind, before: "intake" });
  }
  return parks;
}

/** Stage 0, 0.5, 1B → numeric rank. Null if the title is not a Stage N name. */
export function parseStageRank(name: string): number | null {
  const m = name.match(/stage\s+(\d+(?:\.\d+)?)([a-z])?/i);
  if (!m) return null;
  let n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const letter = m[2]?.toLowerCase();
  if (letter === "b") n += 0.5;
  else if (letter) n += (letter.charCodeAt(0) - 96) * 0.01;
  return n;
}

export function compareProgramMilestones(
  a: LinearProgramMilestoneSnapshot,
  b: LinearProgramMilestoneSnapshot,
): number {
  const ra = parseStageRank(a.name);
  const rb = parseStageRank(b.name);
  if (ra != null && rb != null && ra !== rb) return ra - rb;
  if (ra != null && rb == null) return -1;
  if (ra == null && rb != null) return 1;
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  return a.name.localeCompare(b.name);
}

function sliceIdFromMilestone(
  name: string,
  milestoneId: string,
  used: Set<string>,
): string {
  let base: string;
  try {
    base = slugifyProgramId(name);
  } catch {
    base = `milestone-${milestoneId.slice(0, 8).toLowerCase()}`;
  }
  let id = base;
  let n = 2;
  while (used.has(id)) {
    id = `${base}-${n}`;
    n += 1;
  }
  used.add(id);
  return id;
}

export function compileDeliveryProgramFromLinear(
  snap: LinearProgramSnapshot,
  parkRules: readonly ParkMilestoneRule[] = [],
): CompileProgramResult {
  const warnings: string[] = [];
  const ordered = [...snap.milestones].sort(compareProgramMilestones);
  const skipped = ordered.filter((m) => shouldSkipProgramMilestone(m.name));
  const kept = ordered.filter((m) => !shouldSkipProgramMilestone(m.name));
  const keptIds = new Set(kept.map((m) => m.id));
  const skippedIds = new Set(skipped.map((m) => m.id));

  for (const m of skipped) {
    const n = snap.issues.filter((i) => i.milestoneId === m.id).length;
    warnings.push(
      `Skipped milestone "${m.name}" (${n} issue${n === 1 ? "" : "s"})`,
    );
  }

  const unscheduled = snap.issues.filter(
    (i) => !i.milestoneId || (!keptIds.has(i.milestoneId) && !skippedIds.has(i.milestoneId)),
  );
  const skippedIssues = snap.issues.filter(
    (i) => i.milestoneId !== null && skippedIds.has(i.milestoneId),
  );
  if (unscheduled.length) {
    warnings.push(
      `${unscheduled.length} issue(s) have no project milestone — excluded from AFK`,
    );
  }

  const usedIds = new Set<string>();
  const slices: ProgramSlice[] = kept.map((m) => {
    const issues = snap.issues
      .filter((i) => i.milestoneId === m.id)
      .map((i) => {
        const blockedBy = i.blockedBy.map((b) => b.identifier.toUpperCase());
        const blockedByRelations = i.blockedBy
          .filter((b) => (b.relationId ?? "").trim())
          .map((b) => ({
            blocker: b.identifier.toUpperCase(),
            relationId: (b.relationId ?? "").trim(),
          }));
        return {
          id: i.identifier.toUpperCase(),
          blockedBy,
          ...(blockedByRelations.length ? { blockedByRelations } : {}),
        };
      });
    const issueParks = mergeProgramParks(
      ...snap.issues
        .filter((i) => i.milestoneId === m.id)
        .map((i) => parseParkLabels(i.labels)),
    );
    const park = mergeProgramParks(
      parksFromMilestoneCopy(m.name, m.description, parkRules),
      issueParks,
    );
    const intakePark = park.some((p) => p.before === "intake");
    return {
      id: sliceIdFromMilestone(m.name, m.id, usedIds),
      title: m.name,
      afkTo: intakePark ? "none" : "dev",
      intake: intakePark ? "park" : "auto",
      park,
      issues,
    };
  });

  const states: Record<string, string> = {};
  for (const i of snap.issues) {
    states[i.identifier.toUpperCase()] = i.stateName;
    for (const b of i.blockedBy) {
      const id = b.identifier.toUpperCase();
      if (!states[id]) states[id] = b.stateName;
    }
  }

  if (kept.length === 0) {
    warnings.push(
      `Linear project "${snap.projectName}" has no usable milestones (legacy/do-not-use skipped, ${skippedIssues.length} parked there)`,
    );
  }

  return {
    program: {
      id: slugifyProgramId(snap.projectName),
      spec: snap.projectUrl,
      projectName: snap.projectName,
      slices,
    },
    states,
    warnings,
  };
}

/** Do not Todo tickets that are already intake or delivery-terminal. */
export function shouldProgramSyncSkipState(
  stateName: string | null | undefined,
): boolean {
  const n = (stateName ?? "").trim().toLowerCase();
  if (n === "todo") return true;
  return isGraphUnblockingState(stateName);
}

export function isIssueTerminalForProgram(
  stateName: string | null | undefined,
  board?: ProgramBoard,
): boolean {
  const names = board?.unblocking?.length ? board.unblocking : GRAPH_UNBLOCKING_STATES;
  const n = (stateName ?? "").trim().toLowerCase();
  return names.some((s) => s.trim().toLowerCase() === n);
}

/** Installs name their backlog status. An empty name means no status is backlog. */
export function isProgramBacklogState(
  stateName: string | null | undefined,
  backlog?: string | null,
): boolean {
  const name = (backlog ?? "").trim().toLowerCase();
  if (!name) return false;
  return (stateName ?? "").trim().toLowerCase() === name;
}

export type ProgramBoard = {
  unblocking?: readonly string[];
  backlog?: string | null;
  hold?: string | null;
  dev?: string | null;
  intake?: string | null;
};

/** Tickets the factory may sequence: not terminal, and not the install's backlog status. */
export function isProgramAfkCandidateState(
  stateName: string | null | undefined,
  board?: ProgramBoard,
): boolean {
  if (isIssueTerminalForProgram(stateName, board)) return false;
  if (isProgramBacklogState(stateName, board?.backlog)) return false;
  return true;
}

export function normalizeProgramStates(
  states: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(states)) {
    out[k.trim().toUpperCase()] = v;
  }
  return out;
}

/**
 * A slice is complete when every remaining ticket is terminal or held-off
 * (packet-cited NEEDS RESCOPE). Unparked AFK work keeps the cursor even
 * when those tickets still wait on a declared `blockedBy` (including a park).
 * Identifier-fill edges must not complete the slice by hiding independent
 * tickets behind a park. Parked-intake slices are never the cursor.
 */
export function sliceIsComplete(
  slice: ProgramSlice,
  states: Readonly<Record<string, string | undefined>>,
  heldOff: ReadonlySet<string> = new Set(),
  board?: ProgramBoard,
): boolean {
  if (slice.issues.length === 0) return true;
  const s = normalizeProgramStates(states);
  const skip = new Set(
    [...heldOff].map((id) => id.trim().toUpperCase()).filter(Boolean),
  );
  return !slice.issues.some((i) => {
    const id = i.id.toUpperCase();
    if (skip.has(id)) return false;
    return isProgramAfkCandidateState(s[id], board);
  });
}

export function currentProgramSlice(
  program: DeliveryProgram,
  states: Readonly<Record<string, string | undefined>>,
  heldOff: ReadonlySet<string> = new Set(),
  board?: ProgramBoard,
): ProgramSlice | null {
  return (
    program.slices.find((s) => {
      if (!programIntakeAllowed(s).ok) return false;
      return !sliceIsComplete(s, states, heldOff, board);
    }) ?? null
  );
}

export type ProgramCursorKind = "slice" | "empty-bag" | "complete";

export type ProgramCursorVerdict =
  | { kind: "slice"; slice: ProgramSlice }
  | { kind: "empty-bag" }
  | { kind: "complete" };

/** Parks + dependents of parks are not AFK. That is not the same as Done. */
export function describeProgramCursor(
  program: DeliveryProgram,
  states: Readonly<Record<string, string | undefined>>,
  heldOff: ReadonlySet<string> = new Set(),
  board?: ProgramBoard,
): ProgramCursorVerdict {
  const slice = currentProgramSlice(program, states, heldOff, board);
  if (slice) return { kind: "slice", slice };
  const s = normalizeProgramStates(states);
  for (const sl of program.slices) {
    for (const issue of sl.issues) {
      if (!isIssueTerminalForProgram(s[issue.id.toUpperCase()])) {
        return { kind: "empty-bag" };
      }
    }
  }
  return { kind: "complete" };
}

export function programIntakeAllowed(slice: ProgramSlice): {
  ok: boolean;
  reason: string | null;
} {
  if (slice.intake === "park" || slice.afkTo === "none") {
    const kind =
      slice.park.find((p) => p.before === "intake")?.kind ?? slice.park[0]?.kind;
    return {
      ok: false,
      reason: `slice ${slice.id} parked (${kind ?? "intake"}) — not AFK`,
    };
  }
  const intakePark = slice.park.find((p) => p.before === "intake");
  if (intakePark) {
    return {
      ok: false,
      reason: `slice ${slice.id} parked (${intakePark.kind}) — not AFK`,
    };
  }
  return { ok: true, reason: null };
}

/** Program-graph ready: slice membership + compiled `blockedBy` (from Linear). */
export function evaluateProgramIssueReady(
  identifier: string,
  slice: ProgramSlice,
  states: Readonly<Record<string, string | undefined>>,
): GraphReadyVerdict {
  const self = identifier.trim().toUpperCase();
  const row = slice.issues.find((i) => i.id.toUpperCase() === self);
  if (!row) {
    return { ready: false, reasons: [`${self} not in slice ${slice.id}`] };
  }
  const s = normalizeProgramStates(states);
  const blockedBy: IssueBlocker[] = row.blockedBy.map((id) => ({
    identifier: id,
    stateName: s[id.toUpperCase()] ?? "unknown",
  }));
  return evaluateGraphReady(self, blockedBy);
}

export function programIssueIndex(
  program: DeliveryProgram,
): Map<string, { slice: ProgramSlice; issue: ProgramIssue }> {
  const m = new Map<string, { slice: ProgramSlice; issue: ProgramIssue }>();
  for (const slice of program.slices) {
    for (const issue of slice.issues) {
      m.set(issue.id.toUpperCase(), { slice, issue });
    }
  }
  return m;
}

/** Program mode: one in-flight ticket. Empty PM graphs are not a parallel ready-set. */
export const PROGRAM_WIP_LIMIT = 1;

export function compareIssueIdentifiers(a: string, b: string): number {
  const na = parseInt(a.replace(/^[A-Za-z][A-Za-z0-9]*-/i, ""), 10);
  const nb = parseInt(b.replace(/^[A-Za-z][A-Za-z0-9]*-/i, ""), 10);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return a.toUpperCase().localeCompare(b.toUpperCase());
}

export type GraphFillEdge = {
  blocker: string;
  blocked: string;
};

export type GraphFillPlan = {
  edges: GraphFillEdge[];
  unconstrained: string[];
  note: string;
};

export type StaleGraphPruneReason =
  | "held-off-blocker"
  | "consecutive-afk-fill"
  | "parked-intake-blocker";

export type StaleGraphPruneEdge = {
  blocked: string;
  blocker: string;
  relationId: string | null;
  reason: StaleGraphPruneReason;
};

/**
 * Later slices stay on the install's hold status. The backlog status is not
 * remaining work, so moving a later slice there would make that slice look done.
 */
export function laterSliceSyncMove(
  stateName: string | null | undefined,
  hold = "Hold",
  intake = "Todo",
): string | null {
  const n = (stateName ?? "").trim().toLowerCase();
  if (n !== intake.trim().toLowerCase()) return null;
  return hold;
}

/** In-slice overflow uses the same hold status. */
export function currentSliceOverflowMove(
  stateName: string | null | undefined,
  hold = "Hold",
  intake = "Todo",
): string | null {
  return laterSliceSyncMove(stateName, hold, intake);
}

export function formatDeliveryProgramContext(opts: {
  program: DeliveryProgram;
  states: Readonly<Record<string, string | undefined>>;
  heldOff?: ReadonlySet<string>;
  cursorSliceId?: string | null;
  currentIssueId?: string | null;
  board?: ProgramBoard;
}): string {
  const board = opts.board;
  const hold = board?.hold?.trim() || "Hold";
  const dev = board?.dev?.trim() || "Dev";
  const backlog = board?.backlog?.trim() || "";
  const named = [backlog, hold, dev].filter(Boolean).join(" / ");
  const s = normalizeProgramStates(opts.states);
  const held = new Set(
    [...(opts.heldOff ?? [])].map((id) => id.trim().toUpperCase()).filter(Boolean),
  );
  const current = (opts.currentIssueId ?? "").trim().toUpperCase();
  const lines: string[] = [
    "## Delivery program (full project)",
    `Project: ${opts.program.projectName ?? opts.program.id}`,
    `Cursor slice: ${opts.cursorSliceId ?? "(none)"}`,
    `This snapshot is **context for every sibling**, including ${named} and held-off. Execute **only this issue**. Do not Todo or implement siblings.`,
    "If a later-stage ticket is already delivered, extend those primitives — do not fork a parallel path for the same behavior.",
    "Re-ground when the latest audit lacks **Program graph:** — unchanged description is not a skip.",
    "Linear ticket text is **product intent**, not a closed spec. Engineering owns closed defaults: BUILDABLE the smallest safe change from current code and documented invariants. Write `**Harness packet:**` (one sentence) on the audit. Do not wait for a PM rewrite.",
    `Smallest safe change does not leave other callers of the same primitive on the old behavior. Inventory remaining same-behavior callers (or name a category exclusion with a path). Sweep completes engineering e2e; the only human gate is product using ${dev} and filing a new ticket. Do not park leftover callers in Recommendations. Do not rely on a second ground after land.`,
    `NEEDS RESCOPE without that line is a retry, not a park. NEEDS RESCOPE after a cited harness packet means no safe default — ${hold}. WRONG DIAGNOSIS parks to Canceled. Phase parks and real \`blockedBy\` still bind.`,
    "",
  ];
  for (const sl of opts.program.slices) {
    const mark = sl.id === opts.cursorSliceId ? " [cursor]" : "";
    lines.push(
      `### ${sl.id}${mark} intake=${sl.intake} afkTo=${sl.afkTo}`,
    );
    for (const i of sl.issues) {
      const id = i.id.toUpperCase();
      const st = s[id] ?? "?";
      const bits = [id, st];
      if (held.has(id)) bits.push("held-off");
      bits.push(
        isProgramAfkCandidateState(st, board) && !held.has(id) ? "afk" : "context",
      );
      if (i.blockedBy.length) bits.push(`blockedBy=${i.blockedBy.join(",")}`);
      if (current && current === id) bits.push("← this ticket");
      lines.push(`- ${bits.join(" ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function groundingCitedDeliveryProgram(body: string | null | undefined): boolean {
  const t = body ?? "";
  return (
    /\*\*Program graph:\*\*/i.test(t) ||
    /## Delivery program \(full project\)/i.test(t)
  );
}

/**
 * Opt-in only (`--fill-graph`). When a slice has 2+ active tickets with no
 * *internal* blockedBy, chain them by identifier. This is missing-data fill,
 * not product order. Default sweep does not write these edges.
 * Held-off tickets (packet-cited NEEDS RESCOPE) are context-only: do
 * not chain them, or they freeze the whole identifier sequence.
 */
export function planSliceGraphFill(
  slice: ProgramSlice,
  states: Readonly<Record<string, string | undefined>> = {},
  heldOff: ReadonlySet<string> = new Set(),
): GraphFillPlan {
  const s = normalizeProgramStates(states);
  const skip = new Set(
    [...heldOff].map((id) => id.trim().toUpperCase()).filter(Boolean),
  );
  const sliceIds = new Set(slice.issues.map((i) => i.id.toUpperCase()));
  const active = slice.issues.filter((i) => {
    const id = i.id.toUpperCase();
    if (skip.has(id)) return false;
    return isProgramAfkCandidateState(s[id]);
  });
  const unconstrained = active
    .filter((i) => {
      const internal = i.blockedBy.filter((b) => sliceIds.has(b.toUpperCase()));
      return internal.length === 0;
    })
    .map((i) => i.id.toUpperCase())
    .sort(compareIssueIdentifiers);

  if (unconstrained.length < 2) {
    return {
      edges: [],
      unconstrained,
      note: "no fill (fewer than 2 unconstrained active tickets)",
    };
  }

  const already = new Set<string>();
  for (const i of slice.issues) {
    for (const b of i.blockedBy) {
      already.add(`${b.toUpperCase()}→${i.id.toUpperCase()}`);
    }
  }

  const edges: GraphFillEdge[] = [];
  for (let i = 0; i < unconstrained.length - 1; i++) {
    const blocker = unconstrained[i];
    const blocked = unconstrained[i + 1];
    const key = `${blocker}→${blocked}`;
    if (already.has(key)) continue;
    edges.push({ blocker, blocked });
  }

  return {
    edges,
    unconstrained,
    note: "identifier chain (PM graph empty inside slice — not product order)",
  };
}

export function applyFillEdgesToSlice(
  slice: ProgramSlice,
  edges: readonly GraphFillEdge[],
): ProgramSlice {
  const extra = new Map<string, string[]>();
  for (const e of edges) {
    const blocked = e.blocked.toUpperCase();
    const blocker = e.blocker.toUpperCase();
    const list = extra.get(blocked) ?? [];
    list.push(blocker);
    extra.set(blocked, list);
  }
  return {
    ...slice,
    issues: slice.issues.map((i) => {
      const add = extra.get(i.id.toUpperCase());
      if (!add?.length) return i;
      const blockedBy = [...i.blockedBy.map((b) => b.toUpperCase())];
      for (const b of add) {
        if (!blockedBy.includes(b)) blockedBy.push(b);
      }
      return { ...i, blockedBy };
    }),
  };
}

function relationIdFor(
  issue: ProgramIssue,
  blocker: string,
): string | null {
  const id = blocker.toUpperCase();
  const hit = issue.blockedByRelations?.find(
    (r) => r.blocker.toUpperCase() === id,
  );
  return hit?.relationId?.trim() ? hit.relationId.trim() : null;
}

/**
 * Stale identifier-fill noise: same-slice consecutive AFK identifier pairs,
 * same-slice edges whose blocker is held-off, and any edge whose blocker sits
 * on a parked-intake slice. Cross-slice waits on
 * earlier auto-slice work (e.g. migration blocked by identity) are kept.
 */
export function planStaleGraphPrune(
  program: DeliveryProgram,
  states: Readonly<Record<string, string | undefined>> = {},
  heldOff: ReadonlySet<string> = new Set(),
): StaleGraphPruneEdge[] {
  const s = normalizeProgramStates(states);
  const held = new Set(
    [...heldOff].map((id) => id.trim().toUpperCase()).filter(Boolean),
  );
  const parkedIntakeIds = new Set<string>();
  for (const slice of program.slices) {
    if (!programIntakeAllowed(slice).ok) {
      for (const i of slice.issues) parkedIntakeIds.add(i.id.toUpperCase());
    }
  }
  const out: StaleGraphPruneEdge[] = [];
  const seen = new Set<string>();

  for (const slice of program.slices) {
    const sliceIds = new Set(slice.issues.map((i) => i.id.toUpperCase()));
    const afk = slice.issues
      .filter((i) => isProgramAfkCandidateState(s[i.id.toUpperCase()]))
      .map((i) => i.id.toUpperCase())
      .sort(compareIssueIdentifiers);
    const consecutive = new Set<string>();
    for (let i = 0; i < afk.length - 1; i++) {
      consecutive.add(`${afk[i]}→${afk[i + 1]}`);
    }

    for (const issue of slice.issues) {
      const blocked = issue.id.toUpperCase();
      for (const raw of issue.blockedBy) {
        const blocker = raw.toUpperCase();
        if (!sliceIds.has(blocker) && !parkedIntakeIds.has(blocker)) continue;
        const key = `${blocker}→${blocked}`;
        if (seen.has(key)) continue;
        let reason: StaleGraphPruneReason | null = null;
        if (held.has(blocker) && sliceIds.has(blocker)) {
          reason = "held-off-blocker";
        } else if (parkedIntakeIds.has(blocker)) {
          reason = "parked-intake-blocker";
        } else if (sliceIds.has(blocker) && consecutive.has(key)) {
          reason = "consecutive-afk-fill";
        }
        if (!reason) continue;
        seen.add(key);
        out.push({
          blocked,
          blocker,
          relationId: relationIdFor(issue, blocker),
          reason,
        });
      }
    }
  }
  return out;
}

export function applyPruneEdgesToProgram(
  program: DeliveryProgram,
  edges: readonly StaleGraphPruneEdge[],
): DeliveryProgram {
  const drop = new Map<string, Set<string>>();
  for (const e of edges) {
    const blocked = e.blocked.toUpperCase();
    const blocker = e.blocker.toUpperCase();
    const set = drop.get(blocked) ?? new Set<string>();
    set.add(blocker);
    drop.set(blocked, set);
  }
  return {
    ...program,
    slices: program.slices.map((slice) => ({
      ...slice,
      issues: slice.issues.map((i) => {
        const remove = drop.get(i.id.toUpperCase());
        if (!remove?.size) return i;
        const blockedBy = i.blockedBy.filter(
          (b) => !remove.has(b.toUpperCase()),
        );
        const blockedByRelations = i.blockedByRelations?.filter(
          (r) => !remove.has(r.blocker.toUpperCase()),
        );
        return {
          ...i,
          blockedBy,
          ...(blockedByRelations ? { blockedByRelations } : {}),
        };
      }),
    })),
  };
}

export function pickProgramFrontier(
  slice: ProgramSlice,
  states: Readonly<Record<string, string | undefined>>,
  wip: number = PROGRAM_WIP_LIMIT,
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  const skip = new Set(
    [...exclude].map((id) => id.trim().toUpperCase()).filter(Boolean),
  );
  const ready = slice.issues
    .filter((i) => {
      const id = i.id.toUpperCase();
      if (skip.has(id)) return false;
      const st = states[id];
      if (!isProgramAfkCandidateState(st)) return false;
      return evaluateProgramIssueReady(i.id, slice, states).ready;
    })
    .map((i) => i.id.toUpperCase());
  const todo = ready.filter(
    (id) => (states[id] ?? "").trim().toLowerCase() === "todo",
  );
  const ordered = (todo.length ? todo : ready).sort(compareIssueIdentifiers);
  return ordered.slice(0, Math.max(0, wip));
}

export function capProgramWip<T extends { identifier: string }>(
  rows: readonly T[],
  wip: number = PROGRAM_WIP_LIMIT,
): T[] {
  return [...rows]
    .sort((a, b) => compareIssueIdentifiers(a.identifier, b.identifier))
    .slice(0, Math.max(0, wip));
}

/** Statuses worth one recreate. A capacity refusal is not one of them. */
const RETRIABLE_AGENT_RUN_STATUSES = new Set([
  "error",
  "cancelled",
  "startup_error",
]);

/**
 * Cursor refused to start an agent because the account spend limit or included
 * usage is exhausted. Retrying the same send cannot succeed.
 */
export function isAgentCapacityRefusal(
  notes: string | null | undefined,
): boolean {
  const n = (notes ?? "").toLowerCase();
  return (
    n.includes("usage_limit_exceeded") ||
    n.includes("usage-based pricing") ||
    n.includes("on-demand usage") ||
    n.includes("hard limit") ||
    n.includes("spend limit")
  );
}

export function shouldRetryAgentRun(input: {
  status: string;
  notes?: string | null;
}): boolean {
  if (isAgentCapacityRefusal(input.notes)) return false;
  return RETRIABLE_AGENT_RUN_STATUSES.has(input.status);
}

/**
 * Primary key, then one fallback. Blanks and duplicates drop out so a missing
 * fallback is a one-key list and a copied primary cannot switch to itself.
 */
export function orderedCursorApiKeys(
  primary: string | null | undefined,
  fallback: string | null | undefined,
): string[] {
  const keys: string[] = [];
  for (const raw of [primary, fallback]) {
    const key = (raw ?? "").trim();
    if (!key || keys.includes(key)) continue;
    keys.push(key);
  }
  return keys;
}

/**
 * Sweep and dispatch cloud agents. Medium effort, standard 256k context.
 * Fast stays off: it bills at twice the standard token rate.
 */
export const HARNESS_AGENT_MODEL = {
  id: "grok-4.7",
  params: [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "medium" },
    { id: "fast", value: "false" },
  ],
} as const;

/** GitHub-hosted job max (`timeout-minutes: 360`). Larger runners do not extend this. */
export const GHA_HOSTED_PAGE_BUDGET_MINUTES = 360;

/**
 * Do not start another ticket/wave when less than this remains on the page.
 * Finish the current ticket; the chain job starts page N+1.
 */
export const GHA_PAGE_RESERVE_MINUTES = 45;

/** Treat cancelled/failure as the 6h cap when the job ran at least this fraction of the budget. */
export const GHA_PAGE_TIMEOUT_FRACTION = 0.9;

export type DeliveryPageChainDecision = {
  chain: boolean;
  reason: string;
};

/**
 * Continue-as-new for the GHA parent. Chain when this page hit the hosted
 * cap (or stopped itself for the 45m reserve). Do not chain a short cancel
 * (human stop) or when another parent is already live (queued successor /
 * kicker race).
 */
export function shouldChainDeliveryPage(input: {
  mode: string;
  parentResult: string;
  explicitChain: boolean;
  durationMs: number;
  otherLiveRunCount: number;
  budgetMinutes?: number;
  timeoutFraction?: number;
}): DeliveryPageChainDecision {
  const mode = input.mode.trim().toLowerCase();
  if (mode !== "sweep" && mode !== "pipeline") {
    return { chain: false, reason: "mode-not-pageable" };
  }
  if (input.otherLiveRunCount > 0) {
    return { chain: false, reason: "other-parent-live" };
  }
  if (input.explicitChain) {
    return { chain: true, reason: "explicit-page-budget" };
  }
  const budgetMs =
    (input.budgetMinutes ?? GHA_HOSTED_PAGE_BUDGET_MINUTES) * 60_000;
  const long =
    input.durationMs >=
    budgetMs * (input.timeoutFraction ?? GHA_PAGE_TIMEOUT_FRACTION);
  const result = input.parentResult.trim().toLowerCase();
  if (result === "timed_out") {
    return { chain: true, reason: "timed_out" };
  }
  if (result === "cancelled" && long) {
    return { chain: true, reason: "cancelled-near-budget" };
  }
  if (result === "failure" && long) {
    return { chain: true, reason: "failure-near-budget" };
  }
  return { chain: false, reason: `no-chain:${result || "unknown"}` };
}

export function pageBudgetRemainingMs(input: {
  nowMs: number;
  startedAtMs: number | null;
  budgetMinutes?: number;
}): number | null {
  if (input.startedAtMs == null || !Number.isFinite(input.startedAtMs)) {
    return null;
  }
  const budget =
    (input.budgetMinutes ?? GHA_HOSTED_PAGE_BUDGET_MINUTES) * 60_000;
  return budget - (input.nowMs - input.startedAtMs);
}

export function shouldStopForPageReserve(input: {
  remainingMs: number | null;
  reserveMinutes?: number;
}): boolean {
  if (input.remainingMs == null) return false;
  const reserve =
    (input.reserveMinutes ?? GHA_PAGE_RESERVE_MINUTES) * 60_000;
  return input.remainingMs <= reserve;
}
