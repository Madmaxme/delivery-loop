import {
  assertCanonicalCredential,
  authorizationHeader,
  CanonicalPathError,
  isHealthy,
  probeGithub,
  type CanonicalCredential,
} from "./canonical-path.ts";
import { commitActorLogin, type CommitActor } from "./github-actor.js";
import type { CompareStatus, FetchLike, ForgeAdapter, PullMerge, PullRequest } from "./types.js";
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
import { interpretDesignChecks } from "../engine/design-gate.ts";
import {
  interpretQualityActions,
  qualityRunUnscheduled,
  type QualityRunLite,
} from "../engine/linear-harness-policy.js";

export function interpretMergeability(body: {
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head?: { sha?: string | null };
}): PullMerge {
  const headSha = body.head?.sha ?? "";
  const raw = (body.mergeable_state ?? "").toLowerCase();
  if (raw === "dirty") return { state: "conflict", headSha };
  if (raw === "behind") return { state: "behind", headSha };
  if (raw === "blocked" || raw === "draft") return { state: "blocked", headSha };
  if (raw === "clean" || raw === "unstable" || raw === "has_hooks") return { state: "clean", headSha };
  if (body.mergeable === false && raw !== "unknown" && raw !== "") {
    return { state: "conflict", headSha };
  }
  return { state: "unknown", headSha };
}

export function interpretCompare(status: string | null | undefined): CompareStatus {
  const raw = (status ?? "").toLowerCase();
  if (raw === "ahead" || raw === "behind" || raw === "identical" || raw === "diverged") return raw;
  return "unknown";
}

function headersFor(credential: CanonicalCredential): Record<string, string> {
  return {
    Authorization: authorizationHeader(credential.token),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

export function githubForge(opts: {
  opener: CanonicalCredential;
  merger: CanonicalCredential;
  fetch?: FetchLike;
  repo?: string;
  /** Writes by the opener require `GET /user` to be that login. The merger is a different identity. */
  commitActors?: CommitActor[];
}): ForgeAdapter {
  assertCanonicalCredential(opts.opener, "github");
  assertCanonicalCredential(opts.merger, "github");
  if (opts.opener.role !== "opener" || opts.merger.role !== "merger" || opts.opener.source === opts.merger.source) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      "github",
      "github opener and merger credentials are different identities",
    );
  }
  const fetchImpl = opts.fetch ?? fetch;
  const openerHeaders = headersFor(opts.opener);
  const mergerHeaders = headersFor(opts.merger);
  let openerReady: Promise<void> | null = null;
  let mergerReady: Promise<void> | null = null;

  async function gateOpener(repoUrl?: string): Promise<void> {
    if (isHealthy(opts.opener)) return;
    const expected = repoUrl ? commitActorLogin(opts.commitActors, repoUrl) : null;
    openerReady ??= probeGithub(opts.opener, fetchImpl, { expectedLogin: expected });
    await openerReady;
  }

  async function gateMerger(): Promise<void> {
    if (isHealthy(opts.merger)) return;
    mergerReady ??= probeGithub(opts.merger, fetchImpl, {});
    await mergerReady;
  }

  async function api(path: string, init?: RequestInit, headers: Record<string, string> = openerHeaders): Promise<Response> {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      ...init,
      headers: { ...headers, ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const err = new Error(`GitHub ${path} failed: ${response.status}`);
      (err as Error & { httpStatus: number }).httpStatus = response.status;
      await response.text().catch(() => undefined);
      throw err;
    }
    return response;
  }

  return {
    async openPullRequest(input): Promise<PullRequest> {
      await gateOpener(input.repoUrl);
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const body = JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      });
      const created = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        headers: openerHeaders,
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
    async designCheck(input) {
      await gateOpener(input.repoUrl);
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const response = await api(
        `/repos/${owner}/${repo}/commits/${input.headSha}/check-runs?per_page=100`,
      );
      const json = (await response.json()) as {
        check_runs?: {
          name?: string;
          status?: string;
          conclusion?: string | null;
          head_sha?: string;
        }[];
      };
      return interpretDesignChecks(
        (json.check_runs ?? []).map((run) => ({
          name: run.name ?? "",
          status: run.status ?? "",
          conclusion: run.conclusion ?? null,
          headSha: run.head_sha ?? "",
        })),
        input.headSha,
        input.name,
      );
    },
    async quality(input) {
      await gateOpener(input.repoUrl);
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
      const commit = await readCommit(fetchImpl, openerHeaders, owner, repo, input.headSha);
      return commit?.committedAt
        ? { ...interpreted, committedAt: commit.committedAt }
        : interpreted;
    },
    async requestQualityRun(input) {
      await gateOpener(input.repoUrl);
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const commit = await readCommit(fetchImpl, openerHeaders, owner, repo, input.headSha);
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
    async mergeability(input) {
      await gateOpener(input.repoUrl);
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const response = await api(`/repos/${owner}/${repo}/pulls/${input.number}`);
      return interpretMergeability(
        (await response.json()) as {
          mergeable?: boolean | null;
          mergeable_state?: string | null;
          head?: { sha?: string | null };
        },
      );
    },
    async compare(input) {
      await gateOpener(input.repoUrl);
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const spec = `${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`;
      const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/compare/${spec}`,
        { headers: openerHeaders },
      );
      if (!response.ok) return "unknown";
      const json = (await response.json()) as { status?: string };
      return interpretCompare(json.status);
    },
    async updateBranch(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      await gateOpener(`https://github.com/${owner}/${repo}`);
      const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${input.number}/update-branch`,
        {
          method: "PUT",
          headers: openerHeaders,
          body: JSON.stringify(
            input.expectedHeadSha ? { expected_head_sha: input.expectedHeadSha } : {},
          ),
        },
      );
      if (response.status === 422) {
        const text = await response.text();
        if (/no new commits|already up.to.date|not behind/i.test(text)) return;
        throw new Error(`GitHub update-branch failed: 422 ${text}`);
      }
      if (!response.ok) {
        throw new Error(
          `GitHub update-branch failed: ${response.status} ${await response.text()}`,
        );
      }
    },
    async squashMerge(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      await gateMerger();
      if (!input.headSha || !/^[0-9a-f]{40}$/i.test(input.headSha)) {
        throw new Error("refusing to merge without the pull request head sha");
      }
      const response = await api(
        `/repos/${owner}/${repo}/pulls/${input.number}/merge`,
        {
          method: "PUT",
          body: JSON.stringify({ merge_method: "squash", sha: input.headSha }),
        },
        mergerHeaders,
      );
      const json = (await response.json()) as { sha?: string };
      const sha = json.sha?.trim() ?? "";
      if (!sha) throw new Error("GitHub merge did not return a commit");
      return sha;
    },
    async dispatch(input) {
      if (!opts.repo) throw new Error("Forge dispatch needs owner/repo");
      await gateOpener(`https://github.com/${opts.repo}`);
      await api(`/repos/${opts.repo}/actions/workflows/${input.workflow}/dispatches`, {
        method: "POST",
        body: JSON.stringify({ ref: input.ref, inputs: input.inputs }),
      });
    },
  };
}

/** GitHub GraphQL uses the same credential gate as REST. The health check runs first. */
export async function githubGraphql(
  credential: CanonicalCredential,
  query: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  assertCanonicalCredential(credential, "github");
  if (!isHealthy(credential)) await probeGithub(credential, fetchImpl, {});
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(credential.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new CanonicalPathError("credential-unhealthy", "github", "github graphql failed", response.status);
  }
  return response.json();
}

export function rejectRawCredential(): void {
  githubForge({
    opener: { token: "stored", api: "github" } as CanonicalCredential,
    merger: { token: "stored", api: "github" } as CanonicalCredential,
  });
}
