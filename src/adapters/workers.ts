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

export function httpWorker(opts: {
  startUrl: string;
  statusUrl: string;
  token?: string;
  fetch?: FetchLike;
}): WorkerAdapter {
  const fetchImpl = opts.fetch ?? fetch;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  return {
    kind: "http",
    async start(input: WorkerStart) {
      const response = await fetchImpl(opts.startUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error(`HTTP worker start failed: ${response.status}`);
      const json = (await response.json()) as { runId: string };
      return { runId: json.runId };
    },
    async join(runId: string) {
      return poll(async () => {
        const response = await fetchImpl(`${opts.statusUrl.replace(/\/$/, "")}/${runId}`, {
          headers,
        });
        if (!response.ok) throw new Error(`HTTP worker status failed: ${response.status}`);
        return (await response.json()) as WorkerResult;
      });
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
      const response = await fetchImpl(base, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: input.prompt,
          base_ref: input.baseRef,
          create_pull_request: false,
        }),
      });
      if (!response.ok) throw new Error(`Copilot task failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as { id: string };
      return { runId: json.id };
    },
    async join(runId) {
      return poll(async () => {
        const response = await fetchImpl(`${base}/${runId}`, { headers });
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
      const response = await fetchImpl("https://api.openai.com/v1/agents/sessions", {
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
      });
      if (!response.ok) throw new Error(`Codex session failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as { id: string };
      return { runId: json.id };
    },
    async join(runId) {
      return poll(async () => {
        const response = await fetchImpl(`https://api.openai.com/v1/agents/sessions/${runId}`, {
          headers,
        });
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
      const response = await fetchImpl("https://api.anthropic.com/v1/sessions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          task: input.prompt,
          environment: { type: "repository", url: input.repoUrl, ref: input.baseRef },
        }),
      });
      if (!response.ok) throw new Error(`Claude session failed: ${response.status} ${await response.text()}`);
      const json = (await response.json()) as { id: string };
      return { runId: json.id };
    },
    async join(runId) {
      return poll(async () => {
        const response = await fetchImpl(`https://api.anthropic.com/v1/sessions/${runId}`, {
          headers,
        });
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

export type CursorSdk = {
  create(options: {
    apiKey: string;
    cloud: { repos: { url: string; startingRef: string }[]; autoCreatePR: boolean };
  }): Promise<{
    agentId: string;
    send(prompt: string): Promise<{
      wait(): Promise<{ status?: string; git?: { branch?: string; sha?: string } }>;
    }>;
    [Symbol.asyncDispose](): Promise<void>;
  }>;
  messages: { list(agentId: string): Promise<{ content?: { text?: string }[] } | unknown> };
};

export function cursorWorker(opts: {
  apiKey: string;
  sdk?: CursorSdk;
}): WorkerAdapter {
  return {
    kind: "cursor",
    async start(input) {
      const sdk =
        opts.sdk ??
        ((await import("@cursor/sdk")) as { Agent: CursorSdk }).Agent;
      const agent = await sdk.create({
        apiKey: opts.apiKey,
        cloud: {
          repos: [{ url: input.repoUrl, startingRef: input.baseRef }],
          autoCreatePR: false,
        },
      });
      const run = await agent.send(input.prompt);
      const done = await run.wait();
      await agent[Symbol.asyncDispose]();
      const text = JSON.stringify(done);
      return {
        runId: JSON.stringify({
          agentId: agent.agentId,
          status: done.status ?? "finished",
          branch: done.git?.branch,
          head: done.git?.sha,
          text,
        }),
      };
    },
    async join(runId) {
      const stored = JSON.parse(runId) as WorkerResult & { status: string };
      const status = stored.status === "failed" ? "failed" : "finished";
      return {
        status,
        branch: stored.branch,
        head: stored.head,
        text: stored.text,
      };
    },
  };
}
