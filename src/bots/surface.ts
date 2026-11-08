import type { BotDefinition } from "./types.ts";

/**
 * Adapter methods the delivery agent may name.
 * `src/bots/bots.test.ts` checks these arrays against `src/adapters/types.ts`.
 * The inventory does not define them.
 */
export const FORGE_OPERATIONS = [
  "openPullRequest",
  "quality",
  "designCheck",
  "requestQualityRun",
  "mergeability",
  "compare",
  "updateBranch",
  "squashMerge",
  "dispatch",
] as const;

export const TRACKER_OPERATIONS = [
  "listIntake",
  "get",
  "comment",
  "setState",
  "addLabel",
  "removeLabel",
  "projectSnapshot",
] as const;

export const WORKER_OPERATIONS = ["start", "join"] as const;

/** Execution identities from the pack kinds, plus the commit actor and the review identity. */
export const EXECUTION_IDENTITIES = [
  { ref: "ref:forge-github", kind: "execution", adapter: "forge" },
  { ref: "ref:forge-git", kind: "execution", adapter: "forge" },
  { ref: "ref:tracker-linear", kind: "execution", adapter: "tracker" },
  { ref: "ref:tracker-github", kind: "execution", adapter: "tracker" },
  { ref: "ref:worker-cursor", kind: "worker", adapter: "worker" },
  { ref: "ref:worker-claude", kind: "worker", adapter: "worker" },
  { ref: "ref:worker-codex", kind: "worker", adapter: "worker" },
  { ref: "ref:worker-copilot", kind: "worker", adapter: "worker" },
  { ref: "ref:worker-http", kind: "worker", adapter: "worker" },
  { ref: "ref:runner-gha", kind: "runner", adapter: "runner" },
  { ref: "ref:runner-local", kind: "runner", adapter: "runner" },
  { ref: "ref:commit-actor", kind: "commit-actor", adapter: "forge" },
  { ref: "ref:merge-review", kind: "review", adapter: "forge" },
] as const;

export function requiredTools(connectorNames: readonly string[]): { adapter: string; operation: string }[] {
  return [
    ...FORGE_OPERATIONS.map((operation) => ({ adapter: "forge", operation })),
    ...TRACKER_OPERATIONS.map((operation) => ({ adapter: "tracker", operation })),
    ...WORKER_OPERATIONS.map((operation) => ({ adapter: "worker", operation })),
    ...connectorNames.map((operation) => ({ adapter: "connector", operation })),
  ];
}

/**
 * The delivery agent must name the adapter surface.
 * Any other role that names a tool or an execution identity is invalid.
 * Naming the surface does not call it.
 */
export function assertDeliverySurface(
  definition: BotDefinition,
  connectorNames: readonly string[],
  at: string,
): void {
  if (definition.role !== "delivery-agent") {
    if (definition.tools?.length || definition.identities?.length) {
      throw new Error(`${at}: only the delivery agent names adapter tools or execution identities`);
    }
    return;
  }
  const tools = definition.tools ?? [];
  const seen = new Set<string>();
  for (const tool of tools) {
    const key = `${tool.adapter}.${tool.operation}`;
    if (seen.has(key)) throw new Error(`${at}: duplicate tool ${key}`);
    seen.add(key);
  }
  for (const tool of requiredTools(connectorNames)) {
    const key = `${tool.adapter}.${tool.operation}`;
    if (!seen.has(key)) throw new Error(`${at}: missing tool ${key}`);
    seen.delete(key);
  }
  if (seen.size > 0) throw new Error(`${at}: unknown tool ${[...seen][0]}`);

  const identities = definition.identities ?? [];
  const seenRefs = new Set<string>();
  for (const identity of identities) {
    if (seenRefs.has(identity.ref)) throw new Error(`${at}: duplicate identity ${identity.ref}`);
    seenRefs.add(identity.ref);
  }
  for (const identity of EXECUTION_IDENTITIES) {
    const found = identities.find((item) => item.ref === identity.ref);
    if (!found) throw new Error(`${at}: missing identity ${identity.ref}`);
    if (found.kind !== identity.kind || found.adapter !== identity.adapter) {
      throw new Error(`${at}: identity ${identity.ref} must be ${identity.kind} on ${identity.adapter}`);
    }
  }
}
