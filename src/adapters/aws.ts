import type { AwsCallerClass } from "../bots/canonical.ts";
import {
  assertCanonicalCredential,
  assertHealthy,
  CanonicalPathError,
  credentialCallerClass,
  type CanonicalCredential,
} from "./canonical-path.ts";

/** One AWS caller class. The health check already matched the account and ARN. */
export function awsCaller(opts: {
  credential: CanonicalCredential;
  callerClass: AwsCallerClass;
}): { callerClass: AwsCallerClass; identity(): Promise<void> } {
  assertCanonicalCredential(opts.credential, "aws");
  if (credentialCallerClass(opts.credential) !== opts.callerClass) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      "aws",
      `aws ${opts.callerClass} credential did not come from the canonical path`,
    );
  }
  return {
    callerClass: opts.callerClass,
    async identity() {
      assertHealthy(opts.credential);
    },
  };
}

export function rejectRawCredential(): void {
  awsCaller({
    credential: { token: "stored" } as CanonicalCredential,
    callerClass: "agent",
  });
}
