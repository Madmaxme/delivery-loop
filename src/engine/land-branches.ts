import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lockedGitEnv } from "../adapters/forge-git.ts";
import {
  allowlistedEnv,
  assertHealthy,
  credentialSecret,
  type CanonicalCredential,
} from "../adapters/canonical-path.ts";
import type { RepoSpec } from "../schema/pack.ts";

export function renderBranch(template: string, issue: string, repo: string): string {
  return template
    .replaceAll("{issue}", issue.trim().toLowerCase())
    .replaceAll("{repo}", repo);
}

/** `repo:` / `branch:` rows in a build handoff. Origin still has to have the ref. */
export function artifactBranches(text: string): { repo: string; branch: string }[] {
  const out: { repo: string; branch: string }[] = [];
  const re = /(?:^|\n)\s*-?\s*repo:\s*([A-Za-z0-9._-]+)\s*\n\s*branch:\s*(\S+)/gi;
  for (const match of text.matchAll(re)) {
    const repo = match[1]?.trim();
    const branch = match[2]?.trim();
    if (!repo || !branch || branch === "unknown") continue;
    out.push({ repo, branch });
  }
  return out;
}

export type ConfirmedBranch = {
  repo: RepoSpec;
  branch: string;
  sha: string;
};

/**
 * A branch the worker reported, a branch named in the handoff, then the
 * install's template. The first name origin actually has is the one we land.
 */
export function confirmLandBranches(input: {
  issue: string;
  repos: string[];
  packRepos: RepoSpec[];
  template?: string;
  text: string;
  reported: { repoUrl: string; branch: string }[];
  lookup: (repoUrl: string, branch: string) => string | null;
}): ConfirmedBranch[] | null {
  const artifacts = artifactBranches(input.text);
  const confirmed: ConfirmedBranch[] = [];
  for (const name of input.repos) {
    const spec = input.packRepos.find((repo) => repo.name === name);
    if (!spec) return null;
    const names = [
      ...input.reported
        .filter((row) => row.branch && sameRepo(row.repoUrl, spec.url))
        .map((row) => row.branch),
      ...artifacts.filter((row) => row.repo === name).map((row) => row.branch),
      input.template ? renderBranch(input.template, input.issue, name) : "",
    ].filter((branch, index, all) => branch && all.indexOf(branch) === index);
    let hit: ConfirmedBranch | null = null;
    for (const branch of names) {
      const sha = input.lookup(spec.url, branch);
      if (!sha) continue;
      hit = { repo: spec, branch, sha };
      break;
    }
    if (!hit) return null;
    confirmed.push(hit);
  }
  return confirmed.length ? confirmed : null;
}

/**
 * Git reads the token from askpass. The remote URL and the argv do not contain it.
 * A stamped credential wins. Otherwise the process token is used, still outside argv.
 */
export function lookupRemoteHead(
  repoUrl: string,
  branch: string,
  credential?: CanonicalCredential | null,
  spawn: typeof spawnSync = spawnSync,
): string | null {
  if (credential) assertHealthy(credential);
  const token = credential
    ? credentialSecret(credential, { api: "github", operation: "git", role: "opener", destination: repoUrl })
    : "";
  const ask = token ? gitAskPass(token) : null;
  try {
    const result = spawn("git", ["-c", "credential.helper=", "ls-remote", repoUrl, `refs/heads/${branch}`], {
      encoding: "utf8",
      env: ask?.env ?? lockedGitEnv(),
    });
    if (result.status !== 0) return null;
    const sha = result.stdout.trim().split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  } finally {
    if (ask) rmSync(ask.dir, { recursive: true, force: true });
  }
}

/** A git child reads the token from the environment. The token is not a URL argument. */
function gitAskPass(token: string): { dir: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), "git-askpass-"));
  const file = join(dir, "askpass.sh");
  writeFileSync(file, "#!/bin/sh\nprintf '%s\\n' \"$DELIVERY_LOOP_GIT_TOKEN\"\n", { mode: 0o700 });
  return {
    dir,
    env: {
      ...lockedGitEnv(),
      GIT_ASKPASS: file,
      GIT_TERMINAL_PROMPT: "0",
      DELIVERY_LOOP_GIT_TOKEN: token,
    },
  };
}

function sameRepo(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const match = value.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : value.replace(/\.git$/, "").toLowerCase();
  };
  return normalize(a) === normalize(b);
}
