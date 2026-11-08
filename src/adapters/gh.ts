import { spawnSync } from "node:child_process";

import {
  allowlistedEnv,
  assertCanonicalCredential,
  assertHealthy,
  credentialSecret,
  type CanonicalCredential,
} from "./canonical-path.ts";

type GhSpawn = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => { status: number | null };

/** `gh` receives the issued credential in an allowlisted env. Ambient tokens are not copied. */
export function runGh(
  credential: CanonicalCredential,
  args: string[],
  spawn: GhSpawn = (command, commandArgs, opts) => spawnSync(command, commandArgs, opts),
): { status: number | null } {
  assertCanonicalCredential(credential, "github");
  assertHealthy(credential);
  const token = credentialSecret(credential);
  const env = allowlistedEnv(process.env, { GH_TOKEN: token, GITHUB_TOKEN: token });
  return spawn("gh", args, { env, stdio: "inherit" });
}

export function rejectRawCredential(): void {
  runGh({ token: "stored" } as CanonicalCredential, ["api", "user"]);
}
