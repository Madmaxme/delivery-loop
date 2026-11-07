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
  it("reads the trunk file and ignores the working tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "commit-actors-"));
    git(dir, ["init", "-b", "main"]);
    writeFileSync(
      join(dir, "delivery-loop.yaml"),
      "commitActors:\n  - login: owner\n",
    );
    git(dir, ["add", "delivery-loop.yaml"]);
    git(dir, ["commit", "-m", "base"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    writeFileSync(
      join(dir, "delivery-loop.yaml"),
      "commitActors:\n  - login: attacker\n",
    );
    const previous = process.cwd();
    process.chdir(dir);
    try {
      const actors = commitActorsFromTrustedRef({
        agent: { url: "https://github.com/acme/loop", trunk: "main" },
        commitActors: [],
      } as ProjectPack);
      assert.equal(actors?.[0]?.login, "owner");
    } finally {
      process.chdir(previous);
    }
  });
});
