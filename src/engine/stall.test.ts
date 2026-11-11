import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_HEAL_CAP,
  exhaustedFailureType,
  failureTypeForHealKey,
  healCapFor,
  healVerdict,
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
    assert.equal(healVerdict("**Verdict:** BUILDABLE"), "edit");
  });
});
