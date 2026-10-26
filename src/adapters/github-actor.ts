import type { CommitActor } from "../schema/pack.js";
import type { FetchLike } from "./types.js";

export type { CommitActor };

/** `owner/repo` for a GitHub URL, ssh path, or `owner/repo` string. */
export function githubRepoKey(repoUrl: string): string {
  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/#.]+)/i);
  if (match) return `${match[1]}/${match[2]}`.toLowerCase();
  return repoUrl.replace(/\.git$/, "").replace(/^\/+/, "").toLowerCase();
}

export function commitActorLogin(
  actors: CommitActor[] | undefined,
  repoUrl: string,
): string | null {
  const key = githubRepoKey(repoUrl);
  for (const actor of actors ?? []) {
    if (actor.repos.some((repo) => githubRepoKey(repo) === key)) return actor.login;
  }
  return null;
}

/** The user a token authenticates as. An installation token has no user login. */
export async function githubUserLogin(fetchImpl: FetchLike, token: string): Promise<string | null> {
  const response = await fetchImpl("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`GitHub user lookup failed: ${response.status}`);
  }
  const json = (await response.json()) as { login?: string };
  return json.login ?? null;
}

export function assertCommitActor(repoUrl: string, login: string | null, expected: string): void {
  if (login === expected) return;
  throw new Error(
    `Refusing to write ${githubRepoKey(repoUrl)}: token login is ${login ?? "not a user"}, commit actor is ${expected}.`,
  );
}
