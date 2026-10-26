import { readFileSync } from "node:fs";
import { parse } from "yaml";

/** Writes to `repos` are refused unless the token's GitHub login is `login`. */
export type CommitActor = {
  login: string;
  repos: string[];
};

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

/** A real shared list of next, blocked, and done. Not files dropped in the repo. */
export type TrackerKind = "linear" | "github";

/** Who edits the code. The runner starts this and waits. */
export type WorkerKind = "cursor" | "claude" | "codex" | "copilot" | "http";

/**
 * Where the branch is published and merged.
 * `github` uses pull requests. `git` merges with git on any remote.
 */
export type ForgeKind = "github" | "git";

/**
 * How a commit is allowed to merge.
 * `workflow` polls a forge workflow. `command` runs `qualityCommand` in the checkout.
 */
export type CheckKind = "workflow" | "command";

/**
 * The process that stays awake and runs commands.
 * `gha` is GitHub Actions. `local` is this process. One of them is required.
 */
export type RunnerKind = "gha" | "local";

const TRACKERS: readonly TrackerKind[] = ["linear", "github"];
const WORKERS: readonly WorkerKind[] = ["cursor", "claude", "codex", "copilot", "http"];
const FORGES: readonly ForgeKind[] = ["github", "git"];
const CHECKS: readonly CheckKind[] = ["workflow", "command"];
const RUNNERS: readonly RunnerKind[] = ["gha", "local"];

export type ProjectPack = {
  tracker: TrackerKind;
  worker: WorkerKind;
  /** `github` opens pull requests. `git` merges the branch with git. */
  forge?: ForgeKind;
  /** `workflow` polls the quality workflow. `command` runs `qualityCommand`. */
  check?: CheckKind;
  /** What executes the loop. `gha` dispatches GitHub Actions. `local` runs here. */
  runner?: RunnerKind;
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
  /**
   * Repos whose commits must show a person. Absent repos keep the token's
   * own account, including a GitHub App.
   */
  commitActors?: CommitActor[];
  qualityCommand: string;
  qualityWorkflow: string;
  /**
   * Branch the coding agent pushes, with `{issue}` and `{repo}`.
   * The runner lands that ref only when origin has it.
   */
  branchTemplate?: string;
  invariantsFile: string;
  /**
   * `hold` is the status after owned code lands when the ticket still needs
   * something this repo cannot obtain. It does not clear blockers.
   * Installs name it. The default is Hold.
   * `backlog` is a status that does not count as remaining work.
   * `closed` clears blockers besides dev and prod. The default is Canceled and Duplicate.
   */
  status: {
    intake: string;
    dev: string;
    prod: string;
    hold?: string;
    backlog?: string;
    closed?: string[];
  };
  /**
   * Milestone title rules that park a slice before intake.
   * `where: name` matches the title only. `where: text` matches the title and description.
   */
  program?: {
    parkMilestones?: { match: string; kind: string; where?: "name" | "text" }[];
  };
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
    hold: "Hold",
  };
}

/** Status that keeps a ticket off dev-done. Installs override `status.hold`. */
export function holdStatus(pack: ProjectPack): string {
  const named = pack.status.hold?.trim();
  return named || defaultStatus().hold;
}

export function closedStates(pack: ProjectPack): string[] {
  const named = (pack.status.closed ?? []).map((s) => s.trim()).filter(Boolean);
  return named.length > 0 ? named : ["Canceled", "Duplicate"];
}

export function loadPack(path: string): ProjectPack {
  const raw = parse(readFileSync(path, "utf8")) as ProjectPack;
  if (!raw || !Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error(`${path} needs at least one repo`);
  }
  if (!TRACKERS.includes(raw.tracker)) {
    throw new Error(`${path} tracker must be linear or github`);
  }
  if (!WORKERS.includes(raw.worker)) {
    throw new Error(`${path} worker must be cursor, claude, codex, copilot, or http`);
  }
  raw.forge = raw.forge ?? "github";
  raw.check = raw.check ?? "workflow";
  raw.runner = raw.runner ?? "gha";
  if (!FORGES.includes(raw.forge)) throw new Error(`${path} forge must be github or git`);
  if (!CHECKS.includes(raw.check)) throw new Error(`${path} check must be workflow or command`);
  if (!RUNNERS.includes(raw.runner)) throw new Error(`${path} runner must be gha or local`);
  if (raw.check === "workflow" && raw.forge !== "github") {
    throw new Error(`${path} check workflow needs forge github`);
  }
  if (!raw.qualityCommand?.trim()) throw new Error(`${path} needs qualityCommand`);
  raw.status = { ...defaultStatus(), ...raw.status };
  raw.qualityWorkflow = raw.qualityWorkflow || "quality";
  raw.connectors = raw.connectors ?? [];
  raw.commitActors = raw.commitActors ?? [];
  raw.invariantsFile = raw.invariantsFile || "invariants.md";
  raw.prompts = {
    ground: raw.prompts?.ground ?? [],
    build: raw.prompts?.build ?? [],
  };
  raw.invariantHeadings = raw.invariantHeadings ?? [];
  return raw;
}

export function unblockingStates(pack: ProjectPack): string[] {
  return [pack.status.dev, pack.status.prod, ...closedStates(pack)];
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
