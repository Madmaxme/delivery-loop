import { spawnSync } from "node:child_process";

import {
  engineHealFilesNeedReview,
  engineHealMergeArgs,
  engineHealReleaseNotes,
  gitBlobSha,
  gitChangedFiles,
  latestQualityProof,
  observeQualityRun,
  planEngineHealRelease,
  QUALITY_WORKFLOW_PATH,
  shouldMergeEngineHeal,
  type EngineHealPlan,
  type QualityRunProof,
} from "../src/engine/engine-heal.ts";

type Pull = {
  number: number;
  state: string;
  headRefName?: string;
  labels?: { name: string }[];
  mergeCommit?: { oid?: string } | null;
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

function pullState(state: string): "OPEN" | "MERGED" | "CLOSED" {
  if (state === "OPEN" || state === "MERGED") return state;
  return "CLOSED";
}

function sleep(seconds: number): void {
  spawnSync("sleep", [String(seconds)]);
}

function inflight(run: QualityRunProof): boolean {
  const status = (run.status ?? "").toLowerCase();
  return status === "queued" || status === "in_progress" || status === "waiting" || status === "pending" || status === "requested";
}

/**
 * Watch a pull_request quality run that is already in progress.
 * This job does not start a run and does not approve one. The opener's push does that.
 */
function watchPullRequestQuality(repo: string, _branch: string, sha: string): number | null {
  const attempts = qualityAttempts(repo, sha);
  const latest = latestQualityProof((attempts ?? []).filter((item) => item.event === "pull_request"));
  if (!latest || typeof latest.id !== "number" || !inflight(latest)) return null;
  const watched = spawnSync("gh", ["run", "watch", String(latest.id), "--repo", repo, "--exit-status"], {
    encoding: "utf8",
    timeout: 20 * 60 * 1000,
  });
  if (watched.status !== 0) {
    const detail = `${watched.stderr ?? ""}${watched.stdout ?? ""}`.trim();
    throw new Error(`quality on ${sha} did not pass${detail ? `: ${detail}` : ""}`);
  }
  return latest.id;
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

function mergePull(repo: string, prNumber: number, headSha: string): string {
  run("gh", engineHealMergeArgs(repo, prNumber, headSha));
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
  runId: string;
}): EngineHealPlan {
  const observed = observeQualityRun(qualityProof(input.repo, input.tip, input.runId), input.tip);
  const files = gitChangedFiles(process.cwd(), "refs/remotes/origin/main", input.tip);
  return planEngineHealRelease({
    pullState: input.state,
    qualityOnTip: observed.onTip,
    qualityTrusted: observed.trusted,
    qualityKnown: observed.known,
    filesNeedReview: engineHealFilesNeedReview(files),
    mainVersion: input.mainVersion,
    tipVersion: input.tipVersion,
    tagExists: tagExists(input.tipVersion),
    branch: input.branch,
    branchTip: input.tip,
    prNumber: input.prNumber,
  });
}

/** The pull ref and the branch tip are the same commit, or the head is unknown. */
function confirmedHead(prNumber: number, branchTip: string): string | null {
  const pullHead = fetchPullHead(prNumber);
  if (!pullHead || pullHead !== branchTip.trim().toLowerCase()) return null;
  return pullHead;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function readGhJson(args: string[]): unknown | null {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout ?? "") as unknown;
  } catch {
    return null;
  }
}

function fetchPullHead(prNumber: number): string | null {
  const ref = `refs/remotes/origin/pr-${prNumber}-head`;
  const fetched = spawnSync(
    "git",
    ["fetch", "origin", `refs/pull/${prNumber}/head:${ref}`],
    { encoding: "utf8" },
  );
  if (fetched.status !== 0) return null;
  const parsed = spawnSync("git", ["rev-parse", ref], { encoding: "utf8" });
  if (parsed.status !== 0) return null;
  const sha = (parsed.stdout ?? "").trim().toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** Every quality attempt on this SHA. Null when the list is truncated or malformed. */
function qualityAttempts(repo: string, sha: string): QualityRunProof[] | null {
  const listed = readGhJson([
    "api",
    "--method",
    "GET",
    `repos/${repo}/actions/workflows/quality.yml/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
  ]);
  if (!listed || typeof listed !== "object") return null;
  const body = listed as { total_count?: unknown; workflow_runs?: unknown };
  if (!Array.isArray(body.workflow_runs)) return null;
  if (typeof body.total_count !== "number" || body.total_count !== body.workflow_runs.length) return null;
  const proofs: QualityRunProof[] = [];
  for (const item of body.workflow_runs) {
    if (!item || typeof item !== "object") return null;
    const run = item as Record<string, unknown>;
    const id = integer(run.id);
    const attempt = integer(run.run_attempt);
    if (id === null || attempt === null || attempt <= 0) return null;
    const started =
      typeof run.run_started_at === "string" && run.run_started_at.length > 0
        ? run.run_started_at
        : typeof run.created_at === "string"
          ? run.created_at
          : "";
    if (!started) return null;
    proofs.push({
      id,
      attempt,
      createdAt: started,
      runStartedAt: started,
      event: typeof run.event === "string" ? run.event : "",
      status: typeof run.status === "string" ? run.status : "",
      conclusion: typeof run.conclusion === "string" ? run.conclusion : "",
      headSha: typeof run.head_sha === "string" ? run.head_sha : "",
      path: typeof run.path === "string" ? run.path : "",
      appId: null,
      appSlug: null,
      workflowBlobSha: null,
      mainWorkflowBlobSha: null,
    });
  }
  return proofs;
}

/** The latest attempt, with the app and workflow blob filled in. An older success is not used. */
function qualityProof(repo: string, pullHead: string, triggeringId: string): QualityRunProof | null {
  if (!/^[1-9]\d*$/.test(triggeringId)) return null;
  const attempts = qualityAttempts(repo, pullHead);
  if (!attempts || !attempts.some((item) => String(item.id) === triggeringId)) return null;
  const latest = latestQualityProof(attempts, Number(triggeringId));
  if (!latest || typeof latest.id !== "number") return null;
  const run = readGhJson(["api", "--method", "GET", `repos/${repo}/actions/runs/${latest.id}`]);
  if (!run || typeof run !== "object") return null;
  const body = run as Record<string, unknown>;
  if (integer(body.id) !== latest.id) return null;
  const suiteId = integer(body.check_suite_id);
  if (suiteId === null) return null;
  const suite = readGhJson(["api", "--method", "GET", `repos/${repo}/check-suites/${suiteId}`]);
  if (!suite || typeof suite !== "object") return null;
  const app = (suite as Record<string, unknown>).app;
  if (!app || typeof app !== "object") return null;
  const appId = integer((app as Record<string, unknown>).id);
  const slugValue = (app as Record<string, unknown>).slug;
  if (slugValue != null && typeof slugValue !== "string") return null;
  const path = typeof body.path === "string" ? body.path : "";
  const headSha = typeof body.head_sha === "string" ? body.head_sha : "";
  const proof: QualityRunProof = {
    ...latest,
    event: typeof body.event === "string" ? body.event : latest.event,
    status: typeof body.status === "string" ? body.status : latest.status,
    conclusion: typeof body.conclusion === "string" ? body.conclusion : latest.conclusion,
    headSha,
    path,
    appId,
    appSlug: typeof slugValue === "string" ? slugValue : null,
  };
  if (path !== QUALITY_WORKFLOW_PATH || headSha.toLowerCase() !== pullHead.toLowerCase()) return proof;
  proof.workflowBlobSha = gitBlobSha(process.cwd(), headSha, path);
  proof.mainWorkflowBlobSha = gitBlobSha(process.cwd(), "refs/remotes/origin/main", path);
  return proof;
}

function finish(repo: string, prNumber: number, plan: EngineHealPlan): void {
  if (plan.action === "comment" || plan.action === "review") {
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
  const runId = (process.env.HEAL_RUN_ID ?? "").trim();
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
    const head = fetchPullHead(pull.number);
    const plan = head
      ? releasePlan({
          state,
          repo: baseRepo,
          branch,
          tip: head,
          mainVersion: version,
          tipVersion: version,
          prNumber: pull.number,
          runId,
        })
      : planEngineHealRelease({
          pullState: "MERGED",
          qualityOnTip: "none",
          qualityTrusted: false,
          qualityKnown: false,
          filesNeedReview: null,
          mainVersion: version,
          tipVersion: version,
          tagExists: tagExists(version),
          branch,
          branchTip: "",
          prNumber: pull.number,
        });
    if (plan.action === "tag-merged") publishTagAt(pull.number, plan.version, sha);
    else finish(baseRepo, pull.number, plan);
    return;
  }
  if (state !== "OPEN") {
    process.stdout.write("Pull request is closed.\n");
    return;
  }

  fetchBranch(branch);
  const tip = run("git", ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
  const head = confirmedHead(pull.number, tip);
  const mainVersion = readVersionAt("refs/remotes/origin/main");
  const tipVersion = head ? readVersionAt(head) : readVersionAt(tip);
  let greenSha = head ?? "";
  let plan = head
    ? releasePlan({
        state,
        repo: baseRepo,
        branch,
        tip: head,
        mainVersion,
        tipVersion,
        prNumber: pull.number,
        runId,
      })
    : planEngineHealRelease({
        pullState: "OPEN",
        qualityOnTip: "none",
        qualityTrusted: false,
        qualityKnown: false,
        filesNeedReview: null,
        mainVersion,
        tipVersion,
        tagExists: false,
        branch,
        branchTip: "",
        prNumber: pull.number,
      });

  if (plan.action === "wait-for-quality") {
    const watched = watchPullRequestQuality(baseRepo, plan.branch, plan.sha);
    if (!watched) {
      process.stdout.write(`Waiting for pull_request quality on ${plan.sha}.\n`);
      return;
    }
    const checked = run("git", ["rev-parse", `refs/remotes/origin/${branch}`]).trim();
    if (checked !== plan.sha) throw new Error(`branch tip moved from ${plan.sha} to ${checked}`);
    const checkedHead = confirmedHead(pull.number, checked);
    if (!checkedHead) throw new Error(`pull head does not match ${checked}`);
    greenSha = checkedHead;
    plan = releasePlan({
      state,
      repo: baseRepo,
      branch,
      tip: checkedHead,
      mainVersion,
      tipVersion: readVersionAt(checkedHead),
      prNumber: pull.number,
      runId: String(watched),
    });
  }

  if (plan.action === "tag-merged") {
    publishTagAt(pull.number, plan.version, tip);
    return;
  }
  if (plan.action === "merge-and-tag") {
    const sha = mergePull(baseRepo, pull.number, greenSha);
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
