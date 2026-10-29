/**
 * Why a red quality check is red. The next edit follows the cause.
 * A product patch is not the answer for a flake, a red trunk, a
 * different worker image, or generated-client drift.
 */

export type QualityCause = "flake" | "trunk" | "environment" | "contract" | "change";

export type QualitySample = {
  state: "success" | "failure" | "pending" | "unscheduled";
  detail: string;
};

const CONTRACT_RE =
  /openapi|api-types|wire-shape|generated client|codegen|swagger_to_dart/i;

export function classifyQualityCause(input: {
  detail: string;
  /** A second read of the same SHA. Null when this install did not rerun it. */
  rerun: QualitySample | null;
  /** The same check on the trunk tip. Null when this install did not read it. */
  trunk: QualitySample | null;
  /** False when the worker command or image is not the workflow's. */
  commandMatchesWorkflow: boolean | null;
}): QualityCause {
  if (input.rerun?.state === "success") return "flake";
  if (input.trunk?.state === "failure") return "trunk";
  if (input.commandMatchesWorkflow === false) return "environment";
  if (CONTRACT_RE.test(input.detail)) return "contract";
  return "change";
}

/** The worker's stated reason for the edit. A missing line is null. */
export function parseHypothesis(text: string): string | null {
  const line = text.match(/\*\*Hypothesis:\*\*\s*(.+)/i)?.[1]?.trim() ?? "";
  return line || null;
}

function norm(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

/** A second edit that repeats the previous hypothesis is not a new fix. */
export function sameHypothesis(previous: string | null, next: string | null): boolean {
  if (!previous || !next) return false;
  return norm(previous) === norm(next);
}
