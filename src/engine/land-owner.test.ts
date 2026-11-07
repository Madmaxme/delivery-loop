import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ownerOnlyLandFailure } from "./loop.ts";

describe("ownerOnlyLandFailure", () => {
  it("uses the HTTP status and ignores spoofed text", () => {
    assert.equal(ownerOnlyLandFailure({ httpStatus: 403, message: "behind" }), true);
    assert.equal(ownerOnlyLandFailure({ httpStatus: 401 }), true);
    assert.equal(
      ownerOnlyLandFailure(new Error("403 forbidden token permission")),
      false,
    );
  });
});
