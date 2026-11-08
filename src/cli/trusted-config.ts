import { parse } from "yaml";

import type { CanonicalPath } from "../bots/canonical.ts";
import type { ForgeTreeReader } from "../adapters/types.ts";
import {
  canonicalGithubRepo,
  trustedPackHome,
  type CommitActor,
  type ProjectPack,
  type TrustedProofPaths,
} from "../schema/pack.ts";
import { readAtTrustedSha, textFromTrustedRef } from "../schema/trusted-ref.ts";

export type CredentialMode = "legacy" | "canonical" | "refused";

export type LegacyCapability = object;

const legacyCaps = new WeakSet<object>();

/** Only a verified legacy decision can mint this. Object literals are not capabilities. */
export function issueLegacyCapability(): LegacyCapability {
  const cap = Object.freeze(Object.create(null));
  legacyCaps.add(cap);
  return cap;
}

export function hasLegacyCapability(value: unknown): value is LegacyCapability {
  return !!value && typeof value === "object" && legacyCaps.has(value);
}

export type CredentialDecision = {
  mode: CredentialMode;
  reason: string;
  paths: CanonicalPath[];
  trunk: string;
  proof: TrustedProofPaths;
  actors: CommitActor[];
  legacy: LegacyCapability | null;
};

function refused(reason: string): CredentialDecision {
  return {
    mode: "refused",
    reason,
    paths: [],
    trunk: "",
    proof: { paths: null, trunkSha: null },
    actors: [],
    legacy: null,
  };
}

function botsPathOf(doc: { bots?: { path?: unknown } } | null): string | null {
  const rel = doc?.bots && typeof doc.bots === "object" ? doc.bots.path : undefined;
  if (typeof rel !== "string" || !rel.trim()) return null;
  return rel.trim().replace(/\/$/, "");
}

/**
 * Enforcement comes from one pinned SHA. A missing home, a missing SHA, or a
 * working-tree replacement is refused. There is no default trunk.
 */
export async function trustedDecision(
  workPackYaml: string,
  forge: ForgeTreeReader,
  readWorkInventory: (rel: string) => string | null = () => null,
): Promise<CredentialDecision> {
  let work: ProjectPack;
  try {
    work = parse(workPackYaml) as ProjectPack;
  } catch {
    return refused("working pack is not valid YAML");
  }
  if (!trustedPackHome(work)) return refused("trusted home is missing or ambiguous");
  let pinned: { text: string; trunkSha: string };
  try {
    pinned = await textFromTrustedRef(forge, work, "delivery-loop.yaml");
  } catch (error) {
    return refused(error instanceof Error ? error.message : "trusted read failed");
  }
  let trusted: ProjectPack;
  try {
    trusted = parse(pinned.text) as ProjectPack;
  } catch {
    return refused("trusted pack is not valid YAML");
  }
  const home = trustedPackHome(trusted);
  const workHome = trustedPackHome(work);
  if (!home || !workHome) return refused("trusted home is missing or ambiguous");
  if (
    canonicalGithubRepo(home.url) !== canonicalGithubRepo(workHome.url) ||
    home.trunk !== workHome.trunk
  ) {
    return refused("working tree replaced the trusted home");
  }
  const trustedBots = botsPathOf(trusted);
  const workBots = botsPathOf(work);
  if (trustedBots !== workBots) {
    return {
      ...refused(trustedBots ? "working tree removed the trusted bots path" : "working tree replaced the trusted bots path"),
      trunk: home.trunk,
      proof: { paths: null, trunkSha: pinned.trunkSha },
    };
  }
  const actors = Array.isArray(trusted.commitActors) ? trusted.commitActors : [];
  if (!trustedBots) {
    return {
      mode: "legacy",
      reason: "trusted base has no bots path",
      paths: [],
      trunk: home.trunk,
      proof: { paths: null, trunkSha: pinned.trunkSha },
      actors,
      legacy: issueLegacyCapability(),
    };
  }
  let inventoryText: string;
  try {
    inventoryText = await readAtTrustedSha(forge, trusted, `${trustedBots}/inventory.yaml`, pinned.trunkSha);
  } catch (error) {
    return refused(error instanceof Error ? error.message : "trusted inventory is absent");
  }
  const workInventory = readWorkInventory(trustedBots);
  if (workInventory == null || workInventory.trim() !== inventoryText.trim()) {
    return refused("working tree replaced the trusted inventory");
  }
  let inventory: { canonicalPaths?: CanonicalPath[] };
  try {
    inventory = parse(inventoryText) as { canonicalPaths?: CanonicalPath[] };
  } catch {
    return refused("trusted inventory is not valid YAML");
  }
  return {
    mode: "canonical",
    reason: "trusted base declares bots",
    paths: inventory.canonicalPaths ?? [],
    trunk: home.trunk,
    proof: { paths: null, trunkSha: pinned.trunkSha },
    actors,
    legacy: null,
  };
}

/** Bots path from one YAML document. Callers do not re-scan the text. */
export function botsPathFromPackYaml(text: string): string | null {
  try {
    return botsPathOf(parse(text) as { bots?: { path?: unknown } });
  } catch {
    return null;
  }
}
