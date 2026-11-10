import { randomUUID } from "node:crypto";

import { credentialFetch, noteCredential, type CredentialNoteFn } from "../engine/credential-log.ts";
import {
  isAgentCapacityRefusal,
  orderedCursorApiKeys,
} from "../engine/linear-harness-policy.js";
import {
  DEFAULT_WORKER_HTTP_MAX_WAIT_MS,
  DEFAULT_WORKER_HTTP_POLL_MS,
  type WorkerHttpHeaders,
  type WorkerHttpStatusStore,
} from "../schema/pack.ts";
import type { InstallationToken } from "./github-mint.ts";
import type { FetchLike, WorkerAdapter, WorkerResult, WorkerStart } from "./types.js";

async function poll(
  read: () => Promise<WorkerResult>,
  opts?: { attempts?: number; sleepMs?: number },
): Promise<WorkerResult> {
  const attempts = opts?.attempts ?? 30;
  for (let i = 0; i < attempts; i++) {
    const result = await read();
    if (result.status !== "running") return result;
    if (opts?.sleepMs) await new Promise((r) => setTimeout(r, opts.sleepMs));
  }
  return { status: "failed", text: "worker join timed out" };
}

const HTTP_PENDING = new Set(["pending", "running"]);

export type WorkerHttpToken = {
  /** Minted installation token when that command is set, otherwise the forge token. */
  mint(): Promise<InstallationToken>;
  /** Forge token. The value is not written. */
  forge(): InstallationToken;
};

function headerToken(name: string, value: string): string {
  if (name.toLowerCase() !== "authorization") return value;
  if (/^(Bearer|Basic|Token)\s+\S+/i.test(value)) return value;
  return `Bearer ${value}`;
}

function credentialSlot(slots: string[]): string {
  if (slots.includes("mint")) return "mint";
  if (slots.includes("gh-token")) return "gh-token";
  return "worker-http";
}

async function resolveHeaderMap(
  map: WorkerHttpHeaders | undefined,
  legacyToken: string | undefined,
  env: Record<string, string | undefined>,
  tokens: WorkerHttpToken | undefined,
): Promise<{ headers: Record<string, string>; slot: string }> {
  const headers: Record<string, string> = {};
  const slots: string[] = [];
  for (const [name, source] of Object.entries(map ?? {})) {
    let value = "";
    let slot = "worker-http";
    if (source === "mint") {
      const minted = await tokens?.mint();
      value = minted?.token ?? "";
      slot = minted?.slot ?? "mint";
    } else if (source === "gh-token") {
      const forge = tokens?.forge();
      value = forge?.token ?? "";
      slot = "gh-token";
    } else {
      value = env[source] ?? "";
    }
    if (!value) throw new Error(`worker http header ${name} is missing source ${source}`);
    headers[name] = headerToken(name, value);
    slots.push(slot);
  }
  if (!Object.keys(headers).some((name) => name.toLowerCase() === "authorization") && legacyToken) {
    headers.Authorization = headerToken("Authorization", legacyToken);
    slots.push("worker-http");
  }
  return { headers, slot: credentialSlot(slots) };
}

/** `{id}` is replaced. A path with no placeholder gains the id as its last segment. */
export function workerHttpStatusUrl(template: string, id: string): string {
  const encoded = encodeURIComponent(id);
  if (template.includes("{id}")) return template.replaceAll("{id}", encoded);
  return `${template.replace(/\/$/, "")}/${encoded}`;
}

function parseBranches(value: unknown): WorkerResult["branches"] {
  if (!Array.isArray(value)) return undefined;
  const rows: { repoUrl: string; branch: string }[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const record = row as { repoUrl?: unknown; branch?: unknown };
    if (typeof record.repoUrl !== "string" || typeof record.branch !== "string") continue;
    rows.push({ repoUrl: record.repoUrl, branch: record.branch });
  }
  return rows.length > 0 ? rows : undefined;
}

function resultRecord(value: unknown): Record<string, unknown> | null {
  let record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!record) return null;
  if (typeof record.status !== "string" && record.encoding === "base64" && typeof record.content === "string") {
    try {
      const decoded = Buffer.from(record.content.replace(/\s+/g, ""), "base64").toString("utf8");
      const parsed = JSON.parse(decoded) as unknown;
      record =
        parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return record;
}

export type WorkerHttpFiles = {
  /** Returns the write status. A non-2xx status means the file was not seeded. */
  write(input: { repo: string; branch: string; path: string; text: string }): Promise<number>;
  read(input: { repo: string; branch: string; path: string }): Promise<{ status: number; text: string }>;
};

export function workerHttpStorePath(template: string, id: string): string {
  const safe = /^[A-Za-z0-9._-]+$/.test(id) ? id : encodeURIComponent(id);
  return template.replaceAll("{id}", safe);
}

function pendingWorkerRecord(input: {
  id: string;
  repoUrl: string;
  baseRef: string;
  requestedAt: string;
}): string {
  return JSON.stringify({
    status: "pending",
    id: input.id,
    repoUrl: input.repoUrl,
    baseRef: input.baseRef,
    requestedAt: input.requestedAt,
  });
}

/** A terminal result, or null while the status is still pending or running. */
function classifyHttpResult(parsed: unknown): WorkerResult | null {
  const result = workerResultFromStatusBody(parsed);
  if (!result) return { status: "failed", text: "http worker status is not a result" };
  if (HTTP_PENDING.has(result.status)) return null;
  if (result.status === "finished" || result.status === "failed") return result;
  return { status: "failed", text: `http worker status ${result.status}` };
}

function statusOf(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { httpStatus?: unknown }).httpStatus;
  return typeof value === "number" ? value : undefined;
}

/** Status body, or the decoded document when the store wraps it. */
export function workerResultFromStatusBody(body: unknown): WorkerResult | null {
  const record = resultRecord(body);
  if (!record || typeof record.status !== "string") return null;
  return {
    status: record.status as WorkerResult["status"],
    branch: typeof record.branch === "string" ? record.branch : undefined,
    head: typeof record.head === "string" ? record.head : undefined,
    branches: parseBranches(record.branches),
    text: typeof record.text === "string" ? record.text : "",
  };
}

export function httpWorker(opts: {
  startUrl: string;
  statusUrl: string;
  /** `workerModel`. Absent omits `model` from the start body. */
  model?: string;
  pollMs?: number;
  maxWaitMs?: number;
  /** Legacy Authorization when the header maps omit it. */
  token?: string;
  startHeaders?: WorkerHttpHeaders;
  statusHeaders?: WorkerHttpHeaders;
  statusStore?: WorkerHttpStatusStore;
  /** Forge file reads and writes. Required when `statusStore` is set. */
  files?: WorkerHttpFiles;
  env?: Record<string, string | undefined>;
  tokens?: WorkerHttpToken;
  fetch?: FetchLike;
  credentialNote?: CredentialNoteFn;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}): WorkerAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const env = opts.env ?? process.env;
  const pollMs = opts.pollMs ?? DEFAULT_WORKER_HTTP_POLL_MS;
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_WORKER_HTTP_MAX_WAIT_MS;
  const nowMs = opts.nowMs ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const modelId = opts.model?.trim() || "";
  const note = opts.credentialNote;
  return {
    kind: "http",
    async start(input: WorkerStart) {
      const id = (opts.newId ?? randomUUID)();
      const storePath = opts.statusStore ? workerHttpStorePath(opts.statusStore.path, id) : "";
      if (opts.statusStore) {
        if (!opts.files) throw new Error("http worker seed failed: forge has no file store");
        let status: number;
        try {
          status = await opts.files.write({
            repo: opts.statusStore.repo,
            branch: opts.statusStore.branch,
            path: storePath,
            text: pendingWorkerRecord({
              id,
              repoUrl: input.repoUrl,
              baseRef: input.baseRef,
              requestedAt: new Date(nowMs()).toISOString(),
            }),
          });
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("http worker seed failed")) throw error;
          const failed = statusOf(error);
          throw new Error(failed ? `http worker seed failed: ${failed}` : "http worker seed failed");
        }
        if (status < 200 || status > 299) throw new Error(`http worker seed failed: ${status}`);
      }
      const auth = await resolveHeaderMap(opts.startHeaders, opts.token, env, opts.tokens);
      const body: Record<string, unknown> = {
        id,
        prompt: input.prompt,
        repoUrl: input.repoUrl,
        baseRef: input.baseRef,
      };
      if (modelId) body.model = { id: modelId };
      if (opts.statusStore) {
        body.statusStore = {
          repo: opts.statusStore.repo,
          branch: opts.statusStore.branch,
          path: storePath,
        };
      }
      const response = await credentialFetch(
        auth.slot,
        "worker-http-start",
        () =>
          fetchImpl(opts.startUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth.headers },
            body: JSON.stringify(body),
          }),
        note ?? noteCredential,
      );
      await response.text().catch(() => undefined);
      if (!response.ok) throw new Error(`HTTP worker start failed: ${response.status}`);
      return { runId: id };
    },
    async join(runId: string) {
      const url = workerHttpStatusUrl(opts.statusUrl ?? "", runId);
      const storePath = opts.statusStore ? workerHttpStorePath(opts.statusStore.path, runId) : "";
      const started = nowMs();
      for (;;) {
        if (opts.statusStore && opts.files) {
          const read = await opts.files.read({
            repo: opts.statusStore.repo,
            branch: opts.statusStore.branch,
            path: storePath,
          });
          if (read.status < 200 || read.status > 299) {
            return { status: "failed", text: `http worker status failed: ${read.status}` };
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(read.text);
          } catch {
            return { status: "failed", text: "http worker status is not a result" };
          }
          const stored = classifyHttpResult(parsed);
          if (stored) return stored;
          if (nowMs() - started >= maxWaitMs) {
            return { status: "failed", text: "http worker join exceeded maxWaitMs" };
          }
          const remaining = maxWaitMs - (nowMs() - started);
          await sleep(Math.min(pollMs, remaining));
          continue;
        }
        const auth = await resolveHeaderMap(opts.statusHeaders, opts.token, env, opts.tokens);
        const response = await credentialFetch(
          auth.slot,
          "worker-http-status",
          () => fetchImpl(url, { headers: auth.headers }),
          note ?? noteCredential,
        );
        if (!response.ok) {
          await response.text().catch(() => undefined);
          return { status: "failed", text: `http worker status failed: ${response.status}` };
        }
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          return { status: "failed", text: "http worker status is not a result" };
        }
        const result = workerResultFromStatusBody(parsed);
        if (!result) return { status: "failed", text: "http worker status is not a result" };
        if (!HTTP_PENDING.has(result.status)) {
          if (result.status === "finished" || result.status === "failed") return result;
          return { status: "failed", text: `http worker status ${result.status}` };
        }
        if (nowMs() - started >= maxWaitMs) {
          return { status: "failed", text: "http worker join exceeded maxWaitMs" };
        }
        const remaining = maxWaitMs - (nowMs() - started);
        await sleep(Math.min(pollMs, remaining));
      }
    },
  };
}

export function copilotWorker(opts: {
  token: string;
  owner: string;
  repo: string;
  fetch?: FetchLike;
}): WorkerAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "Content-Type": "application/json",
  };
  const base = `https://api.github.com/agents/repos/${opts.owner}/${opts.repo}/tasks`;
  return {
    kind: "copilot",
    async start(input) {
      const response = await credentialFetch("gh-token", "copilot", () =>
        fetchImpl(base, {
          method: "POST",
          headers,
          body: JSON.stringify({
            prompt: input.prompt,
            base_ref: input.baseRef,
            create_pull_request: false,
          }),
        }),
      );
      if (!response.ok) throw new Error(`Copilot task failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as { id: string };
      return { runId: json.id };
    },
    async join(runId) {
      return poll(async () => {
        const response = await credentialFetch("gh-token", "copilot", () =>
          fetchImpl(`${base}/${runId}`, { headers }),
        );
        if (!response.ok) throw new Error(`Copilot status failed: ${response.status}`);
        const json = (await response.json()) as {
          state: string;
          head_ref?: string;
          head_sha?: string;
          summary?: string;
        };
        const state = json.state;
        if (state === "completed") {
          return {
            status: "finished",
            branch: json.head_ref,
            head: json.head_sha,
            text: json.summary ?? "",
          };
        }
        if (state === "failed" || state === "cancelled" || state === "timed_out") {
          return { status: "failed", text: state };
        }
        return { status: "running", text: state };
      });
    },
  };
}

export function codexWorker(opts: { apiKey: string; fetch?: FetchLike }): WorkerAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    Authorization: `Bearer ${opts.apiKey}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": "agents=v1",
  };
  return {
    kind: "codex",
    async start(input) {
      const response = await credentialFetch("codex", "codex", () =>
        fetchImpl("https://api.openai.com/v1/agents/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({
          agent: { model: "gpt-5.4", instructions: "Follow the work order. Do not widen the change." },
          environment: {
            type: "hosted",
            repository: input.repoUrl,
            ref: input.baseRef,
          },
          input: [{ role: "user", content: [{ type: "input_text", text: input.prompt }] }],
        }),
      }),
      );
      if (!response.ok) throw new Error(`Codex session failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as { id: string };
      return { runId: json.id };
    },
    async join(runId) {
      return poll(async () => {
        const response = await credentialFetch("codex", "codex", () =>
          fetchImpl(`https://api.openai.com/v1/agents/sessions/${runId}`, {
            headers,
          }),
        );
        if (!response.ok) throw new Error(`Codex status failed: ${response.status}`);
        const json = (await response.json()) as {
          status: string;
          output_text?: string;
          branch?: string;
          head?: string;
        };
        if (json.status === "completed" || json.status === "idle") {
          return {
            status: "finished",
            branch: json.branch,
            head: json.head,
            text: json.output_text ?? "",
          };
        }
        if (json.status === "failed" || json.status === "cancelled") {
          return { status: "failed", text: json.status };
        }
        return { status: "running", text: json.status };
      });
    },
  };
}

export function claudeWorker(opts: { apiKey: string; fetch?: FetchLike }): WorkerAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const headers = {
    "x-api-key": opts.apiKey,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
  return {
    kind: "claude",
    async start(input) {
      const response = await credentialFetch("claude", "claude", () =>
        fetchImpl("https://api.anthropic.com/v1/sessions", {
          method: "POST",
          headers,
          body: JSON.stringify({
          model: "claude-sonnet-4-5",
          task: input.prompt,
          environment: { type: "repository", url: input.repoUrl, ref: input.baseRef },
        }),
      }),
      );
      if (!response.ok) throw new Error(`Claude session failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as { id: string };
      return { runId: json.id };
    },
    async join(runId) {
      return poll(async () => {
        const response = await credentialFetch("claude", "claude", () =>
          fetchImpl(`https://api.anthropic.com/v1/sessions/${runId}`, {
            headers,
          }),
        );
        if (!response.ok) throw new Error(`Claude status failed: ${response.status}`);
        const json = (await response.json()) as {
          status: string;
          output?: string;
          branch?: string;
          head?: string;
        };
        if (json.status === "completed" || json.status === "succeeded") {
          return {
            status: "finished",
            branch: json.branch,
            head: json.head,
            text: json.output ?? "",
          };
        }
        if (json.status === "failed" || json.status === "cancelled") {
          return { status: "failed", text: json.status };
        }
        return { status: "running", text: json.status };
      });
    },
  };
}

export type CursorRunResult = {
  status?: string;
  result?: unknown;
  git?: {
    branches?: { repoUrl?: string; branch?: string; prUrl?: string }[];
  };
};

/** One wait before the second attempt on the same key slot. */
export const CURSOR_LAUNCH_RETRY_MS = 1000;

export const CURSOR_ACCOUNT_DEFAULT_MODEL = "cursor worker model is the account default";

export type CursorSdk = {
  create(options: {
    apiKey: string;
    model?: { id: string };
    cloud: { repos: { url: string; startingRef: string }[]; autoCreatePR: boolean };
  }): Promise<{
    agentId: string;
    send(prompt: string): Promise<{ id?: string; wait(): Promise<CursorRunResult> }>;
    [Symbol.asyncDispose](): Promise<void>;
  }>;
  messages: { list(agentId: string): Promise<unknown> };
};

const CLOSED_HANDOFF =
  /<!--\s*(?:GROUNDING_HANDOFF|BUILD_HANDOFF)\b[\s\S]*?\b(?:GROUNDING_HANDOFF|BUILD_HANDOFF)\s*-->|\*\*Verdict:\*\*/i;

function textBlocks(message: unknown): string {
  if (typeof message === "string") return message;
  if (!message || typeof message !== "object") return "";
  const record = message as { text?: unknown; content?: unknown };
  if (typeof record.text === "string" && record.text.trim()) return record.text;
  if (!Array.isArray(record.content)) return "";
  const bits: string[] = [];
  for (const block of record.content) {
    if (!block || typeof block !== "object") continue;
    const item = block as { type?: string; text?: unknown };
    if (item.type === "text" && typeof item.text === "string") bits.push(item.text);
  }
  return bits.join("");
}

export function assistantTextFromMessages(messages: unknown): string {
  const list = Array.isArray(messages)
    ? messages
    : messages && typeof messages === "object" && Array.isArray((messages as { messages?: unknown }).messages)
      ? (messages as { messages: unknown[] }).messages
      : [];
  const parts: string[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as { type?: string; message?: unknown };
    if ((row.type ?? "").toLowerCase() !== "assistant") continue;
    const text = textBlocks(row.message);
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * The run receipt is the assistant transcript. `wait()` returns a RunResult
 * whose `result` string is that transcript; `Agent.messages` is the same
 * text when the result string is empty. The RunResult object itself is not
 * the receipt.
 */
export function cursorReceiptText(done: CursorRunResult, messages: unknown): string {
  const stored = assistantTextFromMessages(messages);
  const result = typeof done.result === "string" ? done.result : "";
  if (stored.trim() && CLOSED_HANDOFF.test(stored) && stored.length >= result.length) {
    return stored;
  }
  if (result.trim()) return result;
  return stored;
}

export function cursorBranches(done: CursorRunResult): { repoUrl: string; branch: string }[] {
  const rows = done.git?.branches ?? [];
  const out: { repoUrl: string; branch: string }[] = [];
  for (const row of rows) {
    if (!row.repoUrl || !row.branch) continue;
    out.push({ repoUrl: row.repoUrl, branch: row.branch });
  }
  return out;
}

type CursorLiveRun = {
  agentId: string;
  wait(): Promise<CursorRunResult>;
  dispose(): Promise<void>;
  repoUrl: string;
};

export type CursorKeySlotName = "primary" | "fallback";

export type CursorKeySlot = {
  slot: CursorKeySlotName;
  apiKey: string;
};

/**
 * Primary slot, then one fallback. A blank primary is an empty list.
 * `orderedCursorApiKeys` drops a blank or duplicate fallback.
 */
export function cursorKeySlots(
  primary: string | null | undefined,
  fallback: string | null | undefined,
): CursorKeySlot[] {
  if (!(primary ?? "").trim()) return [];
  return orderedCursorApiKeys(primary, fallback).map((apiKey, index) => ({
    slot: index === 0 ? "primary" : "fallback",
    apiKey,
  }));
}

function redactSecrets(text: string, secrets: readonly string[]): string {
  const ordered = [...secrets].filter((secret) => secret.length > 0).sort((a, b) => b.length - a.length);
  let out = text;
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function launchStatus(error: unknown): number {
  if (error && typeof error === "object") {
    const record = error as { status?: unknown; statusCode?: unknown; httpStatus?: unknown };
    for (const value of [record.httpStatus, record.status, record.statusCode]) {
      if (typeof value === "number" && value >= 100 && value <= 599) return value;
    }
  }
  return 0;
}

function isLaunchServerError(status: number): boolean {
  return status >= 500 && status <= 599;
}

export function cursorWorker(opts: {
  apiKey?: string;
  slots?: CursorKeySlot[];
  /** Model id from `workerModel`. Absent omits the model. */
  model?: string;
  sdk?: CursorSdk;
  log?: (line: string) => void;
  credentialNote?: CredentialNoteFn;
  sleep?: (ms: number) => Promise<void>;
}): WorkerAdapter {
  const live = new Map<string, CursorLiveRun>();
  const slots = (opts.slots ?? cursorKeySlots(opts.apiKey, undefined)).slice(0, 2);
  const log = opts.log ?? ((line: string) => console.error(`[delivery-loop] ${line}`));
  const emit: CredentialNoteFn = opts.credentialNote ?? ((call) => noteCredential(call, log));
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const modelId = opts.model?.trim() || "";
  return {
    kind: "cursor",
    async start(input) {
      if (slots.length === 0) throw new Error("CURSOR_API_KEY is required");
      if (!modelId) log(CURSOR_ACCOUNT_DEFAULT_MODEL);
      const sdk =
        opts.sdk ??
        ((await import("@cursor/sdk")) as { Agent: CursorSdk }).Agent;
      const secrets = slots.map((slot) => slot.apiKey);
      let failure: Error | undefined;
      let capacityRefusals = 0;
      for (let i = 0; i < slots.length; i++) {
        const current = slots[i];
        let retried = false;
        for (;;) {
          try {
            const agent = await sdk.create({
              apiKey: current.apiKey,
              ...(modelId ? { model: { id: modelId } } : {}),
              cloud: {
                repos: [{ url: input.repoUrl, startingRef: input.baseRef }],
                autoCreatePR: false,
              },
            });
            let run: Awaited<ReturnType<(typeof agent)["send"]>>;
            try {
              run = await agent.send(input.prompt);
            } catch (error) {
              await agent[Symbol.asyncDispose]().catch(() => undefined);
              throw error;
            }
            emit({
              slot: current.slot,
              endpoint: "cursor-launch",
              status: 200,
              detail: modelId || undefined,
            });
            const runKey = run.id?.trim() || agent.agentId;
            live.set(runKey, {
              agentId: agent.agentId,
              wait: () => run.wait(),
              dispose: () => agent[Symbol.asyncDispose](),
              repoUrl: input.repoUrl,
            });
            return {
              runId: JSON.stringify({
                agentId: agent.agentId,
                runId: runKey,
                status: "running",
              }),
            };
          } catch (error) {
            const message = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
            const status = launchStatus(error);
            emit({
              slot: current.slot,
              endpoint: "cursor-launch",
              status,
              detail: modelId || undefined,
            });
            if (isLaunchServerError(status)) {
              if (!retried) {
                retried = true;
                await sleep(CURSOR_LAUNCH_RETRY_MS);
                continue;
              }
              const last = i + 1 >= slots.length;
              if (last) {
                failure = new Error(`Cursor worker launch failed on the ${current.slot} key slot: ${message}`);
              }
              break;
            }
            if (!isAgentCapacityRefusal(message)) {
              throw new Error(`Cursor worker launch failed on the ${current.slot} key slot: ${message}`);
            }
            capacityRefusals += 1;
            const last = i + 1 >= slots.length;
            if (last && slots.length > 1 && capacityRefusals === slots.length) {
              failure = new Error(`Cursor worker launch failed: both key slots are out of capacity. ${message}`);
              break;
            }
            if (last) {
              failure = new Error(
                `Cursor worker launch failed on the ${current.slot} key slot: the account is out of capacity. ${message}`,
              );
              break;
            }
            break;
          }
        }
      }
      throw failure ?? new Error("Cursor worker launch failed.");
    },
    async join(runId) {
      const stored = JSON.parse(runId) as {
        agentId?: string;
        runId?: string;
        status?: string;
        branch?: string;
        head?: string;
        branches?: { repoUrl: string; branch: string }[];
        text?: string;
      };
      if (stored.status !== "running") {
        const status = stored.status === "failed" ? "failed" : "finished";
        return {
          status,
          branch: stored.branch,
          head: stored.head,
          branches: stored.branches,
          text: stored.text ?? "",
        };
      }
      const handle = stored.runId ? live.get(stored.runId) : undefined;
      const sdk =
        opts.sdk ??
        ((await import("@cursor/sdk")) as { Agent: CursorSdk }).Agent;
      if (!handle) {
        let messages: unknown = [];
        try {
          if (stored.agentId) messages = await sdk.messages.list(stored.agentId);
        } catch {
          messages = [];
        }
        const text = assistantTextFromMessages(messages);
        if (text.trim() && CLOSED_HANDOFF.test(text)) {
          return { status: "finished", text };
        }
        return { status: "running", text };
      }
      const done = await handle.wait();
      let messages: unknown = [];
      try {
        messages = await sdk.messages.list(handle.agentId);
      } catch {
        messages = [];
      }
      await handle.dispose().catch(() => undefined);
      live.delete(stored.runId ?? "");
      const text = cursorReceiptText(done, messages);
      const branches = cursorBranches(done);
      const own = branches.find((row) => sameGithubRepo(row.repoUrl, handle.repoUrl));
      const failed = done.status === "error" || done.status === "cancelled";
      return {
        status: failed ? "failed" : "finished",
        branch: own?.branch ?? branches[0]?.branch,
        branches,
        text,
      };
    },
  };
}

function sameGithubRepo(a: string, b: string): boolean {
  const normalize = (value: string) => {
    const match = value.match(/github\.com[:/]([^/]+)\/([^/.]+)/i);
    return match ? `${match[1]}/${match[2]}`.toLowerCase() : value.replace(/\.git$/, "").toLowerCase();
  };
  return normalize(a) === normalize(b);
}
