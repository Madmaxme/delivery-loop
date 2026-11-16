import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Read } from "./read.ts";

describe("read", () => {
  it("returns the owner's value", () => {
    const read = Read.required("status.hold", " Shaping ");
    assert.equal(read.owner, "status.hold");
    assert.equal(read.value, "Shaping");
  });

  it("stops when the owner returned nothing", () => {
    assert.throws(() => Read.required("status.hold", "  "), /status\.hold returned nothing/);
    assert.throws(() => Read.required("status.hold", null), /status\.hold returned nothing/);
  });
});
