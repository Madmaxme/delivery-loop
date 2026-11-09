import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { githubForge } from "../adapters/forge-github.ts";
import { linearTracker } from "../adapters/trackers.ts";
import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";
import { figmaUrlsFromText, parseFigmaTarget, readFigmaFrame } from "./design-gate.ts";
import { createCredentialRecorder } from "./credential-log.ts";
import { runTicket } from "./loop.ts";

const FRAME = "https://www.figma.com/design/ABC123/Home?node-id=1-2";
const HEAD = "a".repeat(40);
const TOKEN_FILE = "src/tokens.scss";
const UI_CHECK = "npm run check:ui-primitives";

const pack: ProjectPack = {
  tracker: "linear",
  worker: "http",
  repos: [{ name: "admin-web", url: "https://github.com/acme/admin-web", trunk: "development" }],
  qualityCommand: "npm test",
  qualityWorkflow: "quality",
  invariantsFile: "invariants.md",
  status: { intake: "Todo", dev: "Dev", prod: "Prod" },
  connectors: ["figma"],
  design: {
    figmaTokenEnv: "FIGMA_ACCESS_TOKEN",
    repos: [
      {
        name: "admin-web",
        check: UI_CHECK,
        checkName: "ui-primitives",
        tokenFile: TOKEN_FILE,
      },
    ],
  },
};

const invariants = "## charges-are-idempotent\n";

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "1",
    identifier: "QUI-1",
    title: "Home screen",
    body: "Lay out the home screen.",
    stateName: "Todo",
    labels: [],
    blockedBy: [],
    comments: [],
    ...overrides,
  };
}

function order(extra: string): string {
  return `
**Verdict:** BUILDABLE
**Prior request:** none
**Outside grant:** none
**Journey evidence:** not-applicable
<!-- BUILD_PACKET
**Repos:** \`admin-web\`
**Allowlist:** \`admin-web/src/home.tsx\`
**Invariant:** \`charges-are-idempotent\`
**Decision:** Compose the home screen from the existing primitives.
**Symbols:** \`admin-web/src/home.tsx#Home\`
**Validation:** \`npm test\`
**Stop:** One home screen remains.
${extra}
BUILD_PACKET -->
`;
}

function harness(text: string) {
  const comments: string[] = [];
  const prompts: string[] = [];
  let starts = 0;
  let merged = false;
  const tracker: TrackerAdapter = {
    kind: "linear",
    async listIntake() {
      return [ticket()];
    },
    async get(id) {
      return ticket({ identifier: id, comments: comments.map((body) => ({ body })) });
    },
    async comment(_id, body) {
      comments.push(body);
    },
    async setState() {},
    async addLabel() {},
    async removeLabel() {},
    async projectSnapshot() {
      return null;
    },
  };
  const worker: WorkerAdapter = {
    kind: "http",
    async start(input) {
      starts += 1;
      prompts.push(input.prompt);
      return { runId: `run-${starts}` };
    },
    async join() {
      return { status: "finished", branch: "delivery/qui-1", head: "abc", text };
    },
  };
  const forge: ForgeAdapter = {
    async openPullRequest() {
      return {
        number: 4,
        url: "https://github.com/acme/admin-web/pull/4",
        headSha: HEAD,
        branch: "delivery/qui-1",
        created: true,
      };
    },
    async quality() {
      return { state: "success", detail: "quality success" };
    },
    async requestQualityRun() {
      return null;
    },
    async mergeability() {
      return { state: "clean", headSha: HEAD };
    },
    async updateBranch() {},
    async compare() {
      return "ahead";
    },
    async squashMerge() {
      merged = true;
      return "trunk";
    },
    async dispatch() {},
    async designCheck() {
      return { state: "success", detail: "ui-primitives success", headSha: "abc" };
    },
  };
  return {
    comments,
    prompts,
    starts: () => starts,
    merged: () => merged,
    deps: {
      pack,
      tracker,
      worker,
      forge,
      invariantsMarkdown: invariants,
      maxQualityPolls: 1,
      sleep: async () => {},
      report() {},
    },
  };
}

describe("design gate", () => {
  it("captures a Figma link that exists only on a Linear attachment", async () => {
    const attachment = "https://www.figma.com/design/FILEKEY/Settings?node-id=9-4";
    const comment = "https://www.figma.com/design/OTHER/Notes?node-id=2-2";
    let sawAttachments = false;
    const linear = linearTracker({
      apiKey: "k",
      team: "QUI",
      intakeState: "Todo",
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { query: string };
        sawAttachments = body.query.includes("attachments");
        return Response.json({
          data: {
            issues: {
              nodes: [
                {
                  id: "uuid",
                  identifier: "QUI-9",
                  title: "Settings",
                  description: "No frame in the description.",
                  state: { name: "Todo" },
                  labels: { nodes: [] },
                  comments: { nodes: [{ body: `frame ${comment}`, createdAt: "2026-01-02T00:00:00.000Z" }] },
                  inverseRelations: { nodes: [] },
                  attachments: { nodes: [{ url: attachment, title: "Settings" }] },
                },
              ],
            },
          },
        });
      },
    });
    const [found] = await linear.listIntake();
    assert.equal(sawAttachments, true);
    assert.ok(found.figmaUrls?.includes(attachment));
    assert.ok(found.figmaUrls?.includes(comment));
  });

  it("stops a ticket that names a Figma frame and omits Design source", async () => {
    const env = harness(order(""));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () =>
      Response.json({ nodes: { "1:2": { document: { id: "1:2", name: "Home frame", type: "FRAME" } } } });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "design-source");
    assert.equal(env.starts(), 1);
    assert.equal(env.merged(), false);
  });

  it("stops a UI repo whose work order omits the UI check", async () => {
    const env = harness(order(""));
    const result = await runTicket(env.deps, ticket());
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "design-check");
    assert.match(env.comments.join("\n"), new RegExp(UI_CHECK));
    assert.equal(env.starts(), 1);
    assert.equal(env.merged(), false);
  });

  it("does not merge when the UI check on the pull request head is red", async () => {
    const root = mkdtempSync(join(tmpdir(), "design-token-"));
    mkdirSync(join(root, "admin-web/src"), { recursive: true });
    writeFileSync(join(root, "admin-web", TOKEN_FILE), "$brand: #ff6600;\n");
    const env = harness(order(`**Validation:** \`${UI_CHECK}\``));
    env.deps.cwd = root;
    env.deps.forge.designCheck = async () => ({
      state: "failure",
      detail: "ui-primitives failure",
      headSha: HEAD,
    });
    const result = await runTicket(env.deps, ticket());
    assert.equal(env.merged(), false);
    assert.notEqual(result.outcome, "landed");
    assert.match(env.prompts.join("\n"), /\$brand: #ff6600/);
    assert.match(env.prompts.join("\n"), new RegExp(TOKEN_FILE));
  });

  it("ignores a green UI check recorded on a different sha", async () => {
    const env = harness(order(`**Validation:** \`${UI_CHECK}\``));
    let merged = false;
    const forge = githubForge({
      token: "t",
      fetch: async (url, init) => {
        const href = String(url);
        if (href.includes(`/commits/${HEAD}/check-runs`)) {
          return Response.json({
            check_runs: [
              {
                name: "ui-primitives",
                status: "completed",
                conclusion: "success",
                head_sha: "b".repeat(40),
              },
            ],
          });
        }
        if (href.endsWith("/pulls") && init?.method === "POST") {
          return Response.json({
            number: 4,
            html_url: "https://github.com/acme/admin-web/pull/4",
            head: { sha: HEAD, ref: "delivery/qui-1" },
          });
        }
        if (href.includes("/actions/runs")) {
          return Response.json({
            workflow_runs: [
              {
                name: "quality",
                status: "completed",
                conclusion: "success",
                head_sha: HEAD,
                html_url: "https://example.test/run",
                created_at: "2026-01-01T00:00:00Z",
              },
            ],
          });
        }
        if (href.includes("/compare/")) return Response.json({ status: "ahead" });
        if (href.endsWith("/pulls/4") && (init?.method ?? "GET") === "GET") {
          return Response.json({ mergeable_state: "clean", mergeable: true, head: { sha: HEAD } });
        }
        if (href.endsWith("/pulls/4/merge")) {
          merged = true;
          return Response.json({ sha: "c".repeat(40) });
        }
        return Response.json({});
      },
    });
    env.deps.forge = forge;
    const result = await runTicket(env.deps, ticket());
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
    assert.match(env.comments.join("\n"), /ignored/);
  });

  it("stops before ground when a Figma frame is present and the token is absent", async () => {
    const previous = process.env.FIGMA_ACCESS_TOKEN;
    delete process.env.FIGMA_ACCESS_TOKEN;
    try {
      const env = harness(order(`**Design source:** \`${FRAME}\``));
      env.deps.figmaToken = null;
      const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
      assert.equal(result.outcome, "missing-credential");
      assert.equal(result.detail, "figma");
      assert.match(env.comments.join("\n"), /missing-credential: figma/);
      assert.equal(env.starts(), 0);
    } finally {
      if (previous === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
      else process.env.FIGMA_ACCESS_TOKEN = previous;
    }
  });

  it("stops before ground when the Figma file read is refused", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => new Response("forbidden", { status: 403 });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(result.outcome, "missing-credential");
    assert.equal(result.detail, "figma");
    assert.match(env.comments.join("\n"), /figma read failed: 403/);
    assert.match(env.comments.join("\n"), /Share the file with the account that owns FIGMA_ACCESS_TOKEN/);
    assert.equal(env.starts(), 0);
    assert.equal(env.merged(), false);
  });

  it("stops before ground when the Figma file is missing", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ message: "Not found" }, { status: 404 });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(result.outcome, "missing-credential");
    assert.equal(result.detail, "figma");
    assert.match(env.comments.join("\n"), /figma read failed: 404 Not found/);
    assert.match(env.comments.join("\n"), /Share the file with the account that owns FIGMA_ACCESS_TOKEN/);
    assert.equal(env.starts(), 0);
  });

  it("reports a Figma 400 as a rejected request and keeps the API reason", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ err: "Node id is invalid" }, { status: 400 });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(result.outcome, "invalid-packet");
    assert.equal(result.detail, "figma-request");
    assert.match(env.comments.join("\n"), /figma read failed: 400 Node id is invalid/);
    assert.equal(/Share the file/.test(env.comments.join("\n")), false);
    assert.equal(env.starts(), 0);
  });

  it("reads a markdown Figma link once, with the node id colon encoded", async () => {
    const linked =
      "[https://www.figma.com/design/FILEKEY/Onboarding?node-id=49-11](<https://www.figma.com/design/FILEKEY/Onboarding?node-id=49-11>)";
    const dirty = "https://www.figma.com/design/FILEKEY/Onboarding?node-id=49-11](";
    assert.deepEqual(figmaUrlsFromText(`${linked}\n${dirty}`), [
      "https://www.figma.com/design/FILEKEY/Onboarding?node-id=49-11",
    ]);
    assert.equal(parseFigmaTarget(dirty)?.nodeId, "49:11");
    const urls: string[] = [];
    const rec = createCredentialRecorder();
    const text = await readFigmaFrame(
      figmaUrlsFromText(linked)[0] ?? "",
      "fixture-token",
      async (url) => {
        urls.push(String(url));
        return Response.json({
          nodes: { "49:11": { document: { id: "49:11", name: "image 37", type: "RECTANGLE" } } },
        });
      },
      rec.note,
    );
    assert.deepEqual(urls, ["https://api.figma.com/v1/files/FILEKEY/nodes?ids=49%3A11"]);
    assert.match(text, /RECTANGLE image 37/);
    assert.deepEqual(rec.lines(), ["credential slot=figma endpoint=figma status=200"]);
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    const seen: string[] = [];
    env.deps.figmaFetch = async (url) => {
      seen.push(String(url));
      return Response.json({
        nodes: { "49:11": { document: { id: "49:11", name: "image 37", type: "RECTANGLE" } } },
      });
    };
    const result = await runTicket(env.deps, ticket({ body: linked }));
    assert.deepEqual(seen, ["https://api.figma.com/v1/files/FILEKEY/nodes?ids=49%3A11"]);
    assert.notEqual(result.outcome, "missing-credential");
    assert.notEqual(result.detail, "figma-request");
  });

  it("puts the Figma frame and the read output in the repair prompt", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\`\n**Validation:** \`${UI_CHECK}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () =>
      Response.json({
        nodes: { "1:2": { document: { id: "1:2", name: "Home frame", type: "FRAME" } } },
      });
    env.deps.forge.quality = async () => ({ state: "failure", detail: "quality failure" });
    const result = await runTicket(env.deps, ticket({ figmaUrls: [FRAME], body: "No link in the body." }));
    assert.notEqual(result.outcome, "landed");
    const repair = env.prompts.filter((prompt) => prompt.includes("Fix that owner")).join("\n");
    assert.match(repair, /figma\.com\/design\/ABC123\/Home/);
    assert.match(repair, /Home frame/);
    assert.equal(repair.includes("fixture-token"), false);
  });
});
