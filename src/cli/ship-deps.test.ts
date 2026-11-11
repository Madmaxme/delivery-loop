import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { shipInvocationDeps } from "./ship-deps.js";
import type { ProjectPack } from "../schema/pack.js";

const pack: ProjectPack = {
  schemaVersion: 2,
  tracker: "linear",
  worker: "cursor",
  githubRepo: "acme/app",
  linearTeam: "APP",
  repos: [{ name: "app", url: "https://github.com/acme/app", trunk: "main" }],
  qualityCommand: "npm test",
  qualityWorkflow: "quality",
  invariantsFile: "invariants.md",
  eligibility: { mode: "none" },
  landingStrategy: "pull-request",
  promotionStages: [],
  status: { intake: "Todo", complete: "Complete" },
  connectors: [],
};

describe("shipInvocationDeps", () => {
  it("uses the tracker for v2 stage state without requiring a worker key", () => {
    const prevCursor = process.env.CURSOR_API_KEY;
    const prevLinear = process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    process.env.LINEAR_API_KEY = "linear-test-key";
    try {
      const deps = shipInvocationDeps(pack, "/tmp");
      assert.equal(deps.worker.kind, "ship-idle");
      assert.equal(deps.tracker.kind, "linear");
    } finally {
      if (prevCursor !== undefined) process.env.CURSOR_API_KEY = prevCursor;
      else delete process.env.CURSOR_API_KEY;
      if (prevLinear !== undefined) process.env.LINEAR_API_KEY = prevLinear;
      else delete process.env.LINEAR_API_KEY;
    }
  });
});
