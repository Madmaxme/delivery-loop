import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseOutcomeLines,
  shipExitCode,
  shipSummaryLines,
  transientReason,
  transientWaitMs,
  TRANSIENT_EXIT,
} from "./step-outcome.ts";

describe("ship outcomes", () => {
  it("keeps the last outcome line for each ticket", () => {
    const rows = parseOutcomeLines(
      [
        "delivery-loop outcome API-1 PARKED store gate",
        "noise",
        "delivery-loop outcome API-2 BLOCKED missing tip",
        "delivery-loop outcome API-1 COMPLETE",
      ].join("\n"),
    );
    assert.deepEqual(rows, [
      { ticket: "API-1", outcome: "COMPLETE", reason: "" },
      { ticket: "API-2", outcome: "BLOCKED", reason: "missing tip" },
    ]);
  });

  it("exits 0 only when every ticket is COMPLETE", () => {
    const complete = [{ ticket: "API-1", outcome: "COMPLETE" as const, reason: "" }];
    const parked = [{ ticket: "API-1", outcome: "PARKED" as const, reason: "store gate" }];
    const mixed = [
      ...complete,
      { ticket: "API-2", outcome: "PARKED" as const, reason: "store gate" },
    ];
    const blocked = [{ ticket: "API-1", outcome: "BLOCKED" as const, reason: "missing tip" }];
    assert.equal(shipExitCode(complete, false), 0);
    assert.equal(shipExitCode([], false), 0);
    assert.equal(shipExitCode(parked, false), 2);
    assert.equal(shipExitCode(mixed, false), 2);
    assert.equal(shipExitCode(parked, true), 0);
    assert.equal(shipExitCode(blocked, true), 1);
    assert.deepEqual(shipSummaryLines(parked), [
      "ship outcome API-1 PARKED store gate",
      "ship outcomes complete=0 parked=1 blocked=0",
    ]);
  });

  it("treats exit 75 and a transient line as a wait, and a zero exit as done", () => {
    assert.equal(transientReason(0, "delivery-loop transient rate limit"), null);
    assert.equal(transientReason(TRANSIENT_EXIT, ""), "exit 75");
    assert.equal(
      transientReason(1, "delivery-loop transient registry download\n"),
      "registry download",
    );
    assert.equal(transientReason(1, "missing required attribute"), null);
  });

  it("waits one second, then doubles, and stops at the attempt count or the total wait", () => {
    const budget = { maxAttempts: 3, maxWaitMs: 60_000 };
    assert.equal(transientWaitMs({ completedAttempts: 1, spentMs: 0, ...budget }), 1000);
    assert.equal(transientWaitMs({ completedAttempts: 2, spentMs: 1000, ...budget }), 2000);
    assert.equal(transientWaitMs({ completedAttempts: 3, spentMs: 3000, ...budget }), null);
    assert.equal(
      transientWaitMs({ completedAttempts: 1, spentMs: 0, maxAttempts: 4, maxWaitMs: 1500 }),
      1000,
    );
    assert.equal(
      transientWaitMs({ completedAttempts: 2, spentMs: 1000, maxAttempts: 4, maxWaitMs: 1500 }),
      500,
    );
    assert.equal(
      transientWaitMs({ completedAttempts: 2, spentMs: 1500, maxAttempts: 4, maxWaitMs: 1500 }),
      null,
    );
  });
});
