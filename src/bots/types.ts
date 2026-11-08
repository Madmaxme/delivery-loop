/** A role. The engine ships the template. A client ships the instance. */
export type BotRole = "orchestrator" | "verdict-writer" | "delivery-agent";

export type BotAdapterName = "forge" | "tracker" | "worker" | "connector" | "runner";

/** A tool the delivery agent calls. The operation is an adapter method, not a bot. */
export type BotTool = {
  ref: string;
  adapter: Exclude<BotAdapterName, "runner">;
  operation: string;
};

/**
 * An execution identity the delivery agent uses.
 * A forge app is one of these. It is not a role and not a bot.
 */
export type BotIdentity = {
  ref: string;
  kind: "execution" | "commit-actor" | "review" | "worker" | "runner";
  adapter: BotAdapterName;
  purpose: string;
};

export type BotAuthority = {
  may: string[];
  mustNot: string[];
};

/**
 * A role template or a client instance of that role.
 * `identityRef` is a reference into the inventory. It is not a platform id.
 */
export type BotDefinition = {
  specversion: "1.0";
  role: BotRole;
  effect: "data-only";
  purpose: string;
  identityRef?: string;
  tools?: BotTool[];
  identities?: BotIdentity[];
  authority: BotAuthority;
};

export type BotRoutineTriggerKind = "event" | "schedule" | "webhook";

export type BotOverlap = "skip" | "queue" | "refuse";

/** A described routine. Loading it does not schedule the trigger. */
export type BotRoutine = {
  specversion: "1.0";
  id: string;
  effect: "data-only";
  purpose: string;
  trigger: { kind: BotRoutineTriggerKind; spec: string };
  inputs: { name: string; source: string }[];
  output: { event: string; contract: string };
  idempotency: string;
  overlap: BotOverlap;
  approval: { boundary: string; requires: string };
};

export type BotVerification = "verified" | "unverified";

/** One inventory row. `identityRef` is a reference. `evidence` is a location. */
export type BotInventoryItem = {
  id: string;
  platform: string;
  purpose: string;
  identityRef: string;
  verification: BotVerification;
  evidence: string;
  observedAt: string;
};

/** A source that was not read. Omitting it is not allowed. The row says why. */
export type BotCoverageGap = {
  source: string;
  status: "unreached" | "unverified";
  reason: string;
  observedAt: string;
};

export type BotInventory = {
  specversion: "1.0";
  items: BotInventoryItem[];
  coverageGaps: BotCoverageGap[];
};

/** File references, relative to the manifest's directory. */
export type BotManifest = {
  specversion: "1.0";
  effect: "data-only";
  roles: Record<BotRole, string>;
  routines: string[];
  inventory: string;
};

/**
 * A validated directory. The engine reads it only to check shape.
 * Callers that decide a merge or a status do not take this object.
 */
export type BotBundle = {
  root: string;
  manifest: BotManifest;
  definitions: BotDefinition[];
  routines: BotRoutine[];
  inventory: BotInventory;
};

/** Inventory fields `delivery-loop bots list` is allowed to print. */
export const INVENTORY_FIELDS = [
  "id",
  "platform",
  "purpose",
  "identityRef",
  "verification",
  "evidence",
  "observedAt",
] as const;

export type InventoryField = (typeof INVENTORY_FIELDS)[number];
