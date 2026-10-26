import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { ForgeAdapter } from "./types.js";

export type GitRun = (args: string[], cwd: string) => { status: number | null };

function defaultGit(args: string[], cwd: string): { status: number | null } {
  return spawnSync("git", args, { cwd, stdio: "inherit" });
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
export function gitForge(opts: {
  cwd: string;
  run?: GitRun;
  checkoutDir?: (repoUrl: string) => string;
}): ForgeAdapter {
  const run = opts.run ?? defaultGit;
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
    async squashMerge(input) {
      const branch = input.branch?.trim();
      const base = input.base?.trim();
      if (!branch || !base) throw new Error("git merge needs the branch and the trunk");
      const cwd = dirFor(input.repoUrl);
      const fetch = run(["fetch", "origin", branch], cwd);
      if (fetch.status !== 0) throw new Error(`git fetch failed for ${branch}`);
      const checkout = run(["checkout", base], cwd);
      if (checkout.status !== 0) throw new Error(`git checkout failed for ${base}`);
      const merge = run(["merge", "--no-ff", branch], cwd);
      if (merge.status !== 0) throw new Error(`git merge failed for ${branch}`);
    },
    async dispatch() {
      throw new Error("git forge has no workflow to dispatch; the runner executes commands");
    },
  };
}
