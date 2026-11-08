import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { CONNECTORS } from "../connectors/catalog.ts";
import { formatInventory, loadBotBundle } from "./load.ts";
import { EXECUTION_IDENTITIES, FORGE_OPERATIONS, TRACKER_OPERATIONS, WORKER_OPERATIONS } from "./surface.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templates = join(root, "bots/templates");

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
      ["delivery-agent", "orchestrator", "verdict-writer"],
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

  it("states the orchestrator and delivery-agent bounds", () => {
    const orchestrator = readFileSync(join(templates, "orchestrator.yaml"), "utf8").toLowerCase();
    for (const phrase of ["start", "dispatch", "re-dispatch", "resume", "sweep", "ground-only", "status", "label"]) {
      assert.match(orchestrator, new RegExp(phrase));
    }
    const delivery = readFileSync(join(templates, "delivery-agent.yaml"), "utf8").toLowerCase();
    for (const phrase of ["opened", "pushed", "independent", "check-runs", "exact", "squash", "rebase", "force-merge", "red"]) {
      assert.match(delivery, new RegExp(phrase));
    }
    assert.match(delivery, /not a bot/);
    assert.doesNotMatch(delivery, /merge-agent/);
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
