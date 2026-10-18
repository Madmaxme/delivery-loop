import { execFileSync } from "node:child_process";

const ACTIVE_GHA_STATUSES = new Set([
  "in_progress",
  "queued",
  "waiting",
  "pending",
  "requested",
]);

/**
 * Whether a GitHub Actions run id still owns a delivery lease.
 * `null` means unknown: missing id, or `gh` failed. Callers fail closed.
 */
export function isGithubActionsRunActive(
  runId: string | null | undefined,
  opts?: {
    currentRunId?: string | null;
    viewStatusJson?: (id: string) => string;
  },
): boolean | null {
  if (!runId || !/^\d+$/.test(runId)) return null;
  const current =
    opts?.currentRunId !== undefined
      ? opts.currentRunId
      : (process.env.GITHUB_RUN_ID ?? null);
  if (current && runId === current) return true;
  try {
    const view = opts?.viewStatusJson ?? defaultViewStatusJson;
    const parsed = JSON.parse(view(runId)) as { status?: string };
    const status = (parsed.status ?? "").trim().toLowerCase();
    if (!status) return null;
    return ACTIVE_GHA_STATUSES.has(status);
  } catch {
    return null;
  }
}

function defaultViewStatusJson(runId: string): string {
  return execFileSync("gh", ["run", "view", runId, "--json", "status"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 20_000,
  }).trim();
}
