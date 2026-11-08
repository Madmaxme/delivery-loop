import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BotDefinition, BotRole } from "./types.ts";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const BOT_SCHEMA_FILES = {
  definition: "bot-definition-1.0.schema.json",
  routine: "bot-routine-1.0.schema.json",
  inventory: "bot-inventory-1.0.schema.json",
  manifest: "bot-manifest-1.0.schema.json",
} as const;

type JsonSchema = {
  type?: "object" | "string" | "array" | "boolean" | "integer" | "number";
  const?: unknown;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: false;
  items?: JsonSchema;
  minLength?: number;
  minItems?: number;
  pattern?: string;
};

/**
 * Credential and platform-id field names. A bot file may name a reference.
 * It may not carry a secret or an id the platform issued.
 */
function forbiddenKey(key: string): boolean {
  const norm = key.toLowerCase().replace(/[_-]/g, "");
  if (
    norm === "botid" ||
    norm === "cloudagentid" ||
    norm === "agentid" ||
    norm === "cursoragentid" ||
    norm === "installationid"
  ) {
    return true;
  }
  return /token|secret|password|passwd|credential|apikey|privatekey|authorization|bearer|cookie|accesskey/.test(norm);
}

export function assertNoCredentialFields(value: unknown, at: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialFields(item, `${at}/${index}`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (forbiddenKey(key)) {
      throw new Error(`${at}: credential field ${key} is not allowed; use a reference`);
    }
    assertNoCredentialFields((value as Record<string, unknown>)[key], `${at}/${key}`);
  }
}

export function loadBotSchema(file: string): JsonSchema {
  const path = resolve(packageRoot, "schemas", file);
  return JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
}

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function check(schema: JsonSchema, value: unknown, at: string): void {
  if (schema.type === "object" && schema.additionalProperties !== false) {
    throw new Error(`${at}: schema must set additionalProperties false`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${at}: expected ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${at}: expected one of ${schema.enum.join(", ")}`);
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${at}: expected an integer`);
  } else if (schema.type && typeOf(value) !== schema.type) {
    throw new Error(`${at}: expected ${schema.type}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new Error(`${at}: expected a non-empty string`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new Error(`${at}: does not match ${schema.pattern}`);
    }
  }
  if (schema.type === "array" || Array.isArray(value)) {
    if (!Array.isArray(value)) throw new Error(`${at}: expected an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      throw new Error(`${at}: expected at least ${schema.minItems}`);
    }
    if (schema.items) value.forEach((item, index) => check(schema.items as JsonSchema, item, `${at}/${index}`));
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${at}: expected an object`);
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (record[key] === undefined) throw new Error(`${at}: missing ${key}`);
    }
    const known = new Set(Object.keys(schema.properties ?? {}));
    for (const key of Object.keys(record)) {
      if (!known.has(key)) throw new Error(`${at}: additional property ${key}`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (record[key] !== undefined) check(child, record[key], `${at}/${key}`);
    }
  }
}

export function validateSchema(schema: JsonSchema, value: unknown, at: string): void {
  check(schema, value, at);
}

function joined(lines: string[]): string {
  return lines.join("\n").toLowerCase();
}

function requirePhrases(text: string, phrases: readonly string[], at: string, field: string): void {
  for (const phrase of phrases) {
    if (!text.includes(phrase)) throw new Error(`${at}: ${field} must state "${phrase}"`);
  }
}

/**
 * Role bounds live in the engine, not in the file's claim of authority.
 * A definition that omits a bound is invalid. Stating the bound grants nothing.
 */
export function assertRoleSemantics(definition: BotDefinition, at: string): void {
  const mustNot = joined(definition.authority.mustNot);
  const may = joined(definition.authority.may);
  const role: BotRole = definition.role;
  if (role === "orchestrator") {
    requirePhrases(
      mustNot,
      ["start", "dispatch", "re-dispatch", "resume", "run the delivery loop", "sweep", "ground-only", "status", "label"],
      at,
      "mustNot",
    );
    requirePhrases(may, ["monitor", "evidence"], at, "may");
  } else if (role === "verdict-writer") {
    requirePhrases(mustNot, ["status", "label", "start", "gate"], at, "mustNot");
    requirePhrases(may, ["verdict", "evidence"], at, "may");
  } else if (role === "delivery-agent") {
    requirePhrases(mustNot, ["opened", "pushed", "rebase", "force-merge", "red", "gate"], at, "mustNot");
    requirePhrases(may, ["independent", "check-runs", "exact", "squash", "adapter"], at, "may");
  } else {
    throw new Error(`${at}: unknown role ${role}`);
  }
}
