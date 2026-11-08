import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { BotDefinition, MayId, PolicyId } from "./types.ts";
import { ALLOWED_MAY, MAY_IDS, REQUIRED_POLICIES } from "./types.ts";

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

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((id) => seen.has(id));
}

/**
 * A real UTC timestamp. The schema pattern accepts impossible dates such as month 13.
 * This does not. A definition that states a policy still does not enforce it.
 */
export function assertRealTimestamp(value: string, at: string): void {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$/.exec(value);
  if (!match) throw new Error(`${at}: expected a UTC timestamp`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`${at}: not a real date`);
  }
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${at}: not a real date`);
  }
}

/**
 * Required policy ids for the role must be present.
 * A may id is accepted only when it is on that role's allowlist.
 * The sentences are not consulted. This is not a runtime gate.
 */
export function assertRoleSemantics(definition: BotDefinition, at: string): void {
  const required = REQUIRED_POLICIES[definition.role];
  if (!required) throw new Error(`${at}: unknown role ${definition.role}`);
  const policies = definition.policies ?? [];
  if (new Set(policies).size !== policies.length) throw new Error(`${at}: duplicate policy`);
  if (!sameIds(policies, required)) {
    const missing = required.filter((id) => !policies.includes(id));
    const unexpected = policies.filter((id) => !required.includes(id as PolicyId));
    if (missing.length > 0) throw new Error(`${at}: missing policy ${missing[0]}`);
    throw new Error(`${at}: unexpected policy ${unexpected[0]}`);
  }
  const mustNot = definition.authority.mustNot.map((entry) => entry.id);
  if (!sameIds(mustNot, policies)) {
    const missing = policies.filter((id) => !mustNot.includes(id));
    throw new Error(`${at}: mustNot is missing policy ${missing[0] ?? "id"}`);
  }
  const allowed = new Set<string>(ALLOWED_MAY[definition.role]);
  for (const entry of definition.authority.may) {
    if (!MAY_IDS.includes(entry.id as MayId)) throw new Error(`${at}: unknown may id ${entry.id}`);
    if (!allowed.has(entry.id)) throw new Error(`${at}: may ${entry.id} is not allowed for ${definition.role}`);
  }
  if (definition.role === "engineering-bot") {
    if (definition.reportsTo !== "orchestrator") throw new Error(`${at}: reportsTo must be orchestrator`);
  } else if (definition.reportsTo !== undefined) {
    throw new Error(`${at}: reportsTo is only valid on engineering-bot`);
  }
}
