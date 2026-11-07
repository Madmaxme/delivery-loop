import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  engineHealReleaseSubject,
  shouldMergeEngineHeal,
} from "../src/engine/engine-heal.ts";

type Pull = {
  number: number;
  state: string;
  headRefName?: string;
  labels?: { name: string }[];
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
    "number,state,labels,headRefName",
    "--limit",
    "20",
  ]);
  return JSON.parse(stdout) as Pull[];
}

function releaseAlready(subject: string): boolean {
  const sha = run(
    "git",
    ["log", "origin/main", "--fixed-strings", "--grep", subject, "-1", "--format=%H"],
    true,
  ).trim();
  return sha.length > 0;
}

function readVersion(): string {
  return (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
}

function publishTag(prNumber: number, version: string): void {
  const tag = `v${version}`;
  const local = run("git", ["tag", "-l", tag], true).trim();
  const remote = run("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], true).trim();
  if (!local) run("git", ["tag", tag]);
  if (!remote) run("git", ["push", "origin", tag]);
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
    tag,
    "--title",
    tag,
    "--notes",
    `Automated patch after engine-heal pull request #${prNumber} passed the quality check and merged. Clients install this tag.`,
  ]);
  process.stdout.write(`Tagged ${tag} after #${prNumber}.\n`);
}

function publishPatch(prNumber: number): void {
  const subject = engineHealReleaseSubject(prNumber);
  run("git", ["fetch", "origin", "main", "--tags"]);
  run("git", ["checkout", "main"]);
  run("git", ["reset", "--hard", "origin/main"]);
  if (releaseAlready(subject)) {
    publishTag(prNumber, readVersion());
    return;
  }
  const current = readVersion();
  run("npm", ["version", "patch", "--no-git-tag-version"]);
  const next = readVersion();
  if (next === current) throw new Error(`patch version did not move from ${current}`);
  run("git", ["config", "user.name", "github-actions[bot]"]);
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  run("git", ["add", "package.json", "package-lock.json"]);
  run("git", [
    "commit",
    "-m",
    subject,
    "-m",
    `Automated patch after engine-heal pull request #${prNumber} passed quality and merged. The previous version was ${current}.`,
  ]);
  run("git", ["push", "origin", "HEAD:main"]);
  publishTag(prNumber, next);
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
  if (pull.state === "OPEN") {
    run("gh", ["pr", "merge", String(pull.number), "--repo", baseRepo, "--squash", "--delete-branch"]);
  }
  publishPatch(pull.number);
}

main();
