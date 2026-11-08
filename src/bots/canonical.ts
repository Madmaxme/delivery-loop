import type { BotDefinition } from "./types.ts";

/**
 * How a process obtains a credential.
 * `stored-static` is a direct path. It is rejected for Linear and GitHub.
 * AWS runtime may declare it. An extension API may declare it.
 * A mint or OAuth path must not read the stored key.
 */
export const ACQUISITIONS = ["mint-per-process", "oauth-client-credentials", "stored-static"] as const;

export type Acquisition = (typeof ACQUISITIONS)[number];

export const REFRESHES = ["per-process", "static"] as const;

export type Refresh = (typeof REFRESHES)[number];

export const GITHUB_ROLES = ["opener", "merger"] as const;

export type GithubRole = (typeof GITHUB_ROLES)[number];

/** `user` is GET /user. `installation` is the installation token. A workflow token is not a merger. */
export const IDENTITY_KINDS = ["user", "installation"] as const;

export type IdentityKind = (typeof IDENTITY_KINDS)[number];

/** One AWS source for each class. The classes are generic. A client names its own account in its own repo. */
export const AWS_CALLER_CLASSES = ["agent", "actions", "runtime"] as const;

export type AwsCallerClass = (typeof AWS_CALLER_CLASSES)[number];

export const BUILTIN_APIS = ["linear", "github", "aws"] as const;

export type BuiltinApi = (typeof BUILTIN_APIS)[number];

/** Stored env names a mint must not return and must not list as inputs. */
export const STORED_ENV: Record<string, readonly string[]> = {
  linear: ["LINEAR_API_KEY"],
  github: ["GH_TOKEN", "GITHUB_TOKEN"],
  aws: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"],
};

export type CanonicalPath = {
  api: string;
  source: string;
  acquisition: Acquisition;
  refresh: Refresh;
  role?: GithubRole;
  identityKind?: IdentityKind;
  callerClass?: AwsCallerClass;
  mintCommand?: string;
  envRefs?: string[];
  oauthUrl?: string;
  scope?: string;
  /** Display only. The health check matches viewerId and organizationId. */
  expectedIdentity?: string;
  viewerId?: string;
  organizationId?: string;
  actorRef?: string;
  /** GitHub user ids the opener token is allowed to be. Immutable config, not a login blacklist. */
  allowedPrincipalIds?: string[];
  appId?: string;
  installation?: string;
  repository?: string;
  accountId?: string;
  expectedArn?: string;
  /** Prints the stored copy to stdout. Absent means an env value that is unset is not compared. */
  vaultCommand?: string;
  expiresAt?: string;
  healthCommand?: string;
  signingKeyEnv?: string;
  destinationHost?: string;
};

const REF = /^ref:[a-z0-9][a-z0-9-]*$/;
const API_NAME = /^[a-z][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/;

const IDENTITY_API: Record<string, string> = {
  "ref:forge-github": "github",
  "ref:forge-git": "github",
  "ref:tracker-linear": "linear",
  "ref:tracker-github": "github",
  "ref:worker-cursor": "cursor",
  "ref:worker-claude": "anthropic",
  "ref:worker-codex": "openai",
  "ref:worker-copilot": "github",
  "ref:worker-http": "http",
  "ref:runner-gha": "github",
  "ref:commit-actor": "github",
  "ref:merge-review": "github",
};

export type UsedApi = {
  api: string;
  role?: GithubRole;
  callerClass?: AwsCallerClass;
};

/** APIs a bundle actually names. The policy id is required even when this list is empty. */
export function apisUsed(definitions: readonly BotDefinition[]): UsedApi[] {
  const used = new Map<string, UsedApi>();
  const add = (entry: UsedApi) => {
    const key = `${entry.api}:${entry.role ?? ""}:${entry.callerClass ?? ""}`;
    used.set(key, entry);
  };
  for (const definition of definitions) {
    const tools = definition.tools ?? [];
    const identities = definition.identities ?? [];
    if (tools.some((tool) => tool.adapter === "forge") || identities.some((item) => item.adapter === "forge")) {
      add({ api: "github", role: "opener" });
      add({ api: "github", role: "merger" });
    }
    if (
      tools.some((tool) => tool.adapter === "tracker") ||
      identities.some((item) => item.ref === "ref:tracker-linear" || item.ref === "ref:tracker-github")
    ) {
      add({ api: "linear" });
      add({ api: "github", role: "opener" });
    }
    for (const identity of identities) {
      const api = IDENTITY_API[identity.ref];
      if (!api || api === "github" || api === "linear") continue;
      add({ api });
    }
    for (const tool of tools) {
      if (tool.adapter === "connector") add({ api: tool.operation });
    }
  }
  return [...used.values()];
}

function fail(at: string, message: string): never {
  throw new Error(`${at}: ${message}`);
}

function isDirectStoredInput(api: string, name: string): boolean {
  return (STORED_ENV[api] ?? []).includes(name);
}

/** One path object. A direct stored key for Linear or GitHub is rejected here. */
export function assertCanonicalPath(path: CanonicalPath, at: string): void {
  if (!path || typeof path !== "object") fail(at, "canonical path is missing");
  if (!API_NAME.test(path.api ?? "")) fail(at, "canonical path api is invalid");
  if (!REF.test(path.source ?? "")) fail(at, "canonical path source must be a ref");
  if (!ACQUISITIONS.includes(path.acquisition)) fail(at, `canonical path acquisition is invalid`);
  if (!REFRESHES.includes(path.refresh)) fail(at, "canonical path refresh is invalid");
  if (path.mintCommand !== undefined && (path.mintCommand.includes("\n") || path.mintCommand.includes("\0") || !path.mintCommand.trim())) {
    fail(at, "canonical path mintCommand is invalid");
  }
  for (const name of path.envRefs ?? []) {
    if (!ENV_NAME.test(name)) fail(at, `canonical path env ref ${name} is invalid`);
  }
  if (path.api === "linear" || path.api === "github" || (path.api === "aws" && path.callerClass !== "runtime")) {
    if (path.acquisition === "stored-static") {
      fail(at, `non-canonical direct path for ${path.api}`);
    }
  }
  if (path.healthCommand !== undefined && BUILTIN_APIS.includes(path.api as BuiltinApi)) {
    fail(at, `non-canonical direct path for ${path.api}`);
  }
  if (path.api === "linear") {
    if (path.acquisition !== "oauth-client-credentials" && path.acquisition !== "mint-per-process") {
      fail(at, "non-canonical direct path for linear");
    }
    if (path.refresh !== "per-process") fail(at, "linear refresh must be per-process");
    if (!path.viewerId?.trim() || !path.organizationId?.trim()) fail(at, "linear viewerId and organizationId are required");
    if (path.expectedIdentity !== undefined && !IDENTITY.test(path.expectedIdentity)) {
      fail(at, "linear expectedIdentity is invalid");
    }
    if (path.acquisition === "oauth-client-credentials") {
      if (!path.oauthUrl || !/^https:\/\//.test(path.oauthUrl)) fail(at, "linear oauthUrl must be https");
      if ((path.envRefs ?? []).length !== 2) fail(at, "linear oauth client env refs are required");
    }
    if (path.acquisition === "mint-per-process" && !path.mintCommand?.trim()) {
      fail(at, "linear mintCommand is required");
    }
    for (const name of path.envRefs ?? []) {
      if (isDirectStoredInput("linear", name)) fail(at, "non-canonical direct path for linear");
    }
    return;
  }
  if (path.api === "github") {
    if (!path.role || !GITHUB_ROLES.includes(path.role)) fail(at, "github role must be opener or merger");
    if (!path.identityKind || !IDENTITY_KINDS.includes(path.identityKind)) fail(at, "github identityKind is required");
    if (path.refresh !== "per-process") fail(at, "github refresh must be per-process");
    if (path.role === "opener") {
      if (path.identityKind !== "user") fail(at, "non-canonical direct path for github opener");
      if (path.acquisition !== "mint-per-process") fail(at, "non-canonical direct path for github opener");
      if (!path.mintCommand?.trim()) fail(at, "github opener mintCommand is required");
      if (!REF.test(path.actorRef ?? "")) fail(at, "github opener actorRef is required");
      const ids = path.allowedPrincipalIds ?? [];
      if (ids.length < 1 || ids.some((id) => !/^[0-9]+$/.test(id))) {
        fail(at, "github opener allowedPrincipalIds must be numeric user ids");
      }
    }
    if (path.role === "merger") {
      if (path.identityKind !== "installation") fail(at, "github merger must be an installation token");
      if (path.acquisition !== "mint-per-process") fail(at, "non-canonical direct path for github merger");
      if (!path.mintCommand?.trim()) fail(at, "github merger mintCommand is required");
      if (!/^[0-9]+$/.test(path.appId ?? "") || !/^[0-9]+$/.test(path.installation ?? "")) {
        fail(at, "github merger appId and installation are required");
      }
      if (!/^[^/\s]+\/[^/\s]+$/.test(path.repository ?? "")) fail(at, "github merger repository is required");
      if (!/^[A-Z][A-Z0-9_]*$/.test(path.signingKeyEnv ?? "")) fail(at, "github merger signingKeyEnv is required");
    }
    for (const name of path.envRefs ?? []) {
      if (isDirectStoredInput("github", name)) fail(at, "non-canonical direct path for github");
    }
    return;
  }
  if (path.api === "aws") {
    if (!path.callerClass || !AWS_CALLER_CLASSES.includes(path.callerClass)) {
      fail(at, "aws callerClass must be agent, actions, or runtime");
    }
    if (path.callerClass === "runtime") {
      if (path.acquisition !== "stored-static" && path.acquisition !== "mint-per-process") {
        fail(at, "non-canonical direct path for aws");
      }
      if (path.acquisition === "stored-static") {
        if (path.refresh !== "static") fail(at, "aws runtime stored refresh must be static");
        if ((path.envRefs ?? []).length < 1) fail(at, "aws runtime env refs are required");
      }
    } else if (path.acquisition !== "mint-per-process") {
      fail(at, `non-canonical direct path for aws ${path.callerClass}`);
    }
    if (!/^[0-9]{12}$/.test(path.accountId ?? "")) fail(at, "aws accountId is required");
    if (!path.expectedArn?.startsWith("arn:aws:")) fail(at, "aws expectedArn is required");
    if (path.acquisition === "mint-per-process") {
      if (path.refresh !== "per-process") fail(at, "aws mint refresh must be per-process");
      if (!path.mintCommand?.trim()) fail(at, "aws mintCommand is required");
      for (const name of path.envRefs ?? []) {
        if (isDirectStoredInput("aws", name)) fail(at, "non-canonical direct path for aws");
      }
    }
    return;
  }
  if (!path.healthCommand?.trim() || path.healthCommand.includes("\n")) {
    fail(at, `${path.api} healthCommand is required`);
  }
  if (!path.expectedIdentity?.trim()) fail(at, `${path.api} expectedIdentity is required`);
  if (!path.destinationHost?.trim()) fail(at, `${path.api} destinationHost is required`);
  if (path.acquisition === "stored-static") {
    if (path.refresh !== "static") fail(at, `${path.api} stored refresh must be static`);
    if ((path.envRefs ?? []).length !== 1) fail(at, `${path.api} stored env ref is required`);
    return;
  }
  if (path.refresh !== "per-process") fail(at, `${path.api} refresh must be per-process`);
  if (path.acquisition === "oauth-client-credentials") {
    if (!path.oauthUrl || !/^https:\/\//.test(path.oauthUrl)) fail(at, `${path.api} oauthUrl must be https`);
    if ((path.envRefs ?? []).length !== 2) fail(at, `${path.api} oauth client env refs are required`);
    return;
  }
  if (path.acquisition !== "mint-per-process" || !path.mintCommand?.trim()) {
    fail(at, `${path.api} mintCommand is required`);
  }
}

/**
 * Every API the bundle uses needs a path. GitHub opener and merger need different sources.
 * AWS caller classes need different sources. A missing path cannot be skipped.
 */
export function assertCanonicalPaths(
  definitions: readonly BotDefinition[],
  paths: readonly CanonicalPath[] | undefined,
  at: string,
): void {
  const list = paths ?? [];
  list.forEach((path, index) => assertCanonicalPath(path, `${at}/${index}`));
  const seen = new Set<string>();
  for (const path of list) {
    const key = `${path.api}:${path.role ?? ""}:${path.callerClass ?? ""}`;
    if (seen.has(key)) fail(at, `duplicate canonical path for ${path.api}`);
    seen.add(key);
  }
  const github = list.filter((path) => path.api === "github");
  const sources = github.map((path) => path.source);
  if (new Set(sources).size !== sources.length) fail(at, "github opener and merger must use different sources");
  const aws = list.filter((path) => path.api === "aws");
  const awsSources = aws.map((path) => path.source);
  if (new Set(awsSources).size !== awsSources.length) fail(at, "aws caller classes must use different sources");
  for (const needed of apisUsed(definitions)) {
    const found = list.some((path) => {
      if (path.api !== needed.api) return false;
      if (needed.role && path.role !== needed.role) return false;
      if (needed.callerClass && path.callerClass !== needed.callerClass) return false;
      return true;
    });
    if (!found) {
      const suffix = needed.role ? ` ${needed.role}` : "";
      fail(at, `missing canonical path for ${needed.api}${suffix}`);
    }
  }
}
