import { assertCanonicalPath, REJECTED_GITHUB_LOGINS, STORED_ENV } from "../bots/canonical.ts";
import type { AwsCallerClass, CanonicalPath, GithubRole } from "../bots/canonical.ts";
import type { FetchLike } from "./types.ts";

export type CommandResult = { status: number | null; stdout: string };

export type CommandSpawn = (command: string) => CommandResult;

export type CanonicalErrorClass =
  | "missing-policy"
  | "invalid-policy"
  | "non-canonical-credential"
  | "credential-unhealthy"
  | "mint-failed";

const brand = Symbol("canonical-credential");

export type CanonicalCredential = {
  readonly [brand]: true;
  readonly api: string;
  readonly token: string;
  readonly source: string;
  readonly acquisition: CanonicalPath["acquisition"];
  readonly refresh: CanonicalPath["refresh"];
  readonly role?: GithubRole;
  readonly identityKind?: CanonicalPath["identityKind"];
  readonly callerClass?: AwsCallerClass;
  readonly expectedIdentity?: string;
  readonly accessKeyId?: string;
  readonly expiresIn?: number;
  readonly healthCommand?: string;
};

export class CanonicalPathError extends Error {
  readonly errorClass: CanonicalErrorClass;
  readonly api: string;
  readonly status?: number;

  constructor(errorClass: CanonicalErrorClass, api: string, message: string, status?: number) {
    super(message);
    this.name = "CanonicalPathError";
    this.errorClass = errorClass;
    this.api = api;
    this.status = status;
  }
}

const healthy = new WeakSet<CanonicalCredential>();

export function isHealthy(credential: CanonicalCredential): boolean {
  return healthy.has(credential);
}

function markHealthy(credential: CanonicalCredential): void {
  healthy.add(credential);
}

export function assertCanonicalCredential(value: unknown, api: string): asserts value is CanonicalCredential {
  if (!value || typeof value !== "object" || !(brand in value)) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      api,
      `${api} credential did not come from the canonical path`,
    );
  }
  const credential = value as CanonicalCredential;
  if (credential.api !== api) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      api,
      `${api} credential did not come from the canonical path`,
    );
  }
}

export function assertHealthy(credential: CanonicalCredential): void {
  if (!healthy.has(credential)) {
    throw new CanonicalPathError(
      "credential-unhealthy",
      credential.api,
      `${credential.api} credential has not passed the health check`,
    );
  }
}

/** One scheme. A value that already says Bearer is not prefixed again. */
export function authorizationHeader(token: string): string {
  let rest = token.trim();
  if (!rest) {
    throw new CanonicalPathError("non-canonical-credential", "credential", "credential is empty");
  }
  while (/^bearer\s+/i.test(rest)) rest = rest.replace(/^bearer\s+/i, "").trim();
  if (!rest) {
    throw new CanonicalPathError("non-canonical-credential", "credential", "credential is empty");
  }
  return `Bearer ${rest}`;
}

function sameSecret(stored: string, minted: string): boolean {
  if (stored.trim() === minted.trim()) return true;
  try {
    return authorizationHeader(stored) === authorizationHeader(minted);
  } catch {
    return false;
  }
}

function assertNotStored(
  path: CanonicalPath,
  token: string,
  env: NodeJS.ProcessEnv,
  vaultCopies: Readonly<Record<string, string>> | undefined,
): void {
  if (path.acquisition !== "mint-per-process" && path.acquisition !== "oauth-client-credentials") return;
  const names = STORED_ENV[path.api] ?? [];
  for (const name of names) {
    const copies = [env[name], vaultCopies?.[name]];
    for (const copy of copies) {
      if (copy && sameSecret(copy, token)) {
        throw new CanonicalPathError(
          "non-canonical-credential",
          path.api,
          `${path.api} minted credential matches the stored copy`,
        );
      }
    }
  }
}

function stamp(path: CanonicalPath, token: string, extras?: { expiresIn?: number; accessKeyId?: string }): CanonicalCredential {
  if (!token.trim()) {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} credential is empty`);
  }
  return {
    [brand]: true,
    api: path.api,
    token: token.trim(),
    source: path.source,
    acquisition: path.acquisition,
    refresh: path.refresh,
    role: path.role,
    identityKind: path.identityKind,
    callerClass: path.callerClass,
    expectedIdentity: path.expectedIdentity,
    healthCommand: path.healthCommand,
    expiresIn: extras?.expiresIn,
    accessKeyId: extras?.accessKeyId,
  };
}

function lastLine(stdout: string): string {
  return stdout.split(/\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

export type ResolveDeps = {
  env: NodeJS.ProcessEnv;
  spawn: CommandSpawn;
  fetch: FetchLike;
  vaultCopies?: Readonly<Record<string, string>>;
};

function mintedFromCommand(path: CanonicalPath, deps: ResolveDeps): CanonicalCredential {
  const result = deps.spawn(path.mintCommand ?? "");
  const token = lastLine(result.stdout ?? "");
  if (result.status !== 0 || !token) {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} mint failed`);
  }
  assertNotStored(path, token, deps.env, deps.vaultCopies);
  return stamp(path, token);
}

async function mintedFromOAuth(path: CanonicalPath, deps: ResolveDeps): Promise<CanonicalCredential> {
  const [idName, secretName] = path.envRefs ?? [];
  const clientId = deps.env[idName]?.trim() ?? "";
  const clientSecret = deps.env[secretName]?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} oauth client credentials are missing`);
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: path.scope?.trim() || "read,write",
  });
  const response = await deps.fetch(path.oauthUrl ?? "", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (!response.ok) {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} oauth mint failed`, response.status);
  }
  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  const token = json.access_token?.trim() ?? "";
  if (!token) throw new CanonicalPathError("mint-failed", path.api, `${path.api} oauth mint returned no access token`);
  assertNotStored(path, token, deps.env, deps.vaultCopies);
  return stamp(path, token, { expiresIn: json.expires_in });
}

function readDeclared(path: CanonicalPath, deps: ResolveDeps): CanonicalCredential {
  const names = path.envRefs ?? [];
  const secretName = names[names.length - 1] ?? "";
  const token = deps.env[secretName]?.trim() ?? "";
  if (!token) throw new CanonicalPathError("mint-failed", path.api, `${path.api} credential is empty`);
  const accessKeyId = names.length > 1 ? deps.env[names[0]]?.trim() : undefined;
  return stamp(path, token, { accessKeyId });
}

/** Resolve one declared path. A stored key is not a fallback when the path says mint. */
export async function resolveCredential(path: CanonicalPath, deps: ResolveDeps): Promise<CanonicalCredential> {
  try {
    assertCanonicalPath(path, path.api);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CanonicalPathError("invalid-policy", path.api, message);
  }
  if (path.acquisition === "oauth-client-credentials") return mintedFromOAuth(path, deps);
  if (path.acquisition === "mint-per-process") return mintedFromCommand(path, deps);
  if (path.acquisition === "workflow-token" || path.acquisition === "stored-static") return readDeclared(path, deps);
  throw new CanonicalPathError("invalid-policy", path.api, `non-canonical direct path for ${path.api}`);
}

/** Sync mint used by a login refresh. OAuth client credentials use `resolveCredential`. */
export function resolveMintedCredential(
  path: CanonicalPath,
  deps: { env: NodeJS.ProcessEnv; spawn: CommandSpawn; vaultCopies?: Readonly<Record<string, string>> },
): CanonicalCredential {
  try {
    assertCanonicalPath(path, path.api);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CanonicalPathError("invalid-policy", path.api, message);
  }
  if (path.acquisition !== "mint-per-process") {
    throw new CanonicalPathError("invalid-policy", path.api, `non-canonical direct path for ${path.api}`);
  }
  return mintedFromCommand(path, { ...deps, fetch: async () => { throw new CanonicalPathError("mint-failed", path.api, `${path.api} mint failed`); } });
}

export async function probeLinearViewer(credential: CanonicalCredential, fetchImpl: FetchLike): Promise<void> {
  assertCanonicalCredential(credential, "linear");
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(credential.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "{ viewer { id name } }" }),
  });
  if (!response.ok) {
    throw new CanonicalPathError("credential-unhealthy", "linear", "linear viewer health check failed", response.status);
  }
  const json = (await response.json()) as {
    data?: { viewer?: { id?: string; name?: string } };
    errors?: { message?: string }[];
  };
  if (json.errors?.length) {
    throw new CanonicalPathError("credential-unhealthy", "linear", "linear viewer health check failed", response.status);
  }
  const name = json.data?.viewer?.name?.trim() ?? "";
  if (!name || name !== credential.expectedIdentity) {
    throw new CanonicalPathError("credential-unhealthy", "linear", "linear viewer identity does not match the canonical path");
  }
  markHealthy(credential);
}

export async function probeGithub(
  credential: CanonicalCredential,
  fetchImpl: FetchLike,
  opts?: { expectedLogin?: string | null },
): Promise<void> {
  assertCanonicalCredential(credential, "github");
  const headers = {
    Authorization: authorizationHeader(credential.token),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (credential.identityKind === "installation") {
    const response = await fetchImpl("https://api.github.com/installation/repositories?per_page=1", { headers });
    if (!response.ok) {
      throw new CanonicalPathError(
        "credential-unhealthy",
        "github",
        "github installation health check failed",
        response.status,
      );
    }
    markHealthy(credential);
    return;
  }
  if (credential.identityKind === "workflow") {
    const response = await fetchImpl("https://api.github.com/rate_limit", { headers });
    if (!response.ok) {
      throw new CanonicalPathError("credential-unhealthy", "github", "github workflow health check failed", response.status);
    }
    markHealthy(credential);
    return;
  }
  const response = await fetchImpl("https://api.github.com/user", { headers });
  if (!response.ok) {
    throw new CanonicalPathError("credential-unhealthy", "github", "github user health check failed", response.status);
  }
  const json = (await response.json()) as { login?: string };
  const login = json.login?.trim() ?? "";
  if (!login) {
    throw new CanonicalPathError("credential-unhealthy", "github", "github user health check failed", response.status);
  }
  if (REJECTED_GITHUB_LOGINS.some((rejected) => rejected.toLowerCase() === login.toLowerCase())) {
    throw new CanonicalPathError("non-canonical-credential", "github", `${login} is not an opener or a merger`);
  }
  if (opts?.expectedLogin && login !== opts.expectedLogin) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      "github",
      `token login is ${login}, commit actor is ${opts.expectedLogin}`,
    );
  }
  markHealthy(credential);
}

export async function probeExtension(credential: CanonicalCredential, spawn: CommandSpawn): Promise<void> {
  assertCanonicalCredential(credential, credential.api);
  const command = credential.healthCommand?.trim() ?? "";
  if (!command) {
    throw new CanonicalPathError("credential-unhealthy", credential.api, `${credential.api} health check failed`);
  }
  const result = spawn(command);
  if (result.status !== 0) {
    throw new CanonicalPathError("credential-unhealthy", credential.api, `${credential.api} health check failed`);
  }
  markHealthy(credential);
}

export async function probeAws(credential: CanonicalCredential, spawn: CommandSpawn): Promise<void> {
  assertCanonicalCredential(credential, "aws");
  const result = spawn("aws sts get-caller-identity");
  if (result.status !== 0) {
    throw new CanonicalPathError("credential-unhealthy", "aws", "aws caller health check failed");
  }
  markHealthy(credential);
}

const AMBIENT = ["GH_TOKEN", "GITHUB_TOKEN", "LINEAR_API_KEY", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_ACCESS_KEY_ID"];

/** Child env for git, gh, and aws. Ambient tokens are removed. The issued token is the only one set. */
export function scopedChildEnv(base: NodeJS.ProcessEnv, credential: CanonicalCredential | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const name of AMBIENT) delete env[name];
  if (!credential) return env;
  assertCanonicalCredential(credential, credential.api);
  assertHealthy(credential);
  if (credential.api === "github") {
    env.GH_TOKEN = credential.token;
    env.GITHUB_TOKEN = credential.token;
    return env;
  }
  if (credential.api === "aws") {
    if (credential.acquisition === "stored-static") {
      if (credential.accessKeyId) env.AWS_ACCESS_KEY_ID = credential.accessKeyId;
      env.AWS_SECRET_ACCESS_KEY = credential.token;
    } else {
      env.AWS_SESSION_TOKEN = credential.token;
      if (credential.accessKeyId) env.AWS_ACCESS_KEY_ID = credential.accessKeyId;
    }
  }
  return env;
}

export type PreparedCredentials = {
  linear?: CanonicalCredential;
  opener?: CanonicalCredential;
  merger?: CanonicalCredential;
  extensions: Record<string, CanonicalCredential>;
  aws: Partial<Record<AwsCallerClass, CanonicalCredential>>;
};

/**
 * Mint, then Linear viewer, then the GitHub probe for each identity.
 * A later probe does not run when an earlier one fails.
 */
export async function prepareDispatchCredentials(input: {
  paths: readonly CanonicalPath[];
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  spawn: CommandSpawn;
  vaultCopies?: Readonly<Record<string, string>>;
  expectedLogin?: string | null;
  linear?: boolean;
  github?: boolean;
  extensions?: readonly string[];
  awsClasses?: readonly AwsCallerClass[];
}): Promise<PreparedCredentials> {
  const deps: ResolveDeps = {
    env: input.env,
    fetch: input.fetch,
    spawn: input.spawn,
    vaultCopies: input.vaultCopies,
  };
  const prepared: PreparedCredentials = { extensions: {}, aws: {} };
  if (input.linear) {
    const path = input.paths.find((item) => item.api === "linear");
    if (!path) throw new CanonicalPathError("missing-policy", "linear", "missing canonical path for linear");
    prepared.linear = await resolveCredential(path, deps);
    await probeLinearViewer(prepared.linear, input.fetch);
  }
  if (input.github) {
    const opener = input.paths.find((item) => item.api === "github" && item.role === "opener");
    const merger = input.paths.find((item) => item.api === "github" && item.role === "merger");
    if (!opener) throw new CanonicalPathError("missing-policy", "github", "missing canonical path for github opener");
    if (!merger) throw new CanonicalPathError("missing-policy", "github", "missing canonical path for github merger");
    prepared.opener = await resolveCredential(opener, deps);
    await probeGithub(prepared.opener, input.fetch, { expectedLogin: input.expectedLogin });
    prepared.merger = await resolveCredential(merger, deps);
    await probeGithub(prepared.merger, input.fetch, {});
  }
  for (const api of input.extensions ?? []) {
    const path = input.paths.find((item) => item.api === api);
    if (!path) throw new CanonicalPathError("missing-policy", api, `missing canonical path for ${api}`);
    const credential = await resolveCredential(path, deps);
    await probeExtension(credential, input.spawn);
    prepared.extensions[api] = credential;
  }
  for (const callerClass of input.awsClasses ?? []) {
    const path = input.paths.find((item) => item.api === "aws" && item.callerClass === callerClass);
    if (!path) throw new CanonicalPathError("missing-policy", "aws", `missing canonical path for aws ${callerClass}`);
    const credential = await resolveCredential(path, deps);
    await probeAws(credential, input.spawn);
    prepared.aws[callerClass] = credential;
  }
  return prepared;
}

export function mintCredential(path: CanonicalPath, token: string, env: NodeJS.ProcessEnv = {}): CanonicalCredential {
  return resolveMintedCredential(path, {
    env,
    spawn: () => ({ status: 0, stdout: token }),
  });
}
