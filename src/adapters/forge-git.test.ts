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
        return { status: 0 };
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
    await forge.squashMerge({
      repoUrl: "ssh://git.example/acme/api.git",
      number: pr.number,
      branch: "cursor/api-1-api",
      base: "main",
    });
    assert.deepEqual(calls, [
      ["fetch", "origin", "cursor/api-1-api"],
      ["checkout", "main"],
      ["merge", "--no-ff", "cursor/api-1-api"],
    ]);
  });

  it("uses a nested clone when that repo is checked out", () => {
    assert.equal(gitCheckoutDir("/nowhere", "ssh://git.example/acme/api.git"), "/nowhere");
  });
});
