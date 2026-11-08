import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { awsCaller } from "./aws.ts";
import type { CanonicalCredential } from "./canonical-path.ts";
import { figmaTokenValue } from "../engine/design-gate.ts";
import { lookupRemoteHead } from "../engine/land-branches.ts";
import { gitForge } from "./forge-git.ts";
import { githubForge, githubGraphql } from "./forge-github.ts";
import { runGh } from "./gh.ts";
import { githubUserLogin } from "./github-actor.ts";
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

/** Production modules that can open a network or subprocess call. The test compares this to a recursive scan. */
export const OUTBOUND_MODULES = [
  "src/adapters/canonical-path.ts",
  "src/adapters/forge-git.ts",
  "src/adapters/forge-github.ts",
  "src/adapters/gh.ts",
  "src/adapters/github-actor.ts",
  "src/adapters/trackers.ts",
  "src/adapters/workers.ts",
  "src/cli/main.ts",
  "src/engine/design-gate.ts",
  "src/engine/github-run-status.ts",
  "src/engine/land-branches.ts",
  "src/engine/loop.ts",
] as const;

const OUTBOUND_TEXT = /\bfetchImpl\s*\(|\bspawnSync\s*\(|\bexecFileSync\s*\(|\bspawn\s*\(/;

export function detectOutboundModules(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "fixtures") continue;
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const text = readFileSync(abs, "utf8");
      if (!OUTBOUND_TEXT.test(text)) continue;
      found.push(relative(root, abs).split("\\").join("/"));
    }
  };
  walk(join(root, "src"));
  return found.sort();
}

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
      name: "land-branches",
      run: ({ raw }) =>
        lookupRemoteHead("https://github.com/example/app.git", "main", raw as CanonicalCredential, () => {
          throw new Error("spawned");
        }),
    },
    {
      name: "github-actor",
      run: ({ raw, fetch }) => githubUserLogin(fetch, raw as CanonicalCredential),
    },
    {
      name: "design-gate",
      run: ({ raw }) =>
        figmaTokenValue({
          credential: raw as CanonicalCredential,
          mode: "canonical",
          design: undefined,
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
