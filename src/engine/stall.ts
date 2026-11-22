import assert from "node:assert/strict";
import { engineHealBumpInstruction } from "./engine-heal.ts";
import type { QualityCause } from "./quality-cause.js";

/**
 * Where a required step that returned no is fixed.
 * The cause still comes from quality-cause. This only names the owner.
 * `change` is the ticket branch. `install` is the checkout that owns the
 * command, including production promote and store continue.
 * `runner` is the package that executes the loop.
 * `wait` is an existing path. `person` is a cause this table cannot name.
 * A repeated no keeps the owner from the first time. The next page edits it again.
 */
export type StallOwner = "change" | "install" | "runner" | "wait" | "person";

export function stallOwner(input: {
  kind: "quality" | "conflict" | "unscheduled" | "ship";
  cause?: QualityCause;
  healsAlready: number;
}): StallOwner {
  void input.healsAlready;
  if (input.kind === "ship") return "install";
  if (input.kind === "unscheduled" || input.kind === "conflict") return "runner";
  if (input.cause === "flake" || input.cause === "trunk") return "wait";
  if (input.cause === "environment") return "install";
  if (input.cause === "contract" || input.cause === "change") return "change";
  return "person";
}

/**
 * The last line of a step that returned no.
 * The same command can fail for a new reason. That is a new no.
 * A long token is not part of the reason.
 * The line is not classified. The heal names what to do.
 */
export function shipNoSignature(tail: string): string {
  const lines = tail.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const picked = lines.at(-1) ?? "";
  return picked.replace(/[A-Za-z0-9_-]{24,}/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** A named verdict is not evidence that changed owner code was landed. */
export type HealVerdict = "edit" | "wait" | "login";

export function healVerdict(text: string): HealVerdict {
  const named = [...text.matchAll(/^(?:\*\*Heal:\*\*|Heal:)\s*(edit|wait|login)\s*$/gim)];
  assert.equal(named.length, 1, "Owner healing requires exactly one named verdict");
  return named[0][1].toLowerCase() as HealVerdict;
}

export type OwnerRepairCandidate = { repoUrl: string; branch: string; head: string };
export type OwnerHealOutcome =
  | { verdict: "wait" | "login" }
  | { verdict: "edit"; candidate: OwnerRepairCandidate };

/** A transport may carry text, but it cannot assert that an edit was landed. */
export function ownerHealOutcome(value: unknown, repoUrl: string): OwnerHealOutcome {
  assert(value !== null && value !== undefined, "Owner heal returned no outcome");
  if (typeof value === "string") {
    const verdict = healVerdict(value);
    assert(verdict !== "edit", "An edit verdict requires a committed owner candidate");
    return { verdict };
  }
  assert(typeof value === "object", "Invalid owner heal outcome");
  const row = value as Record<string, unknown>;
  assert(row.status === undefined || row.status === "finished", "Owner worker has not finished");
  assert(row.branches === undefined || Array.isArray(row.branches), "Invalid owner branch list");
  const verdict = typeof row.text === "string" ? healVerdict(row.text) : row.verdict;
  assert(row.verdict === undefined || row.verdict === verdict, "Conflicting owner heal verdicts");
  assert(["edit", "wait", "login"].includes(String(verdict)), "Invalid owner heal verdict");
  if (verdict !== "edit") {
    assert(!row.head && !row.branch && !row.candidate && (!Array.isArray(row.branches) || row.branches.length === 0), "A non-edit outcome cannot carry changed owner code");
    return { verdict: verdict as "wait" | "login" };
  }
  const candidate = (row.candidate ?? { repoUrl, branch: row.branch, head: row.head }) as Record<string, unknown>;
  assert(candidate.repoUrl === repoUrl, "Owner repair changed repositories");
  assert(typeof candidate.branch === "string" && /^[\w./-]+$/.test(candidate.branch) && !candidate.branch.startsWith("-") && !candidate.branch.startsWith("refs/") && !candidate.branch.includes(".."), "Invalid owner repair branch");
  assert(typeof candidate.head === "string" && /^[a-f0-9]{40}$/.test(candidate.head), "An edit verdict requires an exact committed owner head");
  assert(row.head === undefined || row.head === candidate.head, "Conflicting owner heads");
  assert(row.branch === undefined || row.branch === candidate.branch, "Conflicting owner branches");
  if (Array.isArray(row.branches)) {
    const reported = row.branches[0] as Record<string, unknown> | undefined;
    assert(row.branches.length === 1 && reported?.repoUrl === repoUrl && reported?.branch === candidate.branch, "Owner repair has ambiguous repositories");
  }
  return { verdict: "edit", candidate: candidate as OwnerRepairCandidate };
}

/**
 * Failure types the runner caps. The key prefix is the source of the type.
 * `other` is a heal key that matches none of those prefixes.
 */
export const HEAL_FAILURE_TYPES = [
  "quality-red",
  "merge-conflict",
  "promote-failed",
  "ship-failed",
  "quality-pending",
  "quality-unscheduled",
  "runner-blocked",
  "other",
] as const;

export type HealFailureType = (typeof HEAL_FAILURE_TYPES)[number];

/** Attempts recorded on the ticket before the runner stops that failure type. */
export const DEFAULT_HEAL_CAP = 3;

export const HEAL_EXHAUSTED_LABEL = "heal-exhausted";


/** The durable failure type for a heal key. Signature stays in the key. The cap is this type. */
export function failureTypeForHealKey(key: string): HealFailureType {
  if (key.startsWith("heal:quality:")) return "quality-red";
  if (key.startsWith("heal:merge:")) return "merge-conflict";
  if (key.startsWith("heal:promote:")) return "promote-failed";
  if (key.startsWith("install:")) return "ship-failed";
  if (key.startsWith("heal:pending:")) return "quality-pending";
  if (key.startsWith("heal:unscheduled:")) return "quality-unscheduled";
  if (key.startsWith("runner:")) return "runner-blocked";
  return "other";
}

export function healCapFor(
  heal: { maxAttempts?: number; caps?: Record<string, number> } | undefined,
  type: string,
): number {
  const named = heal?.caps?.[type];
  if (typeof named === "number" && Number.isFinite(named) && named >= 0) return Math.floor(named);
  const fallback = heal?.maxAttempts;
  if (typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0) {
    return Math.floor(fallback);
  }
  return DEFAULT_HEAL_CAP;
}

/** The failure type already stopped on this ticket. A label or the delivery-state marker is enough. */
export function exhaustedFailureType(input: {
  labels?: readonly string[];
  markers?: readonly { kind: string; body: string }[];
}): HealFailureType | "heal-exhausted" | null {
  const labels = (input.labels ?? []).map((label) => label.toLowerCase());
  if (labels.includes(HEAL_EXHAUSTED_LABEL)) {
    return HEAL_FAILURE_TYPES.find((type) => labels.includes(type)) ?? "heal-exhausted";
  }
  const body = input.markers?.find((marker) => marker.kind === "heal-exhausted")?.body.trim().toLowerCase();
  if (!body) return null;
  return HEAL_FAILURE_TYPES.find((type) => type === body) ?? "heal-exhausted";
}

/** One Linear comment. The first sentence of the reason, without a pasted diff. */
export function healExhaustedNotice(type: string, reason: string): string {
  const compact = reason.replace(/\s+/g, " ").trim();
  const cut = compact.split(" Terraform change for infra")[0]?.trim() ?? "";
  const why = cut.slice(0, 400);
  return `**Stopped.** ${type} reached its heal cap.${why ? ` ${why}` : ""} Another page will not start.`;
}

/** Linear forbids this app from creating labels. The delivery-state marker still records the cap. */
export function labelWriteRefused(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /not allowed to take action/i.test(text);
}

export class HealExhaustedError extends Error {
  readonly failureType: string;

  constructor(failureType: string) {
    super(`heal exhausted: ${failureType}`);
    this.name = "HealExhaustedError";
    this.failureType = failureType;
  }
}

export function ownerHealPrompt(input: {
  reason: string;
  tokenEnv?: string;
  issue?: string;
  releaseTags?: readonly string[];
}): string {
  const token = input.tokenEnv?.trim();
  const branch = input.issue?.trim() ? `engine-heal/${input.issue.trim()}` : "engine-heal/<ticket>";
  const bumped = engineHealBumpInstruction(input.releaseTags);
  const where = [
    "Edit the owner of the behavior that returned no.",
    "That owner may be the ticket branch, this checkout, a repo the command ships, or the package that executes this loop.",
    "When the owner is the package that executes this loop, open a pull request. Do not merge it to main.",
    `Name the branch \`${branch}\` and label the pull request \`engine-heal\`.`,
    bumped,
    "The pull_request quality check gates that head. The engine-heal workflow does not push a commit. It waits until that check is green, squash-merges, reads the version from the merged package.json, and tags that commit. A pull request without the bump gets a comment and stops. Clients install the tag. They do not install main.",
    "When the owner is anything else, commit and publish one repair candidate on its own branch. The controller owns quality, landing, and release-state updates. Do not land trunk or change delivery state from the worker.",
    "This step runs again when you return.",
    "An open pull request is not landed.",
    token
      ? `Push the runner package with the token in \`${token}\`. Do not use GITHUB_TOKEN. An installation token must not merge that package.`
      : "Push the runner package with the commit-actor token. Do not use GITHUB_TOKEN. An installation token must not merge that package.",
  ].join(" ");
  const decide = [
    "Answer with one line: **Heal:** edit, **Heal:** wait, or **Heal:** login.",
    "edit requires a committed repair candidate with its exact branch and head in the worker result. An edit sentence without changed code is invalid. Engine-package edits use the engine-heal pull request and are not an assertion of installation or completion.",
    "wait means the step is not broken. Do not edit. The step runs again.",
    "login means the login was rejected. Do not edit. The login is replaced and the step runs again.",
  ].join(" ");
  return [
    "A required step returned no. Fix that owner so this no cannot happen again. One heal decides. There is no list of failure phrases.",
    input.reason,
    where,
    decide,
    "One code path. A note, a watcher, or a ticket exception is not the fix.",
  ].join("\n\n");
}
