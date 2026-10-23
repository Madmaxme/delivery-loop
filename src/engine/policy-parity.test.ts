import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { holdStatus, unblockingStates, type ProjectPack } from "../schema/pack.ts";
import {
  evaluateGraphReady,
  formatGroundingCommentSample,
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
    const pack = { status: { intake: "Todo", dev: "Dev", prod: "Prod", hold: "Waiting" } } as ProjectPack;
    assert.equal(holdStatus(pack), "Waiting");
    assert.equal(unblockingStates(pack).includes("Waiting"), false);
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

  it("lets a later release supersede a longer lease", () => {
    const stamp = latestDeliveryLeaseStamp([
      "<!-- DELIVERY_LEASE expires=2026-06-01T00:00:00.000Z cursor_run=run-1 cursor_phase=ground -->",
      "<!-- DELIVERY_LEASE released=1 -->",
    ]);
    assert.equal(stamp.expiresAt, null);
  });

  it("stops a page inside the reserve window", () => {
    const started = 0;
    const remaining = pageBudgetRemainingMs({
      nowMs: (360 - 10) * 60 * 1000,
      startedAtMs: started,
    });
    assert.equal(shouldStopForPageReserve({ remainingMs: remaining }), true);
  });

  it("labels comments older than the latest handoff as historical", () => {
    const sample = formatGroundingCommentSample([
      { createdAt: "2025-12-01T00:00:00Z", body: "OLD PACKET" },
      { createdAt: "2026-01-01T00:00:00Z", body: "**Codebase audit:** BUILDABLE" },
      { createdAt: "2026-02-01T00:00:00Z", body: "A later note" },
    ]);
    assert.match(sample, /\[HISTORICAL\] 2025-12-01/);
    assert.match(sample, /\[CURRENT\] 2026-01-01/);
    assert.match(sample, /\[CURRENT\] 2026-02-01/);
    assert.match(sample, /Do not reuse those work orders/);
  });
});
