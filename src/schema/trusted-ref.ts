import { spawnSync } from "node:child_process";

import type { ForgeTreeReader } from "../adapters/types.ts";
import { canonicalGithubRepo, trustedPackHome, type ProjectPack } from "./pack.ts";

const SHA = /^[0-9a-f]{40}$/i;

/**
 * One pinned read. `trustedPackHome`, then `trunkSha`, then `readTextFile` at that SHA.
 * A null home, a null SHA, or a failed read is a refusal. Callers do not fall back.
 */
export async function textFromTrustedRef(
  forge: ForgeTreeReader,
  pack: ProjectPack,
  path: string,
): Promise<{ text: string; trunkSha: string }> {
  const home = trustedPackHome(pack);
  if (!home) throw new Error("trusted home is missing or ambiguous");
  const trunkSha = (await forge.trunkSha({ repoUrl: home.url, trunk: home.trunk }))?.trim() ?? "";
  if (!SHA.test(trunkSha)) throw new Error("trusted trunk sha is absent");
  const text = await forge.readTextFile({ repoUrl: home.url, path, ref: trunkSha });
  if (text == null) throw new Error(`trusted read failed for ${path}`);
  return { text, trunkSha };
}

/** Same SHA as `textFromTrustedRef`. Does not ask the forge for a new tip. */
export async function readAtTrustedSha(
  forge: ForgeTreeReader,
  pack: ProjectPack,
  path: string,
  trunkSha: string,
): Promise<string> {
  const home = trustedPackHome(pack);
  if (!home) throw new Error("trusted home is missing or ambiguous");
  if (!SHA.test(trunkSha)) throw new Error("trusted trunk sha is absent");
  const text = await forge.readTextFile({ repoUrl: home.url, path, ref: trunkSha });
  if (text == null) throw new Error(`trusted read failed for ${path}`);
  return text;
}

function withoutUserinfo(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return url;
  }
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) return null;
  const text = result.stdout?.trim() ?? "";
  return text || null;
}

/**
 * Interim forge reader for the CLI bootstrap, before a credentialed forge exists.
 * Replace this with the forge's `trunkSha` and `readTextFile` when that lands.
 */
export function localForgeTreeReader(cwd: string): ForgeTreeReader {
  return {
    async trunkSha({ repoUrl, trunk }) {
      const origin = git(cwd, ["remote", "get-url", "origin"]);
      const originRepo = origin ? canonicalGithubRepo(withoutUserinfo(origin)) : null;
      const wanted = canonicalGithubRepo(repoUrl);
      if (!originRepo || !wanted || originRepo !== wanted) return null;
      if (!trunk.trim()) return null;
      const sha = git(cwd, ["rev-parse", "--verify", `refs/remotes/origin/${trunk}`]);
      return sha && SHA.test(sha) ? sha : null;
    },
    async readTextFile({ ref, path }) {
      if (!SHA.test(ref)) return null;
      return git(cwd, ["show", `${ref}:${path}`]);
    },
  };
}
