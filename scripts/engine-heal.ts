import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  engineHealQualityState,
  engineHealReleaseNotes,
  engineHealReleaseSubject,
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

function bumpCommit(branch: string, subject: string): string {
  return run(
    "git",
    ["log", `refs/remotes/origin/${branch}`, "--fixed-strings", "--grep", subject, "-1", "--format=%H"],
    true,
  ).trim();
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

function pullState(state: string): "OPEN" | "MERGED" | "CLOSED" {
  if (state === "OPEN" || state === "MERGED") return state;
  return "CLOSED";
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function approveRun(repo: string, runId: number): void {
  run("gh", ["api", "--method", "POST", `repos/${repo}/actions/runs/${runId}/approve`], true);
}

function inflight(run: QualityRun): boolean {
  const status = (run.status ?? "").toLowerCase();
  return status === "queued" || status === "in_progress" || status === "waiting" || status === "pending" || status === "requested";
}

/**
 * A push with the workflow token does not start on: push, and the pull_request
 * run it creates waits for a person to approve it. workflow_dispatch starts
 * quality on this tip without that approval. The check name is still quality.
 */
function ensureQualityGreen(repo: string, branch: string, sha: string): void {
  const listed = () => qualityRuns(repo, branch, sha);
  if (engineHealQualityState(listed()) === "success") return;

  const waitingApproval = listed().find((item) => (item.status ?? "").toLowerCase() === "action_required");
  if (waitingApproval) approveRun(repo, waitingApproval.databaseId);

  let current = listed();
  if (engineHealQualityState(current) === "success") return;
  let active = current.find(inflight);
  if (!active) {
    run("gh", ["workflow", "run", "quality.yml", "--repo", repo, "--ref", branch]);
    for (let attempt = 0; attempt < 30 && !active; attempt += 1) {
      sleep(2);
      current = listed();
      if (engineHealQualityState(current) === "success") return;
      active = current.find(inflight);
    }
  }
  if (!active) throw new Error(`quality did not start on ${sha}`);
  const watched = spawnSync("gh", ["run", "watch", String(active.databaseId), "--repo", repo, "--exit-status"], {
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });
  if (watched.status !== 0) {
    const detail = `${watched.stderr ?? ""}${watched.stdout ?? ""}`.trim();
    throw new Error(`quality on ${sha} did not pass${detail ? `: ${detail}` : ""}`);
  }
}

function commitBump(branch: string, plan: Extract<EngineHealPlan, { action: "bump-branch" }>): void {
  const remote = `refs/remotes/origin/${branch}`;
  run("git", ["reset", "--hard", "HEAD"]);
  run("git", ["checkout", "-B", branch, remote]);
  run("git", ["reset", "--hard", remote]);
  run("npm", ["version", plan.version, "--no-git-tag-version"]);
  const changed = run("git", ["diff", "HEAD", "--name-only", "--", "package.json", "package-lock.json"]);
  if (!changed.includes("package.json") || !changed.includes("package-lock.json")) {
    throw new Error(`patch bump did not change package.json and package-lock.json:\n${changed.trim()}`);
  }
  const written = readVersionFile(readFileSync("package.json", "utf8"));
  if (written !== plan.version) throw new Error(`package.json is ${written}, expected ${plan.version}`);
  run("git", ["config", "user.name", "github-actions[bot]"]);
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", ["commit", "-m", plan.subject, "-m", plan.body]);
  run("git", ["push", "origin", `HEAD:${plan.branchRef}`]);
  process.stdout.write(`Pushed ${plan.version} to ${plan.branchRef}.\n`);
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

function main(): void {
  const event = process.env.HEAL_EVENT ?? "";
  const conclusion = process.env.HEAL_CONCLUSION ?? "";
  const branch = process.env.HEAL_BRANCH ?? "";
  const headRepo = process.env.HEAL_HEAD_REPO ?? "";
  const baseRepo = process.env.HEAL_BASE_REPO ?? "";
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
      bumpOnBranch: true,
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
  const subject = engineHealReleaseSubject(pull.number);
  const bumped = bumpCommit(branch, subject);
  const tip = run("git", ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
  const mainVersion = readVersionAt("refs/remotes/origin/main");
  const tipVersion = readVersionAt(tip);
  let plan = planEngineHealRelease({
    pullState: "OPEN",
    bumpOnBranch: bumped.length > 0,
    qualityOnTip: engineHealQualityState(qualityRuns(baseRepo, branch, tip)),
    mainVersion,
    tipVersion,
    tagExists: tagExists(tipVersion),
    branch,
    branchTip: tip,
    prNumber: pull.number,
  });

  if (plan.action === "bump-branch") {
    commitBump(branch, plan);
    fetchBranch(branch);
    const nextTip = run("git", ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
    const nextVersion = readVersionAt(nextTip);
    plan = planEngineHealRelease({
      pullState: "OPEN",
      bumpOnBranch: true,
      qualityOnTip: "none",
      mainVersion,
      tipVersion: nextVersion,
      tagExists: tagExists(nextVersion),
      branch,
      branchTip: nextTip,
      prNumber: pull.number,
    });
  }

  if (plan.action === "wait-for-quality") {
    ensureQualityGreen(baseRepo, plan.branch, plan.sha);
    const checked = run("git", ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
    if (checked !== plan.sha) throw new Error(`branch tip moved from ${plan.sha} to ${checked}`);
    plan = planEngineHealRelease({
      pullState: "OPEN",
      bumpOnBranch: true,
      qualityOnTip: "success",
      mainVersion,
      tipVersion: readVersionAt(checked),
      tagExists: tagExists(readVersionAt(checked)),
      branch,
      branchTip: checked,
      prNumber: pull.number,
    });
  }

  if (plan.action === "fail") throw new Error(plan.reason);
  if (plan.action === "skip") {
    process.stdout.write(`${plan.reason}.\n`);
    return;
  }
  if (plan.action !== "merge-and-tag") throw new Error(`unexpected engine-heal plan ${plan.action}`);

  const mergeSha = mergePull(baseRepo, pull.number);
  const mergedVersion = readVersionAt(mergeSha);
  if (mergedVersion !== plan.version) {
    throw new Error(`merge commit ${mergeSha} is ${mergedVersion}, expected ${plan.version}`);
  }
  publishTagAt(pull.number, plan.version, mergeSha);
}

main();
