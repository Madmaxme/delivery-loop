import { awsCaller } from "./aws.ts";
import type { CanonicalCredential } from "./canonical-path.ts";
import { gitForge } from "./forge-git.ts";
import { githubForge, githubGraphql } from "./forge-github.ts";
import { runGh } from "./gh.ts";
import { githubIssuesTracker, linearTracker } from "./trackers.ts";
import type { FetchLike } from "./types.ts";
import { claudeWorker, codexWorker, copilotWorker, cursorWorker, httpWorker } from "./workers.ts";

/** Every adapter that can place an outbound call. A new client must be added here. */
export const OUTBOUND_ADAPTERS = [
  "aws.ts",
  "canonical-path.ts",
  "forge-git.ts",
  "forge-github.ts",
  "gh.ts",
  "land-branches.ts",
  "trackers.ts",
  "workers.ts",
] as const;

export type AdapterAttempt = {
  name: string;
  run: (input: {
    raw: unknown;
    copied: unknown;
    unprobed: CanonicalCredential;
    fetch: FetchLike;
  }) => Promise<unknown> | unknown;
};

export function adapterAttempts(unprobed: {
  linear: CanonicalCredential;
  opener: CanonicalCredential;
  merger: CanonicalCredential;
  cursor: CanonicalCredential;
  http: CanonicalCredential;
}): AdapterAttempt[] {
  return [
    {
      name: "linear-tracker",
      run: ({ raw, copied, unprobed: credential, fetch }) =>
        Promise.all([
          linearTracker({ credential: raw as CanonicalCredential, team: "T", intakeState: "Todo", fetch }).listIntake(),
          linearTracker({ credential: copied as CanonicalCredential, team: "T", intakeState: "Todo", fetch }).listIntake(),
          linearTracker({ credential, team: "T", intakeState: "Todo", fetch }).listIntake(),
        ]),
    },
    {
      name: "github-issues",
      run: ({ raw, copied, fetch }) =>
        Promise.all([
          githubIssuesTracker({ credential: raw as CanonicalCredential, repo: "acme/api", intakeLabel: "todo", fetch }).listIntake(),
          githubIssuesTracker({
            credential: copied as CanonicalCredential,
            repo: "acme/api",
            intakeLabel: "todo",
            fetch,
          }).listIntake(),
          githubIssuesTracker({
            credential: unprobed.opener,
            repo: "acme/api",
            intakeLabel: "todo",
            fetch,
          }).listIntake(),
        ]),
    },
    {
      name: "github-forge",
      run: ({ raw, copied, fetch }) => {
        githubForge({ opener: raw as CanonicalCredential, merger: raw as CanonicalCredential, fetch });
        githubForge({ opener: copied as CanonicalCredential, merger: copied as CanonicalCredential, fetch });
        return githubForge({ opener: unprobed.opener, merger: unprobed.merger, fetch }).openPullRequest({
          repoUrl: "https://github.com/example/app",
          title: "t",
          body: "b",
          head: "feature",
          base: "main",
        });
      },
    },
    {
      name: "github-graphql",
      run: ({ raw, fetch }) => githubGraphql(raw as CanonicalCredential, "{ viewer { id } }", fetch),
    },
    {
      name: "git-forge",
      run: ({ raw }) => gitForge({ cwd: process.cwd(), credential: raw as CanonicalCredential }),
    },
    {
      name: "gh",
      run: ({ raw }) => runGh(raw as CanonicalCredential, ["api", "user"], () => ({ status: 0 })),
    },
    {
      name: "aws",
      run: ({ raw }) => awsCaller({ credential: raw as CanonicalCredential, callerClass: "agent" }).identity(),
    },
    {
      name: "cursor-worker",
      run: ({ raw, fetch }) =>
        cursorWorker({ credential: raw as CanonicalCredential }).start({
          prompt: "x",
          repoUrl: "https://github.com/example/app",
          baseRef: "main",
        }).then(() => fetch("https://example.invalid")),
    },
    {
      name: "claude-worker",
      run: ({ raw, fetch }) =>
        claudeWorker({ credential: raw as CanonicalCredential, fetch }).start({
          prompt: "x",
          repoUrl: "https://github.com/example/app",
          baseRef: "main",
        }),
    },
    {
      name: "codex-worker",
      run: ({ raw, fetch }) =>
        codexWorker({ credential: raw as CanonicalCredential, fetch }).start({
          prompt: "x",
          repoUrl: "https://github.com/example/app",
          baseRef: "main",
        }),
    },
    {
      name: "copilot-worker",
      run: ({ raw, fetch }) =>
        copilotWorker({ credential: raw as CanonicalCredential, owner: "example", repo: "app", fetch }).start({
          prompt: "x",
          repoUrl: "https://github.com/example/app",
          baseRef: "main",
        }),
    },
    {
      name: "http-worker",
      run: ({ raw, fetch }) =>
        httpWorker({
          credential: raw as CanonicalCredential,
          startUrl: "https://example.invalid/start",
          statusUrl: "https://example.invalid/status",
          fetch,
        }).start({ prompt: "x", repoUrl: "https://github.com/example/app", baseRef: "main" }),
    },
  ];
}
