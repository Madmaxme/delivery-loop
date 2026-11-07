import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { runnerWorkflowText } from "../cli/main.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "scripts/ledger-report.sh");

const event = {
  action: "completed",
  workflow_run: {
    event: "pull_request",
    head_sha: "abc123def",
    run_number: 12,
    pull_requests: [
      {
        url: "https://api.github.com/repos/Madmaxme/delivery-loop/pulls/41",
        id: 100,
        number: 41,
      },
    ],
  },
};

type Hit = { authorization?: string; contentType?: string; body: string };

function listen(status: number): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      hits.push({
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(status, { "content-type": "text/plain" });
      res.end(status >= 400 ? "nope" : "");
    });
  });
  return new Promise((resolveListen, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("stub did not bind"));
        return;
      }
      resolveListen({
        url: `http://127.0.0.1:${address.port}/hook`,
        hits,
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    });
  });
}

function githubEnv(extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: extra.PATH ?? process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C",
    GITHUB_REPOSITORY: "Madmaxme/delivery-loop",
    GITHUB_RUN_ID: "99",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_WORKFLOW: "engine-heal",
    GITHUB_EVENT_NAME: "workflow_run",
    GITHUB_SHA: "from-env-sha",
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("bash", [script, ...args], { env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
  });
}

function pathWithoutJq(): string {
  const bin = mkdtempSync(join(tmpdir(), "ledger-path-"));
  for (const name of ["bash", "curl", "awk", "mktemp", "rm"]) {
    const found = execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(bin, name));
  }
  return bin;
}

describe("worker ledger report", () => {
  it("posts the payload and the run key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-event-"));
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const stub = await listen(204);
    try {
      const secret = "ledger-secret-value";
      const result = await run(["started", "engine-heal"], githubEnv({
        LEDGER_WEBHOOK_URL: stub.url,
        LEDGER_WEBHOOK_AUTH: `Authorization: Bearer ${secret}`,
        GITHUB_EVENT_PATH: eventPath,
      }));
      assert.equal(result.code, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
      assert.equal(result.stdout.includes(stub.url), false);
      assert.equal(stub.hits.length, 1);
      const hit = stub.hits[0];
      assert.equal(hit.authorization, `Bearer ${secret}`);
      assert.equal(hit.contentType, "application/json");
      const body = JSON.parse(hit.body) as Record<string, string>;
      assert.equal(body.key, "gh:Madmaxme/delivery-loop:run:99:2:started");
      assert.equal(body.source, "engine-heal");
      assert.equal(body.repo, "Madmaxme/delivery-loop");
      assert.equal(body.subject, "engine-heal pull_request #41");
      assert.equal(body.link, "https://github.com/Madmaxme/delivery-loop/actions/runs/99");
      assert.equal(body.phase, "started");
      assert.equal(body.status, "");
      assert.equal(body.run_id, "99");
      assert.equal(body.run_attempt, "2");
      assert.equal(body.workflow, "engine-heal");
      assert.equal(body.sha, "abc123def");
    } finally {
      await stub.close();
    }
  });

  it("builds the same payload when jq is not installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-event-"));
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const stub = await listen(204);
    try {
      const result = await run(
        ["finished", "engine-heal", 'a\\b "c"'],
        githubEnv({
          PATH: pathWithoutJq(),
          LEDGER_WEBHOOK_URL: stub.url,
          LEDGER_WEBHOOK_AUTH: "Authorization: Bearer ledger-secret-value",
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_WORKFLOW: 'say "hi"',
        }),
      );
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(stub.hits.length, 1);
      const body = JSON.parse(stub.hits[0].body) as Record<string, string>;
      assert.equal(body.key, "gh:Madmaxme/delivery-loop:run:99:2:finished");
      assert.equal(body.source, "engine-heal");
      assert.equal(body.subject, 'say "hi" pull_request #41');
      assert.equal(body.workflow, 'say "hi"');
      assert.equal(body.phase, "finished");
      assert.equal(body.status, 'a\\b "c"');
      assert.equal(body.sha, "abc123def");
      assert.equal(body.link, "https://github.com/Madmaxme/delivery-loop/actions/runs/99");
    } finally {
      await stub.close();
    }
  });

  it("exits 1 with an annotation when a secret is missing and does not print it", async () => {
    const url = "http://127.0.0.1:9/hook-secret-path";
    const auth = "Authorization: Bearer ledger-secret-value";
    const missingUrl = await run(["started", "engine-heal"], githubEnv({ LEDGER_WEBHOOK_AUTH: auth }));
    assert.equal(missingUrl.code, 1);
    assert.match(missingUrl.stdout, /^::error title=Ledger write failed::LEDGER_WEBHOOK_URL is empty\n$/);
    assert.equal(missingUrl.stdout.includes("ledger-secret-value"), false);
    assert.equal(missingUrl.stderr.includes("ledger-secret-value"), false);

    const missingAuth = await run(["started", "engine-heal"], githubEnv({ LEDGER_WEBHOOK_URL: url }));
    assert.equal(missingAuth.code, 1);
    assert.match(missingAuth.stdout, /^::error title=Ledger write failed::LEDGER_WEBHOOK_AUTH is empty\n$/);
    assert.equal(missingAuth.stdout.includes(url), false);
    assert.equal(missingAuth.stdout.includes("hook-secret-path"), false);
    assert.equal(missingAuth.stderr.includes("hook-secret-path"), false);

    const missingBoth = await run(["finished", "ci", "success"], githubEnv({}));
    assert.equal(missingBoth.code, 1);
    assert.match(missingBoth.stdout, /::error title=Ledger write failed::/);
  });

  it("exits 1 when the ledger returns 500 and does not print the secret", async () => {
    const stub = await listen(500);
    const secret = "ledger-secret-value";
    try {
      const result = await run(["finished", "engine-heal", "failure"], githubEnv({
        LEDGER_WEBHOOK_URL: stub.url,
        LEDGER_WEBHOOK_AUTH: `Authorization: Bearer ${secret}`,
      }));
      assert.equal(result.code, 1);
      assert.match(result.stdout, /^::error title=Ledger write failed::POST failed after retries \(HTTP 500\)\n$/);
      assert.equal(result.stdout.includes(secret), false);
      assert.equal(result.stderr.includes(secret), false);
      assert.equal(result.stdout.includes(stub.url), false);
      assert.equal(result.stderr.includes(stub.url), false);
      assert.equal(stub.hits.length, 4);
    } finally {
      await stub.close();
    }
  });

  it("wires engine-heal fail-closed, leaves quality alone, and keeps the client hook optional", () => {
    const heal = readFileSync(join(root, ".github/workflows/engine-heal.yml"), "utf8");
    const steps = heal.slice(heal.indexOf("steps:"));
    const checkout = steps.indexOf("actions/checkout@v4");
    const started = steps.indexOf("bash scripts/ledger-report.sh started engine-heal");
    const setup = steps.indexOf("actions/setup-node@v4");
    const install = steps.indexOf("npm install");
    const merge = steps.indexOf("npx tsx scripts/engine-heal.ts");
    const finished = steps.indexOf('bash scripts/ledger-report.sh finished engine-heal "${{ job.status }}"');
    assert.ok(checkout >= 0 && checkout < started);
    assert.ok(started > 0 && started < setup && started < install && started < merge && merge < finished);
    assert.match(heal, /if: always\(\)/);
    assert.match(heal, /LEDGER_WEBHOOK_URL: \$\{\{ secrets\.LEDGER_WEBHOOK_URL \}\}/);
    assert.match(heal, /LEDGER_WEBHOOK_AUTH: \$\{\{ secrets\.LEDGER_WEBHOOK_AUTH \}\}/);
    assert.match(heal, /workflow_run.conclusion == 'success'/);
    assert.match(heal, /workflow_run.event == 'pull_request'/);
    assert.equal(heal.includes("HEAD:main"), false);

    const quality = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");
    assert.equal(quality.includes("ledger-report"), false);
    assert.equal(quality.includes("LEDGER_WEBHOOK"), false);

    const runner = runnerWorkflowText();
    assert.match(runner, /if \[ -z "\$\{LEDGER_WEBHOOK_URL:-\}" \]; then/);
    assert.match(runner, /ledger-report\.sh" "\$@"/);
    assert.match(runner, /ledger started other/);
    assert.match(runner, /ledger finished other "\$ledger_status"/);
    const startedAt = runner.indexOf("ledger started other");
    const installAt = runner.indexOf("npm install --omit=dev");
    const loopAt = runner.indexOf("delivery-loop sweep");
    assert.ok(startedAt > 0 && startedAt < installAt && installAt < loopAt);
  });
});
