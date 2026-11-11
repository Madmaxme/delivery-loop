import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  engineHealBumpInstruction,
  engineHealMergeArgs,
  engineHealBumpVersion,
  engineHealQualityState,
  engineHealTag,
  highestReleaseVersion,
  isEngineHealPull,
  nextPatchVersion,
  planEngineHealRelease,
  releaseTagExists,
  shouldMergeEngineHeal,
} from "./engine-heal.ts";

const open = {
  pullState: "OPEN" as const,
  tagExists: false,
  branch: "engine-heal/APP-1",
  branchTip: "abc111",
  prNumber: 41,
};

describe("engine heal release", () => {
  it("merges only a green pull request that targets this package", () => {
    const base = {
      event: "pull_request",
      conclusion: "success",
      headRepo: "Madmaxme/delivery-loop",
      baseRepo: "Madmaxme/delivery-loop",
    };
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "engine-heal/APP-1", labels: [] }), true);
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "feature", labels: ["engine-heal"] }), true);
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "cursor/methodology", labels: [] }), false);
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "engine-heal-notes", labels: [] }), false);
    assert.equal(
      shouldMergeEngineHeal({ ...base, conclusion: "failure", branch: "engine-heal/APP-1" }),
      false,
    );
    assert.equal(
      shouldMergeEngineHeal({ ...base, event: "push", branch: "engine-heal/APP-1" }),
      false,
    );
    assert.equal(
      shouldMergeEngineHeal({
        ...base,
        branch: "engine-heal/APP-1",
        headRepo: "other/delivery-loop",
      }),
      false,
    );
    assert.equal(isEngineHealPull({ branch: "engine-heal/APP-1" }), true);
  });

  it("takes the next patch after the highest tag and stops when that tag exists", () => {
    assert.equal(nextPatchVersion("1.0.0"), "1.0.1");
    assert.equal(nextPatchVersion("1.2.9"), "1.2.10");
    assert.throws(() => nextPatchVersion("1.0"), /bad version/);
    assert.equal(highestReleaseVersion(["refs/tags/v1.0.0", "refs/tags/v1.0.0^{}", "refs/tags/v0.9.0"]), "1.0.0");
    assert.equal(engineHealBumpVersion(["v1.0.0"]), "1.0.1");
    assert.equal(engineHealBumpVersion(["refs/tags/v1.0.0", "refs/tags/v1.0.2"]), "1.0.3");
    assert.equal(engineHealTag("1.0.1"), "v1.0.1");
    assert.equal(releaseTagExists("1.0.1", ["refs/tags/v1.0.1"]), true);
    assert.throws(() => engineHealBumpVersion([]), /no release tag/);
    assert.match(engineHealBumpInstruction(["v1.0.0"]), /Set package.json and package-lock.json to 1.0.1/);
    assert.match(engineHealBumpInstruction(), /v1\.0\.0 becomes 1\.0\.1/);
  });

  it("comments when the pull request has no bump and does not push one", () => {
    const missing = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.0",
    });
    assert.equal(missing.action, "comment");
    if (missing.action !== "comment") return;
    assert.match(missing.body, /does not bump package.json/);
    assert.match(missing.body, /does not push a commit/);
  });

  it("comments when the bumped version is already tagged", () => {
    const collision = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      tagExists: true,
    });
    assert.equal(collision.action, "comment");
    if (collision.action !== "comment") return;
    assert.match(collision.body, /Tag v1\.0\.1 already exists/);
  });

  it("waits for pull_request quality on the bumped tip and does not merge before that", () => {
    const waiting = planEngineHealRelease({
      ...open,
      qualityOnTip: "none",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: "def222",
    });
    assert.deepEqual(waiting, { action: "wait-for-quality", branch: "engine-heal/APP-1", sha: "def222" });
    const pending = planEngineHealRelease({
      ...open,
      qualityOnTip: "pending",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: "def222",
    });
    assert.equal(pending.action, "wait-for-quality");
    const failed = planEngineHealRelease({
      ...open,
      qualityOnTip: "failure",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
    });
    assert.equal(failed.action, "fail");
  });

  it("pins the squash merge to the green head sha", () => {
    const sha = "a".repeat(40);
    assert.deepEqual(engineHealMergeArgs("acme/loop", 4, sha), [
      "pr",
      "merge",
      "4",
      "--repo",
      "acme/loop",
      "--squash",
      "--match-head-commit",
      sha,
      "--delete-branch",
    ]);
    assert.throws(() => engineHealMergeArgs("acme/loop", 4, "def222"), /head sha/);
  });

  it("squash-merges only when the bumped tip is green, then tags that version", () => {
    const merge = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: "def222",
    });
    assert.deepEqual(merge, { action: "merge-and-tag", version: "1.0.1", tag: "v1.0.1" });
    const behind = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.2",
      tipVersion: "1.0.1",
    });
    assert.equal(behind.action, "comment");
  });

  it("accepts the planned breaking 2.0.0 release while routine bumps stay patch-only", () => {
    assert.equal(engineHealBumpVersion(["v1.0.17"]), "1.0.18");
    const release = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.17",
      tipVersion: "2.0.0",
      branchTip: "def222",
    });
    assert.deepEqual(release, { action: "merge-and-tag", version: "2.0.0", tag: "v2.0.0" });
  });

  it("tags a merged pull request and does not open another bump", () => {
    const tag = planEngineHealRelease({
      ...open,
      pullState: "MERGED",
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
    });
    assert.deepEqual(tag, { action: "tag-merged", version: "1.0.1", tag: "v1.0.1" });
    const done = planEngineHealRelease({
      ...open,
      pullState: "MERGED",
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      tagExists: true,
    });
    assert.equal(done.action, "skip");
    const closed = planEngineHealRelease({
      ...open,
      pullState: "CLOSED",
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.0",
    });
    assert.equal(closed.action, "skip");
  });

  it("does not push a commit", () => {
    const script = readFileSync(new URL("../../scripts/engine-heal.ts", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../../.github/workflows/engine-heal.yml", import.meta.url), "utf8");
    assert.equal(script.includes("HEAD:main"), false);
    assert.equal(script.includes("npm version"), false);
    assert.equal(script.includes("workflow_dispatch"), false);
    assert.equal(workflow.includes("workflow_dispatch"), false);
    assert.match(script, /refs\/tags\//);
    assert.match(script, /pr", "comment"/);
    assert.match(script, /event === "pull_request"/);
  });

  it("reads the quality check on the tip", () => {
    assert.equal(engineHealQualityState([]), "none");
    assert.equal(engineHealQualityState([{ status: "completed", conclusion: "success" }]), "success");
    assert.equal(
      engineHealQualityState([
        { status: "completed", conclusion: "failure" },
        { status: "completed", conclusion: "success" },
      ]),
      "success",
    );
    assert.equal(engineHealQualityState([{ status: "in_progress", conclusion: "" }]), "pending");
    assert.equal(engineHealQualityState([{ status: "action_required", conclusion: "" }]), "pending");
    assert.equal(engineHealQualityState([{ status: "completed", conclusion: "failure" }]), "failure");
  });
});
