import { spawnSync } from "node:child_process";

import { noteMint, type CredentialNoteFn } from "../engine/credential-log.ts";

/** GitHub installation tokens last one hour when the mint command does not say otherwise. */
export const INSTALLATION_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Mint again while this much life remains, so a long page does not call with a dead token. */
export const INSTALLATION_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

export type MintedCredential = {
  token: string;
  expiresAtMs: number;
};

export type MintRun = {
  status: number | null;
  stdout: string;
};

/** Run the mint command. Stdout is the credential. Callers must not print it. */
export function runMintCommand(command: string): MintRun {
  const result = spawnSync(command, { shell: true, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/**
 * The mint command prints a token, or JSON `{"token","expires_at"}`.
 * A bare token expires `INSTALLATION_TOKEN_TTL_MS` after `nowMs`.
 * An ISO-8601 line is the expiry and is not the token.
 */
export function interpretMintOutput(stdout: string, nowMs: number): MintedCredential | null {
  const text = stdout.trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text) as { token?: string; expires_at?: string };
      const token = json.token?.trim() ?? "";
      if (!token) return null;
      const expiresAtMs = json.expires_at ? Date.parse(json.expires_at) : nowMs + INSTALLATION_TOKEN_TTL_MS;
      if (!Number.isFinite(expiresAtMs)) return null;
      return { token, expiresAtMs };
    } catch {
      return null;
    }
  }
  const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
  const expiryLine = lines.find((line) => /^\d{4}-\d{2}-\d{2}T/.test(line));
  const token = [...lines].reverse().find((line) => line !== expiryLine) ?? "";
  if (!token) return null;
  const expiresAtMs = expiryLine ? Date.parse(expiryLine) : nowMs + INSTALLATION_TOKEN_TTL_MS;
  if (!Number.isFinite(expiresAtMs)) return null;
  return { token, expiresAtMs };
}

export type InstallationToken = {
  token: string;
  slot: "mint" | "gh-token";
};

/**
 * One cache for the minted installation token.
 * An empty command uses `fallbackToken` and slot `gh-token`.
 * Callers must not print the token.
 */
export function createInstallationToken(opts: {
  command: () => string;
  fallbackToken: string;
  nowMs?: () => number;
  runMint?: (command: string) => MintRun;
  note?: CredentialNoteFn;
  /** When set, an empty or failed mint throws and names this step. There is no other token. */
  requireMint?: boolean;
  step?: string;
}): { get(): Promise<InstallationToken> } {
  let cached: MintedCredential | null = null;
  return {
    async get() {
      const command = opts.command().trim();
      if (!command) {
        if (opts.requireMint) throw new Error(`${opts.step ?? "mint"}: DELIVERY_LOOP_GITHUB_MINT is required`);
        return { token: opts.fallbackToken, slot: "gh-token" };
      }
      const now = (opts.nowMs ?? Date.now)();
      if (cached && !credentialDue(cached.expiresAtMs, now)) {
        return { token: cached.token, slot: "mint" };
      }
      const refresh = cached !== null;
      const result = (opts.runMint ?? runMintCommand)(command);
      const minted = result.status === 0 ? interpretMintOutput(result.stdout, now) : null;
      const ok = Boolean(minted && minted.expiresAtMs > now);
      noteMint({ exitStatus: result.status, ok, refresh, note: opts.note });
      if (!minted || minted.expiresAtMs <= now) {
        const detail = "DELIVERY_LOOP_GITHUB_MINT did not return an installation token that is still valid.";
        throw new Error(opts.requireMint ? `${opts.step ?? "mint"}: ${detail}` : `credential error: ${detail}`);
      }
      cached = minted;
      return { token: minted.token, slot: "mint" };
    },
  };
}

/** True when the token should be minted again before the next check-runs call. */
export function credentialDue(
  expiresAtMs: number,
  nowMs: number,
  skewMs = INSTALLATION_TOKEN_REFRESH_SKEW_MS,
): boolean {
  return nowMs >= expiresAtMs - skewMs;
}
