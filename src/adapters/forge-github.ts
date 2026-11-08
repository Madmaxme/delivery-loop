import {
  assertCommitActor,
  commitActorLogin,
  githubUserLogin,
  type CommitActor,
} from "./github-actor.js";
import type { CompareStatus, FetchLike, ForgeAdapter, PullMerge, PullRequest } from "./types.js";

/** Reads a file through the forge. The local checkout is not a source. */
export type ForgeTreeReader = {
  /** Commit at the tip of `trunk` on `repoUrl`. Null when the forge does not answer. */
  trunkSha(input: { repoUrl: string; trunk: string }): Promise<string | null>;
  readTextFile(input: { repoUrl: string; path: string; ref: string }): Promise<string | null>;
};
import { githubRepoFromUrl } from "./types.js";
import {
  interpretDesignChecks,
  isActionsWorkflowPath,
  type DesignCheckEvidence,
  type DesignCheckRun,
  type DesignWorkflowEvidence,
} from "../engine/design-gate.ts";

async function workflowRunsAt(
  api: (path: string, init?: RequestInit) => Promise<Response>,
  owner: string,
  repo: string,
  sha: string,
): Promise<{
  complete: boolean;
  runs: { path?: string | null; head_sha?: string | null; event?: string | null; check_suite_id?: number | null }[];
}> {
  const response = await api(
    `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=100`,
  );
  const json = (await response.json()) as {
    total_count?: number;
    workflow_runs?: {
      path?: string | null;
      head_sha?: string | null;
      event?: string | null;
      check_suite_id?: number | null;
    }[];
  };
  const runs = json.workflow_runs ?? [];
  return {
    complete: typeof json.total_count === "number" && json.total_count === runs.length,
    runs,
  };
}

async function compareForDesign(
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  baseRef: string,
  headSha: string,
): Promise<{ complete: boolean; changedPaths: string[] | null; baseSha: string | null }> {
  if (!baseRef.trim() || !headSha.trim()) return { complete: false, changedPaths: null, baseSha: null };
  const spec = `${encodeURIComponent(baseRef)}...${encodeURIComponent(headSha)}`;
  const response = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/compare/${spec}`, { headers });
  if (!response.ok) return { complete: false, changedPaths: null, baseSha: null };
  const json = (await response.json()) as {
    base_commit?: { sha?: string };
    files?: { filename?: string }[];
  };
  const baseSha = typeof json.base_commit?.sha === "string" ? json.base_commit.sha : null;
  if (!Array.isArray(json.files) || !baseSha) return { complete: false, changedPaths: null, baseSha };
  // The compare API keeps at most 300 files and still returns 200. That list is not complete.
  if (json.files.length >= 300) return { complete: false, changedPaths: null, baseSha };
  const changedPaths = json.files.map((file) => file.filename ?? "").filter((name) => name.length > 0);
  if (changedPaths.length !== json.files.length) return { complete: false, changedPaths: null, baseSha };
  return { complete: true, changedPaths, baseSha };
}

const PULL_FILES_PAGE = 100;
const PULL_FILES_MAX_PAGES = 30;

/** Changed paths from `pulls/{number}/files`. A full page without a next link, or a failed page, is incomplete. */
async function changedPathsFromPull(
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  number: number,
): Promise<{ complete: boolean; changedPaths: string[] | null }> {
  if (!Number.isInteger(number) || number <= 0) return { complete: false, changedPaths: null };
  const changedPaths: string[] = [];
  for (let page = 1; page <= PULL_FILES_MAX_PAGES; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/files?per_page=${PULL_FILES_PAGE}&page=${page}`,
      { headers },
    );
    if (!response.ok) return { complete: false, changedPaths: null };
    const json = (await response.json()) as { filename?: string }[];
    if (!Array.isArray(json)) return { complete: false, changedPaths: null };
    for (const file of json) {
      const name = file?.filename ?? "";
      if (!name) return { complete: false, changedPaths: null };
      changedPaths.push(name);
    }
    const link = response.headers.get("link") ?? "";
    const hasNext = /rel="next"/.test(link);
    if (json.length > PULL_FILES_PAGE) return { complete: false, changedPaths: null };
    if (json.length < PULL_FILES_PAGE) {
      if (hasNext) return { complete: false, changedPaths: null };
      return { complete: true, changedPaths };
    }
    if (!hasNext || page === PULL_FILES_MAX_PAGES) return { complete: false, changedPaths: null };
  }
  return { complete: false, changedPaths: null };
}

/** File text at `ref`. Null when the response is not a single base64 file. */
async function contentText(
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null> {
  if (!ref.trim() || path.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    { headers },
  );
  if (!response.ok) return null;
  const json = (await response.json()) as { type?: string; encoding?: string; content?: string };
  if (json.type !== "file" || json.encoding !== "base64" || typeof json.content !== "string" || !json.content.trim()) {
    return null;
  }
  return Buffer.from(json.content.replace(/\s/g, ""), "base64").toString("utf8");
}

/** File blob sha. Null when the path is absent. Undefined when the response is unusable. */
async function contentBlob(
  fetchImpl: FetchLike,
  headers: Record<string, string>,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | null | undefined> {
  if (!ref.trim()) return undefined;
  const encoded = path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const response = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,
    { headers },
  );
  if (response.status === 404) return null;
  if (!response.ok) return undefined;
  const json = (await response.json()) as { type?: string; sha?: string };
  if (json.type !== "file" || !json.sha || !/^[0-9a-f]{40}$/i.test(json.sha)) return undefined;
  return json.sha;
}

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

export function githubForge(opts: {
  token: string;
  fetch?: FetchLike;
  repo?: string;
  /** Writes to a listed repo require `GET /user` to be that login. */
  commitActors?: CommitActor[];
}): ForgeAdapter & ForgeTreeReader {
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
  let loginPromise: Promise<string | null> | null = null;

  async function requireActor(repoUrl: string): Promise<void> {
    const expected = commitActorLogin(opts.commitActors, repoUrl);
    if (!expected) return;
    loginPromise ??= githubUserLogin(fetchImpl, opts.token);
    assertCommitActor(repoUrl, await loginPromise, expected);
  }

  async function api(path: string, init?: RequestInit): Promise<Response> {
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
      await requireActor(input.repoUrl);
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
    async designCheck(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const baseRef = input.baseRef?.trim() ?? "";
      const response = await api(
        `/repos/${owner}/${repo}/commits/${input.headSha}/check-runs?per_page=100`,
      );
      const json = (await response.json()) as {
        total_count?: number;
        check_runs?: {
          id?: number;
          name?: string;
          status?: string;
          conclusion?: string | null;
          head_sha?: string;
          started_at?: string | null;
          app?: { id?: number; slug?: string } | null;
          check_suite?: { id?: number } | null;
        }[];
      };
      const runs: DesignCheckRun[] = (json.check_runs ?? []).map((run) => ({
        name: run.name ?? "",
        status: run.status ?? "",
        conclusion: run.conclusion ?? null,
        headSha: run.head_sha ?? "",
        appId: typeof run.app?.id === "number" && Number.isInteger(run.app.id) ? run.app.id : null,
        appSlug: typeof run.app?.slug === "string" ? run.app.slug : null,
        checkSuiteId:
          typeof run.check_suite?.id === "number" && Number.isInteger(run.check_suite.id)
            ? run.check_suite.id
            : null,
        id: typeof run.id === "number" && Number.isInteger(run.id) ? run.id : null,
        startedAt: typeof run.started_at === "string" ? run.started_at : null,
      }));
      const compared = await compareForDesign(fetchImpl, headers, owner, repo, baseRef, input.headSha);
      const listed = await changedPathsFromPull(fetchImpl, headers, owner, repo, input.number);
      const shas = [input.headSha, compared.baseSha ?? ""].filter(
        (sha, index, all) => sha.length > 0 && all.indexOf(sha) === index,
      );
      const loaded = await Promise.all(shas.map((sha) => workflowRunsAt(api, owner, repo, sha)));
      const runsComplete = loaded.every((item) => item.complete);
      const workflows: DesignWorkflowEvidence[] = loaded.flatMap((item) =>
        item.runs.map((run) => ({
          path: run.path ?? "",
          headSha: run.head_sha ?? "",
          runHeadSha: run.head_sha ?? "",
          baseSha: compared.baseSha,
          event: typeof run.event === "string" ? run.event : "",
          checkSuiteId:
            typeof run.check_suite_id === "number" && Number.isInteger(run.check_suite_id)
              ? run.check_suite_id
              : null,
        })),
      );
      const checksComplete =
        typeof json.total_count === "number" && json.total_count === (json.check_runs ?? []).length;
      let complete = checksComplete && runsComplete && baseRef.length > 0;
      const paths = [
        ...new Set(workflows.map((run) => run.path ?? "").filter((path) => isActionsWorkflowPath(path))),
      ];
      for (const path of paths) {
        const headBlob = await contentBlob(fetchImpl, headers, owner, repo, path, input.headSha);
        const baseBlob = await contentBlob(fetchImpl, headers, owner, repo, path, baseRef);
        if (headBlob === undefined || baseBlob === undefined) {
          complete = false;
          continue;
        }
        for (const workflow of workflows) {
          if (workflow.path !== path) continue;
          workflow.headBlobSha = headBlob;
          workflow.baseBlobSha = baseBlob;
        }
      }
      const evidence: DesignCheckEvidence = {
        complete: complete && listed.complete,
        workflows,
        changedPaths: listed.changedPaths,
        allowPaths: input.proofPaths ?? [],
      };
      return interpretDesignChecks(runs, input.headSha, input.name, evidence);
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
      await requireActor(input.repoUrl);
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
    async trunkSha(input) {
      const trunk = input.trunk.trim();
      if (!trunk || trunk.includes("..") || trunk.includes("\0") || !/^[A-Za-z0-9._/-]+$/.test(trunk)) return null;
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(trunk)}`,
        { headers },
      );
      if (!response.ok) return null;
      const json = (await response.json()) as { sha?: string };
      const sha = json.sha?.trim().toLowerCase() ?? "";
      return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    },
    async readTextFile(input) {
      const ref = input.ref.trim();
      if (!/^[0-9a-f]{40}$/i.test(ref)) return null;
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      return contentText(fetchImpl, headers, owner, repo, input.path, ref);
    },
    async compare(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const spec = `${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`;
      const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/compare/${spec}`,
        { headers },
      );
      if (!response.ok) return "unknown";
      const json = (await response.json()) as { status?: string };
      return interpretCompare(json.status);
    },
    async updateBranch(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      await requireActor(`https://github.com/${owner}/${repo}`);
      const response = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${input.number}/update-branch`,
        {
          method: "PUT",
          headers,
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
      await requireActor(`https://github.com/${owner}/${repo}`);
      if (!input.headSha || !/^[0-9a-f]{40}$/i.test(input.headSha)) {
        throw new Error("refusing to merge without the pull request head sha");
      }
      const response = await api(`/repos/${owner}/${repo}/pulls/${input.number}/merge`, {
        method: "PUT",
        body: JSON.stringify({ merge_method: "squash", sha: input.headSha }),
      });
      const json = (await response.json()) as { sha?: string };
      const sha = json.sha?.trim() ?? "";
      if (!sha) throw new Error("GitHub merge did not return a commit");
      return sha;
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
