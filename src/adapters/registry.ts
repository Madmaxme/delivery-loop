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
  "src/schema/trusted-ref.ts",
] as const;

const OUTBOUND_SPEC = /^(node:)?(child_process|http|https|net|tls)$|octokit|undici/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function importedSpecifiers(source: string): { spec: string; locals: string[] }[] {
  const text = stripComments(source);
  const found: { spec: string; locals: string[] }[] = [];
  const from = /import\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
  for (const match of text.matchAll(from)) {
    const clause = match[2] ?? "";
    const locals = [...clause.matchAll(/\bas\s+([A-Za-z_$][\w$]*)|\b([A-Za-z_$][\w$]*)/g)]
      .map((item) => item[1] || item[2])
      .filter((name) => name && name !== "type" && name !== "from");
    found.push({ spec: match[3], locals });
  }
  const dynamic = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of text.matchAll(dynamic)) found.push({ spec: match[1], locals: [] });
  return found;
}

function callsLocal(source: string, name: string): boolean {
  const text = stripComments(source);
  return new RegExp(`\\b${name}\\s*\\(`).test(text) || new RegExp(`\\b${name}\\s*\\.\\s*[A-Za-z_$]`).test(text);
}

function isDirectOutbound(source: string): boolean {
  const plain = stripComments(source);
  for (const item of importedSpecifiers(source)) {
    if (!OUTBOUND_SPEC.test(item.spec)) continue;
    if (item.locals.length === 0 || item.locals.some((name) => new RegExp(`\\b${name}\\b`).test(plain))) return true;
  }
  const code = plain
    .replace(/"(?:\\.|[^"\n])*"|'(?:\\.|[^'\n])*'|`(?:\\.|[^`])*`/g, "\"\"")
    .replace(/\/(?:\\.|[^/\n])+\/[dgimsuy]*/g, "\"\"");
  const fetchCall = new RegExp(`\\bfetch\\s*\\(|\\bfetchImpl\\s*\\(`);
  return fetchCall.test(code);
}

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
      if (!isDirectOutbound(readFileSync(abs, "utf8"))) continue;
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
        }),
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
