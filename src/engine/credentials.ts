import { fileURLToPath } from "node:url";

import { interpretMintOutput, runMintCommand, type MintRun } from "../adapters/github-mint.ts";
import type { FetchLike } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Env names the pack points at. `mint` and `gh-token` are sources, not env names. */
export function referencedCredentialEnvs(pack: ProjectPack): string[] {
  const names = new Set<string>();
  if (pack.commitActorTokenEnv?.trim()) names.add(pack.commitActorTokenEnv.trim());
  if (pack.design?.figmaTokenEnv?.trim()) names.add(pack.design.figmaTokenEnv.trim());
  if (pack.jira?.authHeaderEnv?.trim()) names.add(pack.jira.authHeaderEnv.trim());
  for (const map of [pack.workerHttp?.startHeaders, pack.workerHttp?.statusHeaders]) {
    for (const source of Object.values(map ?? {})) {
      if (source !== "mint" && source !== "gh-token" && ENV_NAME.test(source)) names.add(source);
    }
  }
  if (pack.identity === "mint") names.add("DELIVERY_LOOP_GITHUB_MINT");
  return [...names];
}

/**
 * Stop before a step when a referenced env is missing or empty.
 * The error names the env. It does not include the value.
 */
export function assertReferencedCredentials(pack: ProjectPack, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of referencedCredentialEnvs(pack)) {
    if (!env[name]?.trim()) throw new Error(`missing env ${name}`);
  }
}

export function credentialWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DELIVERY_LOOP_CREDENTIAL_EXPIRY_DAYS?.trim();
  if (!raw) return 14 * DAY_MS;
  if (!/^\d+$/.test(raw)) throw new Error("DELIVERY_LOOP_CREDENTIAL_EXPIRY_DAYS is not a non-negative integer");
  return Number(raw) * DAY_MS;
}

export type CredentialInspection = {
  name: string;
  state: "ok" | "warn" | "expired" | "invalid" | "unknown";
  expiry: string;
};

export function formatCredentialAudit(rows: readonly CredentialInspection[]): string {
  return rows.map((row) => `credential ${row.name} ${row.state} expiry ${row.expiry}`).join("\n");
}

export function credentialAuditFailed(rows: readonly CredentialInspection[]): boolean {
  return rows.some((row) => row.state === "expired" || row.state === "invalid");
}

function classifyExpiry(expiresAtMs: number, nowMs: number, windowMs: number): Pick<CredentialInspection, "state" | "expiry"> {
  const expiry = new Date(expiresAtMs).toISOString();
  if (expiresAtMs <= nowMs) return { state: "expired", expiry };
  if (expiresAtMs - nowMs <= windowMs) return { state: "warn", expiry };
  return { state: "ok", expiry };
}

function expiryFromBody(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { expires_at?: unknown; expiresAt?: unknown };
    const raw = typeof parsed.expires_at === "string" ? parsed.expires_at : typeof parsed.expiresAt === "string" ? parsed.expiresAt : "";
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

async function identityCall(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const response = await fetchImpl(url, { headers });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

function rowFromIdentity(name: string, status: number, body: string, nowMs: number, windowMs: number): CredentialInspection {
  if (status === 401) return { name, state: "invalid", expiry: "unknown" };
  const expiresAtMs = expiryFromBody(body);
  if (expiresAtMs === null) return { name, state: "unknown", expiry: "unknown" };
  return { name, ...classifyExpiry(expiresAtMs, nowMs, windowMs) };
}

/**
 * Expiry or validity for credentials the engine can inspect.
 * The result names the env. It does not include the value.
 * A provider with no expiry is `unknown`.
 */
export async function inspectCredentials(input: {
  pack: ProjectPack;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  runMint?: (command: string) => MintRun;
  fetch?: FetchLike;
}): Promise<CredentialInspection[]> {
  const env = input.env ?? process.env;
  const nowMs = input.nowMs ?? Date.now();
  const windowMs = credentialWindowMs(env);
  const fetchImpl = input.fetch ?? fetch;
  const rows: CredentialInspection[] = [];
  const command = env.DELIVERY_LOOP_GITHUB_MINT?.trim() ?? "";
  if (input.pack.identity === "mint" || command) {
    if (!command) {
      rows.push({ name: "DELIVERY_LOOP_GITHUB_MINT", state: "invalid", expiry: "unknown" });
    } else {
      const result = (input.runMint ?? runMintCommand)(command);
      const minted = result.status === 0 ? interpretMintOutput(result.stdout, nowMs) : null;
      if (!minted || minted.expiresAtMs <= nowMs) {
        rows.push({ name: "DELIVERY_LOOP_GITHUB_MINT", state: minted ? "expired" : "invalid", expiry: minted ? new Date(minted.expiresAtMs).toISOString() : "unknown" });
      } else {
        rows.push({ name: "DELIVERY_LOOP_GITHUB_MINT", ...classifyExpiry(minted.expiresAtMs, nowMs, windowMs) });
      }
    }
  }
  for (const name of referencedCredentialEnvs(input.pack)) {
    if (name === "DELIVERY_LOOP_GITHUB_MINT") continue;
    const value = env[name]?.trim() ?? "";
    if (!value) {
      rows.push({ name, state: "invalid", expiry: "unknown" });
      continue;
    }
    const call = await providerCall(input.pack, name, value, fetchImpl);
    if (!call) {
      rows.push({ name, state: "unknown", expiry: "unknown" });
      continue;
    }
    rows.push(rowFromIdentity(name, call.status, call.body, nowMs, windowMs));
  }
  return rows;
}

async function providerCall(
  pack: ProjectPack,
  name: string,
  value: string,
  fetchImpl: FetchLike,
): Promise<{ status: number; body: string } | null> {
  if (name === "GH_TOKEN" || name === "GITHUB_TOKEN" || name === pack.commitActorTokenEnv) {
    return identityCall(fetchImpl, "https://api.github.com/user", {
      Authorization: `Bearer ${value}`,
      Accept: "application/vnd.github+json",
    });
  }
  if (pack.design?.figmaTokenEnv === name) {
    return identityCall(fetchImpl, "https://api.figma.com/v1/me", { "X-Figma-Token": value });
  }
  if (name === "LINEAR_API_KEY") {
    return identityCall(fetchImpl, "https://api.linear.app/graphql", {
      Authorization: value,
      "Content-Type": "application/json",
    });
  }
  if (name === "OPENAI_API_KEY") {
    return identityCall(fetchImpl, "https://api.openai.com/v1/models", { Authorization: `Bearer ${value}` });
  }
  if (name === "ANTHROPIC_API_KEY") {
    return identityCall(fetchImpl, "https://api.anthropic.com/v1/models", {
      "x-api-key": value,
      "anthropic-version": "2023-06-01",
    });
  }
  if (pack.jira?.authHeaderEnv === name) {
    return identityCall(fetchImpl, `${pack.jira.apiBaseUrl.replace(/\/$/, "")}/rest/api/3/myself`, {
      Authorization: value,
      Accept: "application/json",
    });
  }
  return null;
}

/** Password for stage git. A mint identity uses only the minted token. */
export function stageGitPassword(
  pack: ProjectPack,
  env: NodeJS.ProcessEnv = process.env,
  runMint: (command: string) => MintRun = runMintCommand,
  nowMs = Date.now(),
): string {
  if (pack.identity !== "mint") return env.GH_TOKEN ?? env.GITHUB_TOKEN ?? "";
  const command = env.DELIVERY_LOOP_GITHUB_MINT?.trim() ?? "";
  if (!command) throw new Error("stage: DELIVERY_LOOP_GITHUB_MINT is required");
  const result = runMint(command);
  const minted = result.status === 0 ? interpretMintOutput(result.stdout, nowMs) : null;
  if (!minted || minted.expiresAtMs <= nowMs) {
    throw new Error("stage: DELIVERY_LOOP_GITHUB_MINT did not return an installation token that is still valid.");
  }
  return minted.token;
}

export function gitAskpassPath(): string {
  return fileURLToPath(new URL("../../scripts/git-askpass.sh", import.meta.url));
}

/** Stage git calls authenticate through this helper. The password is not logged. */
export function stageAskpassEnv(password: string): NodeJS.ProcessEnv {
  const path = gitAskpassPath();
  return {
    GIT_ASKPASS: path,
    DELIVERY_LOOP_GIT_ASKPASS: path,
    DELIVERY_LOOP_GIT_PASSWORD: password,
    GIT_TERMINAL_PROMPT: "0",
  };
}
