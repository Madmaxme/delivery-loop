import { spawnSync } from "node:child_process";

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

/** True when the token should be minted again before the next check-runs call. */
export function credentialDue(
  expiresAtMs: number,
  nowMs: number,
  skewMs = INSTALLATION_TOKEN_REFRESH_SKEW_MS,
): boolean {
  return nowMs >= expiresAtMs - skewMs;
}
