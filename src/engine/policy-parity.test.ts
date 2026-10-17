import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  evaluateGraphReady,
  interpretQualityActions,
  latestDeliveryLeaseStamp,
  shouldStealDeliveryLease,
  shouldStopForPageReserve,
  pageBudgetRemainingMs,
  isSweepIntakeState,
} from "./linear-harness-policy.ts";

describe("ported policy", () => {
  it("keeps Todo as the only intake state", () => {
    assert.equal(isSweepIntakeState("Todo"), true);
    assert.equal(isSweepIntakeState("In Progress"), false);
  });

  it("accepts a pack's dev and prod states as unblocking", () => {
    const blocked = evaluateGraphReady(
      "APP-1",
      [{ identifier: "APP-2", stateName: "Shipped" }],
      ["Shipped", "Live", "Canceled", "Duplicate"],
    );
    assert.equal(blocked.ready, true);
    const waiting = evaluateGraphReady(
      "APP-1",
      [{ identifier: "APP-2", stateName: "Todo" }],
      ["Shipped", "Live", "Canceled", "Duplicate"],
    );
    assert.equal(waiting.ready, false);
  });

  it("counts only the quality workflow", () => {
    const result = interpretQualityActions(
      [
        {
          name: "lint",
          status: "completed",
          conclusion: "success",
          headSha: "abc",
          url: "https://example.test/lint",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      "abc",
    );
    assert.equal(result.state, "pending");
  });

  it("steals an expired lease and keeps a live one", () => {
    const body = "<!-- DELIVERY_LEASE expires=2026-01-01T00:00:00.000Z cursor_run=run-1 cursor_phase=ground -->";
    const stamp = latestDeliveryLeaseStamp([body]);
    assert.equal(stamp.expiresAt, Date.parse("2026-01-01T00:00:00.000Z"));
    assert.equal(stamp.cursorRunId, "run-1");
    assert.equal(
      shouldStealDeliveryLease({
        hasLeaseLabel: true,
        expiresAt: stamp.expiresAt,
        nowMs: Date.parse("2025-12-01T00:00:00.000Z"),
        previousGhaRunActive: true,
      }),
      false,
    );
    assert.equal(
      shouldStealDeliveryLease({
        hasLeaseLabel: true,
        expiresAt: stamp.expiresAt,
        nowMs: Date.parse("2026-02-01T00:00:00.000Z"),
        previousGhaRunActive: true,
      }),
      true,
    );
  });

  it("stops a page inside the reserve window", () => {
    const started = 0;
    const remaining = pageBudgetRemainingMs({
      nowMs: (360 - 10) * 60 * 1000,
      startedAtMs: started,
    });
    assert.equal(shouldStopForPageReserve({ remainingMs: remaining }), true);
  });
});
