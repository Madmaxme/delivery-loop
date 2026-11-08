import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parse } from "yaml";

import { loadBotBundle, resolveBotRoot } from "../bots/load.ts";
import type { BotBundle } from "../bots/types.ts";

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

/** A UI repo. The check run is required on the pull request head, with or without a Figma frame. */
export type DesignRepo = {
  name: string;
  /** Exact command the work order Validation must include. */
  check: string;
  /** GitHub check-run name on the pull request head. */
  checkName: string;
  /** Token file read into a repair prompt when the ticket has no Figma frame. */
  tokenFile: string;
  /**
   * Path prefixes a pull request may change while `checkName` stays independent.
   * A pull_request run is ignored when a changed path is outside this list.
   * Empty means that mode fails closed. pull_request_target from the base revision does not use this list.
   */
  proofPaths?: string[];
};

/**
 * UI repos and the Figma token env name.
 * The token value is never stored here. `figmaTokenEnv` defaults to FIGMA_ACCESS_TOKEN.
 */
export type DesignSpec = {
  figmaTokenEnv: string;
  repos: DesignRepo[];
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
  /**
   * Env var holding the token that may push the runner package.
   * An installation token must not merge that package.
   */
  commitActorTokenEnv?: string;
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
  /**
   * UI repos and the env var that holds a Figma REST token.
   * Absent means this install has no UI check. A Figma URL still requires the token.
   */
  design?: DesignSpec;
  /**
   * After trunk quality is green. `promote` runs `command` once per landed
   * repo that is also listed in `repos`, with `{repo}` replaced.
   * When `promote` is set, `steps` are not run.
   */
  dev?: {
    steps?: string[];
    promote?: { command: string; repos: string[] };
  };
  /**
   * Resolves `**Symbols:**` lines. The engine passes one `repo/path#symbol`
   * per line on stdin. A non-zero exit is an incomplete packet.
   */
  symbolsCommand?: string;
  /**
   * Verifies a recorded journey from the trunk revision, in a separate worktree.
   * The engine does not pass the worker handoff on stdin. Stdin is the revision SHA.
   * The command must observe external state itself. Exit 0 and a `**Journey proof:**`
   * token are the proof. A missing command keeps a recorded journey in intake.
   * A nonzero exit, worker text, and a file that exists are not proof.
   */
  journeyCommand?: string;
  /**
   * Pack-owned production steps. `markStatus` defaults to true.
   * Set it false when a step already moves the ticket to the prod state
   * (for example a store park that must not be marked shipped early).
   * `afterDev` runs `steps` once the dev gate has passed. When it is
   * absent, sweep stops at the dev state and does not run `steps`,
   * including a later page that still has a ship marker. A failed step
   * leaves the dev state. The ship command edits that step's owner once,
   * then the next run retries it. `continue` is the store-continue command.
   * A clean exit, including a store wait, is not a failure.
   */
  ship?: { steps: string[]; continue?: string[]; markStatus?: boolean; afterDev?: boolean };
  /**
   * Heal attempts per failure type, counted from OWNER_HEAL comments on the ticket.
   * `maxAttempts` is the default. `caps` overrides one type.
   * Types: quality-red, merge-conflict, promote-failed, ship-failed,
   * quality-pending, quality-unscheduled, runner-blocked, other.
   * Absent means 3.
   */
  heal?: {
    maxAttempts?: number;
    caps?: Record<string, number>;
  };
  /**
   * Optional directory of bot instances, relative to this file.
   * Absent means this install has no bot definitions and nothing there is read.
   * The directory is validated and then dropped. It is not a gate and not a grant.
   */
  bots?: { path: string };
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

/** The pack, and the bot bundle when `bots.path` is set. The bundle is not stored on the pack. */
export function openPack(path: string): { pack: ProjectPack; bots: BotBundle | null } {
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
  raw.design = loadDesign(raw.design, path);
  const bots = loadBotsField(raw.bots, path);
  raw.bots = bots ? { path: bots.path } : undefined;
  return { pack: raw, bots: bots?.bundle ?? null };
}

export function loadPack(path: string): ProjectPack {
  return openPack(path).pack;
}

/**
 * Validate `bots.path` when the pack sets it.
 * The pack keeps the path only. The bundle cannot change a gate, a status write, or a merge.
 */
function loadBotsField(
  bots: { path?: unknown } | undefined,
  packFile: string,
): { path: string; bundle: BotBundle } | undefined {
  if (bots == null) return undefined;
  if (typeof bots !== "object" || Array.isArray(bots)) throw new Error(`${packFile} bots must be a path`);
  const rel = typeof bots.path === "string" ? bots.path.trim() : "";
  if (!rel) throw new Error(`${packFile} bots.path is required when bots is set`);
  if (isAbsolute(rel)) throw new Error(`${packFile} bots.path must be relative to the pack file`);
  const bundle = loadBotBundle(resolveBotRoot(packFile, rel));
  return { path: rel, bundle };
}

function loadDesign(design: DesignSpec | undefined, path: string): DesignSpec | undefined {
  if (!design) return undefined;
  const figmaTokenEnv = design.figmaTokenEnv?.trim() || "FIGMA_ACCESS_TOKEN";
  if (!Array.isArray(design.repos)) throw new Error(`${path} design.repos must be a list`);
  const repos = design.repos.map((repo) => {
    const name = repo?.name?.trim();
    const check = repo?.check?.trim();
    const checkName = repo?.checkName?.trim();
    const tokenFile = repo?.tokenFile?.trim();
    if (!name || !check || !checkName || !tokenFile) {
      throw new Error(`${path} design.repos entries need name, check, checkName, and tokenFile`);
    }
    const proofPaths = Array.isArray(repo.proofPaths)
      ? repo.proofPaths.map((item: string) => item.trim()).filter(Boolean)
      : [];
    if (repo.proofPaths != null && !Array.isArray(repo.proofPaths)) {
      throw new Error(`${path} design.repos proofPaths must be a list`);
    }
    return { name, check, checkName, tokenFile, proofPaths };
  });
  return { figmaTokenEnv, repos };
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
