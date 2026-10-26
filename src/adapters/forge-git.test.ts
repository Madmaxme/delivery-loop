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

  it("uses a nested clone when that repo is checked out", () => {
    assert.equal(gitCheckoutDir("/nowhere", "ssh://git.example/acme/api.git"), "/nowhere");
  });
});
