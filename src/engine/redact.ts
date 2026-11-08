/** Environment names whose values are secrets once they are loaded. */
export const SECRET_ENV_NAMES = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "DELIVERY_LOOP_GIT_TOKEN",
  "LINEAR_API_KEY",
  "LINEAR_TOKEN",
  "CURSOR_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "FIGMA_ACCESS_TOKEN",
  "OAUTH_CLIENT_SECRET",
  "GITHUB_CLIENT_SECRET",
] as const;

const registered = new Set<string>();

function remember(value: string): void {
  if (value.length < 4) return;
  registered.add(value);
}

/** Record a secret and the forms a log line is likely to contain. */
export function registerSecret(value: string | null | undefined): void {
  const secret = value?.trim() ?? "";
  if (secret.length < 4) return;
  remember(secret);
  remember(Buffer.from(secret).toString("base64"));
  remember(encodeURIComponent(secret));
}

export function registerLoadedSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_ENV_NAMES) registerSecret(env[name]);
}

export function registeredSecrets(): string[] {
  return [...registered];
}

export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const list = [...secrets].filter((secret) => secret.length >= 4).sort((left, right) => right.length - left.length);
  for (const secret of list) out = out.split(secret).join("[redacted]");
  return out;
}

/**
 * Redact across chunk boundaries. A secret split over two reads is still removed.
 * `push` may withhold the tail until `flush`.
 */
export function createStreamRedactor(secrets: readonly string[]): {
  push: (chunk: string) => string;
  flush: () => string;
} {
  const list = secrets.filter((secret) => secret.length >= 4);
  const maxLen = list.reduce((max, secret) => Math.max(max, secret.length), 0);
  let buffer = "";
  return {
    push(chunk: string): string {
      buffer += chunk;
      if (maxLen === 0) {
        const out = buffer;
        buffer = "";
        return out;
      }
      let cut = Math.max(0, buffer.length - (maxLen - 1));
      for (const secret of list) {
        const from = Math.max(0, cut - secret.length + 1);
        let index = buffer.indexOf(secret, from);
        while (index !== -1 && index < cut) {
          if (index + secret.length > cut) cut = index;
          const next = buffer.indexOf(secret, index + secret.length);
          if (next === -1 || next >= cut) break;
          index = next;
        }
      }
      const head = redactSecrets(buffer.slice(0, cut), list);
      buffer = buffer.slice(cut);
      return head;
    },
    flush(): string {
      const out = redactSecrets(buffer, list);
      buffer = "";
      return out;
    },
  };
}
