import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_HEAL_CAP,
  exhaustedFailureType,
  healExhaustedNotice,
  failureTypeForHealKey,
  healCapFor,
  healVerdict,
  ownerHealOutcome,
  shipNoSignature,
  stallOwner,
} from "./stall.ts";

describe("stall", () => {
  it("sorts a no with the existing causes", () => {
    assert.equal(stallOwner({ kind: "quality", cause: "change", healsAlready: 0 }), "change");
    assert.equal(stallOwner({ kind: "quality", cause: "contract", healsAlready: 0 }), "change");
    assert.equal(stallOwner({ kind: "quality", cause: "environment", healsAlready: 0 }), "install");
    assert.equal(stallOwner({ kind: "quality", cause: "flake", healsAlready: 0 }), "wait");
    assert.equal(stallOwner({ kind: "quality", cause: "trunk", healsAlready: 0 }), "wait");
    assert.equal(stallOwner({ kind: "unscheduled", healsAlready: 0 }), "runner");
    assert.equal(stallOwner({ kind: "conflict", healsAlready: 0 }), "runner");
    assert.equal(stallOwner({ kind: "ship", healsAlready: 0 }), "install");
  });

  it("keeps the same owner when the no happens again", () => {
    assert.equal(stallOwner({ kind: "ship", healsAlready: 1 }), "install");
    assert.equal(stallOwner({ kind: "conflict", healsAlready: 1 }), "runner");
    assert.equal(stallOwner({ kind: "quality", cause: "environment", healsAlready: 1 }), "install");
  });

  it("maps owner-edit keys to failure caps", () => {
    assert.equal(failureTypeForHealKey("heal:quality:api:red"), "quality-red");
    assert.equal(failureTypeForHealKey("heal:merge:conflict"), "merge-conflict");
    assert.equal(failureTypeForHealKey("heal:promote:stage-one"), "promote-failed");
    assert.equal(failureTypeForHealKey("install:continue:store"), "ship-failed");
    assert.equal(failureTypeForHealKey("heal:pending:still"), "quality-pending");
    assert.equal(failureTypeForHealKey("heal:unscheduled:none"), "quality-unscheduled");
    assert.equal(failureTypeForHealKey("runner:conflict"), "runner-blocked");
    assert.equal(failureTypeForHealKey("custom:key"), "other");
  });

  it("keeps configured caps and label-based exhaustion", () => {
    assert.equal(healCapFor(undefined, "ship-failed"), DEFAULT_HEAL_CAP);
    assert.equal(healCapFor({ maxAttempts: 5 }, "ship-failed"), 5);
    assert.equal(healCapFor({ maxAttempts: 5, caps: { "ship-failed": 1 } }, "ship-failed"), 1);
    assert.equal(healCapFor({ caps: { "quality-red": 0 } }, "quality-red"), 0);
    assert.equal(exhaustedFailureType({ labels: ["heal-exhausted", "merge-conflict"] }), "merge-conflict");
    assert.equal(exhaustedFailureType({ labels: ["heal-exhausted"] }), "heal-exhausted");
    assert.equal(exhaustedFailureType({ labels: [] }), null);
    assert.equal(exhaustedFailureType({
      markers: [{ kind: "heal-exhausted", body: "promote-failed" }],
    }), "promote-failed");
    assert.equal(
      healExhaustedNotice(
        "promote-failed",
        "qws-gha-workspace cannot read qws/verify/development. Terraform change for infra (not applied): diff",
      ),
      "**Stopped.** promote-failed reached its heal cap. qws-gha-workspace cannot read qws/verify/development. Another page will not start.",
    );
  });


  it("treats a different failure of the same command as a new no", () => {
    const social = shipNoSignature("waiting for build\nmissing required attribute socialMedia");
    const other = shipNoSignature("missing required attribute exportCompliance");
    assert.match(social, /socialMedia/);
    assert.match(other, /exportCompliance/);
    assert.notEqual(social, other);
    assert.equal(shipNoSignature(""), "");
    assert.equal(shipNoSignature("ok"), "ok");
    assert.equal(shipNoSignature("error token abcdefghijklmnopqrstuvwxyz123456"), "error token");
    assert.equal(healVerdict("**Heal:** wait"), "wait");
    assert.equal(healVerdict("**Heal:** login"), "login");
    assert.equal(healVerdict("**Heal:** edit"), "edit");
    assert.throws(() => healVerdict("**Verdict:** BUILDABLE"), /exactly one named/);
  });

  it("fails closed on absent, malformed, or conflicting owner outcomes", () => {
    for (const text of ["", "unknown", "**Heal:** edited", "**Heal:** wait\nHeal: edit", "Heal: wait\nHeal: wait"]) {
      assert.throws(() => healVerdict(text), /exactly one named/);
    }
    for (const verdict of ["edit", "wait", "login"] as const) {
      assert.equal(healVerdict(`Heal: ${verdict}`), verdict);
      assert.equal(healVerdict(`**Heal:** ${verdict}\nA separate explanation.`), verdict);
    }
  });

  it("requires exact committed candidates and never infers an edit from text", () => {
    for (const repoUrl of ["https://example.test/first", "https://another.test/second"]) {
      for (const value of [undefined, "", "**Heal:** edit", { text: "Heal: edit" }, { verdict: "edit" }]) {
        assert.throws(() => ownerHealOutcome(value, repoUrl));
      }
      assert.deepEqual(ownerHealOutcome("Heal: wait", repoUrl), { verdict: "wait" });
      assert.deepEqual(ownerHealOutcome({ verdict: "login" }, repoUrl), { verdict: "login" });
      const candidate = { repoUrl, branch: "repair/T-1", head: "a".repeat(40) };
      assert.deepEqual(ownerHealOutcome({ verdict: "edit", candidate }, repoUrl), { verdict: "edit", candidate });
      assert.throws(() => ownerHealOutcome({ verdict: "edit", candidate: { ...candidate, repoUrl: "foreign" } }, repoUrl), /repositories/);
      assert.throws(() => ownerHealOutcome({ verdict: "edit", candidate: { ...candidate, head: "short" } }, repoUrl), /exact committed/);
      assert.throws(() => ownerHealOutcome({ verdict: "wait", candidate }, repoUrl), /non-edit/);
      assert.throws(() => ownerHealOutcome({ verdict: "wait", branches: [{ repoUrl, branch: candidate.branch }] }, repoUrl), /non-edit/);
      assert.throws(() => ownerHealOutcome({ verdict: "wait", branches: "unknown" }, repoUrl), /Invalid owner branch list/);
      assert.throws(() => ownerHealOutcome({ verdict: "edit", candidate, branches: {} }, repoUrl), /Invalid owner branch list/);
      assert.throws(() => ownerHealOutcome({ verdict: "edit", candidate, head: "b".repeat(40) }, repoUrl), /Conflicting owner heads/);
      assert.throws(() => ownerHealOutcome({ verdict: "edit", candidate, branch: "other" }, repoUrl), /Conflicting owner branches/);
      assert.throws(() => ownerHealOutcome({ verdict: "edit", candidate: { ...candidate, branch: "refs/heads/main" } }, repoUrl), /Invalid owner repair branch/);
      assert.throws(() => ownerHealOutcome({ status: "failed", text: "Heal: wait" }, repoUrl), /not finished/);
      assert.throws(() => ownerHealOutcome({ verdict: "edit", text: "Heal: wait", candidate }, repoUrl), /Conflicting owner heal verdicts/);
    }
  });
});
