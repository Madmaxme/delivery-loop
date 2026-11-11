import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { failForPolicyErrors, init, installConnector, update, writeProject } from "./main.ts";
import { loadPack } from "../schema/pack.ts";

describe("installer", () => {
  it("writes a project, refreshes skills, and leaves the pack in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-"));
    writeProject(dir, {
      schemaVersion: 2,
      tracker: "github",
      worker: "http",
      githubRepo: "acme/api",
      repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main", packages: ["packages/api"] }],
      qualityCommand: "npm test",
      qualityWorkflow: "quality",
      invariantsFile: "invariants.md",
      eligibility: { mode: "none" },
      landingStrategy: "pull-request",
      promotionStages: [],
      status: { intake: "todo", complete: "Dev Complete" },
      connectors: [],
      workerHttp: { startUrl: "https://host/start", statusUrl: "https://host/status" },
    });
    const before = readFileSync(join(dir, "delivery-loop.yaml"), "utf8");
    const invariants = readFileSync(join(dir, "invariants.md"), "utf8");
    const canonical = join(dir, ".agents/skills");
    const methodSkill = join(canonical, "delivery-loop/SKILL.md");
    const conductSkill = join(canonical, "delivery-loop-conduct/SKILL.md");
    assert.match(readFileSync(conductSkill, "utf8"), /One code path/);
    assert.match(readFileSync(methodSkill, "utf8"), /schemaVersion: 2/);
    for (const client of [".cursor", ".claude"]) {
      for (const skill of ["delivery-loop", "delivery-loop-conduct"]) {
        const link = join(dir, client, "skills", skill);
        assert.ok(lstatSync(link).isSymbolicLink());
        assert.equal(realpathSync(link), realpathSync(join(canonical, skill)));
      }
    }
    assert.equal(existsSync(join(dir, ".cursor/skills/conduct")), false);
    assert.equal(existsSync(join(dir, ".cursor/skills/methodology")), false);
    const workflow = readFileSync(join(dir, ".github/workflows/delivery-loop.yml"), "utf8");
    const version = (
      JSON.parse(
        readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
      ) as { version: string }
    ).version;
    assert.match(workflow, /workflow_dispatch/);
    assert.match(workflow, /description: audit, sweep, deliver, or ship/);
    assert.match(workflow, /ship_action/);
    assert.match(workflow, /inputs\.ship_action/);
    assert.match(workflow, /delivery-loop ship continue/);
    assert.match(workflow, /delivery-loop audit/);
    assert.match(workflow, /inputs\.mode != 'audit'/);
    assert.match(workflow, /persist-credentials: false/);
    assert.doesNotMatch(workflow, /DELIVERY_LOOP_DEPLOY_KEY/);
    assert.match(workflow, new RegExp(`--branch v${version.replaceAll(".", "\\.")}`));
    assert.match(workflow, /https:\/\/github.com\/Madmaxme\/delivery-loop.git/);
    assert.doesNotMatch(workflow, /__DELIVERY_LOOP_REF__/);
    assert.match(workflow, /npm install --omit=dev/);
    assert.match(workflow, /CURSOR_API_KEY_FALLBACK/);
    writeFileSync(methodSkill, "stale generated content");
    update(["--dir", dir]);
    assert.match(readFileSync(methodSkill, "utf8"), /schemaVersion: 2/);
    assert.equal(readFileSync(join(dir, "delivery-loop.yaml"), "utf8"), before);
    const beforePack = loadPack(join(dir, "delivery-loop.yaml"));
    installConnector(dir, "sentry");
    const afterPack = loadPack(join(dir, "delivery-loop.yaml"));
    assert.deepEqual(afterPack.connectors, ["sentry"]);
    assert.deepEqual({ ...afterPack, connectors: beforePack.connectors }, beforePack);
    assert.match(readFileSync(join(dir, ".cursor/mcp.json"), "utf8"), /sentry/);
    assert.match(readFileSync(join(canonical, "sentry/SKILL.md"), "utf8"), /Sentry/);
    for (const client of [".cursor", ".claude"]) {
      assert.equal(realpathSync(join(dir, client, "skills/sentry")), realpathSync(join(canonical, "sentry")));
    }
    assert.equal(readFileSync(join(dir, "invariants.md"), "utf8"), invariants);
  });

  it("installs Atlassian with the official credential-free URL and preserves client state", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-atlassian-"));
    init(["--dir", dir, "--eligibility", "none"]);
    const packBefore = loadPack(join(dir, "delivery-loop.yaml"));
    const invariants = readFileSync(join(dir, "invariants.md"), "utf8");
    const otherServer = { type: "http", url: "https://other.example/mcp" };
    writeFileSync(join(dir, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { other: otherServer } }));

    installConnector(dir, "atlassian");

    const packAfter = loadPack(join(dir, "delivery-loop.yaml"));
    assert.deepEqual(packAfter.connectors, ["atlassian"]);
    assert.deepEqual({ ...packAfter, connectors: packBefore.connectors }, packBefore);
    assert.equal(readFileSync(join(dir, "invariants.md"), "utf8"), invariants);
    const mcp = JSON.parse(readFileSync(join(dir, ".cursor/mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    assert.deepEqual(mcp.mcpServers.other, otherServer);
    assert.deepEqual(mcp.mcpServers.atlassian, { url: "https://mcp.atlassian.com/v2/mcp" });
    assert.doesNotMatch(JSON.stringify(mcp.mcpServers.atlassian), /token|secret|authorization|tools=all/i);
    const canonical = join(dir, ".agents/skills/atlassian");
    for (const client of [".cursor", ".claude"]) {
      assert.equal(realpathSync(join(dir, client, "skills/atlassian")), realpathSync(canonical));
    }
  });

  it("refuses an unowned Atlassian skill path without changing pack or MCP config", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-atlassian-collision-"));
    init(["--dir", dir, "--eligibility", "none"]);
    const target = join(dir, ".agents/skills/atlassian");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "user skill\n");
    const packPath = join(dir, "delivery-loop.yaml");
    const packBefore = readFileSync(packPath, "utf8");
    const mcpPath = join(dir, ".cursor/mcp.json");
    writeFileSync(mcpPath, '{"mcpServers":{"other":{"url":"https://other.example/mcp"}}}\n');
    const mcpBefore = readFileSync(mcpPath, "utf8");

    assert.throws(() => installConnector(dir, "atlassian"));
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "user skill\n");
    assert.equal(readFileSync(packPath, "utf8"), packBefore);
    assert.equal(readFileSync(mcpPath, "utf8"), mcpBefore);
  });

  it("refuses a same-name MCP config with a different endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-atlassian-mcp-collision-"));
    init(["--dir", dir, "--eligibility", "none"]);
    const mcpPath = join(dir, ".cursor/mcp.json");
    const prior = {
      mcpServers: {
        atlassian: {
          url: "https://mcp.atlassian.com/other",
        },
      },
    };
    writeFileSync(mcpPath, `${JSON.stringify(prior)}\n`);
    const packPath = join(dir, "delivery-loop.yaml");
    const packBefore = readFileSync(packPath, "utf8");

    assert.throws(() => installConnector(dir, "atlassian"));
    assert.deepEqual(JSON.parse(readFileSync(mcpPath, "utf8")), prior);
    assert.equal(readFileSync(packPath, "utf8"), packBefore);
    assert.equal(existsSync(join(dir, ".agents/skills/atlassian")), false);
  });

  it("preserves extra fields on an existing matching Atlassian endpoint", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-atlassian-mcp-existing-"));
    init(["--dir", dir, "--eligibility", "none"]);
    const mcpPath = join(dir, ".cursor/mcp.json");
    const prior = {
      mcpServers: {
        atlassian: {
          url: "https://mcp.atlassian.com/v2/mcp",
          headers: { "X-Client-Option": "preserve" },
        },
        other: { url: "https://other.example/mcp" },
      },
    };
    writeFileSync(mcpPath, `${JSON.stringify(prior)}\n`);

    installConnector(dir, "atlassian");

    assert.deepEqual(JSON.parse(readFileSync(mcpPath, "utf8")), prior);
    assert.deepEqual(loadPack(join(dir, "delivery-loop.yaml")).connectors, ["atlassian"]);
  });

  it("requires explicit v2 init choices and explicit Jira settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-init-"));
    assert.throws(() => init(["--dir", dir]), /--eligibility/);
    assert.throws(
      () => init(["--dir", dir, "--tracker", "jira", "--eligibility", "none"]),
      /--jira-api-base-url/,
    );

    init(["--dir", dir, "--eligibility", "none"]);
    const pack = loadPack(join(dir, "delivery-loop.yaml"));
    assert.equal(pack.schemaVersion, 2);
    assert.deepEqual(pack.eligibility, { mode: "none" });
    assert.equal(pack.landingStrategy, "pull-request");
    assert.deepEqual(pack.promotionStages, []);
    assert.equal(pack.status.complete, "Complete");
    const policyDir = mkdtempSync(join(tmpdir(), "delivery-loop-policy-init-"));
    init([
      "--dir", policyDir, "--eligibility", "command",
      "--eligibility-command", "node scripts/policy.mjs",
    ]);
    assert.deepEqual(loadPack(join(policyDir, "delivery-loop.yaml")).eligibility, {
      mode: "command",
      command: "node scripts/policy.mjs",
    });
    const jiraDir = mkdtempSync(join(tmpdir(), "delivery-loop-jira-init-"));
    init([
      "--dir", jiraDir, "--tracker", "jira", "--eligibility", "none",
      "--jira-api-base-url", "https://jira.example.com",
      "--jira-auth-header-env", "JIRA_AUTHORIZATION",
      "--jira-intake-jql", "project = APP",
      "--jira-approval-field-id", "customfield_123",
    ]);
    assert.equal(loadPack(join(jiraDir, "delivery-loop.yaml")).jira?.approvalFieldId, "customfield_123");
  });

  it("refuses unowned canonical skill paths without modifying them", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-collision-"));
    const target = join(dir, ".agents/skills/delivery-loop");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "SKILL.md"), "user content\n");

    assert.throws(() => init(["--dir", dir, "--eligibility", "none"]), /unowned skill/);
    assert.equal(readFileSync(join(target, "SKILL.md"), "utf8"), "user content\n");
    assert.equal(existsSync(join(dir, "delivery-loop.yaml")), false);
  });

  it("refuses unowned legacy aliases rather than deleting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-legacy-collision-"));
    const alias = join(dir, ".cursor/skills/methodology");
    mkdirSync(alias, { recursive: true });
    writeFileSync(join(alias, "SKILL.md"), "custom methodology\n");

    assert.throws(() => init(["--dir", dir, "--eligibility", "none"]), /unowned legacy skill/);
    assert.equal(readFileSync(join(alias, "SKILL.md"), "utf8"), "custom methodology\n");
    assert.equal(existsSync(join(dir, "delivery-loop.yaml")), false);
  });

  it("refuses unowned native skill paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-link-collision-"));
    const link = join(dir, ".claude/skills/delivery-loop");
    mkdirSync(link, { recursive: true });
    writeFileSync(join(link, "SKILL.md"), "user skill\n");

    assert.throws(() => init(["--dir", dir, "--eligibility", "none"]), /unowned skill path/);
    assert.equal(readFileSync(join(link, "SKILL.md"), "utf8"), "user skill\n");
    assert.equal(existsSync(join(dir, "delivery-loop.yaml")), false);
  });

  it("refuses to overwrite an existing client pack during init", () => {
    const dir = mkdtempSync(join(tmpdir(), "delivery-loop-pack-collision-"));
    const packPath = join(dir, "delivery-loop.yaml");
    writeFileSync(packPath, "user pack\n");

    assert.throws(() => init(["--dir", dir, "--eligibility", "none"]), /refusing to overwrite/);
    assert.equal(readFileSync(packPath, "utf8"), "user pack\n");
  });
});

describe("dispatch result exit codes", () => {
  it("fails policy errors but not ordinary blocked or complete outcomes", () => {
    const previous = process.exitCode;
    try {
      process.exitCode = 0;
      failForPolicyErrors([{ outcome: "blocked" }, { outcome: "already-complete" }]);
      assert.equal(process.exitCode, 0);
      failForPolicyErrors([{ outcome: "policy-error" }]);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previous;
    }
  });
});
