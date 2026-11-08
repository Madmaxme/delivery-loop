import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { githubForge } from "../adapters/forge-github.ts";
import { gitForge } from "../adapters/forge-git.ts";
import { linearTracker } from "../adapters/trackers.ts";
import { localForgeTreeReader } from "../schema/trusted-ref.ts";
import { botsPathFromPackYaml, hasLegacyCapability, trustedDecision } from "./trusted-config.ts";

const sha = "a".repeat(40);

function forgeFor(packText: string, inventory = "") {
  return {
    async trunkSha() {
      return sha;
    },
    async readTextFile(input: { path: string; ref: string }) {
      if (input.ref !== sha) return null;
      if (input.path === "delivery-loop.yaml") return packText;
      if (input.path.endsWith("/inventory.yaml")) return inventory;
      return null;
    },
  };
}

const home = `agent:
  url: https://github.com/example/workspace
  trunk: main
`;

const legacyPack = `${home}tracker: linear
worker: cursor
forge: github
repos:
  - name: api
    url: https://github.com/example/api.git
    trunk: main
qualityCommand: npm test
`;

const canonicalPack = `${legacyPack}bots:
  path: bots
`;

const inventory = `specversion: "1.0"
items: []
coverageGaps: []
canonicalPaths: []
`;

describe("trusted credential mode", () => {
  it("keeps legacy when the trusted base has no bots path", async () => {
    const decision = await trustedDecision(legacyPack, forgeFor(legacyPack));
    assert.equal(decision.mode, "legacy");
    assert.equal(decision.proof.trunkSha, sha);
    assert.equal(hasLegacyCapability(decision.legacy), true);
    const tracker = linearTracker({
      legacyKey: "stored-linear",
      legacy: decision.legacy,
      team: "APP",
      intakeState: "Todo",
    });
    assert.equal(tracker.kind, "linear");
    const forge = githubForge({
      legacyToken: "stored-github",
      legacy: decision.legacy,
      repo: "example/api",
    });
    assert.equal(typeof forge.openPullRequest, "function");
  });

  it("builds a git forge without a GitHub credential when the trusted base is legacy", async () => {
    const gitPack = legacyPack.replace("forge: github", "forge: git");
    const decision = await trustedDecision(gitPack, forgeFor(gitPack));
    assert.equal(decision.mode, "legacy");
    const forge = gitForge({ cwd: process.cwd(), mode: "legacy", legacy: decision.legacy });
    assert.equal(typeof forge.compare, "function");
  });

  it("refuses a missing home instead of defaulting the trunk", async () => {
    const pack = legacyPack.replace(/agent:[\s\S]*?trunk: main\n/, "");
    const decision = await trustedDecision(pack, forgeFor(pack));
    assert.equal(decision.mode, "refused");
    assert.equal(decision.proof.trunkSha, null);
  });

  it("refuses a working tree that deletes the trusted bots path", async () => {
    const decision = await trustedDecision(legacyPack, forgeFor(canonicalPack, inventory));
    assert.equal(decision.mode, "refused");
    assert.match(decision.reason, /removed|home/);
  });

  it("uses the trusted inventory when the working tree matches", async () => {
    const decision = await trustedDecision(canonicalPack, forgeFor(canonicalPack, inventory), () => inventory);
    assert.equal(decision.mode, "canonical");
    assert.equal(decision.trunk, "main");
    assert.equal(decision.proof.trunkSha, sha);
    assert.equal(decision.legacy, null);
  });

  it("reads one pinned sha from a canonical checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trusted-home-"));
    const git = (args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: dir,
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
    };
    git(["init", "-b", "main"]);
    writeFileSync(join(dir, "delivery-loop.yaml"), canonicalPack);
    git(["add", "delivery-loop.yaml"]);
    git(["commit", "-m", "base"]);
    git(["remote", "add", "origin", "https://github.com/example/workspace.git"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const decision = await trustedDecision(canonicalPack, localForgeTreeReader(dir), () => inventory);
    assert.equal(decision.mode, "refused");
    assert.match(decision.reason, /inventory/);
    mkdirSync(join(dir, "bots"));
    writeFileSync(join(dir, "bots/inventory.yaml"), inventory);
    git(["add", "bots/inventory.yaml"]);
    git(["commit", "-m", "inventory"]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    const again = await trustedDecision(
      canonicalPack,
      localForgeTreeReader(dir),
      () => inventory,
    );
    assert.equal(again.mode, "canonical");
    assert.match(again.proof.trunkSha ?? "", /^[0-9a-f]{40}$/);
    assert.equal(botsPathFromPackYaml(canonicalPack), "bots");
  });
});
