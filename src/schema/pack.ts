import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type RepoSpec = {
  name: string;
  url: string;
  trunk: string;
  /** Set for a monorepo. Work orders name these paths. */
  packages?: string[];
};

/** A heading file the install owns. `prefix/slug` matches a heading in `file`. */
export type InvariantHeading = {
  prefix: string;
  file: string;
};

export type ProjectPack = {
  tracker: "linear" | "github";
  worker: "cursor" | "claude" | "codex" | "copilot" | "http";
  /** owner/repo used when the tracker is GitHub Issues. */
  githubRepo?: string;
  /**
   * Documents the install wants in the worker prompt, relative to the
   * workspace. The package does not name project files itself.
   */
  prompts?: { ground?: string[]; build?: string[] };
  /** Heading files that count as invariant ids, beside `invariantsFile`. */
  invariantHeadings?: InvariantHeading[];
  /**
   * Cloud agent checkout. Set this when product repos are mounted inside a
   * workspace repo (the agent must start there, not on repos[0]).
   */
  agent?: { url: string; trunk: string };
  /** Tracker team key, such as ENG. */
  linearTeam?: string;
  workerHttp?: { startUrl: string; statusUrl: string };
  repos: RepoSpec[];
  qualityCommand: string;
  qualityWorkflow: string;
  /**
   * Branch the coding agent pushes, with `{issue}` and `{repo}`.
   * The runner lands that ref only when origin has it.
   */
  branchTemplate?: string;
  invariantsFile: string;
  status: { intake: string; dev: string; prod: string };
  connectors: string[];
  dev?: { steps: string[] };
  /**
   * Pack-owned production steps. `markStatus` defaults to true.
   * Set it false when a step already moves the ticket to the prod state
   * (for example a store park that must not be marked shipped early).
   */
  ship?: { steps: string[]; markStatus?: boolean };
};

export function defaultStatus(): ProjectPack["status"] {
  return {
    intake: "Todo",
    dev: "Dev",
    prod: "Prod",
  };
}

export function loadPack(path: string): ProjectPack {
  const raw = parse(readFileSync(path, "utf8")) as ProjectPack;
  if (!raw || !Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error(`${path} needs at least one repo`);
  }
  if (raw.tracker !== "linear" && raw.tracker !== "github") {
    throw new Error(`${path} tracker must be linear or github`);
  }
  raw.status = { ...defaultStatus(), ...raw.status };
  raw.qualityWorkflow = raw.qualityWorkflow || "quality";
  raw.connectors = raw.connectors ?? [];
  raw.invariantsFile = raw.invariantsFile || "invariants.md";
  raw.prompts = {
    ground: raw.prompts?.ground ?? [],
    build: raw.prompts?.build ?? [],
  };
  raw.invariantHeadings = raw.invariantHeadings ?? [];
  return raw;
}

export function unblockingStates(pack: ProjectPack): string[] {
  return [pack.status.dev, pack.status.prod, "Canceled", "Duplicate"];
}

export function repoByName(pack: ProjectPack, name: string): RepoSpec | undefined {
  return pack.repos.find((r) => r.name === name);
}

/** Where the coding agent checks out. Product pull requests stay on `repos`. */
export function agentHome(pack: ProjectPack): { url: string; trunk: string } {
  if (pack.agent?.url && pack.agent.trunk) {
    return { url: pack.agent.url, trunk: pack.agent.trunk };
  }
  const first = pack.repos[0];
  return { url: first.url, trunk: first.trunk };
}
