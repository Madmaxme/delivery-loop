import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { commitActorsFromTrustedRef } from "./main.ts";
import type { ProjectPack } from "../schema/pack.ts";

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  assert.equal(result.status, 0, result.stderr);
}

describe("commitActorsFromTrustedRef", () => {
  it("reads the pinned trunk file through the forge and ignores the checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-actors-"));
    git(dir, ["init", "-b", "main"]);
    writeFileSync(join(dir, "delivery-loop.yaml"), "commitActors:\n  - login: git-owner\n");
    git(dir, ["add", "delivery-loop.yaml"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeFileSync(join(dir, "delivery-loop.yaml"), "commitActors:\n  - login: attacker\n");
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const actors = await commitActorsFromTrustedRef(
        {
          agent: { url: "https://github.com/acme/loop", trunk: "release" },
          repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main" }],
          commitActors: [],
        } as ProjectPack,
        {
          async trunkSha(input) {
            assert.equal(input.repoUrl, "https://github.com/acme/loop");
            assert.equal(input.trunk, "release");
            return "b".repeat(40);
          },
          async readTextFile(input) {
            assert.equal(input.ref, "b".repeat(40));
            assert.equal(input.path, "delivery-loop.yaml");
            return "commitActors:\n  - login: forge-owner\n";
          },
        },
      );
      assert.equal(actors?.[0]?.login, "forge-owner");
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses a missing workspace home instead of defaulting to main", async () => {
    await assert.rejects(
      () =>
        commitActorsFromTrustedRef(
          {
            repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main" }],
          } as ProjectPack,
          {
            async trunkSha() {
              throw new Error("trunk was read");
            },
            async readTextFile() {
              throw new Error("file was read");
            },
          },
        ),
      /workspace trunk/,
    );
  });
});
