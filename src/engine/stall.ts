import type { QualityCause } from "./quality-cause.js";

/**
 * Where a required step that returned no is fixed.
 * The cause still comes from quality-cause. This only names the owner.
 * `change` is the ticket branch. `install` is the checkout that owns the
 * command, including production promote and store continue.
 * `runner` is the package that executes the loop.
 * `wait` is an existing path. `person` is a second edit of the same no.
 */
export type StallOwner = "change" | "install" | "runner" | "wait" | "person";

export function stallOwner(input: {
  kind: "quality" | "conflict" | "unscheduled" | "ship";
  cause?: QualityCause;
  healsAlready: number;
}): StallOwner {
  if (input.healsAlready >= 1) return "person";
  if (input.kind === "ship") return "install";
  if (input.kind === "unscheduled" || input.kind === "conflict") return "runner";
  if (input.cause === "flake" || input.cause === "trunk") return "wait";
  if (input.cause === "environment") return "install";
  if (input.cause === "contract" || input.cause === "change") return "change";
  return "person";
}

/**
 * The last distinctive line of a step that returned no.
 * The same command can fail for a new reason. That is a new no.
 * A long token is not part of the reason.
 */
export function shipNoSignature(tail: string): string {
  const lines = tail.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const picked = [...lines].reverse().find((line) => /error|fail|missing|required|denied|attribute/i.test(line)) ?? "";
  return picked.replace(/[A-Za-z0-9_-]{24,}/g, "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** A required check that has not finished is a wait, not an owner edit. */
export function shipNoIsWait(tail: string): boolean {
  return /GH006|quality is in progress|required status check[^\n]*in progress/i.test(tail);
}

/** One owner edit per key. The marker lives on the ticket so the next page sees it. */
export function ownerHealMarker(key: string): string {
  return `<!-- OWNER_HEAL ${key} -->`;
}

export function ownerHealPrompt(input: {
  reason: string;
  owner: "install" | "runner";
  tokenEnv?: string;
}): string {
  const token = input.tokenEnv?.trim();
  const where =
    input.owner === "runner"
      ? [
          "Edit the package that executes this loop.",
          "Land it on that package's trunk.",
          token
            ? `Push with the token in \`${token}\`. An installation token must not merge that package.`
            : "Push with the commit-actor token. An installation token must not merge that package.",
        ].join(" ")
      : "Edit the owner of the behavior that returned no. That owner may be this checkout, or a repo the command ships, including production promote and store continue. Land that owner's trunk before you finish. This step runs again when you return. An open pull request is not landed. A clean store wait is not a no. A production check that restores the previous tip and exits clean is not a no.";
  return [
    "A required step returned no. Fix that owner so this no cannot happen again.",
    input.reason,
    where,
    "One code path. A note, a watcher, or a ticket exception is not the fix.",
  ].join("\n\n");
}
