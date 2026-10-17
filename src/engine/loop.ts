import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { repoByName, unblockingStates, type ProjectPack } from "../schema/pack.js";
import {
  evaluateGraphReady,
  latestDeliveryLeaseStamp,
  pageBudgetRemainingMs,
  shouldStealDeliveryLease,
  shouldStopForPageReserve,
  DELIVERY_LEASE_TTL_MS,
} from "./linear-harness-policy.js";
import { invariantExists, parseVerdict, parseWorkOrder, type Verdict } from "./packet.js";

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
  /** Linear project name. Limits intake. GitHub Issues ignores it. */
  project?: string | null;
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
    | "worker-failed";
  detail: string;
};

function leaseComment(nowMs: number, phase: string, runId: string): string {
  const expires = new Date(nowMs + DELIVERY_LEASE_TTL_MS).toISOString();
  return `<!-- DELIVERY_LEASE expires=${expires} cursor_run=${runId} cursor_phase=${phase} -->`;
}

function groundPrompt(ticket: Ticket, pack: ProjectPack): string {
  return [
    `Ticket ${ticket.identifier}: ${ticket.title}`,
    ticket.body,
    "",
    "Check this ticket against the code. Do not edit files.",
    "Cite one invariant that already exists. One code path. No one-off patch.",
    "If a connector you need is not enabled, set **Connector:** to its name and verdict NEEDS DIAGNOSIS.",
    "Reply with **Verdict:** one of BUILDABLE, NEEDS DIAGNOSIS, NEEDS RESCOPE, WRONG DIAGNOSIS, ALREADY SHIPPED.",
    "When BUILDABLE, include a BUILD_PACKET block with **Repos:**, **Allowlist:**, **Invariant:**, **Decision:**, **Symbols:**, **Validation:**, and **Stop:**.",
    `Enabled connectors: ${pack.connectors.join(", ") || "(none)"}`,
    `Repos: ${pack.repos.map((r) => r.name).join(", ")}`,
  ].join("\n");
}

function buildPrompt(ticket: Ticket, orderText: string): string {
  return [
    `Implement only this work order for ${ticket.identifier}.`,
    orderText,
    "Stay inside the allowlist. Run the validation commands. Push a branch and report the branch name and commit.",
  ].join("\n");
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

  const lease = latestDeliveryLeaseStamp(ticket.comments);
  const live =
    lease.expiresAt !== null &&
    !shouldStealDeliveryLease({
      hasLeaseLabel: true,
      expiresAt: lease.expiresAt,
      nowMs: now,
      previousGhaRunActive: true,
    });
  if (live) {
    return { identifier: ticket.identifier, outcome: "skipped-lease", detail: "lease held" };
  }

  const repo = deps.pack.repos[0];
  await deps.tracker.comment(ticket.identifier, leaseComment(now, "ground", "pending"));
  let ground;
  try {
    const started = await deps.worker.start({
      prompt: groundPrompt(ticket, deps.pack),
      repoUrl: repo.url,
      baseRef: repo.trunk,
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
    return {
      identifier: ticket.identifier,
      outcome: "verdict",
      detail: verdict ?? "missing verdict",
    };
  }

  const order = parseWorkOrder(ground.text);
  if (!order) {
    await deps.tracker.comment(ticket.identifier, "BUILDABLE without a complete work order.");
    return { identifier: ticket.identifier, outcome: "invalid-packet", detail: "packet" };
  }
  const invariants =
    deps.invariantsMarkdown ??
    readFileSync(deps.pack.invariantsFile, "utf8");
  if (!invariantExists(invariants, order.invariant)) {
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
  let built;
  try {
    const started = await deps.worker.start({
      prompt: buildPrompt(ticket, ground.text),
      repoUrl: target.url,
      baseRef: target.trunk,
    });
    built = await finishWorker(deps.worker, started.runId);
  } catch (error) {
    return {
      identifier: ticket.identifier,
      outcome: "worker-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!built.branch) {
    return { identifier: ticket.identifier, outcome: "worker-failed", detail: "no branch" };
  }

  const pr = await deps.forge.openPullRequest({
    repoUrl: target.url,
    title: `${ticket.identifier}: ${order.decision}`,
    body: ground.text,
    head: built.branch,
    base: target.trunk,
  });
  const head = built.head || pr.headSha;
  let quality: "success" | "failure" | "pending" = "pending";
  const polls = deps.maxQualityPolls ?? 5;
  for (let i = 0; i < polls; i++) {
    quality = await deps.forge.quality({
      repoUrl: target.url,
      headSha: head,
      workflow: deps.pack.qualityWorkflow,
    });
    if (quality !== "pending") break;
  }
  if (quality !== "success") {
    await deps.tracker.comment(ticket.identifier, `Quality ${quality} on ${pr.url}`);
    return { identifier: ticket.identifier, outcome: "quality-failed", detail: pr.url };
  }
  await deps.forge.squashMerge({ repoUrl: target.url, number: pr.number });
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
  await deps.tracker.setState(ticket.identifier, deps.pack.status.dev);
  return { identifier: ticket.identifier, outcome: "landed", detail: pr.url };
}

export async function sweep(deps: LoopDeps): Promise<TicketResult[]> {
  const tickets = await deps.tracker.listIntake(
    deps.project ? { project: deps.project } : undefined,
  );
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
    results.push(await runTicket(deps, ticket));
  }
  return results;
}

export async function deliver(deps: LoopDeps, identifier: string): Promise<TicketResult> {
  const ticket = await deps.tracker.get(identifier);
  return runTicket(deps, ticket);
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
