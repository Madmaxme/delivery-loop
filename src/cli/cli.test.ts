import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { installConnector, update, writeProject } from "./main.ts";
import { loadPack } from "../schema/pack.ts";

describe("installer", () => {
  it("writes a project, refreshes skills, and leaves the pack in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-"));
    writeProject(dir, {
      tracker: "github",
      worker: "http",
      githubRepo: "acme/api",
      repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main", packages: ["packages/api"] }],
      qualityCommand: "npm test",
      qualityWorkflow: "quality",
      invariantsFile: "invariants.md",
      status: { intake: "todo", dev: "Deployed to Dev", prod: "Deployed to Prod" },
      connectors: [],
      workerHttp: { startUrl: "https://host/start", statusUrl: "https://host/status" },
    });
    const before = readFileSync(join(dir, "delivery-loop.yaml"), "utf8");
    const invariants = readFileSync(join(dir, "invariants.md"), "utf8");
    assert.match(readFileSync(join(dir, ".cursor/skills/conduct/SKILL.md"), "utf8"), /One code path/);
    assert.match(readFileSync(join(dir, ".github/workflows/delivery-loop.yml"), "utf8"), /workflow_dispatch/);
    update(["--dir", dir]);
    assert.equal(readFileSync(join(dir, "delivery-loop.yaml"), "utf8"), before);
    assert.equal(readFileSync(join(dir, "invariants.md"), "utf8"), invariants);
    installConnector(dir, "sentry");
    assert.deepEqual(loadPack(join(dir, "delivery-loop.yaml")).connectors, ["sentry"]);
    assert.match(readFileSync(join(dir, ".cursor/mcp.json"), "utf8"), /sentry/);
    assert.match(readFileSync(join(dir, ".cursor/skills/sentry/SKILL.md"), "utf8"), /Sentry/);
    assert.equal(readFileSync(join(dir, "invariants.md"), "utf8"), invariants);
  });
});
