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
const script = join(root, "scripts/run-event.sh");
const schemaPath = join(root, "schemas/run-event-1.0.schema.json");

const event = {
  action: "completed",
  workflow_run: {
    event: "pull_request",
    head_sha: "abc123def",
    run_number: 12,
    pull_requests: [{ number: 41 }],
  },
};

type Hit = { header?: string; contentType?: string; body: string };

type Schema = {
  properties: {
    specversion: { const: string };
    type: { enum: string[] };
    data: { required: string[]; properties: { phase: { enum: string[] } } };
  };
  required: string[];
};

function listen(status: number): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const header = req.headers["x-delivery-loop-event"];
      hits.push({
        header: Array.isArray(header) ? header[0] : header,
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

function githubEnv(workspace: string, extra: Record<string, string | undefined>): NodeJS.ProcessEnv {
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
    GITHUB_WORKSPACE: workspace,
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function run(
  workspace: string,
  args: string[],
  extra: Record<string, string | undefined>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn("bash", [script, ...args], { env: githubEnv(workspace, extra) });
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
  const bin = mkdtempSync(join(tmpdir(), "run-event-path-"));
  for (const name of ["bash", "curl", "awk", "mktemp", "rm", "date", "mkdir"]) {
    const found = execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    symlinkSync(found, join(bin, name));
  }
  return bin;
}

function eventFile(workspace: string, phase: "started" | "finished"): string {
  return join(workspace, ".delivery-loop", "events", `delivery-loop.run.${phase}.json`);
}

function assertSilent(text: string, hidden: string[]): void {
  for (const item of hidden) {
    assert.equal(text.includes(item), false, text);
  }
}

describe("run event", () => {
  it("writes the schema fields and does not post when the endpoint is unset", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "run-event-"));
    const eventPath = join(workspace, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as Schema;
    const result = await run(workspace, ["started"], { GITHUB_EVENT_PATH: eventPath });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const body = JSON.parse(readFileSync(eventFile(workspace, "started"), "utf8")) as {
      specversion: string;
      id: string;
      source: string;
      type: string;
      time: string;
      data: Record<string, string>;
    };
    assert.equal(body.specversion, schema.properties.specversion.const);
    for (const key of schema.required) {
      if (key === "data") {
        assert.equal(typeof body.data, "object");
        continue;
      }
      assert.equal(typeof body[key as keyof typeof body], "string");
    }
    assert.ok(schema.properties.type.enum.includes(body.type));
    assert.match(body.time, /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/);
    assert.equal(body.id, "gh:99:2:started");
    assert.equal(body.source, "https://github.com/Madmaxme/delivery-loop");
    assert.equal(body.type, "delivery-loop.run.started");
    for (const key of schema.properties.data.required) {
      assert.equal(typeof body.data[key], "string");
    }
    assert.equal(body.data.repo, "Madmaxme/delivery-loop");
    assert.equal(body.data.sha, "abc123def");
    assert.equal(body.data.workflow, "engine-heal");
    assert.equal(body.data.run_id, "99");
    assert.equal(body.data.run_attempt, "2");
    assert.equal(body.data.phase, "started");
    assert.equal(body.data.status, "");
  });

  it("is a silent no-op beyond the file when no endpoint is set, including without curl", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "run-event-"));
    const bin = mkdtempSync(join(tmpdir(), "run-event-nocurl-"));
    for (const name of ["bash", "awk", "mktemp", "rm", "date", "mkdir"]) {
      const found = execFileSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
      symlinkSync(found, join(bin, name));
    }
    const result = await run(workspace, ["finished", "success"], { PATH: bin });
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const body = JSON.parse(readFileSync(eventFile(workspace, "finished"), "utf8")) as {
      type: string;
      data: { sha: string; phase: string; status: string };
    };
    assert.equal(body.type, "delivery-loop.run.finished");
    assert.equal(body.data.sha, "from-env-sha");
    assert.equal(body.data.phase, "finished");
    assert.equal(body.data.status, "success");
  });

  it("posts the file when an endpoint is set and does not print the endpoint or the header", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "run-event-"));
    const eventPath = join(workspace, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const stub = await listen(204);
    const token = "hook-token-value";
    try {
      const result = await run(workspace, ["started"], {
        DELIVERY_LOOP_EVENT_URL: stub.url,
        DELIVERY_LOOP_EVENT_HEADER: `X-Delivery-Loop-Event: ${token}`,
        GITHUB_EVENT_PATH: eventPath,
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assertSilent(result.stdout + result.stderr, [token, stub.url]);
      assert.equal(stub.hits.length, 1);
      const hit = stub.hits[0];
      assert.equal(hit.header, token);
      assert.equal(hit.contentType, "application/json");
      const file = readFileSync(eventFile(workspace, "started"), "utf8");
      assert.equal(hit.body, file);
      const body = JSON.parse(file) as { data: { sha: string } };
      assert.equal(body.data.sha, "abc123def");
    } finally {
      await stub.close();
    }
  });

  it("builds the same file when jq is not installed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "run-event-"));
    const eventPath = join(workspace, "event.json");
    writeFileSync(eventPath, JSON.stringify(event));
    const stub = await listen(204);
    try {
      const result = await run(workspace, ["finished", 'a\\b "c"'], {
        PATH: pathWithoutJq(),
        DELIVERY_LOOP_EVENT_URL: stub.url,
        DELIVERY_LOOP_EVENT_HEADER: "X-Delivery-Loop-Event: hook-token-value",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_WORKFLOW: 'say "hi"',
      });
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assertSilent(result.stdout + result.stderr, ["hook-token-value", stub.url]);
      assert.equal(stub.hits.length, 1);
      const body = JSON.parse(stub.hits[0].body) as {
        id: string;
        type: string;
        data: { workflow: string; phase: string; status: string; sha: string };
      };
      assert.equal(body.id, "gh:99:2:finished");
      assert.equal(body.type, "delivery-loop.run.finished");
      assert.equal(body.data.workflow, 'say "hi"');
      assert.equal(body.data.phase, "finished");
      assert.equal(body.data.status, 'a\\b "c"');
      assert.equal(body.data.sha, "abc123def");
    } finally {
      await stub.close();
    }
  });

  it("keeps the run green when a post fails and REQUIRED is false or unset", async () => {
    const stub = await listen(500);
    const token = "hook-token-value";
    try {
      for (const required of [undefined, "false", ""]) {
        const workspace = mkdtempSync(join(tmpdir(), "run-event-"));
        const result = await run(workspace, ["finished", "failure"], {
          DELIVERY_LOOP_EVENT_URL: stub.url,
          DELIVERY_LOOP_EVENT_HEADER: `X-Delivery-Loop-Event: ${token}`,
          DELIVERY_LOOP_EVENT_REQUIRED: required,
        });
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /^::warning title=Run event::post failed \(HTTP 500\)\n$/);
        assert.equal(result.stderr, "");
        assertSilent(result.stdout + result.stderr, [token, stub.url]);
        const body = JSON.parse(readFileSync(eventFile(workspace, "finished"), "utf8")) as {
          data: { status: string };
        };
        assert.equal(body.data.status, "failure");
      }
    } finally {
      await stub.close();
    }
  });

  it("fails the run when a post fails and REQUIRED is true, without printing the endpoint or the header", async () => {
    const stub = await listen(500);
    const token = "hook-token-value";
    try {
      const workspace = mkdtempSync(join(tmpdir(), "run-event-"));
      const result = await run(workspace, ["started"], {
        DELIVERY_LOOP_EVENT_URL: `${stub.url}/${token}`,
        DELIVERY_LOOP_EVENT_HEADER: `X-Delivery-Loop-Event: ${token}`,
        DELIVERY_LOOP_EVENT_REQUIRED: "true",
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /^::error title=Run event::post failed \(HTTP 500\)\n$/);
      assert.equal(result.stderr, "");
      assertSilent(result.stdout + result.stderr, [token, stub.url]);
      assert.equal(readFileSync(eventFile(workspace, "started"), "utf8").includes(token), false);
      const refused = await run(mkdtempSync(join(tmpdir(), "run-event-")), ["started"], {
        DELIVERY_LOOP_EVENT_URL: `http://127.0.0.1:9/${token}`,
        DELIVERY_LOOP_EVENT_HEADER: `X-Delivery-Loop-Event: ${token}`,
        DELIVERY_LOOP_EVENT_REQUIRED: "1",
      });
      assert.equal(refused.code, 1);
      assert.match(refused.stdout, /^::error title=Run event::post failed\n$/);
      assertSilent(refused.stdout + refused.stderr, [token, "127.0.0.1:9"]);
      const optional = await run(mkdtempSync(join(tmpdir(), "run-event-")), ["started"], {
        DELIVERY_LOOP_EVENT_URL: `http://127.0.0.1:9/${token}`,
        DELIVERY_LOOP_EVENT_HEADER: `X-Delivery-Loop-Event: ${token}`,
        DELIVERY_LOOP_EVENT_REQUIRED: "false",
      });
      assert.equal(optional.code, 0);
      assert.match(optional.stdout, /^::warning title=Run event::post failed\n$/);
      assertSilent(optional.stdout + optional.stderr, [token, "127.0.0.1:9"]);
    } finally {
      await stub.close();
    }
  });

  it("does not print the endpoint when the run identity is empty", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "run-event-"));
    const token = "hook-token-value";
    const url = `http://127.0.0.1:9/${token}`;
    const result = await run(workspace, ["started"], {
      GITHUB_REPOSITORY: undefined,
      DELIVERY_LOOP_EVENT_URL: url,
      DELIVERY_LOOP_EVENT_HEADER: `X-Delivery-Loop-Event: ${token}`,
      DELIVERY_LOOP_EVENT_REQUIRED: "true",
    });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /^::error title=Run event::run identity is empty\n$/);
    assertSilent(result.stdout + result.stderr, [token, url]);
  });

  it("wires engine-heal as a file upload and leaves the client post optional", () => {
    const heal = readFileSync(join(root, ".github/workflows/engine-heal.yml"), "utf8");
    const steps = heal.slice(heal.indexOf("steps:"));
    const checkout = steps.indexOf("actions/checkout@v4");
    const started = steps.indexOf("bash scripts/run-event.sh started");
    const setup = steps.indexOf("actions/setup-node@v4");
    const install = steps.indexOf("npm install");
    const merge = steps.indexOf("npx tsx scripts/engine-heal.ts");
    const finished = steps.indexOf('bash scripts/run-event.sh finished "${{ job.status }}"');
    const upload = steps.indexOf("actions/upload-artifact@v4");
    assert.ok(checkout >= 0 && checkout < started);
    assert.ok(started > 0 && started < setup && started < install && started < merge && merge < finished);
    assert.ok(finished < upload);
    const finishBlock = steps.slice(steps.lastIndexOf("- name:", finished), finished);
    const uploadBlock = steps.slice(finished);
    assert.match(finishBlock, /if: always\(\)/);
    assert.match(uploadBlock, /if: always\(\)/);
    assert.match(uploadBlock, /include-hidden-files: true/);
    assert.match(uploadBlock, /delivery-loop-run-events/);
    assert.match(heal, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.equal(heal.includes("DELIVERY_LOOP_EVENT_URL"), false);
    assert.equal(heal.includes("DELIVERY_LOOP_EVENT_HEADER"), false);
    assert.equal(heal.includes("WEBHOOK"), false);
    assert.match(heal, /workflow_run.conclusion == 'success'/);
    assert.match(heal, /workflow_run.event == 'pull_request'/);
    assert.equal(heal.includes("HEAD:main"), false);

    const quality = readFileSync(join(root, ".github/workflows/quality.yml"), "utf8");
    assert.equal(quality.includes("run-event"), false);
    assert.equal(quality.includes("DELIVERY_LOOP_EVENT"), false);
    assert.equal(quality.includes("WEBHOOK"), false);

    const runner = runnerWorkflowText();
    assert.match(runner, /DELIVERY_LOOP_EVENT_URL: \$\{\{ vars\.DELIVERY_LOOP_EVENT_URL \}\}/);
    assert.match(runner, /DELIVERY_LOOP_EVENT_HEADER: \$\{\{ secrets\.DELIVERY_LOOP_EVENT_HEADER \}\}/);
    assert.match(runner, /DELIVERY_LOOP_EVENT_REQUIRED: \$\{\{ vars\.DELIVERY_LOOP_EVENT_REQUIRED \}\}/);
    assert.match(runner, /bash "\$dir\/scripts\/run-event\.sh" started/);
    assert.match(runner, /bash "\$dir\/scripts\/run-event\.sh" finished "\$event_status"/);
    assert.match(runner, /include-hidden-files: true/);
    const startedAt = runner.indexOf('bash "$dir/scripts/run-event.sh" started');
    const installAt = runner.indexOf("npm install --omit=dev");
    const loopAt = runner.indexOf("delivery-loop sweep");
    const finishedAt = runner.indexOf('bash "$dir/scripts/run-event.sh" finished');
    assert.ok(startedAt > 0 && startedAt < installAt && installAt < loopAt && loopAt < finishedAt);
    assert.equal(runner.includes("WEBHOOK"), false);
  });
});
