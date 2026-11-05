import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ownerHealMarker, stallOwner } from "./stall.ts";

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
});
