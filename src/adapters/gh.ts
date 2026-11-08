import { spawnSync } from "node:child_process";

import { assertCanonicalCredential, assertHealthy, scopedChildEnv, type CanonicalCredential } from "./canonical-path.ts";

type GhSpawn = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => { status: number | null };

/** `gh` uses the issued GitHub credential and no ambient token. The health check has already passed. */
export function runGh(
  credential: CanonicalCredential,
  args: string[],
  spawn: GhSpawn = (command, commandArgs, opts) => spawnSync(command, commandArgs, opts),
): { status: number | null } {
  assertCanonicalCredential(credential, "github");
  assertHealthy(credential);
  const env = scopedChildEnv(process.env, credential);
  return spawn("gh", args, { env, stdio: "inherit" });
}

export function rejectRawCredential(): void {
  runGh({ token: "stored", api: "github" } as CanonicalCredential, ["api", "user"]);
}
