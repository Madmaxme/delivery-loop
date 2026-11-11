import { readFileSync } from "node:fs";
import { parse } from "yaml";

import { GHA_HOSTED_PAGE_BUDGET_MINUTES } from "../engine/linear-harness-policy.ts";
import { journeySpecPattern } from "../../scripts/journey-proof.mjs";

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

/** A UI repo whose check is required when a ticket has no Figma frame. */
export type DesignRepo = {
  name: string;
  /** Exact command the work order Validation must include. */
  check: string;
  /** GitHub check-run name on the pull request head. */
  checkName: string;
  /** Token file read into a repair prompt when the ticket has no Figma frame. */
  tokenFile: string;
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
export type TrackerKind = "linear" | "github" | "jira";

/** Who edits the code. The runner starts this and waits. */
export type WorkerKind = "cursor" | "claude" | "codex" | "copilot" | "http";

/** Env var names for the cursor worker. The values are not stored in the pack. */
export type WorkerKeys = {
  primary: string;
  fallback: string;
};

export const DEFAULT_CURSOR_PRIMARY_ENV = "CURSOR_API_KEY";
export const DEFAULT_CURSOR_FALLBACK_ENV = "CURSOR_API_KEY_FALLBACK";

/** Pause between http worker status reads. A coding run is tens of minutes. */
export const DEFAULT_WORKER_HTTP_POLL_MS = 15_000;

/**
 * Stop waiting for an http worker after this long.
 * One hour stays inside the hosted job budget and covers a coding run.
 */
export const DEFAULT_WORKER_HTTP_MAX_WAIT_MS = 60 * 60 * 1000;

/** Hosted job budget. `workerHttp.maxWaitMs` cannot exceed this. */
export const WORKER_HTTP_JOB_BUDGET_MS = GHA_HOSTED_PAGE_BUDGET_MINUTES * 60_000;

/** Header name to an env var, or the source `mint` or `gh-token`. Values are not secrets. */
export type WorkerHttpHeaders = Record<string, string>;

/**
 * File the loop writes before start, then reads until the worker finishes.
 * `path` contains `{id}`. The loop replaces it and sends the resolved path.
 */
export type WorkerHttpStatusStore = {
  kind: "forge";
  /** `owner/name`. */
  repo: string;
  branch: string;
  path: string;
};

/**
 * Start signal written as a forge issue. Requires `statusStore`.
 * `assignee` is applied in a second call so the forge emits an assignment.
 */
export type WorkerHttpRequest = {
  kind: "forge-issue";
  /** `owner/name`. */
  repo: string;
  assignee: string;
  labels?: string[];
};

export type WorkerHttp = {
  /** Absent when `request` opens a forge issue instead. */
  startUrl?: string;
  /**
   * `{id}` is replaced with the request id. Without it, the id is the last path segment.
   * Absent when `statusStore` is set. Reads then use the store.
   */
  statusUrl?: string;
  pollMs?: number;
  maxWaitMs?: number;
  startHeaders?: WorkerHttpHeaders;
  statusHeaders?: WorkerHttpHeaders;
  /** When set, the loop seeds and reads this file through the forge. */
  statusStore?: WorkerHttpStatusStore;
  /**
   * When set, start opens a forge issue instead of posting `startUrl`.
   * Requires `statusStore`.
   */
  request?: WorkerHttpRequest;
};

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

const TRACKERS: readonly TrackerKind[] = ["linear", "github", "jira"];
const WORKERS: readonly WorkerKind[] = ["cursor", "claude", "codex", "copilot", "http"];
const FORGES: readonly ForgeKind[] = ["github", "git"];
const CHECKS: readonly CheckKind[] = ["workflow", "command"];
const RUNNERS: readonly RunnerKind[] = ["gha", "local"];
export type Eligibility = { mode: "command"; command: string } | { mode: "none" };

export type LandingStrategy = "pull-request" | "fast-forward";

export type PromotionStage = {
  id: string;
  target: string;
  authorization: "deliver" | "ship";
  promoteCommand: string;
  repos: string[];
  refs?: Record<string, string[]>;
  verifyCommand: string;
  continueCommand?: string;
  parkSuccess?: boolean;
  writeStatus?: boolean;
};

export type JiraConfig = {
  apiBaseUrl: string;
  /** Env var containing the full Authorization header value; passed through unchanged. */
  authHeaderEnv: string;
  intakeJql: string;
  approvalFieldId: string;
};

export type ProjectPack = {
  schemaVersion: 2;
  tracker: TrackerKind;
  worker: WorkerKind;
  /**
   * Cursor model id. The launch passes `{ id }` and no other model fields.
   * Absent omits the model, so the account default is used.
   */
  workerModel?: string;
  /** `github` opens pull requests. `git` merges the branch with git. */
  forge?: ForgeKind;
  /** `workflow` polls the quality workflow. `command` runs `qualityCommand`. */
  check?: CheckKind;
  /** What executes the loop. `gha` dispatches GitHub Actions. `local` runs here. */
  runner?: RunnerKind;
  /** owner/repo used when the tracker is GitHub Issues. */
  githubRepo?: string;
  /** Jira REST settings. Secrets remain in `authHeaderEnv`'s environment value. */
  jira?: JiraConfig;
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
  /**
   * Env var names for the cursor worker's key slots. Values stay in the
   * environment. `primary` defaults to CURSOR_API_KEY. `fallback` defaults
   * to CURSOR_API_KEY_FALLBACK. An empty fallback value leaves the launch
   * on the primary slot.
   */
  workerKeys?: WorkerKeys;
  /**
   * HTTP worker. `pollMs` defaults to 15000. `maxWaitMs` defaults to 3600000.
   * `maxWaitMs` stays inside the hosted job budget (360 minutes).
   * Header maps name an env var, or the source `mint` or `gh-token`.
   * The header value is not stored here.
   * `statusStore` seeds a pending file through the forge before start.
   * Without it, status reads use `statusUrl`.
   * `request` opens a forge issue after that seed. It replaces `startUrl`.
   */
  workerHttp?: WorkerHttp;
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
  eligibility: Eligibility;
  landingStrategy: LandingStrategy;
  promotionStages: PromotionStage[];
  status: {
    intake: string;
    complete: string;
    shipped?: string;
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
   * Resolves `**Symbols:**` lines. The engine passes one `repo/path#symbol`
   * per line on stdin. A non-zero exit is an incomplete packet.
   */
  symbolsCommand?: string;
  /**
   * Prints `**Journey proof:**` tokens on stdout. The engine appends that
   * stdout to the build receipt. The author does not write the token.
   */
  journeyCommand?: string;
  /**
   * Path pattern for an end-to-end journey spec, relative to the repo.
   * A route-test proof matches this pattern. Absent uses
   * `{e2e,integration_test,journey}/**`. A directory name is that tree.
   * A spec outside the pattern is not journey proof.
   */
  journeySpec?: string;
  /**
   * Retries a ship or promote step that reports transient.
   * `maxAttempts` defaults to 3. `maxWaitMs` defaults to 60000.
   * Waits start at one second and double. The sum stops at `maxWaitMs`.
   */
  transient?: { maxAttempts?: number; maxWaitMs?: number };
  /**
   * Heal attempts per failure type, counted from v2 `owner-heal` state markers.
   * `maxAttempts` is the default. `caps` overrides one type.
   * Types: quality-red, merge-conflict, promote-failed, ship-failed,
   * quality-pending, quality-unscheduled, runner-blocked, other.
   * Absent means 3.
   */
  heal?: {
    maxAttempts?: number;
    caps?: Record<string, number>;
  };
};

export function defaultStatus(): { intake: string; hold: string } {
  return { intake: "Todo", hold: "Hold" };
}

/** Status that keeps a ticket incomplete. Installs override `status.hold`. */
export function holdStatus(pack: ProjectPack): string {
  const named = pack.status.hold?.trim();
  return named || defaultStatus().hold;
}

export function closedStates(pack: ProjectPack): string[] {
  const named = (pack.status.closed ?? []).map((s) => s.trim()).filter(Boolean);
  return named.length > 0 ? named : ["Canceled", "Duplicate"];
}

export function loadPack(path: string): ProjectPack {
  const parsed = parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown } | null;
  if (!parsed || parsed.schemaVersion !== 2) {
    throw new Error("delivery-loop.yaml requires schemaVersion: 2; migrate the client pack before running Delivery Loop v2");
  }
  const raw = parsed as ProjectPack;
  const legacy = raw as unknown as Record<string, unknown>;
  const legacyStatus = legacy.status && typeof legacy.status === "object" ? legacy.status as Record<string, unknown> : {};
  if (legacy.dev !== undefined || legacy.ship !== undefined || "dev" in legacyStatus || "prod" in legacyStatus) {
    throw new Error(`${path} contains v1 promotion fields; migrate them to promotionStages`);
  }
  if (!Array.isArray(raw.repos) || raw.repos.length === 0) {
    throw new Error(`${path} needs at least one repo`);
  }
  ignoreBots(raw, path);
  if (!TRACKERS.includes(raw.tracker)) {
    throw new Error(`${path} tracker must be linear, github, or jira`);
  }
  if (!WORKERS.includes(raw.worker)) {
    throw new Error(`${path} worker must be cursor, claude, codex, copilot, or http`);
  }
  if (raw.tracker === "jira") raw.jira = loadJira(raw.jira, path);
  if (!raw.eligibility) throw new Error(`${path} needs an explicit eligibility choice`);
  raw.eligibility = loadEligibility(raw.eligibility, path);
  if (raw.landingStrategy !== "pull-request" && raw.landingStrategy !== "fast-forward") {
    throw new Error(`${path} needs landingStrategy: pull-request or fast-forward`);
  }
  if (!Array.isArray(raw.promotionStages)) {
    throw new Error(`${path} needs an explicit promotionStages list`);
  }
  raw.promotionStages = loadPromotionStages(raw.promotionStages, path);
  if (!raw.status || typeof raw.status.complete !== "string" || !raw.status.complete.trim()) {
    throw new Error(`${path} needs status.complete`);
  }
  if (raw.status.shipped !== undefined &&
    (typeof raw.status.shipped !== "string" || !raw.status.shipped.trim())) {
    throw new Error(`${path} status.shipped must be a non-empty status`);
  }
  if (raw.promotionStages.some((stage) => stage.authorization === "ship" && stage.writeStatus) &&
    !raw.status.shipped?.trim()) {
    throw new Error(`${path} needs status.shipped when a ship stage writes status`);
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
  raw.journeySpec = journeySpecPattern(raw.journeySpec);
  raw.invariantsFile = raw.invariantsFile || "invariants.md";
  raw.prompts = {
    ground: raw.prompts?.ground ?? [],
    build: raw.prompts?.build ?? [],
  };
  raw.invariantHeadings = raw.invariantHeadings ?? [];
  raw.design = loadDesign(raw.design, path);
  raw.workerKeys = loadWorkerKeys(raw.workerKeys, path);
  raw.workerModel = loadWorkerModel(raw.workerModel, path);
  raw.workerHttp = loadWorkerHttp(raw.workerHttp, raw.worker, path);
  raw.transient = loadTransient(raw.transient, path);
  return raw;
}

function loadEligibility(value: unknown, path: string): Eligibility {
  if (value && typeof value === "object" && "mode" in value && value.mode === "none") {
    return { mode: "none" };
  }
  if (value && typeof value === "object" && "mode" in value && value.mode === "command" &&
    "command" in value && typeof value.command === "string" && value.command.trim()) {
    return { mode: "command", command: value.command.trim() };
  }
  throw new Error(`${path} eligibility must be { mode: command, command } or { mode: none }`);
}

function loadJira(value: unknown, path: string): JiraConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} tracker jira needs jira settings`);
  const config = value as Partial<JiraConfig>;
  const apiBaseUrl = typeof config.apiBaseUrl === "string" ? config.apiBaseUrl.trim() : "";
  const authHeaderEnv = typeof config.authHeaderEnv === "string" ? config.authHeaderEnv.trim() : "";
  const intakeJql = typeof config.intakeJql === "string" ? config.intakeJql.trim() : "";
  const approvalFieldId = typeof config.approvalFieldId === "string" ? config.approvalFieldId.trim() : "";
  let base: URL;
  try {
    base = new URL(apiBaseUrl);
  } catch {
    throw new Error(`${path} jira.apiBaseUrl must be an HTTPS URL`);
  }
  if (base.protocol !== "https:" || !base.host || base.username || base.password || base.search || base.hash) {
    throw new Error(`${path} jira.apiBaseUrl must be an HTTPS URL without credentials, query, or fragment`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(authHeaderEnv)) {
    throw new Error(`${path} jira.authHeaderEnv must name an environment variable`);
  }
  if (!intakeJql) throw new Error(`${path} jira.intakeJql must be non-empty`);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(approvalFieldId)) {
    throw new Error(`${path} jira.approvalFieldId must be a Jira field ID`);
  }
  return { apiBaseUrl: base.toString().replace(/\/$/, ""), authHeaderEnv, intakeJql, approvalFieldId };
}

function loadPromotionStages(value: unknown, path: string): PromotionStage[] {
  if (!Array.isArray(value)) throw new Error(`${path} promotionStages must be a list`);
  const ids = new Set<string>();
  const targets = new Set<string>();
  let shipStageSeen = false;
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${path} promotionStages[${index}] must be an object`);
    const stage = item as Partial<PromotionStage>;
    const id = typeof stage.id === "string" ? stage.id.trim() : "";
    const target = typeof stage.target === "string" ? stage.target.trim() : "";
    const promoteCommand = typeof stage.promoteCommand === "string" ? stage.promoteCommand.trim() : "";
    const verifyCommand = typeof stage.verifyCommand === "string" ? stage.verifyCommand.trim() : "";
    if (!id || !target || !promoteCommand || !verifyCommand || !Array.isArray(stage.repos) ||
      stage.repos.length === 0 || stage.repos.some((repo) => typeof repo !== "string" || !repo.trim())) {
      throw new Error(`${path} promotionStages[${index}] needs id, target, commands, and repos`);
    }
    if (ids.has(id) || targets.has(target)) throw new Error(`${path} promotion stage IDs and targets must be unique`);
    ids.add(id);
    targets.add(target);
    if (stage.authorization !== "deliver" && stage.authorization !== "ship") {
      throw new Error(`${path} promotionStages[${index}].authorization must be deliver or ship`);
    }
    if (stage.authorization === "ship") {
      shipStageSeen = true;
      if (typeof stage.parkSuccess !== "boolean" || typeof stage.writeStatus !== "boolean") {
        throw new Error(`${path} ship stages require parkSuccess and writeStatus`);
      }
    } else if (shipStageSeen) {
      throw new Error(`${path} deliver stages must precede ship stages`);
    }
    if (stage.continueCommand !== undefined &&
      (typeof stage.continueCommand !== "string" || !stage.continueCommand.trim())) {
      throw new Error(`${path} promotionStages[${index}].continueCommand must be non-empty`);
    }
    if (stage.refs !== undefined && (!stage.refs || typeof stage.refs !== "object" || Array.isArray(stage.refs) ||
      Object.values(stage.refs).some((refs) => !Array.isArray(refs) || refs.some((ref) => typeof ref !== "string" || !ref.trim())))) {
      throw new Error(`${path} promotionStages[${index}].refs must map repos to ref lists`);
    }
    return {
      ...stage,
      id,
      target,
      promoteCommand,
      verifyCommand,
      repos: stage.repos.map((repo) => repo.trim()),
    } as PromotionStage;
  });
}

function loadTransient(
  value: ProjectPack["transient"],
  path: string,
): ProjectPack["transient"] {
  const maxAttempts = value?.maxAttempts ?? 3;
  const maxWaitMs = value?.maxWaitMs ?? 60_000;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(`${path} transient.maxAttempts is a positive integer`);
  }
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 0) {
    throw new Error(`${path} transient.maxWaitMs is a non-negative integer`);
  }
  return { maxAttempts, maxWaitMs };
}

const WORKER_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** A model id, or absent when the install leaves the account default. */
export function loadWorkerModel(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !WORKER_MODEL_ID.test(value.trim())) {
    throw new Error(`${path} workerModel is a model id`);
  }
  return value.trim();
}

/** Env var names for the cursor worker. Absent names use the generic slots. */
export function workerKeyNames(pack: Pick<ProjectPack, "workerKeys">): WorkerKeys {
  return {
    primary: pack.workerKeys?.primary?.trim() || DEFAULT_CURSOR_PRIMARY_ENV,
    fallback: pack.workerKeys?.fallback?.trim() || DEFAULT_CURSOR_FALLBACK_ENV,
  };
}

const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const HEADER_SOURCE = /^(?:mint|gh-token|[A-Za-z_][A-Za-z0-9_]*)$/;

function loadHeaderMap(
  value: WorkerHttpHeaders | undefined,
  path: string,
  key: string,
): WorkerHttpHeaders | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} workerHttp.${key} maps a header to an env var`);
  }
  const out: WorkerHttpHeaders = {};
  for (const [name, source] of Object.entries(value)) {
    if (!HEADER_NAME.test(name) || typeof source !== "string" || !HEADER_SOURCE.test(source.trim())) {
      throw new Error(`${path} workerHttp.${key} maps a header to an env var or mint or gh-token`);
    }
    out[name] = source.trim();
  }
  return out;
}

function loadWorkerHttp(
  value: WorkerHttp | undefined,
  worker: WorkerKind,
  path: string,
): WorkerHttp | undefined {
  if (!value) {
    if (worker === "http") throw new Error(`${path} worker http needs workerHttp.startUrl and workerHttp.statusUrl`);
    return undefined;
  }
  const startUrl = value.startUrl?.trim() ?? "";
  const statusUrl = value.statusUrl?.trim() ?? "";
  const statusStore = loadStatusStore(value.statusStore, path);
  const request = loadWorkerRequest(value.request, statusStore, path);
  if (worker === "http" && !startUrl && !request) {
    throw new Error(`${path} worker http needs workerHttp.startUrl or workerHttp.request`);
  }
  if (worker === "http" && !statusUrl && !statusStore) {
    throw new Error(`${path} worker http needs workerHttp.statusUrl or workerHttp.statusStore`);
  }
  if (statusUrl.includes("?") && !statusUrl.includes("{id}")) {
    throw new Error(`${path} workerHttp.statusUrl needs {id} when it has a query`);
  }
  const pollMs = value.pollMs ?? DEFAULT_WORKER_HTTP_POLL_MS;
  const maxWaitMs = value.maxWaitMs ?? DEFAULT_WORKER_HTTP_MAX_WAIT_MS;
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error(`${path} workerHttp.pollMs is a positive integer`);
  }
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 1) {
    throw new Error(`${path} workerHttp.maxWaitMs is a positive integer`);
  }
  if (maxWaitMs < pollMs) {
    throw new Error(`${path} workerHttp.maxWaitMs is at least workerHttp.pollMs`);
  }
  if (maxWaitMs > WORKER_HTTP_JOB_BUDGET_MS) {
    throw new Error(`${path} workerHttp.maxWaitMs stays inside the job budget`);
  }
  return {
    ...(startUrl ? { startUrl } : {}),
    ...(statusUrl ? { statusUrl } : {}),
    pollMs,
    maxWaitMs,
    startHeaders: loadHeaderMap(value.startHeaders, path, "startHeaders"),
    statusHeaders: loadHeaderMap(value.statusHeaders, path, "statusHeaders"),
    ...(statusStore ? { statusStore } : {}),
    ...(request ? { request } : {}),
  };
}

const FORGE_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function loadWorkerRequest(
  value: WorkerHttpRequest | undefined,
  statusStore: WorkerHttpStatusStore | undefined,
  path: string,
): WorkerHttpRequest | undefined {
  if (value === undefined || value === null) return undefined;
  if (!statusStore) throw new Error(`${path} workerHttp.request needs workerHttp.statusStore`);
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} workerHttp.request is a forge issue`);
  }
  const kind = value.kind?.trim();
  const repo = value.repo?.trim() ?? "";
  const assignee = value.assignee?.trim() ?? "";
  if (kind !== "forge-issue" || !STORE_REPO.test(repo) || !FORGE_LOGIN.test(assignee)) {
    throw new Error(`${path} workerHttp.request is a forge issue`);
  }
  const labels = (value.labels ?? []).map((label) => (typeof label === "string" ? label.trim() : ""));
  if (labels.some((label) => !label || /[\r\n]/.test(label))) {
    throw new Error(`${path} workerHttp.request labels are names`);
  }
  return { kind: "forge-issue", repo, assignee, ...(labels.length ? { labels } : {}) };
}

const STORE_REPO = /^[^/\s]+\/[^/\s]+$/;

function loadStatusStore(
  value: WorkerHttpStatusStore | undefined,
  path: string,
): WorkerHttpStatusStore | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} workerHttp.statusStore is a forge file`);
  }
  const kind = value.kind?.trim();
  const repo = value.repo?.trim() ?? "";
  const branch = value.branch?.trim() ?? "";
  const file = value.path?.trim() ?? "";
  if (kind !== "forge" || !STORE_REPO.test(repo) || !branch || /\s/.test(branch) || branch.includes("..")) {
    throw new Error(`${path} workerHttp.statusStore is a forge file`);
  }
  if (!file.includes("{id}") || file.startsWith("/") || file.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`${path} workerHttp.statusStore.path contains {id}`);
  }
  return { kind: "forge", repo, branch, path: file };
}

function loadWorkerKeys(keys: WorkerKeys | undefined, path: string): WorkerKeys {
  const named = workerKeyNames({ workerKeys: keys });
  for (const name of [named.primary, named.fallback]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`${path} workerKeys names an env var`);
    }
  }
  return named;
}

/** A leftover bots key is ignored with a warning. */
function ignoreBots(raw: object, packFile: string): void {
  if (!Object.hasOwn(raw, "bots")) return;
  console.warn(`${packFile}: bots is ignored`);
  delete (raw as { bots?: unknown }).bots;
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
    return { name, check, checkName, tokenFile };
  });
  return { figmaTokenEnv, repos };
}

export function unblockingStates(pack: ProjectPack): string[] {
  return [
    pack.status.complete,
    ...(pack.status.shipped ? [pack.status.shipped] : []),
    ...closedStates(pack),
  ];
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
