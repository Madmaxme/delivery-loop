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

/**
 * Next patch after the greater of main and the pull request.
 * The first heal after 1.0.0 is 1.0.1.
 */
export function engineHealNextVersion(mainVersion: string, branchVersion: string): string {
  return nextPatchVersion(laterVersion(mainVersion, branchVersion));
}

export function engineHealTag(version: string): string {
  const trimmed = version.trim();
  if (!/^\d+\.\d+\.\d+$/.test(trimmed)) throw new Error(`bad version ${version}`);
  return `v${trimmed}`;
}

export function engineHealReleaseSubject(prNumber: number): string {
  return `Bump the patch version after engine heal #${prNumber}.`;
}

export function engineHealReleaseBody(prNumber: number, previous: string, next: string): string {
  return `Automated patch on engine-heal pull request #${prNumber}. The previous version was ${previous}. This commit sets ${next} on the pull request so the squash merge carries it. No commit is pushed to main.`;
}

export function engineHealReleaseNotes(prNumber: number): string {
  return `Automated patch on the merge commit of engine-heal pull request #${prNumber}. Quality was green on the bumped tip before the squash merge. Clients install this tag.`;
}

/** Ref to push. A commit is never pushed to main. */
export function engineHealBranchRef(branch: string): string {
  const name = branch.trim();
  if (!name || name === "main" || name === "refs/heads/main" || name.startsWith("refs/heads/main")) {
    throw new Error("engine heal must not push a commit to main");
  }
  if (name.startsWith("-") || name.includes(" ") || name.includes("..")) throw new Error(`bad branch ${branch}`);
  if (name.startsWith("refs/heads/")) return name;
  return `refs/heads/${name}`;
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

export type EngineHealPlan =
  | { action: "skip"; reason: string }
  | { action: "fail"; reason: string }
  | { action: "bump-branch"; branchRef: string; version: string; subject: string; body: string }
  | { action: "wait-for-quality"; branch: string; sha: string }
  | { action: "merge-and-tag"; version: string; tag: string }
  | { action: "tag-merged"; version: string; tag: string };

/**
 * What to do after a green quality run on an engine-heal pull request.
 * The patch is committed on the pull request, quality must be green on that
 * tip, and the squash merge is what lands the bump. Nothing pushes a commit to main.
 */
export function planEngineHealRelease(input: {
  pullState: "OPEN" | "MERGED" | "CLOSED";
  bumpOnBranch: boolean;
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
  if (!input.bumpOnBranch) {
    const version = engineHealNextVersion(input.mainVersion, input.tipVersion);
    const previous = laterVersion(input.mainVersion, input.tipVersion);
    return {
      action: "bump-branch",
      branchRef: engineHealBranchRef(input.branch),
      version,
      subject: engineHealReleaseSubject(input.prNumber),
      body: engineHealReleaseBody(input.prNumber, previous, version),
    };
  }
  if (input.qualityOnTip === "failure") {
    return { action: "fail", reason: "quality failed on the bumped tip" };
  }
  if (input.qualityOnTip !== "success") {
    if (!input.branchTip.trim()) return { action: "fail", reason: "branch tip is missing" };
    return { action: "wait-for-quality", branch: input.branch, sha: input.branchTip.trim() };
  }
  if (laterVersion(input.mainVersion, input.tipVersion) !== input.tipVersion.trim()) {
    return {
      action: "fail",
      reason: `release version ${input.tipVersion} is not newer than main ${input.mainVersion}`,
    };
  }
  if (input.tipVersion.trim() === input.mainVersion.trim()) {
    return {
      action: "fail",
      reason: `release version ${input.tipVersion} is not newer than main ${input.mainVersion}`,
    };
  }
  return { action: "merge-and-tag", version: input.tipVersion.trim(), tag: engineHealTag(input.tipVersion) };
}
