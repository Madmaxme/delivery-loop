import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
      status: { intake: "todo", dev: "Dev", prod: "Prod" },
      connectors: [],
      workerHttp: { startUrl: "https://host/start", statusUrl: "https://host/status" },
    });
    const before = readFileSync(join(dir, "delivery-loop.yaml"), "utf8");
    const invariants = readFileSync(join(dir, "invariants.md"), "utf8");
    assert.match(readFileSync(join(dir, ".cursor/skills/conduct/SKILL.md"), "utf8"), /One code path/);
    assert.match(readFileSync(join(dir, ".cursor/skills/methodology/SKILL.md"), "utf8"), /master copy/);
    assert.match(readFileSync(join(dir, ".cursor/rules/delivery-loop.mdc"), "utf8"), /engine is the only status writer/);
    const workflow = readFileSync(join(dir, ".github/workflows/delivery-loop.yml"), "utf8");
    const version = (
      JSON.parse(
        readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
      ) as { version: string }
    ).version;
    assert.match(workflow, /workflow_dispatch/);
    assert.doesNotMatch(workflow, /DELIVERY_LOOP_DEPLOY_KEY/);
    assert.match(workflow, new RegExp(`--branch v${version.replaceAll(".", "\\.")}`));
    assert.match(workflow, /https:\/\/github.com\/Madmaxme\/delivery-loop.git/);
    assert.doesNotMatch(workflow, /__DELIVERY_LOOP_REF__/);
    assert.match(workflow, /LINEAR_API_KEY/);
    assert.match(workflow, /unset LINEAR_API_KEY/);
    assert.match(workflow, /botsPathFromPackYaml/);
    assert.doesNotMatch(workflow, /awk /);
    assert.match(workflow, /LINEAR_OAUTH_CLIENT_ID/);
    assert.match(workflow, /LINEAR_OAUTH_CLIENT_SECRET/);
    assert.match(workflow, /npm install --omit=dev/);
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
