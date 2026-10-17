import type { FetchLike, ForgeAdapter, PullRequest } from "./types.js";
import { githubRepoFromUrl } from "./types.js";
import { interpretQualityActions, type QualityRunLite } from "../engine/linear-harness-policy.js";

export function githubForge(opts: {
  token: string;
  fetch?: FetchLike;
  repo?: string;
}): ForgeAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  async function api(path: string, init?: RequestInit): Promise<Response> {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      throw new Error(`GitHub ${path} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  return {
    async openPullRequest(input): Promise<PullRequest> {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const response = await api(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        body: JSON.stringify({
          title: input.title,
          body: input.body,
          head: input.head,
          base: input.base,
        }),
      });
      const json = (await response.json()) as {
        number: number;
        html_url: string;
        head: { sha: string; ref: string };
      };
      return {
        number: json.number,
        url: json.html_url,
        headSha: json.head.sha,
        branch: json.head.ref,
      };
    },
    async quality(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const response = await api(
        `/repos/${owner}/${repo}/actions/runs?head_sha=${input.headSha}&per_page=20`,
      );
      const json = (await response.json()) as {
        workflow_runs?: {
          name: string;
          status: string;
          conclusion: string | null;
          head_sha: string;
          html_url: string;
          created_at: string;
        }[];
      };
      const runs: QualityRunLite[] = (json.workflow_runs ?? []).map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        headSha: run.head_sha,
        url: run.html_url,
        createdAt: run.created_at,
      }));
      const named = runs.map((run) =>
        run.name === input.workflow ? { ...run, name: "quality" } : run,
      );
      const interpreted = interpretQualityActions(named, input.headSha);
      if (interpreted.state === "success") return "success";
      if (interpreted.state === "failure") return "failure";
      return "pending";
    },
    async squashMerge(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      await api(`/repos/${owner}/${repo}/pulls/${input.number}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: "squash" }),
      });
    },
    async dispatch(input) {
      if (!opts.repo) throw new Error("Forge dispatch needs owner/repo");
      await api(`/repos/${opts.repo}/actions/workflows/${input.workflow}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref: input.ref, inputs: input.inputs }),
      });
    },
  };
}
