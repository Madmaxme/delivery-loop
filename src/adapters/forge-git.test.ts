import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { gitCheckoutDir, gitForge } from "./forge-git.ts";

describe("git forge", () => {
  it("merges the branch with git and does not call a pull request API", async () => {
    const calls: string[][] = [];
    const forge = gitForge({
      cwd: "/work",
      checkoutDir: () => "/work/api",
      run: (args) => {
        calls.push(args);
        return { status: 0, stdout: args[0] === "rev-parse" ? "abc1234\n" : "" };
      },
    });
    const pr = await forge.openPullRequest({
      repoUrl: "ssh://git.example/acme/api.git",
      title: "API-1",
      body: "",
      head: "cursor/api-1-api",
      base: "main",
    });
    assert.equal(pr.url, "ssh://git.example/acme/api.git#cursor/api-1-api");
    const sha = await forge.squashMerge({
      repoUrl: "ssh://git.example/acme/api.git",
      number: pr.number,
      branch: "cursor/api-1-api",
      base: "main",
    });
    assert.equal(sha, "abc1234");
    assert.deepEqual(calls, [
      ["fetch", "origin", "cursor/api-1-api"],
      ["checkout", "main"],
      ["merge", "--no-ff", "cursor/api-1-api"],
      ["rev-parse", "HEAD"],
    ]);
  });

  it("reads ahead, behind, identical, and diverged from git", async () => {
    const answers = new Map<string, { status: number; stdout: string }>([
      ["rev-parse main", { status: 0, stdout: "base\n" }],
      ["rev-parse feature", { status: 0, stdout: "head\n" }],
      ["merge-base --is-ancestor base head", { status: 0, stdout: "" }],
    ]);
    const forge = gitForge({
      cwd: "/work",
      checkoutDir: () => "/work",
      run: (args) => answers.get(args.join(" ")) ?? { status: 1, stdout: "" },
    });
    assert.equal(
      await forge.compare({ repoUrl: "ssh://git.example/acme/api.git", base: "main", head: "feature" }),
      "ahead",
    );
    answers.set("merge-base --is-ancestor base head", { status: 1, stdout: "" });
    answers.set("merge-base --is-ancestor head base", { status: 0, stdout: "" });
    assert.equal(
      await forge.compare({ repoUrl: "ssh://git.example/acme/api.git", base: "main", head: "feature" }),
      "behind",
    );
    answers.set("rev-parse feature", { status: 0, stdout: "base\n" });
    assert.equal(
      await forge.compare({ repoUrl: "ssh://git.example/acme/api.git", base: "main", head: "feature" }),
      "identical",
    );
  });

  it("lands only the expected fast-forward head with an atomic base lease", async () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const calls: string[][] = [];
    const forge = gitForge({
      cwd: "/work",
      checkoutDir: () => "/work/api",
      run: (args) => {
        calls.push(args);
        if (args[0] === "rev-parse") {
          return { status: 0, stdout: args[1]?.includes("/feature") ? `${headSha}\n` : `${baseSha}\n` };
        }
        return { status: 0, stdout: "" };
      },
    });
    assert.equal(
      await forge.directLand({
        repoUrl: "https://github.com/acme/api",
        branch: "feature",
        base: "main",
        expectedHeadSha: headSha,
        expectedBaseSha: baseSha,
      }),
      headSha,
    );
    assert.deepEqual(calls.at(-1), [
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/main:${baseSha}`,
      "origin",
      `${headSha}:refs/heads/main`,
    ]);
  });

  it("does not push stale source/target, divergent, or concurrently changed refs", async () => {
    const headSha = "a".repeat(40);
    const baseSha = "b".repeat(40);
    const changedBaseSha = "c".repeat(40);
    const calls: string[][] = [];
    let remoteHeadSha = headSha;
    let remoteBaseSha = changedBaseSha;
    let ancestor = true;
    let pushStatus = 0;
    const forge = gitForge({
      cwd: "/work",
      checkoutDir: () => "/work/api",
      run: (args) => {
        calls.push(args);
        if (args[0] === "rev-parse") {
          return {
            status: 0,
            stdout: args[1]?.includes("/feature") ? `${remoteHeadSha}\n` : `${remoteBaseSha}\n`,
          };
        }
        if (args[0] === "merge-base") return { status: ancestor ? 0 : 1, stdout: "" };
        if (args[0] === "push") return { status: pushStatus, stdout: "" };
        return { status: 0, stdout: "" };
      },
    });
    const input = {
      repoUrl: "https://github.com/acme/api",
      branch: "feature",
      base: "main",
      expectedHeadSha: headSha,
      expectedBaseSha: baseSha,
    };
    await assert.rejects(forge.directLand(input), /target branch main no longer matches expected base/);
    assert.equal(calls.some((args) => args[0] === "push"), false);
    remoteBaseSha = baseSha;
    remoteHeadSha = "c".repeat(40);
    await assert.rejects(forge.directLand(input), /source branch feature no longer matches expected head/);
    assert.equal(calls.some((args) => args[0] === "push"), false);
    remoteHeadSha = headSha;
    ancestor = false;
    await assert.rejects(forge.directLand(input), /not a fast-forward/);
    assert.equal(calls.some((args) => args[0] === "push"), false);
    ancestor = true;
    pushStatus = 1;
    await assert.rejects(forge.directLand(input), /expected base may have changed/);
    assert.deepEqual(calls.at(-1)?.slice(0, 3), [
      "push",
      "--porcelain",
      `--force-with-lease=refs/heads/main:${baseSha}`,
    ]);
  });

  it("uses a nested clone when that repo is checked out", () => {
    assert.equal(gitCheckoutDir("/nowhere", "ssh://git.example/acme/api.git"), "/nowhere");
  });
});
