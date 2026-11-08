import { spawnSync } from "node:child_process";

import type { AwsCallerClass } from "../bots/canonical.ts";
import {
  assertCanonicalCredential,
  CanonicalPathError,
  probeAws,
  type CanonicalCredential,
  type CommandSpawn,
} from "./canonical-path.ts";

function awsChildEnv(credential: CanonicalCredential): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.LINEAR_API_KEY;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_ACCESS_KEY_ID;
  if (credential.acquisition === "stored-static") {
    if (credential.accessKeyId) env.AWS_ACCESS_KEY_ID = credential.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = credential.token;
  } else {
    env.AWS_SESSION_TOKEN = credential.token;
  }
  return env;
}

/** One AWS caller class. The credential's class must be the class this call declared. */
export function awsCaller(opts: {
  credential: CanonicalCredential;
  callerClass: AwsCallerClass;
  spawn?: CommandSpawn;
}): { callerClass: AwsCallerClass; identity(): Promise<void> } {
  assertCanonicalCredential(opts.credential, "aws");
  if (opts.credential.callerClass !== opts.callerClass) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      "aws",
      `aws ${opts.callerClass} credential did not come from the canonical path`,
    );
  }
  const spawn: CommandSpawn =
    opts.spawn ??
    ((command: string) => {
      const result = spawnSync(command, {
        shell: true,
        encoding: "utf8",
        env: awsChildEnv(opts.credential),
      });
      return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
    });
  return {
    callerClass: opts.callerClass,
    async identity() {
      await probeAws(opts.credential, spawn);
    },
  };
}

export function rejectRawCredential(): void {
  awsCaller({
    credential: { token: "stored", api: "aws", callerClass: "agent" } as CanonicalCredential,
    callerClass: "agent",
  });
}
