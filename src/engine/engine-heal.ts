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

function versionParts(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) throw new Error(`bad version ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** The greater of two patch versions. Equal versions return the first. */
export function laterVersion(a: string, b: string): string {
  const left = versionParts(a);
  const right = versionParts(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] > right[i] ? a.trim() : b.trim();
  }
  return a.trim();
}

/** `v1.2.3` from a tag name or `refs/tags/` line. Annotated peels are ignored. */
export function releaseVersionFromTag(ref: string): string | null {
  const cleaned = ref.trim().replace(/\^\{\}$/, "");
  const match = /^(?:refs\/tags\/)?v(\d+\.\d+\.\d+)$/.exec(cleaned);
  return match ? match[1] : null;
}

/** Highest `vX.Y.Z` tag. Other refs are ignored. */
export function highestReleaseVersion(tags: readonly string[]): string | null {
  const versions = tags
    .map((tag) => releaseVersionFromTag(tag))
    .filter((version): version is string => version !== null);
  if (versions.length === 0) return null;
  return versions.reduce((best, version) => laterVersion(best, version));
}

export function releaseTagExists(version: string, tags: readonly string[]): boolean {
  const wanted = engineHealTag(version);
  return tags.some((tag) => {
    const parsed = releaseVersionFromTag(tag);
    return parsed !== null && engineHealTag(parsed) === wanted;
  });
}

/**
 * Next patch after the highest v* tag.
 * The first heal after v1.0.0 is 1.0.1.
 * Two heals that both see v1.0.0 both ask for 1.0.1. The second stops once that tag exists.
 */
export function engineHealBumpVersion(tags: readonly string[]): string {
  const latest = highestReleaseVersion(tags);
  if (!latest) throw new Error("no release tag");
  const next = nextPatchVersion(latest);
  if (releaseTagExists(next, tags)) throw new Error(`tag ${engineHealTag(next)} already exists`);
  return next;
}

/** What the opener puts in the engine-heal pull request. The workflow does not bump. */
export function engineHealBumpInstruction(tags?: readonly string[]): string {
  if (tags && tags.length > 0) {
    try {
      const version = engineHealBumpVersion(tags);
      return `Set package.json and package-lock.json to ${version} in that pull request. That is the next patch after the highest v* tag. Use npm version ${version} --no-git-tag-version. If tag v${version} already exists, stop and do not open the pull request.`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "the release tag already exists";
      return `Stop. ${message}. Do not open the pull request.`;
    }
  }
  return "Set package.json and package-lock.json to the next patch after the highest v* tag in that pull request. v1.0.0 becomes 1.0.1. Use npm version with --no-git-tag-version. If that tag already exists, stop and do not open the pull request.";
}

export function engineHealTag(version: string): string {
  const trimmed = version.trim();
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) throw new Error(`bad version ${version}`);
  return `v${trimmed}`;
}

export function engineHealMissingBumpComment(prNumber: number, mainVersion: string, tipVersion: string): string {
  return `Engine-heal pull request #${prNumber} does not bump package.json. The branch is ${tipVersion} and main is ${mainVersion}. Add the next patch after the highest v* tag to package.json and package-lock.json in this pull request, and push it with the commit-actor token. This workflow does not push a commit.`;
}

export function engineHealTagCollisionComment(version: string): string {
  const tag = engineHealTag(version);
  return `Tag ${tag} already exists. This pull request was not merged. Pick the next patch after the highest v* tag. This workflow does not push a commit.`;
}

export function engineHealReleaseNotes(prNumber: number): string {
  return `Automated patch on the merge commit of engine-heal pull request #${prNumber}. Quality was green on the bumped tip before the squash merge. Clients install this tag.`;
}

export type EngineHealCheck = "success" | "failure" | "pending" | "none";

/** Quality on one commit. A success wins. A run that has not finished is pending. */
export function engineHealQualityState(
  runs: readonly { status?: string; conclusion?: string }[],
): EngineHealCheck {
  if (runs.some((run) => (run.conclusion ?? "").toLowerCase() === "success")) return "success";
  const pending = runs.some((run) => {
    const status = (run.status ?? "").toLowerCase();
    return status.length > 0 && status !== "completed";
  });
  if (pending) return "pending";
  const failed = runs.some((run) => {
    const conclusion = (run.conclusion ?? "").toLowerCase();
    return (
      conclusion === "failure" ||
      conclusion === "cancelled" ||
      conclusion === "timed_out" ||
      conclusion === "startup_failure"
    );
  });
  if (failed) return "failure";
  return "none";
}

export function engineHealMergeArgs(repo: string, prNumber: number, headSha: string): string[] {
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    throw new Error("refusing to merge without the pull request head sha");
  }
  return [
    "pr",
    "merge",
    String(prNumber),
    "--repo",
    repo,
    "--squash",
    "--match-head-commit",
    headSha,
    "--delete-branch",
  ];
}

export type EngineHealPlan =
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "comment"; body: string }
  | { action: "wait-for-quality"; branch: string; sha: string }
  | { action: "merge-and-tag"; version: string; tag: string }
  | { action: "tag-merged"; version: string; tag: string };

function versionIsBump(mainVersion: string, tipVersion: string): boolean {
  const tip = tipVersion.trim();
  const main = mainVersion.trim();
  if (!tip || tip === main) return false;
  return laterVersion(main, tip) === tip;
}

/**
 * What to do after a green pull_request quality run on an engine-heal pull request.
 * The opener already committed the patch. This plan never pushes a commit.
 * A head without a bump, or a version whose tag already exists, gets a comment and stops.
 */
export function planEngineHealRelease(input: {
  pullState: "OPEN" | "MERGED" | "CLOSED";
  qualityOnTip: EngineHealCheck;
  mainVersion: string;
  tipVersion: string;
  tagExists: boolean;
  branch: string;
  branchTip: string;
  prNumber: number;
}): EngineHealPlan {
  if (input.pullState === "CLOSED") return { action: "skip", reason: "pull request is closed" };
  if (input.pullState === "MERGED") {
    if (input.tagExists) return { action: "skip", reason: "tag already exists" };
    return { action: "tag-merged", version: input.tipVersion, tag: engineHealTag(input.tipVersion) };
  }
  if (!versionIsBump(input.mainVersion, input.tipVersion)) {
    return {
      action: "comment",
      body: engineHealMissingBumpComment(input.prNumber, input.mainVersion, input.tipVersion),
    };
  }
  if (input.tagExists) {
    return { action: "comment", body: engineHealTagCollisionComment(input.tipVersion) };
  }
  if (input.qualityOnTip === "failure") {
    return { action: "fail", reason: "quality failed on the pull request head" };
  }
  if (input.qualityOnTip !== "success") {
    if (!input.branchTip.trim()) return { action: "fail", reason: "branch tip is missing" };
    return { action: "wait-for-quality", branch: input.branch, sha: input.branchTip.trim() };
  }
  return { action: "merge-and-tag", version: input.tipVersion.trim(), tag: engineHealTag(input.tipVersion) };
}
