/** A role. The engine ships the template. A client ships the instance. */
export type BotRole = "orchestrator" | "verdict-writer" | "delivery-agent" | "engineering-bot";

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

/** Required bounds. A missing id is invalid. Stating an id does not enforce it at merge time. */
export const POLICY_IDS = [
  "no-self-merge",
  "independent-review",
  "checks-on-exact-head",
  "head-pinned-squash",
  "no-rebase",
  "no-merge-on-red",
  "orchestrator-no-dispatch",
  "orchestrator-no-status-writes",
  "verdict-no-status-writes",
  "verdict-no-relax-gate",
  "engineering-no-dispatch",
  "engineering-no-status-writes",
  "engineering-no-relax-gate",
  "engineering-reports-only-to-orchestrator",
] as const;

export type PolicyId = (typeof POLICY_IDS)[number];

/**
 * Every may id the schema accepts.
 * A role may use only the ids in ALLOWED_MAY. The others stay in the schema so a wrong role is rejected by the allowlist.
 */
export const MAY_IDS = [
  "monitor-runs",
  "report-evidence",
  "record-verdict",
  "record-evidence",
  "call-adapters",
  "review-independently",
  "read-checks-on-exact-head",
  "squash-exact-green-head",
  "start-delivery-loop",
  "dispatch-delivery-loop",
  "write-delivery-status",
  "write-delivery-label",
  "merge-own-head",
  "merge-other-head",
  "rebase-head",
  "force-merge-on-red",
  "relax-quality-gate",
  "engineer-task",
  "report-to-orchestrator",
  "merge-pr",
  "self-merge",
  "write-tracker-status",
] as const;

export type MayId = (typeof MAY_IDS)[number];

export const REQUIRED_POLICIES: Record<BotRole, readonly PolicyId[]> = {
  orchestrator: ["orchestrator-no-dispatch", "orchestrator-no-status-writes"],
  "verdict-writer": ["verdict-no-status-writes", "verdict-no-relax-gate"],
  "delivery-agent": [
    "no-self-merge",
    "independent-review",
    "checks-on-exact-head",
    "head-pinned-squash",
    "no-rebase",
    "no-merge-on-red",
  ],
  "engineering-bot": [
    "no-self-merge",
    "engineering-no-dispatch",
    "engineering-no-status-writes",
    "engineering-no-relax-gate",
    "engineering-reports-only-to-orchestrator",
  ],
};

/** The only may ids a role may list. Anything else is rejected. */
export const ALLOWED_MAY: Record<BotRole, readonly MayId[]> = {
  orchestrator: ["monitor-runs", "report-evidence"],
  "verdict-writer": ["record-verdict", "record-evidence"],
  "delivery-agent": ["call-adapters", "review-independently", "read-checks-on-exact-head", "squash-exact-green-head"],
  "engineering-bot": ["engineer-task", "report-to-orchestrator"],
};

export type BotStatement = {
  id: string;
  statement: string;
};

export type BotAuthority = {
  may: BotStatement[];
  mustNot: BotStatement[];
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
  policies: PolicyId[];
  /**
   * The role this definition reports to.
   * Only the engineering bot sets it, and the value must be the orchestrator role.
   */
  reportsTo?: BotRole;
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
  roles: {
    orchestrator: string;
    "verdict-writer": string;
    "delivery-agent": string;
    "engineering-bot"?: string;
  };
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
