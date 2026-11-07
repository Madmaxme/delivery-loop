/** Branch prefix and label for a heal that edits this package. */
export const ENGINE_HEAL_BRANCH_PREFIX = "engine-heal/";
export const ENGINE_HEAL_LABEL = "engine-heal";

export function isEngineHealPull(input: {
  branch?: string | null;
  labels?: readonly string[];
}): boolean {
  const branch = (input.branch ?? "").trim();
  if (branch.startsWith(ENGINE_HEAL_BRANCH_PREFIX)) return true;
  return (input.labels ?? []).some((label) => label.toLowerCase() === ENGINE_HEAL_LABEL);
}

/**
 * A green quality run on an engine-heal pull request in this repo.
 * A push to main, a fork, or a red check does not merge.
 */
export function shouldMergeEngineHeal(input: {
  event: string;
  conclusion: string;
  branch?: string | null;
  labels?: readonly string[];
  headRepo: string;
  baseRepo: string;
}): boolean {
  if (input.event.trim() !== "pull_request") return false;
  if (input.conclusion.trim() !== "success") return false;
  if (input.headRepo.trim().toLowerCase() !== input.baseRepo.trim().toLowerCase()) return false;
  return isEngineHealPull(input);
}

export function nextPatchVersion(current: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim());
  if (!match) throw new Error(`bad version ${current}`);
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

export function engineHealReleaseSubject(prNumber: number): string {
  return `Bump the patch version after engine heal #${prNumber}.`;
}
