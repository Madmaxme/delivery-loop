/** One credential call. The line carries the slot, the endpoint class, and the status. */

export type CredentialNote = {
  slot: string;
  endpoint: string;
  status: number;
  /** Set when the mint ran again because the previous token was near expiry. */
  refresh?: boolean;
  /** Short API reason. A token, a header, or a URL is not a reason. */
  detail?: string;
};

export type CredentialNoteFn = (call: CredentialNote) => void;

const SLOTS = new Set([
  "mint",
  "gh-token",
  "linear",
  "figma",
  "primary",
  "jira",
  "fallback",
  "worker-http",
  "codex",
  "claude",
]);

const ENDPOINTS = new Set([
  "mint",
  "check-runs",
  "pulls",
  "contents",
  "commits",
  "compare",
  "actions",
  "issues",
  "git",
  "user",
  "rate-limit",
  "github",
  "linear-graphql",
  "jira-rest",
  "cursor-launch",
  "figma",
  "worker-http",
  "copilot",
  "codex",
  "claude",
]);

type CountKey = { slot: string; endpoint: string; status: number; count: number };

const counts = new Map<string, CountKey>();

function cleanToken(value: string, allowed: Set<string>): string {
  return allowed.has(value) ? value : "unknown";
}

function cleanStatus(status: number): number {
  if (!Number.isInteger(status) || status < 0 || status > 599) return 0;
  return status;
}

/** GitHub path or URL, reduced to an endpoint class. The path itself is not logged. */
export function githubEndpointClass(path: string): string {
  const clean = path.replace(/^https:\/\/api\.github\.com/i, "").split("?")[0] ?? "";
  if (clean.includes("/check-runs")) return "check-runs";
  if (clean.includes("/contents")) return "contents";
  if (clean.includes("/pulls")) return "pulls";
  if (clean.includes("/issues")) return "issues";
  if (clean.includes("/actions/")) return "actions";
  if (clean.includes("/compare/")) return "compare";
  if (clean.includes("/commits")) return "commits";
  if (clean.includes("/git/")) return "git";
  if (clean === "/user" || clean.startsWith("/user/")) return "user";
  if (clean === "/rate_limit" || clean.startsWith("/rate_limit/")) return "rate-limit";
  return "github";
}

function cleanDetail(detail: string | undefined): string {
  if (!detail) return "";
  const clean = detail.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!clean || /https?:\/\//i.test(clean) || /bearer\s/i.test(clean)) return "";
  return clean;
}

export function formatCredentialLine(call: CredentialNote): string {
  const slot = cleanToken(call.slot, SLOTS);
  const endpoint = cleanToken(call.endpoint, ENDPOINTS);
  const status = cleanStatus(call.status);
  const refresh = call.refresh ? " refresh=1" : "";
  const detail = cleanDetail(call.detail);
  const suffix = detail ? ` detail=${detail}` : "";
  return `credential slot=${slot} endpoint=${endpoint} status=${status}${refresh}${suffix}`;
}

export function formatCredentialSummary(row: CountKey): string {
  return `credential summary slot=${row.slot} endpoint=${row.endpoint} status=${row.status} count=${row.count}`;
}

/** The run log prefixes every credential line. */
export function credentialLogText(line: string): string {
  return `[delivery-loop] ${line}`;
}

function remember(call: CredentialNote, bucket: Map<string, CountKey>): void {
  const slot = cleanToken(call.slot, SLOTS);
  const endpoint = cleanToken(call.endpoint, ENDPOINTS);
  const status = cleanStatus(call.status);
  const key = `${slot}\0${endpoint}\0${status}`;
  const row = bucket.get(key);
  if (row) row.count += 1;
  else bucket.set(key, { slot, endpoint, status, count: 1 });
}

export function summaryLines(bucket: Map<string, CountKey>): string[] {
  return [...bucket.values()]
    .sort((a, b) =>
      a.slot === b.slot
        ? a.endpoint === b.endpoint
          ? a.status - b.status
          : a.endpoint < b.endpoint
            ? -1
            : 1
        : a.slot < b.slot
          ? -1
          : 1,
    )
    .map(formatCredentialSummary);
}

function defaultWrite(line: string): void {
  process.stderr.write(`${credentialLogText(line)}\n`);
}

/** Record one call. `write` receives the line without the run-log prefix. */
export function noteCredential(call: CredentialNote, write?: (line: string) => void): void {
  const line = formatCredentialLine(call);
  (write ?? defaultWrite)(line);
  remember(call, counts);
}

export function credentialSummaryLines(): string[] {
  return summaryLines(counts);
}

/** One line per slot, endpoint class, and status. Nothing is written when no call was recorded. */
export function writeCredentialSummary(): void {
  for (const line of credentialSummaryLines()) defaultWrite(line);
}

export function mintCallStatus(exitStatus: number | null, ok: boolean): number {
  if (ok) return 200;
  if (typeof exitStatus === "number" && exitStatus > 0 && exitStatus <= 599) return exitStatus;
  return 0;
}

export function noteMint(input: {
  exitStatus: number | null;
  ok: boolean;
  refresh?: boolean;
  note?: CredentialNoteFn;
}): void {
  const note = input.note ?? noteCredential;
  note({
    slot: "mint",
    endpoint: "mint",
    status: mintCallStatus(input.exitStatus, input.ok),
    refresh: input.refresh,
  });
}

export async function credentialFetch(
  slot: string,
  endpoint: string,
  run: () => Promise<Response>,
  note: CredentialNoteFn = noteCredential,
  detailOf?: (response: Response) => Promise<string | undefined>,
): Promise<Response> {
  let response: Response;
  try {
    response = await run();
  } catch (error) {
    note({ slot, endpoint, status: 0 });
    throw error;
  }
  let detail: string | undefined;
  if (!response.ok && detailOf) {
    try {
      detail = await detailOf(response.clone());
    } catch {
      detail = undefined;
    }
  }
  note({ slot, endpoint, status: response.status, detail });
  return response;
}

/** Isolated recorder for tests. It does not write to the process log. */
export function createCredentialRecorder(): {
  note: CredentialNoteFn;
  lines: () => string[];
  summaryLines: () => string[];
} {
  const lines: string[] = [];
  const bucket = new Map<string, CountKey>();
  return {
    note(call) {
      lines.push(formatCredentialLine(call));
      remember(call, bucket);
    },
    lines: () => [...lines],
    summaryLines: () => summaryLines(bucket),
  };
}
