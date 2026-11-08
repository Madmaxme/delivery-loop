import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { credentialSecret, probeLinearViewer } from "../adapters/canonical-path.ts";
import { healthFetch, issue, linearPath } from "../testing/canonical-fixtures.ts";
import { shipInvocationDeps } from "./ship-deps.js";
import type { ProjectPack } from "../schema/pack.js";

function pack(markStatus: boolean): ProjectPack {
  return {
    tracker: "linear",
    worker: "cursor",
    githubRepo: "acme/app",
    linearTeam: "APP",
    status: { intake: "Todo", prod: "Prod", dev: "Dev", blocked: "Blocked" },
    ship: { steps: ["true"], markStatus },
  } as ProjectPack;
}

describe("shipInvocationDeps", () => {
  it("does not require a worker API key when the pack owns prod status", () => {
    const prev = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    try {
      const deps = shipInvocationDeps(pack(false), "/tmp");
      assert.equal(deps.worker.kind, "ship-idle");
      assert.equal(deps.tracker.kind, "ship-idle");
    } finally {
      if (prev !== undefined) process.env.CURSOR_API_KEY = prev;
    }
  });

  it("still skips the worker when the CLI must set prod status", async () => {
    const prevCursor = process.env.CURSOR_API_KEY;
    const prevGh = process.env.GH_TOKEN;
    const prevLinear = process.env.LINEAR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    process.env.GH_TOKEN = "stored-github";
    process.env.LINEAR_API_KEY = "stored-linear";
    try {
      const legacy = shipInvocationDeps(pack(true), "/tmp");
      assert.equal(legacy.tracker.kind, "linear");
      const minted = issue(linearPath, "minted-linear", { LINEAR_API_KEY: "stored-linear" });
      const deps = shipInvocationDeps(pack(true), "/tmp", { enforced: true, linear: minted, extensions: {}, aws: {}, actors: [] });
      assert.equal(deps.worker.kind, "ship-idle");
      assert.equal(deps.tracker.kind, "linear");
      await probeLinearViewer(minted, healthFetch);
      assert.notEqual(
        credentialSecret(minted, { api: "linear", operation: "graphql", destination: "https://api.linear.app" }),
        "stored-linear",
      );
    } finally {
      if (prevCursor !== undefined) process.env.CURSOR_API_KEY = prevCursor;
      else delete process.env.CURSOR_API_KEY;
      if (prevGh !== undefined) process.env.GH_TOKEN = prevGh;
      else delete process.env.GH_TOKEN;
      if (prevLinear !== undefined) process.env.LINEAR_API_KEY = prevLinear;
      else delete process.env.LINEAR_API_KEY;
    }
  });
});
