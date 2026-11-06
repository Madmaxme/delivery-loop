import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ownerHealMarker, shipNoIsWait, shipNoSignature, stallOwner } from "./stall.ts";

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

  it("leaves a second edit of the same no to a person", () => {
    assert.equal(stallOwner({ kind: "ship", healsAlready: 1 }), "person");
    assert.equal(stallOwner({ kind: "conflict", healsAlready: 1 }), "person");
    assert.equal(stallOwner({ kind: "quality", cause: "environment", healsAlready: 1 }), "person");
  });

  it("names the heal in a marker the next page can read", () => {
    assert.equal(ownerHealMarker("install:steps:ship"), "<!-- OWNER_HEAL install:steps:ship -->");
  });

  it("treats a different failure of the same command as a new no", () => {
    const social = shipNoSignature("waiting for build\nmissing required attribute socialMedia");
    const other = shipNoSignature("missing required attribute exportCompliance");
    assert.match(social, /socialMedia/);
    assert.match(other, /exportCompliance/);
    assert.notEqual(social, other);
    assert.equal(shipNoIsWait('GH006: Required status check "quality" is in progress.'), true);
    assert.equal(shipNoIsWait("missing required attribute socialMedia"), false);
    assert.equal(shipNoSignature("ok"), "");
    assert.equal(shipNoSignature("error token abcdefghijklmnopqrstuvwxyz123456"), "error token");
  });
});
