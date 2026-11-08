import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowlistedEnv,
  assertCanonicalCredential,
  assertHealthy,
  CanonicalPathError,
  credentialSecret,
  type CanonicalCredential,
} from "./canonical-path.ts";
import type { CompareStatus, ForgeAdapter } from "./types.js";

export type GitRun = (args: string[], cwd: string, env: NodeJS.ProcessEnv) => { status: number | null; stdout?: string };

function defaultGit(args: string[], cwd: string, env: NodeJS.ProcessEnv): { status: number | null; stdout: string } {
  const capture = args[0] === "rev-parse" || args[0] === "merge-base";
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

/** Checkout for a repo URL. A nested clone wins. Otherwise the workspace root. */
export function gitCheckoutDir(cwd: string, repoUrl: string): string {
  const name = repoUrl.replace(/\.git$/, "").split("/").filter(Boolean).pop() ?? "";
  const nested = name ? join(cwd, name) : cwd;
  return existsSync(join(nested, ".git")) ? nested : cwd;
}

/**
 * Code host for any git remote. There is no pull-request API.
 * The runner merges the branch. A workflow check is refused by the pack.
 */
export function lockedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return allowlistedEnv(base, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  });
}

export function gitForge(opts: {
  cwd: string;
  credential?: CanonicalCredential | null;
  /** Canonical mode refuses to run without a healthy credential and ignores ambient helpers. */
  mode?: "legacy" | "canonical";
  run?: GitRun;
  checkoutDir?: (repoUrl: string) => string;
}): ForgeAdapter {
  const canonical = opts.mode === "canonical";
  if (canonical && !opts.credential) {
    throw new CanonicalPathError("missing-policy", "github", "missing canonical credential");
  }
  if (opts.credential) assertCanonicalCredential(opts.credential, "github");
  const runFor = (repoUrl: string): GitRun => {
    if (canonical && !opts.credential) {
      throw new CanonicalPathError("missing-policy", "github", "missing canonical credential");
    }
    let askDir: string | null = null;
    const env = lockedGitEnv();
    if (opts.credential) {
      assertHealthy(opts.credential);
      const token = credentialSecret(opts.credential, {
        api: "github",
        operation: "git",
        role: "opener",
        destination: repoUrl,
      });
      askDir = mkdtempSync(join(tmpdir(), "git-askpass-"));
      const file = join(askDir, "askpass.sh");
      writeFileSync(file, "#!/bin/sh\nprintf '%s\\n' \"$DELIVERY_LOOP_GIT_TOKEN\"\n", { mode: 0o700 });
      env.GIT_ASKPASS = file;
      env.GIT_TERMINAL_PROMPT = "0";
      env.DELIVERY_LOOP_GIT_TOKEN = token;
    }
    const run = opts.run ?? ((args: string[], cwd: string, childEnv: NodeJS.ProcessEnv) => defaultGit(["-c", "credential.helper=", ...args], cwd, childEnv));
    return (args, cwd) => run(args, cwd, env);
  };
  const run = (args: string[], cwd: string) => runFor("https://github.com")(args, cwd);
  const dirFor = opts.checkoutDir ?? ((repoUrl: string) => gitCheckoutDir(opts.cwd, repoUrl));
  return {
    async openPullRequest(input) {
      return {
        number: 0,
        url: `${input.repoUrl}#${input.head}`,
        headSha: "",
        branch: input.head,
        created: true,
      };
    },
    async quality() {
      return {
        state: "failure",
        detail: "git forge has no workflow; set check: command so the runner executes qualityCommand",
      };
    },
    async requestQualityRun() {
      return null;
    },
    async mergeability() {
      return { state: "clean", headSha: "" };
    },
    async updateBranch() {},
    async compare(input): Promise<CompareStatus> {
      const run = runFor(input.repoUrl);
      const cwd = dirFor(input.repoUrl);
      const base = run(["rev-parse", input.base], cwd);
      const head = run(["rev-parse", input.head], cwd);
      const baseSha = base.stdout?.trim() ?? "";
      const headSha = head.stdout?.trim() ?? "";
      if (base.status !== 0 || head.status !== 0 || !baseSha || !headSha) return "unknown";
      if (baseSha === headSha) return "identical";
      const headContainsBase = run(["merge-base", "--is-ancestor", baseSha, headSha], cwd);
      if (headContainsBase.status === 0) return "ahead";
      const baseContainsHead = run(["merge-base", "--is-ancestor", headSha, baseSha], cwd);
      if (baseContainsHead.status === 0) return "behind";
      return "diverged";
    },
    async squashMerge(input) {
      const branch = input.branch?.trim();
      const base = input.base?.trim();
      if (!branch || !base) throw new Error("git merge needs the branch and the trunk");
      if (!input.headSha || !/^[0-9a-f]{40}$/i.test(input.headSha)) {
        throw new Error("refusing to merge without the pull request head sha");
      }
      const run = runFor(input.repoUrl);
      const cwd = dirFor(input.repoUrl);
      const fetch = run(["fetch", "origin", branch], cwd);
      if (fetch.status !== 0) throw new Error(`git fetch failed for ${branch}`);
      const checkout = run(["checkout", base], cwd);
      if (checkout.status !== 0) throw new Error(`git checkout failed for ${base}`);
      const merge = run(["merge", "--no-ff", branch], cwd);
      if (merge.status !== 0) throw new Error(`git merge failed for ${branch}`);
      const rev = run(["rev-parse", "HEAD"], cwd);
      const sha = rev.stdout?.trim() ?? "";
      if (rev.status !== 0 || !sha) throw new Error("git rev-parse failed after merge");
      return sha;
    },
    async dispatch() {
      throw new Error("git forge has no workflow to dispatch; the runner executes commands");
    },
  };
}

export function rejectRawCredential(): void {
  gitForge({ cwd: process.cwd(), credential: { token: "stored" } as CanonicalCredential });
}
