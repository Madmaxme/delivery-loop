import type { DesignCheckRun } from "../engine/design-gate.ts";

type ApiGet = (path: string, init?: RequestInit) => Promise<Response>;

/**
 * Design-check read used only when the Checks API returns 403.
 * Actions jobs are the same signal. This file is the whole fallback.
 */
export async function designRunsWhenChecksForbidden(
  api: ApiGet,
  owner: string,
  repo: string,
  headSha: string,
): Promise<DesignCheckRun[]> {
  const listed = await api(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${headSha}&per_page=20`,
  );
  const runs = (await listed.json()) as {
    workflow_runs?: { id?: number; head_sha?: string }[];
  };
  const checks: DesignCheckRun[] = [];
  for (const run of runs.workflow_runs ?? []) {
    if (!run.id) continue;
    const jobsResponse = await api(
      `/repos/${owner}/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
    );
    const jobs = (await jobsResponse.json()) as {
      jobs?: { name?: string; status?: string; conclusion?: string | null }[];
    };
    for (const job of jobs.jobs ?? []) {
      checks.push({
        name: job.name ?? "",
        status: job.status ?? "",
        conclusion: job.conclusion ?? null,
        headSha: run.head_sha ?? headSha,
      });
    }
  }
  return checks;
}
