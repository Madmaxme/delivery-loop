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

/** What the heal decided. The runner does not keep its own list of failures. */
export type HealVerdict = "edit" | "wait" | "login";

export function healVerdict(text: string): HealVerdict {
  const named = text.match(/\*\*Heal:\*\*\s*(edit|wait|login)\b/i)?.[1]?.toLowerCase();
  if (named === "wait" || named === "login" || named === "edit") return named;
  return "edit";
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

/** The failure type already stopped on this ticket. Null when the cap label is absent. */
export function exhaustedFailureType(input: {
  labels?: readonly string[];
}): HealFailureType | "heal-exhausted" | null {
  const labels = (input.labels ?? []).map((label) => label.toLowerCase());
  if (!labels.includes(HEAL_EXHAUSTED_LABEL)) return null;
  return HEAL_FAILURE_TYPES.find((type) => labels.includes(type)) ?? "heal-exhausted";
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
    "When the owner is anything else, land that owner's trunk before you finish.",
    "This step runs again when you return.",
    "An open pull request is not landed.",
    token
      ? `Push the runner package with the token in \`${token}\`. Do not use GITHUB_TOKEN. An installation token must not merge that package.`
      : "Push the runner package with the commit-actor token. Do not use GITHUB_TOKEN. An installation token must not merge that package.",
  ].join(" ");
  const decide = [
    "Answer with one line: **Heal:** edit, **Heal:** wait, or **Heal:** login.",
    "edit changes the owner above. Land that trunk, unless the owner is the package that executes this loop. That edit opens the engine-heal pull request and does not merge to main.",
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
