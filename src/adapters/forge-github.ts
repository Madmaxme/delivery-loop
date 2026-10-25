import type { FetchLike, ForgeAdapter, PullRequest } from "./types.js";
import { githubRepoFromUrl } from "./types.js";

async function readCommit(
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  sha: string,
): Promise<{ message: string; tree: string; committedAt: string } | null> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/commits/${sha}`,
    { headers },
  );
  if (!response.ok) return null;
  const json = (await response.json()) as {
    commit?: { message?: string; tree?: { sha?: string }; committer?: { date?: string } };
  };
  const tree = json.commit?.tree?.sha ?? "";
  if (!tree) return null;
  return {
    message: json.commit?.message ?? "",
    tree,
    committedAt: json.commit?.committer?.date ?? "",
  };
}
import {
  interpretQualityActions,
  qualityRunUnscheduled,
  type QualityRunLite,
} from "../engine/linear-harness-policy.js";

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
      const body = JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      });
      const created = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers,
        body,
      });
      if (created.status === 422) {
        const listed = await api(
          `/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${input.head}`)}&state=open`,
        );
        const rows = (await listed.json()) as {
          number: number;
          html_url: string;
          head: { sha: string; ref: string };
        }[];
        const existing = rows[0];
        if (!existing) {
          throw new Error(`GitHub pulls failed: 422 ${await created.text()}`);
        }
        return {
          number: existing.number,
          url: existing.html_url,
          headSha: existing.head.sha,
          branch: existing.head.ref,
          created: false,
        };
      }
      if (!created.ok) {
        throw new Error(`GitHub pulls failed: ${created.status} ${await created.text()}`);
      }
      const json = (await created.json()) as {
        number: number;
        html_url: string;
        head: { sha: string; ref: string };
      };
      return {
        number: json.number,
        url: json.html_url,
        headSha: json.head.sha,
        branch: json.head.ref,
        created: true,
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
      if (!qualityRunUnscheduled(interpreted.detail)) return interpreted;
      const commit = await readCommit(fetchImpl, headers, owner, repo, input.headSha);
      return commit?.committedAt
        ? { ...interpreted, committedAt: commit.committedAt }
        : interpreted;
    },
    async requestQualityRun(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const commit = await readCommit(fetchImpl, headers, owner, repo, input.headSha);
      const requested = input.message.split("\n")[0]?.trim();
      const current = commit?.message.split("\n")[0]?.trim();
      if (!commit?.tree || !requested || current === requested) return null;
      const created = await api(`/repos/${owner}/${repo}/git/commits`, {
        method: "POST",
        body: JSON.stringify({
          message: input.message,
          tree: commit.tree,
          parents: [input.headSha],
        }),
      });
      const json = (await created.json()) as { sha?: string };
      if (!json.sha) return null;
      const branch = input.branch.replace(/^\/+/, "");
      await api(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: json.sha }),
      });
      return json.sha;
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
