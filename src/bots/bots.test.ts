import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { CONNECTORS } from "../connectors/catalog.ts";
import { loadPack } from "../schema/pack.ts";
import { formatInventory, loadBotBundle } from "./load.ts";
import { EXECUTION_IDENTITIES, FORGE_OPERATIONS, TRACKER_OPERATIONS, WORKER_OPERATIONS } from "./surface.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templates = join(root, "bots/templates");
const threeRoleFixture = join(root, "src/bots/fixtures/v1.0.5");

function copyTemplates(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "bots-")), "defs");
  cpSync(templates, dir, { recursive: true });
  return dir;
}

function interfaceMethods(source: string, name: string): string[] {
  const marker = `export type ${name} = {`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, name);
  let depth = 1;
  let body = "";
  for (let i = start + marker.length; i < source.length && depth > 0; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth > 0) body += ch;
  }
  return [...body.matchAll(/^\s+([A-Za-z][A-Za-z0-9]*)\??\(/gm)].map((match) => match[1]);
}

function stringArray(source: string, name: string): string[] {
  const match = new RegExp(`const ${name}[^=]*=\\s*\\[([^\\]]+)\\]`).exec(source);
  assert.ok(match, name);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function objectSchemas(schema: unknown, at: string, found: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const record = schema as Record<string, unknown>;
  if (record.type === "object") {
    assert.equal(record.additionalProperties, false, at);
    found.push(at);
  }
  const properties = record.properties;
  if (properties && typeof properties === "object") {
    for (const [key, value] of Object.entries(properties)) objectSchemas(value, `${at}/${key}`, found);
  }
  if (record.items) objectSchemas(record.items, `${at}/items`, found);
}

describe("bot templates", () => {
  it("validates the role templates shipped with the engine", () => {
    const bundle = loadBotBundle(templates);
    assert.deepEqual(
      bundle.definitions.map((definition) => definition.role).sort(),
      ["delivery-agent", "engineering-bot", "orchestrator", "verdict-writer"],
    );
    assert.equal(bundle.routines.length, 5);
    assert.equal(existsTemplate("merge-agent.yaml"), false);
    const gaps = bundle.inventory.coverageGaps.map((gap) => gap.status).sort();
    assert.deepEqual(gaps, ["unreached", "unreached", "unverified"]);
    for (const gap of bundle.inventory.coverageGaps) {
      assert.ok(gap.reason.trim());
      assert.match(gap.observedAt, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T/);
    }
  });

  it("requires policy ids and rejects a missing or contradicted bound", () => {
    const bundle = loadBotBundle(templates);
    const delivery = bundle.definitions.find((definition) => definition.role === "delivery-agent");
    assert.ok(delivery?.policies.includes("head-pinned-squash"));
    assert.ok(delivery?.policies.includes("no-merge-on-red"));
    assert.ok(delivery?.policies.includes("checks-on-exact-head"));
    const orchestrator = bundle.definitions.find((definition) => definition.role === "orchestrator");
    assert.ok(orchestrator?.policies.includes("orchestrator-no-dispatch"));

    const droppedHead = copyTemplates();
    writeFileSync(join(droppedHead, "delivery-agent.yaml"), dropPolicy(readFileSync(join(droppedHead, "delivery-agent.yaml"), "utf8"), "head-pinned-squash"));
    assert.throws(() => loadBotBundle(droppedHead), /missing policy head-pinned-squash/);

    const droppedGreen = copyTemplates();
    writeFileSync(join(droppedGreen, "delivery-agent.yaml"), dropPolicy(readFileSync(join(droppedGreen, "delivery-agent.yaml"), "utf8"), "no-merge-on-red"));
    assert.throws(() => loadBotBundle(droppedGreen), /missing policy no-merge-on-red/);

    const droppedChecks = copyTemplates();
    writeFileSync(
      join(droppedChecks, "delivery-agent.yaml"),
      dropPolicy(readFileSync(join(droppedChecks, "delivery-agent.yaml"), "utf8"), "checks-on-exact-head"),
    );
    assert.throws(() => loadBotBundle(droppedChecks), /missing policy checks-on-exact-head/);

    for (const id of ["no-self-merge", "independent-review", "no-rebase"]) {
      const dropped = copyTemplates();
      writeFileSync(join(dropped, "delivery-agent.yaml"), dropPolicy(readFileSync(join(dropped, "delivery-agent.yaml"), "utf8"), id));
      assert.throws(() => loadBotBundle(dropped), new RegExp(`missing policy ${id}`));
    }

    for (const id of ["orchestrator-no-dispatch", "orchestrator-no-status-writes"]) {
      const dropped = copyTemplates();
      writeFileSync(join(dropped, "orchestrator.yaml"), dropPolicy(readFileSync(join(dropped, "orchestrator.yaml"), "utf8"), id));
      assert.throws(() => loadBotBundle(dropped), new RegExp(`missing policy ${id}`));
    }
    for (const id of ["verdict-no-status-writes", "verdict-no-relax-gate"]) {
      const dropped = copyTemplates();
      writeFileSync(join(dropped, "verdict-writer.yaml"), dropPolicy(readFileSync(join(dropped, "verdict-writer.yaml"), "utf8"), id));
      assert.throws(() => loadBotBundle(dropped), new RegExp(`missing policy ${id}`));
    }

    const noPolicies = copyTemplates();
    writeFileSync(
      join(noPolicies, "orchestrator.yaml"),
      readFileSync(join(noPolicies, "orchestrator.yaml"), "utf8").replace(/policies:\n(?:  - .+\n)+/, ""),
    );
    assert.throws(() => loadBotBundle(noPolicies), /missing policies/);

    const unknownMay = copyTemplates();
    writeFileSync(
      join(unknownMay, "orchestrator.yaml"),
      readFileSync(join(unknownMay, "orchestrator.yaml"), "utf8").replace(
        "    - id: monitor-runs\n",
        "    - id: not-a-real-id\n      statement: Not a real allowance\n    - id: monitor-runs\n",
      ),
    );
    assert.throws(() => loadBotBundle(unknownMay), /not-a-real-id|expected one of/);

    const orchestratorCalls = copyTemplates();
    writeFileSync(
      join(orchestratorCalls, "orchestrator.yaml"),
      readFileSync(join(orchestratorCalls, "orchestrator.yaml"), "utf8").replace("id: monitor-runs", "id: call-adapters"),
    );
    assert.throws(() => loadBotBundle(orchestratorCalls), /may call-adapters is not allowed for orchestrator/);

    const verdictDispatches = copyTemplates();
    writeFileSync(
      join(verdictDispatches, "verdict-writer.yaml"),
      readFileSync(join(verdictDispatches, "verdict-writer.yaml"), "utf8").replace("id: record-verdict", "id: dispatch-delivery-loop"),
    );
    assert.throws(() => loadBotBundle(verdictDispatches), /may dispatch-delivery-loop is not allowed for verdict-writer/);

    const deliveryRelaxes = copyTemplates();
    writeFileSync(
      join(deliveryRelaxes, "delivery-agent.yaml"),
      readFileSync(join(deliveryRelaxes, "delivery-agent.yaml"), "utf8").replace("id: call-adapters", "id: relax-quality-gate"),
    );
    assert.throws(() => loadBotBundle(deliveryRelaxes), /may relax-quality-gate is not allowed for delivery-agent/);

    const contradicted = copyTemplates();
    writeFileSync(
      join(contradicted, "orchestrator.yaml"),
      readFileSync(join(contradicted, "orchestrator.yaml"), "utf8").replace(
        "    - id: monitor-runs\n",
        "    - id: start-delivery-loop\n      statement: Start the delivery loop\n    - id: monitor-runs\n",
      ),
    );
    assert.throws(() => loadBotBundle(contradicted), /may start-delivery-loop is not allowed for orchestrator/);

    const reworded = copyTemplates();
    writeFileSync(
      join(reworded, "delivery-agent.yaml"),
      readFileSync(join(reworded, "delivery-agent.yaml"), "utf8").replace(
        "statement: Merge a head other than the exact reviewed head",
        "statement: A different sentence for the same policy id",
      ),
    );
    assert.equal(
      loadBotBundle(reworded).definitions.find((definition) => definition.role === "delivery-agent")?.policies.includes("head-pinned-squash"),
      true,
    );
  });

  it("validates the engineering bot and rejects a broken bound or parent", () => {
    const loaded = loadBotBundle(templates).definitions.find((definition) => definition.role === "engineering-bot");
    assert.equal(loaded?.reportsTo, "orchestrator");
    assert.deepEqual(
      [...(loaded?.policies ?? [])].sort(),
      [
        "canonical-call-path",
        "engineering-no-dispatch",
        "engineering-no-relax-gate",
        "engineering-no-status-writes",
        "engineering-reports-only-to-orchestrator",
        "no-self-merge",
      ],
    );

    for (const id of [
      "canonical-call-path",
      "no-self-merge",
      "engineering-no-dispatch",
      "engineering-no-status-writes",
      "engineering-no-relax-gate",
      "engineering-reports-only-to-orchestrator",
    ]) {
      const dropped = copyTemplates();
      writeFileSync(join(dropped, "engineering-bot.yaml"), dropPolicy(readFileSync(join(dropped, "engineering-bot.yaml"), "utf8"), id));
      assert.throws(() => loadBotBundle(dropped), new RegExp(`missing policy ${id}`));
    }

    for (const id of ["merge-pr", "self-merge", "dispatch-delivery-loop", "write-tracker-status", "relax-quality-gate"]) {
      const denied = copyTemplates();
      writeFileSync(
        join(denied, "engineering-bot.yaml"),
        readFileSync(join(denied, "engineering-bot.yaml"), "utf8").replace("id: engineer-task", `id: ${id}`),
      );
      assert.throws(() => loadBotBundle(denied), new RegExp(`may ${id} is not allowed for engineering-bot`));
    }

    const badParent = copyTemplates();
    writeFileSync(
      join(badParent, "engineering-bot.yaml"),
      readFileSync(join(badParent, "engineering-bot.yaml"), "utf8").replace("reportsTo: orchestrator", "reportsTo: delivery-agent"),
    );
    assert.throws(() => loadBotBundle(badParent), /reportsTo must be orchestrator/);

    const blank = copyTemplates();
    writeFileSync(
      join(blank, "manifest.yaml"),
      readFileSync(join(blank, "manifest.yaml"), "utf8").replace(
        "engineering-bot: engineering-bot.yaml",
        'engineering-bot: "   "',
      ),
    );
    assert.throws(() => loadBotBundle(blank), /engineering-bot/);
  });

  it("rejects the committed v1.0.5 bundle that has no canonical-call-path", () => {
    assert.throws(() => loadBotBundle(threeRoleFixture), /missing policy canonical-call-path/);
    const client = mkdtempSync(join(tmpdir(), "pack-v105-"));
    cpSync(templates, join(client, "bots"), { recursive: true });
    writeFileSync(
      join(client, "delivery-loop.yaml"),
      `tracker: linear
worker: cursor
repos:
  - name: api
    url: https://git.example/acme/api.git
    trunk: main
qualityCommand: npm test
bots:
  path: bots
`,
    );
    const pack = loadPack(join(client, "delivery-loop.yaml"));
    assert.deepEqual(pack.bots, { path: "bots" });
    assert.equal(pack.qualityCommand, "npm test");
  });

  it("maps the delivery agent to the adapter interfaces and the connector catalog", () => {
    const types = readFileSync(join(root, "src/adapters/types.ts"), "utf8");
    assert.deepEqual(interfaceMethods(types, "ForgeAdapter"), [...FORGE_OPERATIONS]);
    assert.deepEqual(interfaceMethods(types, "TrackerAdapter"), [...TRACKER_OPERATIONS]);
    assert.deepEqual(interfaceMethods(types, "WorkerAdapter"), [...WORKER_OPERATIONS]);
    const pack = readFileSync(join(root, "src/schema/pack.ts"), "utf8");
    const identities = EXECUTION_IDENTITIES.map((identity) => identity.ref);
    for (const kind of stringArray(pack, "FORGES")) assert.ok(identities.includes(`ref:forge-${kind}`));
    for (const kind of stringArray(pack, "TRACKERS")) assert.ok(identities.includes(`ref:tracker-${kind}`));
    for (const kind of stringArray(pack, "WORKERS")) assert.ok(identities.includes(`ref:worker-${kind}`));
    for (const kind of stringArray(pack, "RUNNERS")) assert.ok(identities.includes(`ref:runner-${kind}`));
    assert.ok(identities.includes("ref:commit-actor"));
    assert.ok(identities.includes("ref:merge-review"));
    const bundle = loadBotBundle(templates);
    const delivery = bundle.definitions.find((definition) => definition.role === "delivery-agent");
    const operations = new Set((delivery?.tools ?? []).filter((tool) => tool.adapter === "connector").map((tool) => tool.operation));
    assert.deepEqual([...operations].sort(), CONNECTORS.map((connector) => connector.name).sort());
  });

  it("requires coverage gaps and refuses a credential, an escape, or a dropped adapter tool", () => {
    const missingGaps = copyTemplates();
    const inventory = readFileSync(join(missingGaps, "inventory.yaml"), "utf8").replace(/\ncoverageGaps:[\s\S]*$/, "\n");
    writeFileSync(join(missingGaps, "inventory.yaml"), inventory);
    assert.throws(() => loadBotBundle(missingGaps), /coverageGaps/);

    const credential = copyTemplates();
    writeFileSync(join(credential, "orchestrator.yaml"), `${readFileSync(join(credential, "orchestrator.yaml"), "utf8")}\ntoken: present\n`);
    assert.throws(() => loadBotBundle(credential), /credential field token/);

    const escape = copyTemplates();
    const manifest = readFileSync(join(escape, "manifest.yaml"), "utf8").replace(
      "orchestrator: orchestrator.yaml",
      "orchestrator: ../outside.yaml",
    );
    writeFileSync(join(escape, "manifest.yaml"), manifest);
    assert.throws(() => loadBotBundle(escape), /escapes/);

    const outside = mkdtempSync(join(tmpdir(), "bots-out-"));
    const linked = copyTemplates();
    rmSync(join(linked, "orchestrator.yaml"));
    symlinkSync(join(outside, "orchestrator.yaml"), join(linked, "orchestrator.yaml"));
    writeFileSync(join(outside, "orchestrator.yaml"), "role: orchestrator\n");
    assert.throws(() => loadBotBundle(linked), /symlink escapes/);

    const inside = copyTemplates();
    mkdirSync(join(inside, "links"));
    symlinkSync(join(inside, "orchestrator.yaml"), join(inside, "links/orchestrator.yaml"));
    writeFileSync(
      join(inside, "manifest.yaml"),
      readFileSync(join(inside, "manifest.yaml"), "utf8").replace(
        "orchestrator: orchestrator.yaml",
        "orchestrator: links/orchestrator.yaml",
      ),
    );
    assert.equal(loadBotBundle(inside).definitions.some((definition) => definition.role === "orchestrator"), true);

    const dropped = copyTemplates();
    writeFileSync(
      join(dropped, "delivery-agent.yaml"),
      readFileSync(join(dropped, "delivery-agent.yaml"), "utf8").replace(
        /  - ref: ref:forge-squash-merge\n    adapter: forge\n    operation: squashMerge\n/,
        "",
      ),
    );
    assert.throws(() => loadBotBundle(dropped), /missing tool forge.squashMerge/);

    const extraRole = copyTemplates();
    writeFileSync(
      join(extraRole, "inventory.yaml"),
      readFileSync(join(extraRole, "inventory.yaml"), "utf8").replace(
        "  - id: delivery-agent",
        `  - id: merge-agent
    platform: unspecified
    purpose: Not a role.
    identityRef: ref:merge-agent
    verification: unverified
    evidence: evidence/merge-agent.md
    observedAt: "2026-11-08T00:00:00Z"
  - id: delivery-agent`,
      ),
    );
    assert.throws(() => loadBotBundle(extraRole), /cannot add merge-agent/);

    const impossible = copyTemplates();
    writeFileSync(
      join(impossible, "inventory.yaml"),
      readFileSync(join(impossible, "inventory.yaml"), "utf8").replace("2026-11-08T00:00:00Z", "2026-02-31T00:00:00Z"),
    );
    assert.throws(() => loadBotBundle(impossible), /not a real date/);

    const named = copyTemplates();
    writeFileSync(join(named, "..foo.yaml"), readFileSync(join(named, "orchestrator.yaml"), "utf8"));
    writeFileSync(
      join(named, "manifest.yaml"),
      readFileSync(join(named, "manifest.yaml"), "utf8").replace("orchestrator: orchestrator.yaml", "orchestrator: ..foo.yaml"),
    );
    assert.equal(loadBotBundle(named).definitions.some((definition) => definition.role === "orchestrator"), true);
  });

  it("prints inventory rows and coverage gaps only", () => {
    const text = formatInventory(loadBotBundle(templates).inventory);
    assert.match(text, /status: unreached/);
    assert.match(text, /status: unverified/);
    assert.match(text, /reason: /);
    assert.doesNotMatch(text, /mustNot|squashMerge|authority|tools:/);
    for (const line of text.split("\n").filter((line) => line && line !== "coverageGaps:")) {
      assert.match(line, /^(id|platform|purpose|identityRef|verification|evidence|observedAt|source|status|reason): /);
    }
  });

  it("keeps every object schema closed and keeps the loop off the bundle", () => {
    for (const file of [
      "bot-definition-1.0.schema.json",
      "bot-routine-1.0.schema.json",
      "bot-inventory-1.0.schema.json",
      "bot-manifest-1.0.schema.json",
    ]) {
      const schema = JSON.parse(readFileSync(join(root, "schemas", file), "utf8")) as { $schema?: string };
      assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
      const found: string[] = [];
      objectSchemas(schema, file, found);
      assert.ok(found.length > 0);
    }
    for (const file of readdirSync(join(root, "src/engine"))) {
      if (!file.endsWith(".ts")) continue;
      const text = readFileSync(join(root, "src/engine", file), "utf8");
      assert.equal(text.includes("loadBotBundle"), false, file);
    }
  });
});

function existsTemplate(name: string): boolean {
  return readdirSync(templates).includes(name);
}

function dropPolicy(text: string, id: string): string {
  return text
    .replace(new RegExp(`  - ${id}\\n`), "")
    .replace(new RegExp(`    - id: ${id}\\n      statement:.*\\n`), "");
}
