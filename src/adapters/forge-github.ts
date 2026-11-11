import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretDesignChecks, type DesignCheckRun } from "../engine/design-gate.ts";
import {
  credentialFetch,
  githubEndpointClass,
  noteMint,
  noteCredential,
  type CredentialNoteFn,
} from "../engine/credential-log.ts";
import {
  createInstallationToken,
  runMintCommand,
  type MintRun,
} from "./github-mint.ts";
import {
  interpretQualityActions,
  qualityRunUnscheduled,
  type QualityRunLite,
} from "../engine/linear-harness-policy.js";
import {
  assertCommitActor,
  commitActorLogin,
  githubUserLogin,
  type CommitActor,
} from "./github-actor.js";
import { gitForge, type GitRun } from "./forge-git.js";
import type { CompareStatus, FetchLike, ForgeAdapter, ListedPull, PullMerge, PullRequest } from "./types.js";
import { githubRepoFromUrl } from "./types.js";

function runGitCommand(
  args: string[],
  cwd: string,
  env?: Record<string, string | undefined>,
): { status: number | null; stdout: string } {
  const capture = args[0] === "rev-parse" || args[0] === "merge-base";
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: env ?? process.env,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "ignore",
  });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function isolatedGitEnvironment(tempDir: string): Record<string, string | undefined> {
  const globalConfig = join(tempDir, "global.gitconfig");
  writeFileSync(globalConfig, "", { mode: 0o600 });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tempDir,
    XDG_CONFIG_HOME: tempDir,
    TMPDIR: tempDir,
    TEMP: tempDir,
    TMP: tempDir,
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    SSL_CERT_FILE: process.env.SSL_CERT_FILE,
    SSL_CERT_DIR: process.env.SSL_CERT_DIR,
    SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_TERMINAL_PROMPT: "0",
    GIT_TRACE: "0",
    GIT_TRACE_CURL: "0",
    GIT_CURL_VERBOSE: "0",
    GIT_TRACE_PACKET: "0",
    GIT_TRACE2: "0",
    GIT_TRACE2_EVENT: "0",
  };
}

async function readCommit(
  call: (path: string, init?: RequestInit) => Promise<Response>,
  owner: string,
  repo: string,
  sha: string,
): Promise<{ message: string; tree: string; committedAt: string } | null> {
  const response = await call(`/repos/${owner}/${repo}/commits/${sha}`);
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

/** A 401 or 403 from check-runs is a credential error. There is no other read. */
export function checkRunsCredentialError(status: number, owner: string, repo: string): Error {
  const err = new Error(
    `credential error: GitHub check-runs returned ${status} for ${owner}/${repo}. ` +
      "Set DELIVERY_LOOP_GITHUB_MINT to a command that prints a GitHub App installation token.",
  );
  (err as Error & { httpStatus: number }).httpStatus = status;
  return err;
}

export function designRunsFromBody(json: {
  check_runs?: {
    name?: string;
    status?: string;
    conclusion?: string | null;
    head_sha?: string;
  }[];
}): DesignCheckRun[] {
  return (json.check_runs ?? []).map((run) => ({
    name: run.name ?? "",
    status: run.status ?? "",
    conclusion: run.conclusion ?? null,
    headSha: run.head_sha ?? "",
  }));
}

export type PullListRow = {
  number?: number;
  html_url?: string;
  state?: string;
  merged_at?: string | null;
  merge_commit_sha?: string | null;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
};

/** Keep pulls whose head and base match the land branch. A merged row keeps the squash commit. */
export function interpretPullList(
  rows: PullListRow[],
  expected: { head: string; base: string },
): ListedPull[] {
  const out: ListedPull[] = [];
  for (const row of rows) {
    const branch = row.head?.ref ?? "";
    const base = row.base?.ref ?? "";
    if (!row.number || !branch || branch !== expected.head || base !== expected.base) continue;
    const merged = Boolean(row.merged_at);
    const state = merged ? "merged" : row.state === "open" ? "open" : "closed";
    out.push({
      number: row.number,
      url: row.html_url ?? "",
      headSha: row.head?.sha ?? "",
      branch,
      base,
      state,
      mergedSha: row.merge_commit_sha?.trim() || null,
    });
  }
  return out;
}

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
  /**
   * Command that prints an installation token for check-runs.
   * Unset reads `DELIVERY_LOOP_GITHUB_MINT`. An empty string keeps the forge token.
   */
  mintCommand?: string;
  nowMs?: () => number;
  runMint?: (command: string) => MintRun;
  /** Defaults to the process credential log. */
  credentialNote?: CredentialNoteFn;
  /** Injection seam for credential-safe direct-land pushes. */
  runGit?: GitRun;
  /**
   * Shared mint cache. Absent builds one from `mintCommand`.
   * The token is not written.
   */
  installation?: ReturnType<typeof createInstallationToken>;
}): ForgeAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const note = opts.credentialNote;
  const gitRun = opts.runGit ?? runGitCommand;
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
    loginPromise ??= githubUserLogin(fetchImpl, opts.token, note);
    assertCommitActor(repoUrl, await loginPromise, expected);
  }

  function mintCommand(): string {
    if (opts.mintCommand !== undefined) return opts.mintCommand.trim();
    return process.env.DELIVERY_LOOP_GITHUB_MINT?.trim() ?? "";
  }

  const installation =
    opts.installation ??
    createInstallationToken({
      command: mintCommand,
      fallbackToken: opts.token,
      nowMs: opts.nowMs,
      runMint: opts.runMint ?? runMintCommand,
      note,
    });

  function tokenForCheckRuns() {
    return installation.get();
  }

  function callGithub(
    path: string,
    init?: RequestInit,
    slot = "gh-token",
    endpoint?: string,
  ): Promise<Response> {
    return credentialFetch(
      slot,
      endpoint ?? githubEndpointClass(path),
      () =>
        fetchImpl(`https://api.github.com${path}`, {
          ...init,
          headers: { ...headers, ...(init?.headers ?? {}) },
        }),
      note,
    );
  }

  function filePath(file: string): string {
    const clean = file.replace(/^\/+/, "");
    if (!clean || clean.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("http worker seed failed: path");
    }
    return clean.split("/").map((part) => encodeURIComponent(part)).join("/");
  }

  async function branchSha(
    owner: string,
    repo: string,
    branch: string,
    slot: string,
    token: string,
    endpoint: string,
  ): Promise<string | null> {
    const response = await callGithub(
      `/repos/${owner}/${repo}/git/matching-refs/heads/${filePath(branch)}`,
      { headers: { Authorization: `Bearer ${token}` } },
      slot,
      endpoint,
    );
    if (!response.ok) {
      await response.text().catch(() => undefined);
      throw Object.assign(new Error(`http worker seed failed: ${response.status}`), { httpStatus: response.status });
    }
    const rows = (await response.json()) as { ref?: string; object?: { sha?: string } }[];
    const exact = rows.find((row) => row.ref === `refs/heads/${branch}`);
    const sha = exact?.object?.sha?.trim() ?? "";
    return sha || null;
  }

  /** Create `branch` from the default branch when it is missing. Returns a failure status, or 0 when the branch is ready. */
  async function ensureFileBranch(
    owner: string,
    repo: string,
    branch: string,
    slot: string,
    token: string,
    endpoint: string,
  ): Promise<number> {
    const existing = await branchSha(owner, repo, branch, slot, token, endpoint);
    if (existing) return 0;
    const repoResponse = await callGithub(
      `/repos/${owner}/${repo}`,
      { headers: { Authorization: `Bearer ${token}` } },
      slot,
      endpoint,
    );
    if (!repoResponse.ok) {
      await repoResponse.text().catch(() => undefined);
      return repoResponse.status;
    }
    const described = (await repoResponse.json()) as { default_branch?: string };
    const base = described.default_branch?.trim() ?? "";
    if (!base) throw new Error("http worker seed failed: default branch is missing");
    const sha = await branchSha(owner, repo, base, slot, token, endpoint);
    if (!sha) throw new Error("http worker seed failed: default branch is missing");
    const created = await callGithub(
      `/repos/${owner}/${repo}/git/refs`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha }),
      },
      slot,
      endpoint,
    );
    if (created.status === 422) {
      await created.text().catch(() => undefined);
      return 0;
    }
    if (!created.ok) {
      await created.text().catch(() => undefined);
      return created.status;
    }
    await created.text().catch(() => undefined);
    return 0;
  }

  async function api(path: string, init?: RequestInit): Promise<Response> {
    const response = await callGithub(path, init);
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
      const created = await callGithub(`/repos/${owner}/${repo}/pulls`, {
        method: "POST",
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
    async probeCredentials() {
      if (!mintCommand()) return;
      let token = "";
      try {
        token = (await tokenForCheckRuns()).token;
      } catch {
        return;
      }
      try {
        const response = await callGithub(
          "/rate_limit",
          { headers: { Authorization: `Bearer ${token}` } },
          "mint",
        );
        await response.text().catch(() => undefined);
      } catch {
        /* The status is already recorded. The run continues. */
      }
    },
    async designCheck(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const minted = await tokenForCheckRuns();
      const path = `/repos/${owner}/${repo}/commits/${input.headSha}/check-runs?per_page=100`;
      const response = await callGithub(
        path,
        { headers: { Authorization: `Bearer ${minted.token}` } },
        minted.slot,
      );
      if (response.status === 401 || response.status === 403) {
        await response.text().catch(() => undefined);
        throw checkRunsCredentialError(response.status, owner, repo);
      }
      if (!response.ok) {
        await response.text().catch(() => undefined);
        const err = new Error(`GitHub ${path} failed: ${response.status}`);
        (err as Error & { httpStatus: number }).httpStatus = response.status;
        throw err;
      }
      const runs = designRunsFromBody(
        (await response.json()) as { check_runs?: { name?: string; status?: string; conclusion?: string | null; head_sha?: string }[] },
      );
      return interpretDesignChecks(runs, input.headSha, input.name);
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
      const commit = await readCommit(callGithub, owner, repo, input.headSha);
      return commit?.committedAt
        ? { ...interpreted, committedAt: commit.committedAt }
        : interpreted;
    },
    async requestQualityRun(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const commit = await readCommit(callGithub, owner, repo, input.headSha);
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
    async compare(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const spec = `${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`;
      const response = await callGithub(`/repos/${owner}/${repo}/compare/${spec}`);
      if (!response.ok) return "unknown";
      const json = (await response.json()) as { status?: string };
      return interpretCompare(json.status);
    },
    async directLand(input) {
      await requireActor(input.repoUrl);
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const remote = `https://github.com/${owner}/${repo}.git`;
      const tempDir = mkdtempSync(join(tmpdir(), "delivery-loop-direct-land-"));
      try {
        const templateDir = join(tempDir, "template");
        const hooksDir = join(tempDir, "hooks");
        mkdirSync(templateDir, { mode: 0o700 });
        mkdirSync(hooksDir, { mode: 0o700 });
        const bareRepo = join(tempDir, "repo.git");
        const isolatedEnv = isolatedGitEnvironment(tempDir);
        const initialized = gitRun(
          ["init", "--bare", `--template=${templateDir}`, bareRepo],
          tempDir,
          isolatedEnv,
        );
        if (initialized.status !== 0) {
          throw new Error("GitHub direct land could not initialize its isolated repository");
        }
        for (const args of [
          ["config", "--local", "core.hooksPath", hooksDir],
          ["config", "--local", "credential.helper", ""],
          ["remote", "add", "origin", remote],
        ]) {
          if (gitRun(args, bareRepo, isolatedEnv).status !== 0) {
            throw new Error("GitHub direct land could not configure its isolated repository");
          }
        }
        const localGit = gitForge({
          cwd: bareRepo,
          run: (args, cwd) => {
            const gitArgs = [...args];
            if (gitArgs[0] === "push") gitArgs.splice(1, 0, "--atomic", "--no-verify");
            const network = gitArgs[0] === "fetch" || gitArgs[0] === "push";
            const env = network
              ? {
                  ...isolatedEnv,
                  GIT_CONFIG_COUNT: "2",
                  GIT_CONFIG_KEY_1: "http.https://github.com/.extraheader",
                  GIT_CONFIG_VALUE_1: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString("base64")}`,
                }
              : isolatedEnv;
            const record = note ?? noteCredential;
            try {
              const result = gitRun(gitArgs, cwd, env);
              if (network) {
                record({ slot: "gh-token", endpoint: "git", status: result.status === 0 ? 200 : result.status ?? 0 });
              }
              return result;
            } catch (error) {
              if (network) record({ slot: "gh-token", endpoint: "git", status: 0 });
              throw error;
            }
          },
        });
        return await localGit.directLand(input);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
    async listPullRequests(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      const head = `${owner}:${input.head}`;
      const response = await api(
        `/repos/${owner}/${repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(head)}&base=${encodeURIComponent(input.base)}`,
      );
      const rows = (await response.json()) as PullListRow[];
      return interpretPullList(Array.isArray(rows) ? rows : [], {
        head: input.head,
        base: input.base,
      });
    },
    async updateBranch(input) {
      const { owner, repo } = githubRepoFromUrl(input.repoUrl);
      await requireActor(`https://github.com/${owner}/${repo}`);
      const response = await callGithub(
        `/repos/${owner}/${repo}/pulls/${input.number}/update-branch`,
        {
          method: "PUT",
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
    async readTextFile(input) {
      const [owner, repo] = input.repo.split("/");
      const minted = await tokenForCheckRuns();
      const response = await callGithub(
        `/repos/${owner}/${repo}/contents/${filePath(input.path)}?ref=${encodeURIComponent(input.branch)}`,
        { headers: { Authorization: `Bearer ${minted.token}` } },
        minted.slot,
        input.endpoint,
      );
      if (!response.ok) {
        await response.text().catch(() => undefined);
        return { status: response.status, text: "" };
      }
      const json = (await response.json()) as { encoding?: string; content?: string };
      if (json.encoding === "base64" && typeof json.content === "string") {
        return {
          status: response.status,
          text: Buffer.from(json.content.replace(/\s+/g, ""), "base64").toString("utf8"),
        };
      }
      return { status: response.status, text: typeof json.content === "string" ? json.content : "" };
    },
    async writeTextFile(input) {
      const [owner, repo] = input.repo.split("/");
      const minted = await tokenForCheckRuns();
      const ready = await ensureFileBranch(owner, repo, input.branch, minted.slot, minted.token, input.endpoint);
      if (ready !== 0) return { status: ready, actor: "" };
      const response = await callGithub(
        `/repos/${owner}/${repo}/contents/${filePath(input.path)}`,
        {
          method: "PUT",
          headers: { Authorization: `Bearer ${minted.token}` },
          body: JSON.stringify({
            message: input.message,
            content: Buffer.from(input.text, "utf8").toString("base64"),
            branch: input.branch,
          }),
        },
        minted.slot,
        input.endpoint,
      );
      if (!response.ok) {
        await response.text().catch(() => undefined);
        return { status: response.status, actor: "" };
      }
      const json = (await response.json()) as {
        commit?: { author?: { name?: string; email?: string }; committer?: { name?: string; email?: string } };
      };
      const author = json.commit?.author ?? json.commit?.committer;
      return { status: response.status, actor: loginFromGitIdentity(author?.name, author?.email) };
    },
    async createIssue(input) {
      const [owner, repo] = input.repo.split("/");
      const minted = await tokenForCheckRuns();
      const response = await callGithub(
        `/repos/${owner}/${repo}/issues`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${minted.token}` },
          body: JSON.stringify({
            title: input.title,
            body: input.body,
            ...(input.labels?.length ? { labels: input.labels } : {}),
          }),
        },
        minted.slot,
        input.endpoint,
      );
      if (!response.ok) {
        await response.text().catch(() => undefined);
        return { status: response.status, number: 0 };
      }
      const json = (await response.json()) as { number?: number };
      return { status: response.status, number: json.number ?? 0 };
    },
    async assignIssue(input) {
      const [owner, repo] = input.repo.split("/");
      const minted = await tokenForCheckRuns();
      const response = await callGithub(
        `/repos/${owner}/${repo}/issues/${input.number}/assignees`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${minted.token}` },
          body: JSON.stringify({ assignees: [input.assignee] }),
        },
        minted.slot,
        input.endpoint,
      );
      await response.text().catch(() => undefined);
      return response.status;
    },
    async actorLogin() {
      const minted = await tokenForCheckRuns();
      return (await githubUserLogin(fetchImpl, minted.token, note, minted.slot)) ?? "";
    },
  };
}

/** A noreply email or a bot name recorded on a commit. A display name is not a login. */
export function loginFromGitIdentity(name?: string, email?: string): string {
  const mail = email?.trim() ?? "";
  const plus = mail.match(/\+([^@]+)@users\.noreply\.github\.com$/i);
  if (plus?.[1]) return plus[1];
  const plain = mail.match(/^([^@+]+)@users\.noreply\.github\.com$/i);
  if (plain?.[1]) return plain[1];
  const bot = name?.trim() ?? "";
  if (/^[A-Za-z0-9-]+\[bot\]$/.test(bot)) return bot;
  return "";
}
