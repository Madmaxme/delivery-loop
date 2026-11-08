import { createSign, timingSafeEqual } from "node:crypto";

import { assertCanonicalPath, STORED_ENV } from "../bots/canonical.ts";
import { registerSecret } from "../engine/redact.ts";
import { canonicalGithubRepo } from "../schema/pack.ts";
import type { AwsCallerClass, CanonicalPath, GithubRole } from "../bots/canonical.ts";
import type { CommitActor } from "../schema/pack.ts";
import type { FetchLike } from "./types.ts";

function repoKey(repoUrl: string): string {
  const match = repoUrl.match(/github\.com[:/]([^/]+)\/([^/#.]+)/i);
  if (match) return `${match[1]}/${match[2]}`.toLowerCase();
  return repoUrl.replace(/\.git$/, "").replace(/^\/+/, "").toLowerCase();
}

export type CommandResult = { status: number | null; stdout: string };

export type CommandSpawn = (command: string, env: NodeJS.ProcessEnv) => CommandResult;

export type CanonicalErrorClass =
  | "missing-policy"
  | "invalid-policy"
  | "non-canonical-credential"
  | "credential-unhealthy"
  | "mint-failed";

/**
 * Opaque handle. The secret, the policy, and the health evidence live in module-private maps.
 * Copying the handle does not copy the credential.
 */
export type CanonicalCredential = object;

type SecretRecord = {
  readonly api: string;
  readonly token: string;
  readonly accessKeyId: string;
  readonly sessionToken: string;
  readonly expiresAt: string;
  readonly policyKey: string;
  readonly role?: GithubRole;
  readonly identityKind?: CanonicalPath["identityKind"];
  readonly callerClass?: AwsCallerClass;
  readonly viewerId: string;
  readonly organizationId: string;
  readonly allowedPrincipalIds: readonly string[];
  readonly appId: string;
  readonly installationId: string;
  readonly repository: string;
  readonly accountId: string;
  readonly expectedArn: string;
  readonly oauthUrl: string;
  readonly healthCommand: string;
  readonly operations: readonly string[];
  readonly destinations: readonly string[];
  readonly expectedExtensionId: string;
  readonly legacy: boolean;
};

export type CredentialUse = {
  api: string;
  operation: string;
  destination: string;
  role?: GithubRole;
};

type HealthMark = {
  readonly token: string;
  readonly policyKey: string;
  readonly principalId: string;
};

const secrets = new WeakMap<CanonicalCredential, SecretRecord>();
const health = new WeakMap<CanonicalCredential, HealthMark>();

/** Names a child may inherit. Proxy and CA names match the git child env in #39. Tokens are not in this list. */
const ENV_ALLOW = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GIT_SSL_CAINFO",
];

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

function policyKey(path: CanonicalPath): string {
  return JSON.stringify({
    api: path.api,
    source: path.source,
    acquisition: path.acquisition,
    refresh: path.refresh,
    role: path.role ?? "",
    identityKind: path.identityKind ?? "",
    callerClass: path.callerClass ?? "",
    viewerId: path.viewerId ?? "",
    organizationId: path.organizationId ?? "",
    allowedPrincipalIds: [...(path.allowedPrincipalIds ?? [])],
    appId: path.appId ?? "",
    installationId: path.installation ?? "",
    repository: path.repository ?? "",
    accountId: path.accountId ?? "",
    expectedArn: path.expectedArn ?? "",
    oauthUrl: path.oauthUrl ?? "",
    healthCommand: path.healthCommand ?? "",
    mintCommand: path.mintCommand ?? "",
  });
}

function seal(record: SecretRecord): CanonicalCredential {
  const handle = Object.freeze(Object.create(null));
  secrets.set(handle, Object.freeze(record));
  return handle;
}

function recordOf(value: unknown, api?: string): SecretRecord {
  if (!value || typeof value !== "object") {
    throw new CanonicalPathError(
      "non-canonical-credential",
      api ?? "credential",
      `${api ?? "credential"} credential did not come from the canonical path`,
    );
  }
  const record = secrets.get(value);
  if (!record || (api && record.api !== api)) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      api ?? "credential",
      `${api ?? record?.api ?? "credential"} credential did not come from the canonical path`,
    );
  }
  return record;
}

export function assertCanonicalCredential(value: unknown, api: string): asserts value is CanonicalCredential {
  recordOf(value, api);
}

function scopesFor(path: CanonicalPath): { operations: string[]; destinations: string[] } {
  if (path.api === "linear") return { operations: ["graphql"], destinations: ["https://api.linear.app"] };
  if (path.api === "github" && path.role === "merger") return { operations: ["rest"], destinations: ["https://api.github.com"] };
  if (path.api === "github") {
    return { operations: ["rest", "graphql", "git", "gh"], destinations: ["https://api.github.com", "https://github.com"] };
  }
  if (path.api === "aws") return { operations: ["sts"], destinations: ["https://sts.amazonaws.com"] };
  if (path.api === "figma") return { operations: ["rest"], destinations: ["https://api.figma.com"] };
  const host = path.destinationHost?.trim() || `${path.api}.invalid`;
  const origin = host.includes("://") ? host : `https://${host}`;
  return { operations: ["call"], destinations: [origin] };
}

function originParts(value: string): { protocol: string; hostname: string; port: string } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:" && url.protocol !== "ssh:") return null;
  return { protocol: url.protocol, hostname: url.hostname.toLowerCase(), port: url.port };
}

/** Exact origin, or the same canonical GitHub repository. Substring hosts do not match. */
export function sameAuthorizedDestination(request: string, allowed: string): boolean {
  const requestRepo = canonicalGithubRepo(request);
  const allowedRepo = canonicalGithubRepo(allowed);
  if (requestRepo && allowedRepo) return requestRepo === allowedRepo;
  const left = originParts(request.includes("://") ? request : `https://${request}`);
  const right = originParts(allowed.includes("://") ? allowed : `https://${allowed}`);
  if (requestRepo && right?.hostname === "github.com" && right.protocol === "https:") return true;
  if (!left || !right) return false;
  return left.protocol === right.protocol && left.hostname === right.hostname && left.port === right.port;
}

export function credentialSecret(value: CanonicalCredential, use: CredentialUse): string {
  const record = recordOf(value, use.api);
  if (record.legacy) {
    throw new CanonicalPathError("non-canonical-credential", use.api, `${use.api} rejects a legacy credential`);
  }
  if (!isHealthy(value)) {
    throw new CanonicalPathError("credential-unhealthy", use.api, `${use.api} credential has not passed the health check`);
  }
  if (use.role && record.role && record.role !== use.role) {
    throw new CanonicalPathError("non-canonical-credential", use.api, `${use.api} ${use.role} credential is required`);
  }
  if (!record.operations.includes(use.operation)) {
    throw new CanonicalPathError("non-canonical-credential", use.api, `${use.api} ${use.operation} is not allowed for this credential`);
  }
  if (!record.destinations.some((allowed) => sameAuthorizedDestination(use.destination, allowed))) {
    throw new CanonicalPathError("non-canonical-credential", use.api, `${use.api} destination is not authorized`);
  }
  return record.token;
}

export function credentialRole(value: CanonicalCredential): GithubRole | undefined {
  return recordOf(value).role;
}

export function credentialCallerClass(value: CanonicalCredential): AwsCallerClass | undefined {
  return recordOf(value).callerClass;
}

export function credentialPrimaryDestination(value: CanonicalCredential): string {
  return recordOf(value).destinations[0] ?? "";
}

export function credentialAws(value: CanonicalCredential): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: string;
} {
  const record = recordOf(value, "aws");
  return {
    accessKeyId: record.accessKeyId,
    secretAccessKey: record.token,
    sessionToken: record.sessionToken,
    expiresAt: record.expiresAt,
  };
}

export function principalId(value: CanonicalCredential): string {
  return health.get(value)?.principalId ?? "";
}

export function isLegacyCredential(value: CanonicalCredential): boolean {
  return recordOf(value).legacy;
}

export function isHealthy(value: CanonicalCredential): boolean {
  const record = secrets.get(value);
  const mark = health.get(value);
  if (!record || !mark) return false;
  return mark.token === record.token && mark.policyKey === record.policyKey && mark.principalId.length > 0;
}

export function assertHealthy(value: CanonicalCredential): void {
  if (!isHealthy(value)) {
    const api = secrets.get(value)?.api ?? "credential";
    throw new CanonicalPathError("credential-unhealthy", api, `${api} credential has not passed the health check`);
  }
}

function markHealthy(value: CanonicalCredential, principal: string): void {
  const record = recordOf(value);
  if (!principal.trim()) {
    throw new CanonicalPathError("credential-unhealthy", record.api, `${record.api} identity evidence is absent`);
  }
  health.set(
    value,
    Object.freeze({ token: record.token, policyKey: record.policyKey, principalId: principal.trim() }),
  );
}

/** Process env reduced to names the child needs. Secrets are added by the caller. */
export function allowlistedEnv(base: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ENV_ALLOW) {
    if (base[name]) env[name] = base[name];
  }
  for (const [name, value] of Object.entries(extra)) env[name] = value;
  return env;
}

export function authorizationHeader(token: string): string {
  let rest = token.trim();
  if (!rest) throw new CanonicalPathError("non-canonical-credential", "credential", "credential is empty");
  while (/^bearer\s+/i.test(rest)) rest = rest.replace(/^bearer\s+/i, "").trim();
  if (!rest) throw new CanonicalPathError("non-canonical-credential", "credential", "credential is empty");
  return `Bearer ${rest}`;
}

function sameSecret(stored: string, minted: string): boolean {
  const compare = (left: string, right: string): boolean => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    if (a.length !== b.length) {
      timingSafeEqual(a, a);
      return false;
    }
    return timingSafeEqual(a, b);
  };
  if (compare(stored.trim(), minted.trim())) return true;
  try {
    return compare(authorizationHeader(stored), authorizationHeader(minted));
  } catch {
    return false;
  }
}

/**
 * Compare the minted value with stored copies that are actually present.
 * An env name that is unset is not a comparison. A vaultCommand is the declared source for that copy.
 */
export function uncheckedStoredNames(
  path: CanonicalPath,
  token: string,
  env: NodeJS.ProcessEnv,
  vaultCopies: Readonly<Record<string, string>>,
): void {
  if (path.acquisition !== "mint-per-process" && path.acquisition !== "oauth-client-credentials") return;
  const names = STORED_ENV[path.api] ?? [];
  for (const name of names) {
    const copies = [env[name], vaultCopies[name]];
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

function stamp(
  path: CanonicalPath,
  token: string,
  extras?: { accessKeyId?: string; sessionToken?: string; expiresAt?: string },
): CanonicalCredential {
  if (!token.trim()) throw new CanonicalPathError("mint-failed", path.api, `${path.api} credential is empty`);
  const handle = seal({
    api: path.api,
    token: token.trim(),
    accessKeyId: extras?.accessKeyId ?? "",
    sessionToken: extras?.sessionToken ?? "",
    expiresAt: extras?.expiresAt ?? path.expiresAt ?? "",
    policyKey: policyKey(path),
    role: path.role,
    identityKind: path.identityKind,
    callerClass: path.callerClass,
    viewerId: path.viewerId ?? "",
    organizationId: path.organizationId ?? "",
    allowedPrincipalIds: Object.freeze([...(path.allowedPrincipalIds ?? [])]),
    appId: path.appId ?? "",
    installationId: path.installation ?? "",
    repository: path.repository ?? "",
    accountId: path.accountId ?? "",
    expectedArn: path.expectedArn ?? "",
    oauthUrl: path.oauthUrl ?? "",
    healthCommand: path.healthCommand ?? "",
    operations: Object.freeze(scopesFor(path).operations),
    destinations: Object.freeze(scopesFor(path).destinations),
    expectedExtensionId: path.expectedIdentity ?? "",
    legacy: false,
  });
  registerSecret(token);
  return handle;
}

function signAppJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
  const data = `${header}.${payload}`;
  const sign = createSign("RSA-SHA256");
  sign.update(data);
  return `${data}.${sign.sign(pem).toString("base64url")}`;
}

async function mintInstallation(path: CanonicalPath, deps: ResolveDeps, copies: Record<string, string>): Promise<CanonicalCredential> {
  const pemName = path.signingKeyEnv ?? "";
  const pem = deps.env[pemName]?.trim() ?? "";
  if (!pem || !path.appId || !path.installation) {
    throw new CanonicalPathError("mint-failed", "github", "github installation mint is missing the app key");
  }
  const jwt = signAppJwt(path.appId, pem);
  const repoName = path.repository?.split("/")[1]?.trim() ?? "";
  const minted = await deps.fetch(`https://api.github.com/app/installations/${path.installation}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(repoName ? { repositories: [repoName] } : {}),
  });
  if (minted.status !== 201 && minted.status !== 200) {
    throw new CanonicalPathError("mint-failed", "github", "github installation mint failed", minted.status);
  }
  const body = (await minted.json()) as { token?: string };
  const token = body.token?.trim() ?? "";
  if (!token) throw new CanonicalPathError("mint-failed", "github", "github installation mint returned no token");
  uncheckedStoredNames(path, token, deps.env, copies);
  const credential = stamp(path, token);
  const names = await listInstallationRepos(deps.fetch, token);
  if (!path.repository || !names.includes(path.repository.toLowerCase())) {
    throw new CanonicalPathError("credential-unhealthy", "github", "github installation does not include the declared repository");
  }
  markHealthy(credential, `installation:${path.installation}`);
  return credential;
}

function nextLink(headers: Headers | undefined): string | null {
  const link = headers?.get?.("link") ?? "";
  const match = link.match(/<([^>]+)>;\s*rel="next"/);
  return match?.[1] ?? null;
}

async function listInstallationRepos(fetchImpl: FetchLike, token: string): Promise<string[]> {
  const names: string[] = [];
  let url: string | null = "https://api.github.com/installation/repositories?per_page=100";
  for (let page = 0; page < 50 && url; page += 1) {
    const listed = await fetchImpl(url, {
      headers: {
        Authorization: authorizationHeader(token),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
    });
    if (listed.status !== 200) {
      throw new CanonicalPathError("credential-unhealthy", "github", "github installation health check failed", listed.status);
    }
    const repos = (await listed.json()) as { repositories?: { full_name?: string }[] };
    for (const repo of repos.repositories ?? []) {
      if (repo.full_name) names.push(repo.full_name.toLowerCase());
    }
    url = nextLink(listed.headers);
  }
  return names;
}

function lastLine(stdout: string): string {
  return stdout.split(/\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

function declaredEnv(path: CanonicalPath, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const extra: Record<string, string> = {};
  for (const name of path.envRefs ?? []) {
    if (env[name]) extra[name] = env[name] ?? "";
  }
  return allowlistedEnv(env, extra);
}

async function vaultCopiesFor(path: CanonicalPath, deps: ResolveDeps): Promise<Record<string, string>> {
  const copies: Record<string, string> = { ...(deps.vaultCopies ?? {}) };
  if (!path.vaultCommand?.trim()) return copies;
  const result = deps.spawn(path.vaultCommand, allowlistedEnv(deps.env));
  if (result.status !== 0) throw new CanonicalPathError("mint-failed", path.api, `${path.api} vault read failed`);
  const value = lastLine(result.stdout ?? "");
  const name = (STORED_ENV[path.api] ?? [])[0];
  if (name && value) copies[name] = value;
  return copies;
}

export type ResolveDeps = {
  env: NodeJS.ProcessEnv;
  spawn: CommandSpawn;
  fetch: FetchLike;
  /** In-memory copies. A stored value that is not here and not in env is not compared. */
  vaultCopies?: Readonly<Record<string, string>>;
};

function parseJson(stdout: string): unknown {
  return JSON.parse(stdout.trim());
}

function parseAwsMint(stdout: string, path: CanonicalPath): { token: string; accessKeyId: string; sessionToken: string; expiresAt: string } {
  let json: { AccessKeyId?: string; SecretAccessKey?: string; SessionToken?: string; Expiration?: string };
  try {
    json = parseJson(stdout) as typeof json;
  } catch {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} mint did not return STS credentials`);
  }
  const accessKeyId = json.AccessKeyId?.trim() ?? "";
  const token = json.SecretAccessKey?.trim() ?? "";
  const sessionToken = json.SessionToken?.trim() ?? "";
  const expiresAt = json.Expiration?.trim() ?? "";
  if (!accessKeyId || !token || !sessionToken || !expiresAt) {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} mint did not return STS credentials`);
  }
  return { token, accessKeyId, sessionToken, expiresAt };
}

function mintedFromCommand(path: CanonicalPath, deps: ResolveDeps, copies: Record<string, string>): CanonicalCredential {
  const result = deps.spawn(path.mintCommand ?? "", declaredEnv(path, deps.env));
  if (result.status !== 0) throw new CanonicalPathError("mint-failed", path.api, `${path.api} mint failed`);
  if (path.api === "aws") {
    const minted = parseAwsMint(result.stdout ?? "", path);
    uncheckedStoredNames(path, minted.token, deps.env, copies);
    return stamp(path, minted.token, minted);
  }
  const token = lastLine(result.stdout ?? "");
  if (!token) throw new CanonicalPathError("mint-failed", path.api, `${path.api} mint failed`);
  uncheckedStoredNames(path, token, deps.env, copies);
  return stamp(path, token);
}

async function mintedFromOAuth(path: CanonicalPath, deps: ResolveDeps, copies: Record<string, string>): Promise<CanonicalCredential> {
  const [idName, secretName] = path.envRefs ?? [];
  const clientId = deps.env[idName]?.trim() ?? "";
  const clientSecret = deps.env[secretName]?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} oauth client credentials are missing`);
  }
  if (!path.oauthUrl) throw new CanonicalPathError("invalid-policy", path.api, `${path.api} oauthUrl is required`);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: path.scope?.trim() || "read,write",
  });
  const response = await deps.fetch(path.oauthUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  if (response.status !== 200) {
    throw new CanonicalPathError("mint-failed", path.api, `${path.api} oauth mint failed`, response.status);
  }
  const json = (await response.json()) as { access_token?: string; expires_in?: number };
  const token = json.access_token?.trim() ?? "";
  if (!token) throw new CanonicalPathError("mint-failed", path.api, `${path.api} oauth mint returned no access token`);
  registerSecret(deps.env[secretName]);
  uncheckedStoredNames(path, token, deps.env, copies);
  return stamp(path, token, { expiresAt: json.expires_in ? String(json.expires_in) : "" });
}

function readDeclared(path: CanonicalPath, deps: ResolveDeps): CanonicalCredential {
  const names = path.envRefs ?? [];
  const secretName = names.find((name) => name.includes("SECRET")) ?? names[names.length - 1] ?? "";
  const token = deps.env[secretName]?.trim() ?? "";
  if (!token) throw new CanonicalPathError("mint-failed", path.api, `${path.api} credential is empty`);
  const accessKeyId = deps.env.AWS_ACCESS_KEY_ID?.trim() ?? deps.env[names[0] ?? ""]?.trim() ?? "";
  const sessionToken = deps.env.AWS_SESSION_TOKEN?.trim() ?? "";
  return stamp(path, token, { accessKeyId, sessionToken, expiresAt: path.expiresAt ?? deps.env.AWS_SESSION_EXPIRATION?.trim() ?? "" });
}

export async function resolveCredential(path: CanonicalPath, deps: ResolveDeps): Promise<CanonicalCredential> {
  try {
    assertCanonicalPath(path, path.api);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CanonicalPathError("invalid-policy", path.api, message);
  }
  const copies = await vaultCopiesFor(path, deps);
  if (path.api === "github" && path.identityKind === "installation") return mintInstallation(path, deps, copies);
  if (path.acquisition === "oauth-client-credentials") return mintedFromOAuth(path, deps, copies);
  if (path.acquisition === "mint-per-process") return mintedFromCommand(path, deps, copies);
  if (path.acquisition === "stored-static") return readDeclared(path, deps);
  throw new CanonicalPathError("invalid-policy", path.api, `non-canonical direct path for ${path.api}`);
}

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
  if (path.identityKind === "installation") {
    throw new CanonicalPathError("invalid-policy", "github", "github installation credentials are minted with the app key");
  }
  if (path.acquisition !== "mint-per-process") {
    throw new CanonicalPathError("invalid-policy", path.api, `non-canonical direct path for ${path.api}`);
  }
  if (path.vaultCommand) {
    throw new CanonicalPathError("invalid-policy", path.api, `${path.api} vaultCommand requires resolveCredential`);
  }
  return mintedFromCommand(path, { ...deps, fetch: async () => { throw new CanonicalPathError("mint-failed", path.api, `${path.api} mint failed`); } }, {
    ...(deps.vaultCopies ?? {}),
  });
}

export async function probeLinearViewer(credential: CanonicalCredential, fetchImpl: FetchLike): Promise<void> {
  const record = recordOf(credential, "linear");
  const response = await fetchImpl("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: authorizationHeader(record.token),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: "{ viewer { id name organization { id } } }" }),
  });
  if (response.status !== 200) {
    throw new CanonicalPathError("credential-unhealthy", "linear", "linear viewer health check failed", response.status);
  }
  const json = (await response.json()) as {
    data?: { viewer?: { id?: string; name?: string; organization?: { id?: string } } };
    errors?: { message?: string }[];
  };
  const viewerId = json.data?.viewer?.id?.trim() ?? "";
  const organizationId = json.data?.viewer?.organization?.id?.trim() ?? "";
  if (json.errors?.length || !viewerId || !organizationId) {
    throw new CanonicalPathError("credential-unhealthy", "linear", "linear viewer identity evidence is absent", response.status);
  }
  if (viewerId !== record.viewerId || organizationId !== record.organizationId) {
    throw new CanonicalPathError("credential-unhealthy", "linear", "linear viewer identity does not match the canonical path");
  }
  markHealthy(credential, `viewer:${viewerId}`);
}

export async function probeGithub(credential: CanonicalCredential, fetchImpl: FetchLike): Promise<void> {
  if (isHealthy(credential)) return;
  const record = recordOf(credential, "github");
  const headers = {
    Authorization: authorizationHeader(record.token),
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (record.identityKind === "installation") {
    const response = await fetchImpl(`https://api.github.com/repos/${record.repository}/installation`, { headers });
    if (response.status !== 200) {
      throw new CanonicalPathError("credential-unhealthy", "github", "github installation health check failed", response.status);
    }
    const json = (await response.json()) as { id?: number; app_id?: number };
    if (json.id === undefined || json.app_id === undefined) {
      throw new CanonicalPathError("credential-unhealthy", "github", "github installation identity evidence is absent");
    }
    if (String(json.id) !== record.installationId || String(json.app_id) !== record.appId) {
      throw new CanonicalPathError("credential-unhealthy", "github", "github installation identity does not match the canonical path");
    }
    markHealthy(credential, `installation:${json.id}`);
    return;
  }
  const response = await fetchImpl("https://api.github.com/user", { headers });
  if (response.status !== 200) {
    throw new CanonicalPathError("credential-unhealthy", "github", "github user health check failed", response.status);
  }
  const json = (await response.json()) as { id?: number; login?: string };
  if (typeof json.id !== "number") {
    throw new CanonicalPathError("credential-unhealthy", "github", "github user identity evidence is absent");
  }
  const id = String(json.id);
  if (!record.allowedPrincipalIds.includes(id)) {
    throw new CanonicalPathError("non-canonical-credential", "github", "github user id is not an allowed principal");
  }
  markHealthy(credential, `user:${id}`);
}

export function authorizeOpenerRepo(credential: CanonicalCredential, repoUrl: string, actors: readonly CommitActor[]): void {
  assertHealthy(credential);
  if (isLegacyCredential(credential)) return;
  const principal = principalId(credential);
  const key = repoKey(repoUrl);
  const actor = actors.find((item) => item.repos.some((repo) => repoKey(repo) === key));
  if (!actor?.id) {
    throw new CanonicalPathError("non-canonical-credential", "github", "github commit actor id is absent");
  }
  if (principal !== `user:${actor.id}`) {
    throw new CanonicalPathError(
      "non-canonical-credential",
      "github",
      `token user id is ${principal}, commit actor id is user:${actor.id}`,
    );
  }
}

export function assertDistinctPrincipals(opener: CanonicalCredential, merger: CanonicalCredential): void {
  assertHealthy(opener);
  assertHealthy(merger);
  const left = principalId(opener);
  const right = principalId(merger);
  if (!left || !right) {
    throw new CanonicalPathError("credential-unhealthy", "github", "github identity evidence is absent");
  }
  if (left === right || !left.startsWith("user:") || !right.startsWith("installation:")) {
    throw new CanonicalPathError("non-canonical-credential", "github", "github opener and merger are not distinct principals");
  }
}

export async function probeExtension(
  credential: CanonicalCredential,
  fetchImpl: FetchLike,
  _env: NodeJS.ProcessEnv = {},
): Promise<void> {
  const record = recordOf(credential);
  const origin = record.destinations.find((item) => item.startsWith("https://"));
  if (!origin || !record.expectedExtensionId) {
    throw new CanonicalPathError("credential-unhealthy", record.api, `${record.api} probe is UNVERIFIED`);
  }
  const response = await fetchImpl(`${origin}/identity`, {
    headers: { Authorization: authorizationHeader(record.token) },
    redirect: "manual",
  });
  if (response.status >= 300 && response.status < 400) {
    throw new CanonicalPathError("credential-unhealthy", record.api, `${record.api} probe redirected`);
  }
  if (response.status !== 200) {
    throw new CanonicalPathError("credential-unhealthy", record.api, `${record.api} identity probe failed`, response.status);
  }
  const json = (await response.json()) as { id?: string };
  if (!json.id?.trim() || json.id.trim() !== record.expectedExtensionId) {
    throw new CanonicalPathError("credential-unhealthy", record.api, `${record.api} identity does not match the canonical path`);
  }
  markHealthy(credential, `${record.api}:${record.expectedExtensionId}`);
}

export function awsChildEnv(credential: CanonicalCredential, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const aws = credentialAws(credential);
  return allowlistedEnv(base, {
    AWS_ACCESS_KEY_ID: aws.accessKeyId,
    AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
    AWS_SESSION_TOKEN: aws.sessionToken,
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_SDK_LOAD_CONFIG: "0",
  });
}

export async function probeAws(credential: CanonicalCredential, spawn: CommandSpawn, env: NodeJS.ProcessEnv): Promise<void> {
  const record = recordOf(credential, "aws");
  const result = spawn("aws sts get-caller-identity", awsChildEnv(credential, env));
  if (result.status !== 0) {
    throw new CanonicalPathError("credential-unhealthy", "aws", "aws caller health check failed");
  }
  let json: { Account?: string; Arn?: string };
  try {
    json = parseJson(result.stdout ?? "") as { Account?: string; Arn?: string };
  } catch {
    json = {};
  }
  if (!json.Account || !json.Arn) {
    throw new CanonicalPathError("credential-unhealthy", "aws", "aws identity evidence is absent");
  }
  if (json.Account !== record.accountId || json.Arn !== record.expectedArn) {
    throw new CanonicalPathError("credential-unhealthy", "aws", "aws caller identity does not match the canonical path");
  }
  markHealthy(credential, `aws:${json.Account}`);
}

export type PreparedCredentials = {
  enforced: boolean;
  linear?: CanonicalCredential;
  opener?: CanonicalCredential;
  merger?: CanonicalCredential;
  extensions: Record<string, CanonicalCredential>;
  aws: Partial<Record<AwsCallerClass, CanonicalCredential>>;
  actors: readonly CommitActor[];
};

export async function prepareDispatchCredentials(input: {
  paths: readonly CanonicalPath[];
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  spawn: CommandSpawn;
  vaultCopies?: Readonly<Record<string, string>>;
  actors?: readonly CommitActor[];
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
  const prepared: PreparedCredentials = { enforced: true, extensions: {}, aws: {}, actors: input.actors ?? [] };
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
    await probeGithub(prepared.opener, input.fetch);
    const allowed = new Set(opener.allowedPrincipalIds ?? []);
    const known = (input.actors ?? []).map((actor) => actor.id).filter((id): id is string => Boolean(id));
    if (known.length === 0 || known.some((id) => !allowed.has(id))) {
      throw new CanonicalPathError("non-canonical-credential", "github", "trusted commit actor id is not an allowed principal");
    }
    prepared.merger = await resolveCredential(merger, deps);
    await probeGithub(prepared.merger, input.fetch);
    assertDistinctPrincipals(prepared.opener, prepared.merger);
  }
  for (const api of input.extensions ?? []) {
    const path = input.paths.find((item) => item.api === api);
    if (!path) throw new CanonicalPathError("missing-policy", api, `missing canonical path for ${api}`);
    const credential = await resolveCredential(path, deps);
    await probeExtension(credential, input.fetch, input.env);
    prepared.extensions[api] = credential;
  }
  for (const callerClass of input.awsClasses ?? []) {
    const path = input.paths.find((item) => item.api === "aws" && item.callerClass === callerClass);
    if (!path) throw new CanonicalPathError("missing-policy", "aws", `missing canonical path for aws ${callerClass}`);
    const credential = await resolveCredential(path, deps);
    await probeAws(credential, input.spawn, input.env);
    prepared.aws[callerClass] = credential;
  }
  return prepared;
}
