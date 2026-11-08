import { parse } from "yaml";

import type { CanonicalPath } from "../bots/canonical.ts";
import type { BotInventory } from "../bots/types.ts";

export type CredentialMode = "legacy" | "canonical" | "refused";

export type CredentialDecision = {
  mode: CredentialMode;
  reason: string;
  paths: CanonicalPath[];
  trunk: string;
};

function botsPath(yaml: string): string | null {
  const doc = parse(yaml) as { bots?: { path?: unknown } } | null;
  const rel = doc?.bots && typeof doc.bots === "object" ? doc.bots.path : undefined;
  if (typeof rel !== "string" || !rel.trim()) return null;
  return rel.trim();
}

function trunkOf(yaml: string): string {
  const doc = parse(yaml) as { agent?: { trunk?: unknown }; repos?: { trunk?: unknown }[] } | null;
  const named = doc?.agent?.trunk;
  if (typeof named === "string" && named.trim()) return named.trim();
  const repo = doc?.repos?.[0]?.trunk;
  if (typeof repo === "string" && repo.trim()) return repo.trim();
  return "main";
}

/**
 * Enforcement comes from the trusted base text. A working-tree removal or a different inventory is refused.
 * Legacy mode is returned only when the trusted base has no bots path.
 */
export function decideCredentialMode(input: {
  workPackYaml: string;
  trustedPackYaml: string | null;
  workInventoryYaml: string | null;
  trustedInventoryYaml: string | null;
}): CredentialDecision {
  if (!input.trustedPackYaml?.trim()) {
    return { mode: "refused", reason: "trusted base is absent", paths: [], trunk: "main" };
  }
  const trunk = trunkOf(input.trustedPackYaml);
  const trustedBots = botsPath(input.trustedPackYaml);
  const workBots = botsPath(input.workPackYaml);
  if (trustedBots !== workBots) {
    return {
      mode: "refused",
      reason: trustedBots ? "working tree removed the trusted bots path" : "working tree replaced the trusted bots path",
      paths: [],
      trunk,
    };
  }
  if (!trustedBots) return { mode: "legacy", reason: "trusted base has no bots path", paths: [], trunk };
  if (input.trustedInventoryYaml == null) {
    return { mode: "refused", reason: "trusted inventory is absent", paths: [], trunk };
  }
  if ((input.workInventoryYaml ?? "").trim() !== input.trustedInventoryYaml.trim()) {
    return { mode: "refused", reason: "working tree replaced the trusted inventory", paths: [], trunk };
  }
  const inventory = parse(input.trustedInventoryYaml) as BotInventory;
  return {
    mode: "canonical",
    reason: "trusted base declares bots",
    paths: inventory.canonicalPaths ?? [],
    trunk,
  };
}
