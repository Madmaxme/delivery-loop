import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Stage commands receive the job's AWS session. That session is one hour,
 * and a promotion command runs after the worker wait. An expired session
 * is replaced from the job's OIDC token before the command starts.
 * The replacement is not printed.
 */

const EXPIRED = /ExpiredToken|security token included in the request is expired/i;
const OIDC_AUDIENCE = "sts.amazonaws.com";

export type AwsRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => string;

let rememberedRoleArn: string | undefined;

export function resetAwsRoleMemory(): void {
  rememberedRoleArn = undefined;
}

/** `assumed-role/name/session` becomes the IAM role ARN. A path stays in the role name. */
export function roleArnFromAssumedArn(arn: string): string | null {
  const match = /^arn:aws:sts::(\d{12}):assumed-role\/(.+)\/([^/]+)$/.exec(arn.trim());
  if (!match) return null;
  const roleName = match[2];
  if (!roleName || roleName.includes("..")) return null;
  return `arn:aws:iam::${match[1]}:role/${roleName}`;
}

function commandDetail(error: unknown): string {
  const err = error as { stderr?: string | Buffer; message?: string };
  const stderr = typeof err.stderr === "string"
    ? err.stderr
    : err.stderr && typeof err.stderr.toString === "function"
      ? err.stderr.toString("utf8")
      : "";
  return (stderr || err.message || "").trim();
}

function defaultRun(args: readonly string[], env: NodeJS.ProcessEnv): string {
  return execFileSync("aws", args, {
    encoding: "utf8",
    env,
    timeout: 20_000,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function probeSession(env: NodeJS.ProcessEnv, run: AwsRunner): { ok: true; arn: string } | { ok: false; expired: boolean } {
  try {
    const raw = run(["sts", "get-caller-identity", "--output", "json"], env);
    const parsed = JSON.parse(raw) as { Arn?: unknown };
    if (typeof parsed.Arn !== "string" || !parsed.Arn.trim()) return { ok: false, expired: false };
    return { ok: true, arn: parsed.Arn };
  } catch (error) {
    return { ok: false, expired: EXPIRED.test(commandDetail(error)) };
  }
}

function oidcReady(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim());
}

export function awsRoleForRefresh(env: NodeJS.ProcessEnv): string {
  return env.AWS_ROLE_ARN?.trim() || rememberedRoleArn || "";
}

function remember(arn: string): void {
  const role = roleArnFromAssumedArn(arn);
  if (role) rememberedRoleArn = role;
}

/** Same request the Actions OIDC client sends. The token stays out of the error text. */
export function githubOidcRequest(requestUrl: string, requestToken: string): { url: string; headers: Record<string, string> } {
  const url = new URL(requestUrl);
  url.searchParams.set("audience", OIDC_AUDIENCE);
  return {
    url: url.toString(),
    headers: {
      Authorization: `Bearer ${requestToken}`,
      Accept: "application/json",
      "User-Agent": "actions/oidc-client",
    },
  };
}

export async function readGithubOidcToken(env: NodeJS.ProcessEnv): Promise<string> {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL?.trim() ?? "";
  const requestToken = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN?.trim() ?? "";
  if (!requestUrl || !requestToken) throw new Error("aws session refresh failed");
  const request = githubOidcRequest(requestUrl, requestToken);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(request.url, { headers: request.headers });
      if (!response.ok) continue;
      const body = await response.json() as { value?: unknown };
      if (typeof body.value === "string" && body.value.trim()) return body.value;
    } catch {
      // The next attempt uses the same job request token.
    }
  }
  throw new Error("aws session refresh failed");
}

function assumeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const name of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_SECURITY_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
  ]) {
    delete next[name];
  }
  return next;
}

function parseAssumedCredentials(raw: string): { accessKeyId: string; secretAccessKey: string; sessionToken: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("aws session refresh failed");
  }
  const creds = (parsed as { Credentials?: Record<string, unknown> }).Credentials;
  const accessKeyId = creds?.AccessKeyId;
  const secretAccessKey = creds?.SecretAccessKey;
  const sessionToken = creds?.SessionToken;
  if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string" || typeof sessionToken !== "string") {
    throw new Error("aws session refresh failed");
  }
  if (!accessKeyId || !secretAccessKey || !sessionToken) throw new Error("aws session refresh failed");
  return { accessKeyId, secretAccessKey, sessionToken };
}

/**
 * The CLI requires `WebIdentityToken` and ignores `--web-identity-token-file`.
 * The token is a field in the input file, not a process argument.
 */
export function assumeRoleInput(roleArn: string, token: string): string {
  return JSON.stringify({
    RoleArn: roleArn,
    RoleSessionName: "delivery-loop",
    WebIdentityToken: token,
  });
}

function assumeRole(roleArn: string, token: string, env: NodeJS.ProcessEnv, run: AwsRunner): string {
  const dir = mkdtempSync(join(tmpdir(), "aws-session-"));
  const file = join(dir, "input.json");
  try {
    writeFileSync(file, assumeRoleInput(roleArn, token), { mode: 0o600 });
    return run([
      "sts",
      "assume-role-with-web-identity",
      "--cli-input-json",
      `file://${file}`,
      "--output",
      "json",
    ], assumeEnv(env));
  } catch {
    throw new Error("aws session refresh failed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function ensureAwsSession(
  env: NodeJS.ProcessEnv,
  io: { run?: AwsRunner; readOidc?: (env: NodeJS.ProcessEnv) => Promise<string> } = {},
): Promise<void> {
  if (!env.AWS_SESSION_TOKEN?.trim() || !env.AWS_ACCESS_KEY_ID?.trim()) return;
  const run = io.run ?? defaultRun;
  const probe = probeSession(env, run);
  if (probe.ok) {
    remember(probe.arn);
    return;
  }
  if (!probe.expired || !oidcReady(env)) return;
  const roleArn = awsRoleForRefresh(env);
  if (!roleArn) return;
  const readOidc = io.readOidc ?? readGithubOidcToken;
  try {
    const token = await readOidc(env);
    const raw = assumeRole(roleArn, token, env, run);
    const creds = parseAssumedCredentials(raw);
    env.AWS_ACCESS_KEY_ID = creds.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = creds.secretAccessKey;
    env.AWS_SESSION_TOKEN = creds.sessionToken;
  } catch (error) {
    if (error instanceof Error && error.message === "aws session refresh failed") throw error;
    throw new Error("aws session refresh failed");
  }
}
