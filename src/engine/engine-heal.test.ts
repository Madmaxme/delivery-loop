import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  engineHealReleaseSubject,
  isEngineHealPull,
  nextPatchVersion,
  shouldMergeEngineHeal,
} from "./engine-heal.ts";

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
    assert.equal(engineHealReleaseSubject(41), "Bump the patch version after engine heal #41.");
  });
});
