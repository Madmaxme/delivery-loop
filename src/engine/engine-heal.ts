import { spawnSync } from "node:child_process";

import { GITHUB_ACTIONS_APP_ID, GITHUB_ACTIONS_APP_SLUG } from "./github-actions.ts";

/** Branch prefix and label for a heal that edits this package. */
export const ENGINE_HEAL_BRANCH_PREFIX = "engine-heal/";
export const ENGINE_HEAL_LABEL = "engine-heal";

/** The quality workflow this package runs. Auto-merge trusts only this path. */
export const QUALITY_WORKFLOW_PATH = ".github/workflows/quality.yml";

export function isEngineHealPull(input: {
  branch?: string | null;
  labels?: readonly string[];
}): boolean {
  const branch = (input.branch ?? "").trim();
  const labeled = (input.labels ?? []).some((label) => label.toLowerCase() === ENGINE_HEAL_LABEL);
  return branch.startsWith(ENGINE_HEAL_BRANCH_PREFIX) && labeled;
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
  | { action: "review"; body: string }
  | { action: "wait-for-quality"; branch: string; sha: string }
  | { action: "merge-and-tag"; version: string; tag: string }
  | { action: "tag-merged"; version: string; tag: string };

export function engineHealReviewComment(prNumber: number, reason: string): string {
  return `Engine-heal pull request #${prNumber} needs a normal review. ${reason} This workflow will not squash-merge or tag it.`;
}

const QUALITY_UNTRUSTED =
  "The quality run is not a GitHub Actions pull_request run of .github/workflows/quality.yml on this head with the same workflow file as main.";
const FILES_UNKNOWN = "The changed files are unknown.";
const FILES_SENSITIVE =
  "It changes a workflow, a CI script, the heal program, or a test.";
const QUALITY_UNREADABLE = "The quality run could not be read.";

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
  /** True only when the green run is the base workflow on this exact head. */
  qualityTrusted: boolean;
  /** False when the run could not be read. Pending is known. */
  qualityKnown: boolean;
  /** Null when the file list could not be read. True when a sensitive path changed. */
  filesNeedReview: boolean | null;
  mainVersion: string;
  tipVersion: string;
  tagExists: boolean;
  branch: string;
  branchTip: string;
  prNumber: number;
}): EngineHealPlan {
  const review = (reason: string): EngineHealPlan => ({
    action: "review",
    body: engineHealReviewComment(input.prNumber, reason),
  });
  if (input.pullState === "CLOSED") return { action: "skip", reason: "pull request is closed" };
  const filesBlocked =
    input.filesNeedReview === null ? FILES_UNKNOWN : input.filesNeedReview ? FILES_SENSITIVE : null;
  if (input.pullState === "MERGED") {
    if (input.tagExists) return { action: "skip", reason: "tag already exists" };
    if (filesBlocked) return review(filesBlocked);
    if (!input.qualityKnown) return review(QUALITY_UNREADABLE);
    if (input.qualityOnTip !== "success" || input.qualityTrusted !== true) return review(QUALITY_UNTRUSTED);
    return { action: "tag-merged", version: input.tipVersion, tag: engineHealTag(input.tipVersion) };
  }
  if (filesBlocked) return review(filesBlocked);
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
    if (!input.qualityKnown) return review(QUALITY_UNREADABLE);
    if (!input.branchTip.trim()) return { action: "fail", reason: "branch tip is missing" };
    return { action: "wait-for-quality", branch: input.branch, sha: input.branchTip.trim() };
  }
  if (input.qualityTrusted !== true) return review(QUALITY_UNTRUSTED);
  return { action: "merge-and-tag", version: input.tipVersion.trim(), tag: engineHealTag(input.tipVersion) };
}

export type EngineHealFile = {
  path: string;
  /** Null when the file is not package metadata, or the base blob could not be read. */
  baseText: string | null;
  headText: string | null;
};

/** A repository path. `..`, absolute paths, and empty segments are unknown. */
export function normalizeRepoPath(path: string): string | null {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0")) return null;
  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null;
  return parts.join("/");
}

function parsedObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key]);
  }
  return out;
}

function packageManifestNeedsReview(baseText: string | null, headText: string | null): boolean {
  const base = parsedObject(baseText);
  const head = parsedObject(headText);
  if (!base || !head) return true;
  const left = { ...base };
  const right = { ...head };
  delete left.version;
  delete right.version;
  return JSON.stringify(sortKeys(left)) !== JSON.stringify(sortKeys(right));
}

function stripLockVersion(value: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(value);
  delete copy.version;
  const packages = copy.packages;
  if (packages && typeof packages === "object" && !Array.isArray(packages)) {
    const root = (packages as Record<string, unknown>)[""];
    if (root && typeof root === "object" && !Array.isArray(root)) {
      delete (root as Record<string, unknown>).version;
    }
  }
  return copy;
}

function packageLockNeedsReview(baseText: string | null, headText: string | null): boolean {
  const base = parsedObject(baseText);
  const head = parsedObject(headText);
  if (!base || !head) return true;
  return JSON.stringify(sortKeys(stripLockVersion(base))) !== JSON.stringify(sortKeys(stripLockVersion(head)));
}

/**
 * True when auto-merge must stop.
 * Workflow files, CI scripts, the heal program, tests, and package script edits cannot certify themselves.
 * A version-only package.json and package-lock.json change does not.
 */
export function engineHealFileNeedsReview(file: EngineHealFile): boolean {
  const path = normalizeRepoPath(file.path);
  if (!path) return true;
  if (path === "package.json") return packageManifestNeedsReview(file.baseText, file.headText);
  if (path === "package-lock.json") return packageLockNeedsReview(file.baseText, file.headText);
  if (path.startsWith(".github/") || path.startsWith("scripts/")) return true;
  if (path === "src/engine/engine-heal.ts") return true;
  if (path.endsWith(".test.ts") || path.endsWith(".spec.ts")) return true;
  return false;
}

/** Null when the file list is unknown. */
export function engineHealFilesNeedReview(files: readonly EngineHealFile[] | null): boolean | null {
  if (files === null) return null;
  for (const file of files) {
    if (engineHealFileNeedsReview(file)) return true;
  }
  return false;
}

export type QualityRunProof = {
  id?: number | null;
  event?: string | null;
  status?: string | null;
  conclusion?: string | null;
  headSha?: string | null;
  path?: string | null;
  appId?: number | null;
  appSlug?: string | null;
  workflowBlobSha?: string | null;
  mainWorkflowBlobSha?: string | null;
};

function sha40(value: string | null | undefined): string | null {
  const sha = (value ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/**
 * The run is the base-branch quality workflow on this pull request head.
 * The workflow blob on the head must equal the blob on main. Any missing field is untrusted.
 */
export function qualityRunIsBaseWorkflow(proof: QualityRunProof | null, pullHead: string): boolean {
  if (!proof) return false;
  const head = sha40(pullHead);
  const runHead = sha40(proof.headSha);
  if (!head || !runHead || head !== runHead) return false;
  if ((proof.event ?? "").trim() !== "pull_request") return false;
  if ((proof.status ?? "").trim().toLowerCase() !== "completed") return false;
  if ((proof.conclusion ?? "").trim().toLowerCase() !== "success") return false;
  if (proof.path !== QUALITY_WORKFLOW_PATH) return false;
  if (proof.appId !== GITHUB_ACTIONS_APP_ID) return false;
  if (proof.appSlug != null && proof.appSlug !== "" && proof.appSlug !== GITHUB_ACTIONS_APP_SLUG) return false;
  const blob = sha40(proof.workflowBlobSha);
  const mainBlob = sha40(proof.mainWorkflowBlobSha);
  if (!blob || !mainBlob || blob !== mainBlob) return false;
  if (typeof proof.id !== "number" || !Number.isInteger(proof.id) || proof.id <= 0) return false;
  return true;
}

export function observeQualityRun(
  proof: QualityRunProof | null,
  pullHead: string,
): { known: boolean; onTip: EngineHealCheck; trusted: boolean } {
  if (!proof) return { known: false, onTip: "none", trusted: false };
  const trusted = qualityRunIsBaseWorkflow(proof, pullHead);
  const status = (proof.status ?? "").trim().toLowerCase();
  const conclusion = (proof.conclusion ?? "").trim().toLowerCase();
  if (status.length > 0 && status !== "completed") return { known: true, onTip: "pending", trusted: false };
  if (conclusion === "success") return { known: true, onTip: "success", trusted };
  if (
    conclusion === "failure" ||
    conclusion === "cancelled" ||
    conclusion === "timed_out" ||
    conclusion === "startup_failure"
  ) {
    return { known: true, onTip: "failure", trusted: false };
  }
  return { known: true, onTip: "none", trusted: false };
}

function gitText(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  return result.stdout ?? "";
}

/** Blob sha of one path at a rev. Null when the path is missing or the rev is unknown. */
export function gitBlobSha(cwd: string, rev: string, path: string): string | null {
  const normalized = normalizeRepoPath(path);
  if (!normalized || !rev.trim() || rev.includes("\0")) return null;
  const text = gitText(cwd, ["rev-parse", "--verify", `${rev}:${normalized}`]);
  if (text === null) return null;
  return sha40(text.trim());
}

/**
 * Files changed between base and head. Null when git cannot answer.
 * Package metadata includes both sides so a version-only bump can be told from a script edit.
 */
export function gitChangedFiles(cwd: string, baseRev: string, headRev: string): EngineHealFile[] | null {
  if (!baseRev.trim() || !headRev.trim() || baseRev.includes("\0") || headRev.includes("\0")) return null;
  const listed = gitText(cwd, [
    "diff",
    "-z",
    "--name-only",
    "--diff-filter=ACDMRTUXB",
    `${baseRev}...${headRev}`,
  ]);
  if (listed === null) return null;
  const paths = listed.split("\0").filter((path) => path.length > 0);
  const files: EngineHealFile[] = [];
  for (const path of paths) {
    if (path === "package.json" || path === "package-lock.json") {
      const baseText = gitText(cwd, ["show", `${baseRev}:${path}`]);
      const headText = gitText(cwd, ["show", `${headRev}:${path}`]);
      files.push({ path, baseText, headText });
      continue;
    }
    files.push({ path, baseText: null, headText: null });
  }
  return files;
}
