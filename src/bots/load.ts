import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse } from "yaml";

import { CONNECTORS } from "../connectors/catalog.ts";
import { assertDeliverySurface } from "./surface.ts";
import type { BotBundle, BotDefinition, BotInventory, BotManifest, BotRole, BotRoutine } from "./types.ts";
import { INVENTORY_FIELDS } from "./types.ts";
import {
  assertNoCredentialFields,
  assertRealTimestamp,
  assertRoleSemantics,
  BOT_SCHEMA_FILES,
  loadBotSchema,
  validateSchema,
} from "./validate.ts";

const REQUIRED_ROLES: readonly BotRole[] = ["orchestrator", "verdict-writer", "delivery-agent"];
const OPTIONAL_ROLES: readonly BotRole[] = ["engineering-bot"];

function declaredRoles(manifest: BotManifest): BotRole[] {
  const roles: BotRole[] = [...REQUIRED_ROLES];
  for (const role of OPTIONAL_ROLES) {
    if (!Object.hasOwn(manifest.roles, role)) continue;
    const rel = manifest.roles[role];
    if (typeof rel !== "string" || rel.trim() === "") throw new Error(`manifest ${role} path is blank`);
    roles.push(role);
  }
  return roles;
}

function readDocument(path: string): unknown {
  return parse(readFileSync(path, "utf8"));
}

/** Path segments. `..foo` is a name. `..` is a parent step. */
function pathSegments(value: string): string[] {
  return value.split(/[\\/]/).filter((part) => part !== "" && part !== ".");
}

function leaves(base: string, candidate: string, allowBase: boolean): boolean {
  const rel = relative(base, candidate);
  if (rel === "") return !allowBase;
  if (isAbsolute(rel)) return true;
  return pathSegments(rel).includes("..");
}

/**
 * The directory a pack's `bots.path` names.
 * The lexical path and the real path must both stay inside the client directory
 * that contains the pack file. A `../` step or a symlink that points outside is refused.
 */
export function resolveBotRoot(packFile: string, rel: string): string {
  const trimmed = rel.trim();
  if (!trimmed || trimmed.includes("\0")) throw new Error("bots.path is empty");
  if (isAbsolute(trimmed)) throw new Error("bots.path must be relative to the pack file");
  if (pathSegments(trimmed).includes("..")) throw new Error(`bots.path escapes the client directory: ${trimmed}`);
  const clientDir = dirname(resolve(packFile));
  const lexical = resolve(clientDir, trimmed);
  if (leaves(clientDir, lexical, true)) throw new Error(`bots.path escapes the client directory: ${trimmed}`);
  if (!existsSync(lexical)) throw new Error(`bots directory not found: ${trimmed}`);
  const clientReal = realpathSync(clientDir);
  const real = realpathSync(lexical);
  if (!statSync(real).isDirectory()) throw new Error(`bots.path is not a directory: ${trimmed}`);
  if (leaves(clientReal, real, true)) throw new Error(`bots.path symlink escapes the client directory: ${trimmed}`);
  return real;
}

/** A file reference that stays inside `root`, after symlink resolution. */
export function resolveInside(root: string, rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("empty bots ref");
  if (isAbsolute(rel) || rel.includes("\0")) throw new Error(`absolute bots ref refused: ${rel}`);
  if (pathSegments(rel).includes("..")) throw new Error(`bots ref escapes the directory: ${rel}`);
  const rootReal = realpathSync(root);
  const lexical = resolve(rootReal, rel);
  if (leaves(rootReal, lexical, false)) throw new Error(`bots ref escapes the directory: ${rel}`);
  if (!existsSync(lexical)) throw new Error(`bots ref not found: ${rel}`);
  const real = realpathSync(lexical);
  if (leaves(rootReal, real, false)) throw new Error(`bots ref symlink escapes the directory: ${rel}`);
  if (!statSync(real).isFile()) throw new Error(`bots ref is not a file: ${rel}`);
  return real;
}

function stem(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  return base.endsWith(".yaml") ? base.slice(0, -5) : base;
}

function unique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

/**
 * Read and validate one bots directory. This does not schedule, write,
 * or call a network. The bundle is data. It is not a gate and not a grant.
 */
export function loadBotBundle(root: string): BotBundle {
  const rootReal = realpathSync(root);
  const manifestPath = resolveInside(rootReal, "manifest.yaml");
  const manifestDoc = readDocument(manifestPath);
  assertNoCredentialFields(manifestDoc, "manifest.yaml");
  validateSchema(loadBotSchema(BOT_SCHEMA_FILES.manifest), manifestDoc, "manifest.yaml");
  const manifest = manifestDoc as BotManifest;

  const roles = declaredRoles(manifest);
  const definitions = roles.map((role) => {
    const rel = manifest.roles[role];
    if (!rel) throw new Error(`manifest is missing ${role}`);
    const path = resolveInside(rootReal, rel);
    const doc = readDocument(path);
    assertNoCredentialFields(doc, rel);
    validateSchema(loadBotSchema(BOT_SCHEMA_FILES.definition), doc, rel);
    const definition = doc as BotDefinition;
    if (definition.role !== role) throw new Error(`${rel}: role is ${definition.role}, manifest key is ${role}`);
    assertRoleSemantics(definition, rel);
    assertDeliverySurface(definition, CONNECTORS.map((connector) => connector.name), rel);
    return definition;
  });
  const engineering = definitions.find((definition) => definition.role === "engineering-bot");
  if (engineering && !definitions.some((definition) => definition.role === engineering.reportsTo)) {
    throw new Error(`engineering-bot reportsTo ${engineering.reportsTo ?? "nothing"}, and that role is not in this bundle`);
  }

  const routines = manifest.routines.map((rel) => {
    const path = resolveInside(rootReal, rel);
    const doc = readDocument(path);
    assertNoCredentialFields(doc, rel);
    validateSchema(loadBotSchema(BOT_SCHEMA_FILES.routine), doc, rel);
    const routine = doc as BotRoutine;
    if (routine.id !== stem(rel)) throw new Error(`${rel}: id ${routine.id} does not match the file name`);
    return routine;
  });
  unique(routines.map((routine) => routine.id), "routine id");

  const inventoryRel = manifest.inventory;
  const inventoryPath = resolveInside(rootReal, inventoryRel);
  const inventoryDoc = readDocument(inventoryPath);
  assertNoCredentialFields(inventoryDoc, inventoryRel);
  validateSchema(loadBotSchema(BOT_SCHEMA_FILES.inventory), inventoryDoc, inventoryRel);
  const inventory = inventoryDoc as BotInventory;
  inventory.items.forEach((item, index) => assertRealTimestamp(item.observedAt, `${inventoryRel}/items/${index}/observedAt`));
  inventory.coverageGaps.forEach((gap, index) => assertRealTimestamp(gap.observedAt, `${inventoryRel}/coverageGaps/${index}/observedAt`));
  unique(inventory.items.map((item) => item.id), "inventory id");
  unique(inventory.items.map((item) => item.identityRef), "identityRef");
  for (const role of roles) {
    const item = inventory.items.find((row) => row.id === role);
    if (!item) throw new Error(`inventory is missing the ${role} cross-check`);
  }
  for (const item of inventory.items) {
    if (!roles.includes(item.id as BotRole)) {
      throw new Error(`inventory cannot add ${item.id}; it cross-checks the role templates`);
    }
  }
  for (const definition of definitions) {
    const item = inventory.items.find((row) => row.id === definition.role);
    if (definition.identityRef && item && definition.identityRef !== item.identityRef) {
      throw new Error(`${definition.role}: identityRef does not match the inventory`);
    }
  }
  unique(
    inventory.coverageGaps.map((gap) => gap.source),
    "coverage gap",
  );

  return { root: rootReal, manifest, definitions, routines, inventory };
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const GAP_FIELDS = ["source", "status", "reason", "observedAt"] as const;

/** Item fields, then coverage gaps. Nothing from a role definition. */
export function formatInventory(inventory: BotInventory): string {
  const items = [...inventory.items].sort((left, right) => left.id.localeCompare(right.id));
  const itemText = items
    .map((item) => INVENTORY_FIELDS.map((field) => `${field}: ${oneLine(String(item[field]))}`).join("\n"))
    .join("\n\n");
  const gaps = [...inventory.coverageGaps].sort((left, right) => left.source.localeCompare(right.source));
  const gapText = gaps
    .map((gap) => GAP_FIELDS.map((field) => `${field}: ${oneLine(gap[field])}`).join("\n"))
    .join("\n\n");
  return `${itemText}\n\ncoverageGaps:\n${gapText}${gapText ? "\n" : ""}`;
}
