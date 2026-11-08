import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decideCredentialMode } from "./trusted-config.ts";
import { githubForge } from "../adapters/forge-github.ts";
import { gitForge } from "../adapters/forge-git.ts";
import { linearTracker } from "../adapters/trackers.ts";

const legacyPack = `tracker: linear
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
  it("keeps legacy when the trusted base has no bots path", () => {
    const decision = decideCredentialMode({
      workPackYaml: legacyPack,
      trustedPackYaml: legacyPack,
      workInventoryYaml: null,
      trustedInventoryYaml: null,
    });
    assert.equal(decision.mode, "legacy");
    const tracker = linearTracker({ legacyKey: "stored-linear", team: "APP", intakeState: "Todo" });
    assert.equal(tracker.kind, "linear");
    const forge = githubForge({ legacyToken: "stored-github", repo: "example/api" });
    assert.equal(typeof forge.openPullRequest, "function");
  });

  it("builds a git forge without a GitHub credential when the trusted base is legacy", () => {
    const gitPack = legacyPack.replace("forge: github", "forge: git");
    const decision = decideCredentialMode({
      workPackYaml: gitPack,
      trustedPackYaml: gitPack,
      workInventoryYaml: null,
      trustedInventoryYaml: null,
    });
    assert.equal(decision.mode, "legacy");
    const forge = gitForge({ cwd: process.cwd(), mode: "legacy" });
    assert.equal(typeof forge.compare, "function");
  });

  it("refuses a working tree that deletes the trusted bots path", () => {
    const decision = decideCredentialMode({
      workPackYaml: legacyPack,
      trustedPackYaml: canonicalPack,
      workInventoryYaml: null,
      trustedInventoryYaml: inventory,
    });
    assert.equal(decision.mode, "refused");
    assert.match(decision.reason, /removed/);
  });

  it("uses the trusted inventory when the working tree matches", () => {
    const decision = decideCredentialMode({
      workPackYaml: canonicalPack,
      trustedPackYaml: canonicalPack,
      workInventoryYaml: inventory,
      trustedInventoryYaml: inventory,
    });
    assert.equal(decision.mode, "canonical");
    assert.equal(decision.trunk, "main");
  });

  it("does not take the trunk from the first repo", () => {
    const pack = legacyPack.replace("trunk: main", "trunk: develop");
    const decision = decideCredentialMode({
      workPackYaml: pack,
      trustedPackYaml: pack,
      workInventoryYaml: null,
      trustedInventoryYaml: null,
    });
    assert.equal(decision.mode, "legacy");
    assert.equal(decision.trunk, "main");
  });
});
