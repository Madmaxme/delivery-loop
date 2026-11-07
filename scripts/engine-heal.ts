import { spawnSync } from "node:child_process";

import {
  engineHealQualityState,
  engineHealReleaseNotes,
  planEngineHealRelease,
  shouldMergeEngineHeal,
  type EngineHealPlan,
} from "../src/engine/engine-heal.ts";

type Pull = {
  number: number;
  state: string;
  headRefName?: string;
  labels?: { name: string }[];
  mergeCommit?: { oid?: string } | null;
};

type QualityRun = {
  databaseId: number;
  status?: string;
  conclusion?: string;
  event?: string;
  headSha?: string;
};

function run(command: string, args: string[], allowFailure = false): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout ?? "";
}

function pulls(repo: string, branch: string): Pull[] {
  const stdout = run("gh", [
    "pr",
    "list",
    "--repo",
    repo,
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "number,state,labels,headRefName,mergeCommit",
    "--limit",
    "20",
  ]);
  return JSON.parse(stdout) as Pull[];
}

function readVersionFile(text: string): string {
  return (JSON.parse(text) as { version: string }).version;
}

function readVersionAt(rev: string): string {
  return readVersionFile(run("git", ["show", `${rev}:package.json`]));
}

function fetchMain(): void {
  run("git", ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main", "--tags"]);
}

function fetchBranch(branch: string): void {
  fetchMain();
  run("git", ["fetch", "origin", `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
}

function tagExists(version: string): boolean {
  const tag = `v${version}`;
  const remote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], true).trim();
  return remote.length > 0;
}

function qualityRuns(repo: string, branch: string, sha: string): QualityRun[] {
  const stdout = run("gh", [
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    "quality.yml",
    "--branch",
    branch,
    "--commit",
    sha,
    "--json",
    "databaseId,status,conclusion,event,headSha",
    "--limit",
    "20",
  ]);
  const runs = JSON.parse(stdout) as QualityRun[];
  return runs.filter((item) => (item.headSha ?? "").toLowerCase() === sha.toLowerCase());
}

/** Branch protection reads the pull_request quality check. A dispatched run does not. */
function pullRequestQuality(repo: string, branch: string, sha: string): ReturnType<typeof engineHealQualityState> {
  const runs = qualityRuns(repo, branch, sha).filter((item) => (item.event ?? "") === "pull_request");
  return engineHealQualityState(runs);
}

function pullState(state: string): "OPEN" | "MERGED" | "CLOSED" {
  if (state === "OPEN" || state === "MERGED") return state;
  return "CLOSED";
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function inflight(run: QualityRun): boolean {
  const status = (run.status ?? "").toLowerCase();
  return status === "queued" || status === "in_progress" || status === "waiting" || status === "pending" || status === "requested";
}

/**
 * Watch a pull_request quality run that is already in progress.
 * This job does not start a run and does not approve one. The opener's push does that.
 */
function watchPullRequestQuality(repo: string, branch: string, sha: string): boolean {
  const active = qualityRuns(repo, branch, sha)
    .filter((item) => (item.event ?? "") === "pull_request")
    .find(inflight);
  if (!active) return false;
  const watched = spawnSync("gh", ["run", "watch", String(active.databaseId), "--repo", repo, "--exit-status"], {
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });
  if (watched.status !== 0) {
    const detail = `${watched.stderr ?? ""}${watched.stdout ?? ""}`.trim();
    throw new Error(`quality on ${sha} did not pass${detail ? `: ${detail}` : ""}`);
  }
  return true;
}

function commentOnPull(repo: string, prNumber: number, body: string): void {
  run("gh", ["pr", "comment", String(prNumber), "--repo", repo, "--body", body]);
  process.stdout.write(`${body}\n`);
}

function publishTagAt(prNumber: number, version: string, sha: string): void {
  const tag = `v${version}`;
  fetchMain();
  const contains = spawnSync("git", ["merge-base", "--is-ancestor", sha, "refs/remotes/origin/main"], {
    encoding: "utf8",
  });
  if (contains.status !== 0) throw new Error(`merge commit ${sha} is not on main`);
  const local = run("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`], true).trim();
  const remote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], true).trim();
  if (!local && !remote) run("git", ["tag", tag, sha]);
  if (!remote) run("git", ["push", "origin", `refs/tags/${tag}`]);
  const viewed = spawnSync("gh", ["release", "view", tag], { encoding: "utf8" });
  if (viewed.status === 0) {
    process.stdout.write(`Release ${tag} already exists.\n`);
    return;
  }
  run("gh", [
    "release",
    "create",
    tag,
    "--target",
    sha,
    "--title",
    tag,
    "--notes",
    engineHealReleaseNotes(prNumber),
  ]);
  process.stdout.write(`Tagged ${sha} as ${tag} after #${prNumber}.\n`);
}

function mergePull(repo: string, prNumber: number): string {
  run("gh", ["pr", "merge", String(prNumber), "--repo", repo, "--squash", "--delete-branch"]);
  let sha = "";
  for (let attempt = 0; attempt < 5 && !sha; attempt += 1) {
    const view = JSON.parse(
      run("gh", ["pr", "view", String(prNumber), "--repo", repo, "--json", "state,mergeCommit"]),
    ) as Pull;
    sha = view.mergeCommit?.oid ?? "";
    if (!sha) sleep(2);
  }
  if (!sha) throw new Error(`no merge commit for #${prNumber}`);
  fetchMain();
  return sha;
}

function releasePlan(input: {
  state: "OPEN" | "MERGED" | "CLOSED";
  repo: string;
  branch: string;
  tip: string;
  mainVersion: string;
  tipVersion: string;
  prNumber: number;
  triggeredSha: string;
  event: string;
  conclusion: string;
}): EngineHealPlan {
  const triggered =
    input.triggeredSha.length > 0 &&
    input.triggeredSha === input.tip &&
    input.event === "pull_request" &&
    input.conclusion === "success";
  return planEngineHealRelease({
    pullState: input.state,
    qualityOnTip: input.state === "MERGED" || triggered ? "success" : pullRequestQuality(input.repo, input.branch, input.tip),
    mainVersion: input.mainVersion,
    tipVersion: input.tipVersion,
    tagExists: tagExists(input.tipVersion),
    branch: input.branch,
    branchTip: input.tip,
    prNumber: input.prNumber,
  });
}

function finish(repo: string, prNumber: number, plan: EngineHealPlan): void {
  if (plan.action === "comment") {
    commentOnPull(repo, prNumber, plan.body);
    return;
  }
  if (plan.action === "fail") throw new Error(plan.reason);
  if (plan.action === "skip") {
    process.stdout.write(`${plan.reason}.\n`);
    return;
  }
  throw new Error(`unexpected engine-heal plan ${plan.action}`);
}

function main(): void {
  const event = process.env.HEAL_EVENT ?? "";
  const conclusion = process.env.HEAL_CONCLUSION ?? "";
  const branch = process.env.HEAL_BRANCH ?? "";
  const headRepo = process.env.HEAL_HEAD_REPO ?? "";
  const baseRepo = process.env.HEAL_BASE_REPO ?? "";
  const triggeredSha = (process.env.HEAL_SHA ?? "").trim();
  if (!branch || !baseRepo) {
    process.stdout.write("No engine-heal pull request context.\n");
    return;
  }
  const found = pulls(baseRepo, branch);
  const pull = found.find((item) => item.state === "OPEN") ?? found.find((item) => item.state === "MERGED");
  const labels = (pull?.labels ?? []).map((label) => label.name);
  if (
    !shouldMergeEngineHeal({
      event,
      conclusion,
      branch: pull?.headRefName || branch,
      labels,
      headRepo: headRepo || baseRepo,
      baseRepo,
    })
  ) {
    process.stdout.write(`Not an engine-heal merge: ${branch}\n`);
    return;
  }
  if (!pull) throw new Error(`No pull request for ${branch}`);

  const state = pullState(pull.state);
  if (state === "MERGED") {
    const sha = pull.mergeCommit?.oid ?? "";
    if (!sha) throw new Error(`no merge commit for #${pull.number}`);
    fetchMain();
    const version = readVersionAt(sha);
    const plan = planEngineHealRelease({
      pullState: "MERGED",
      qualityOnTip: "success",
      mainVersion: version,
      tipVersion: version,
      tagExists: tagExists(version),
      branch,
      branchTip: sha,
      prNumber: pull.number,
    });
    if (plan.action === "tag-merged") publishTagAt(pull.number, plan.version, sha);
    else process.stdout.write(`${plan.action === "skip" ? plan.reason : plan.action}.\n`);
    return;
  }
  if (state !== "OPEN") {
    process.stdout.write("Pull request is closed.\n");
    return;
  }

  fetchBranch(branch);
  const tip = run("git", ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
  const mainVersion = readVersionAt("refs/remotes/origin/main");
  const tipVersion = readVersionAt(tip);
  let plan = releasePlan({
    state,
    repo: baseRepo,
    branch,
    tip,
    mainVersion,
    tipVersion,
    prNumber: pull.number,
    triggeredSha,
    event,
    conclusion,
  });

  if (plan.action === "wait-for-quality") {
    const watched = watchPullRequestQuality(baseRepo, plan.branch, plan.sha);
    if (!watched) {
      process.stdout.write(`Waiting for pull_request quality on ${plan.sha}.\n`);
      return;
    }
    const checked = run("git", ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
    if (checked !== plan.sha) throw new Error(`branch tip moved from ${plan.sha} to ${checked}`);
    plan = planEngineHealRelease({
      pullState: "OPEN",
      qualityOnTip: "success",
      mainVersion,
      tipVersion: readVersionAt(checked),
      tagExists: tagExists(readVersionAt(checked)),
      branch,
      branchTip: checked,
      prNumber: pull.number,
    });
  }

  if (plan.action === "tag-merged") {
    publishTagAt(pull.number, plan.version, tip);
    return;
  }
  if (plan.action === "merge-and-tag") {
    const sha = mergePull(baseRepo, pull.number);
    const mergedVersion = readVersionAt(sha);
    if (mergedVersion !== plan.version) {
      throw new Error(`merge commit ${sha} is ${mergedVersion}, expected ${plan.version}`);
    }
    publishTagAt(pull.number, mergedVersion, sha);
    return;
  }
  finish(baseRepo, pull.number, plan);
}

main();
