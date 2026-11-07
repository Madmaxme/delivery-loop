import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  engineHealBranchRef,
  engineHealNextVersion,
  engineHealQualityState,
  engineHealReleaseBody,
  engineHealReleaseSubject,
  engineHealTag,
  isEngineHealPull,
  nextPatchVersion,
  planEngineHealRelease,
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

  it("bumps only the patch and names the release commit after the pull request", () => {
    assert.equal(nextPatchVersion("1.0.0"), "1.0.1");
    assert.equal(nextPatchVersion("1.2.9"), "1.2.10");
    assert.throws(() => nextPatchVersion("1.0"), /bad version/);
    assert.equal(engineHealNextVersion("1.0.0", "1.0.0"), "1.0.1");
    assert.equal(engineHealNextVersion("1.0.9", "1.0.10"), "1.0.11");
    assert.equal(engineHealTag("1.0.1"), "v1.0.1");
    assert.equal(engineHealReleaseSubject(41), "Bump the patch version after engine heal #41.");
    assert.match(engineHealReleaseBody(41, "1.0.0", "1.0.1"), /sets 1\.0\.1 on the pull request/);
    assert.match(engineHealReleaseBody(41, "1.0.0", "1.0.1"), /No commit is pushed to main/);
  });

  it("commits the first patch after v1.0.0 on the pull request, then tags the merge", () => {
    const bump = planEngineHealRelease({
      ...open,
      bumpOnBranch: false,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.0",
    });
    assert.equal(bump.action, "bump-branch");
    if (bump.action !== "bump-branch") return;
    assert.equal(bump.version, "1.0.1");
    assert.equal(bump.branchRef, "refs/heads/engine-heal/APP-1");
    assert.equal(engineHealTag(bump.version), "v1.0.1");
  });

  it("refuses a commit ref on main", () => {
    assert.throws(() => engineHealBranchRef("main"), /must not push a commit to main/);
    assert.throws(() => engineHealBranchRef("refs/heads/main"), /must not push a commit to main/);
    assert.equal(engineHealBranchRef("engine-heal/APP-1"), "refs/heads/engine-heal/APP-1");
  });

  it("waits for quality on the bumped tip and does not merge before that", () => {
    const waiting = planEngineHealRelease({
      ...open,
      bumpOnBranch: true,
      qualityOnTip: "none",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: "def222",
    });
    assert.deepEqual(waiting, { action: "wait-for-quality", branch: "engine-heal/APP-1", sha: "def222" });
    const pending = planEngineHealRelease({
      ...open,
      bumpOnBranch: true,
      qualityOnTip: "pending",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: "def222",
    });
    assert.equal(pending.action, "wait-for-quality");
    const failed = planEngineHealRelease({
      ...open,
      bumpOnBranch: true,
      qualityOnTip: "failure",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
    });
    assert.equal(failed.action, "fail");
  });

  it("squash-merges only when the bumped tip is green, then tags that version", () => {
    const merge = planEngineHealRelease({
      ...open,
      bumpOnBranch: true,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: "def222",
    });
    assert.deepEqual(merge, { action: "merge-and-tag", version: "1.0.1", tag: "v1.0.1" });
    const same = planEngineHealRelease({
      ...open,
      bumpOnBranch: true,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.0",
    });
    assert.equal(same.action, "fail");
  });

  it("tags a merged pull request and does not open another bump", () => {
    const tag = planEngineHealRelease({
      ...open,
      pullState: "MERGED",
      bumpOnBranch: true,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
    });
    assert.deepEqual(tag, { action: "tag-merged", version: "1.0.1", tag: "v1.0.1" });
    const done = planEngineHealRelease({
      ...open,
      pullState: "MERGED",
      bumpOnBranch: true,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      tagExists: true,
    });
    assert.equal(done.action, "skip");
    const closed = planEngineHealRelease({
      ...open,
      pullState: "CLOSED",
      bumpOnBranch: false,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.0",
    });
    assert.equal(closed.action, "skip");
  });

  it("does not push a commit to main", () => {
    const script = readFileSync(new URL("../../scripts/engine-heal.ts", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../../.github/workflows/engine-heal.yml", import.meta.url), "utf8");
    assert.equal(script.includes("HEAD:main"), false);
    assert.equal(workflow.includes("HEAD:main"), false);
    assert.match(script, /HEAD:\$\{plan\.branchRef\}/);
    assert.match(script, /refs\/tags\//);
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
