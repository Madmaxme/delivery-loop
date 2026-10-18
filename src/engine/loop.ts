import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.js";
import { agentHome, repoByName, unblockingStates, type ProjectPack, type RepoSpec } from "../schema/pack.js";
import { isGithubActionsRunActive } from "./github-run-status.js";
import {
  evaluateGraphReady,
  latestDeliveryLeaseStamp,
  pageBudgetRemainingMs,
  shouldStealDeliveryLease,
  shouldStopForPageReserve,
  DELIVERY_LEASE_TTL_MS,
  type DeliveryLeaseStamp,
} from "./linear-harness-policy.js";
import { invariantExists, parkStateForVerdict, parseVerdict, parseWorkOrder, type Verdict } from "./packet.js";

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
  /** Override for tests. Default asks `gh` whether the stamped run is still live. */
  githubRunActive?: (runId: string | null) => boolean | null;
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

const GROUND_DOCS = [
  "docs/automation-prompts/linear-ticket-grounding.md",
  ".cursor/skills/ground-linear-ticket/SKILL.md",
  "docs/async-delivery-loop-contract.md",
];

function readIfPresent(cwd: string, rel: string): string {
  const abs = join(cwd, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : "";
}

function groundPrompt(ticket: Ticket, deps: LoopDeps): string {
  const cwd = deps.cwd ?? process.cwd();
  const docs = GROUND_DOCS.map((rel) => readIfPresent(cwd, rel)).filter(Boolean);
  const comments = ticket.comments.slice(-8).join("\n---\n").slice(0, 8000);
  return [
    ...docs,
    `Ticket ${ticket.identifier}: ${ticket.title}`,
    ticket.body,
    "",
    "## Existing comments",
    comments || "(none)",
    "",
    "This send is for this issue only. Do not edit files. Do not call Linear.",
    "Emit GROUNDING_HANDOFF. VERDICT is one of BUILDABLE, NEEDS DIAGNOSIS, NEEDS RESCOPE, WRONG DIAGNOSIS, ALREADY SHIPPED.",
    "When BUILDABLE, put the work order under BUILD_PACKET: inside that handoff.",
    "The invariant id is one existing heading: `scope/slug` (`money/`, `booking/`, `people/`, `core/`) or the exact heading from the invariants file.",
    "One **Decision:** sentence that cites that id. **Symbols:** `repo/path#symbol`. **Repos:** in backticks.",
    `Enabled connectors: ${deps.pack.connectors.join(", ") || "(none)"}`,
    `Repos: ${deps.pack.repos.map((r) => r.name).join(", ")}`,
  ].join("\n\n");
}

function buildPrompt(ticket: Ticket, orderText: string): string {
  return [
    `Implement only this work order for ${ticket.identifier}.`,
    orderText,
    "Stay inside the allowlist. Run the validation commands. Push a branch and report the branch name and commit.",
  ].join("\n");
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
    const dir = name === "qws-workspace" ? cwd : join(cwd, name);
    if (!spec || !existsSync(join(dir, ".git"))) {
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

  const lease = latestDeliveryLeaseStamp(ticket.comments);
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
        priorComments: ticket.comments,
        devStatus: deps.pack.status.dev,
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
  if (!invariantExists(invariants, order.invariant, deps.cwd ?? process.cwd())) {
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
  const landings = landingTargets(deps.pack, order.repos, built.branches, built.branch, target);
  if (!landings) {
    return { identifier: ticket.identifier, outcome: "worker-failed", detail: "no branch" };
  }

  const opened: { repo: RepoSpec; number: number; url: string; headSha: string }[] = [];
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
      headSha: built.head || pr.headSha,
    });
  }
  const polls = deps.maxQualityPolls ?? 5;
  for (const pr of opened) {
    let quality: "success" | "failure" | "pending" = "pending";
    for (let i = 0; i < polls; i++) {
      quality = await deps.forge.quality({
        repoUrl: pr.repo.url,
        headSha: pr.headSha,
        workflow: deps.pack.qualityWorkflow,
      });
      if (quality !== "pending") break;
    }
    if (quality !== "success") {
      await deps.tracker.comment(ticket.identifier, `Quality ${quality} on ${pr.url}`);
      return { identifier: ticket.identifier, outcome: "quality-failed", detail: pr.url };
    }
  }
  for (const pr of opened) {
    await deps.forge.squashMerge({ repoUrl: pr.repo.url, number: pr.number });
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
  await deps.tracker.setState(ticket.identifier, deps.pack.status.dev);
  return {
    identifier: ticket.identifier,
    outcome: "landed",
    detail: opened.map((pr) => pr.url).join(" "),
  };
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
