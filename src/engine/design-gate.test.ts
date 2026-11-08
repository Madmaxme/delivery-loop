import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { githubForge } from "../adapters/forge-github.ts";
import { linearTracker } from "../adapters/trackers.ts";
import type { ForgeAdapter, Ticket, TrackerAdapter, WorkerAdapter } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";
import { GITHUB_ACTIONS_APP_ID } from "./github-actions.ts";
import { interpretDesignChecks, type DesignCheckEvidence, type DesignCheckRun } from "./design-gate.ts";
import { runTicket } from "./loop.ts";

const FRAME = "https://www.figma.com/design/ABC123/Home?node-id=1-2";
const HEAD = "a".repeat(40);
const TRUNK = "f".repeat(40);
const WORKSPACE = "https://github.com/acme/workspace";
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
    async trunkSha() {
      return TRUNK;
    },
    async readTextFile() {
      return packYaml("admin-web", ["src"]);
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
    env.deps.pack = { ...pack, agent: { url: WORKSPACE, trunk: "main" } };
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
    env.deps.pack = {
      ...pack,
      agent: { url: WORKSPACE, trunk: "main" },
      design: {
        ...pack.design!,
        repos: [{ ...pack.design!.repos[0]!, proofPaths: ["src"] }],
      },
    };
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
        if (href.includes("/repos/acme/workspace/commits/")) return Response.json({ sha: TRUNK });
        if (href.includes("/contents/delivery-loop.yaml")) {
          return Response.json({
            type: "file",
            encoding: "base64",
            content: Buffer.from(packYaml("admin-web", ["src"])).toString("base64"),
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

  it("does not treat a Design source line as proof of the frame", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.pack = { ...pack, agent: { url: WORKSPACE, trunk: "main" } };
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () =>
      Response.json({ nodes: { "1:2": { document: { id: "1:2", name: "Home frame", type: "FRAME" } } } });
    env.deps.lookupHead = () => null;
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.notEqual(result.outcome, "landed");
    assert.equal(env.merged(), false);
    assert.match(env.comments.join("\n"), /Design check/);
  });
});

const BLOB = "b".repeat(40);

function designRun(overrides: Partial<DesignCheckRun> = {}): DesignCheckRun {
  return {
    name: "ui-primitives",
    status: "completed",
    conclusion: "success",
    headSha: HEAD,
    appId: GITHUB_ACTIONS_APP_ID,
    appSlug: "github-actions",
    checkSuiteId: 77,
    ...overrides,
  };
}

function designEvidence(overrides: Partial<DesignCheckEvidence> = {}): DesignCheckEvidence {
  return {
    complete: true,
    changedPaths: ["src/home.tsx"],
    allowPaths: ["src"],
    workflows: [
      {
        path: ".github/workflows/ui.yml",
        headSha: HEAD,
        runHeadSha: HEAD,
        event: "pull_request",
        checkSuiteId: 77,
        headBlobSha: BLOB,
        baseBlobSha: BLOB,
      },
    ],
    ...overrides,
  };
}

describe("independent design check", () => {
  it("accepts a GitHub Actions check whose workflow file matches the base branch", () => {
    const result = interpretDesignChecks([designRun()], HEAD, "ui-primitives", designEvidence());
    assert.equal(result.state, "success");
    assert.equal(result.headSha, HEAD);
  });

  it("rejects a pull request that changes a file the workflow can execute", () => {
    const npmrc = interpretDesignChecks(
      [designRun()],
      HEAD,
      "ui-primitives",
      designEvidence({ changedPaths: [".npmrc"] }),
    );
    assert.equal(npmrc.state, "failure");
    const config = interpretDesignChecks(
      [designRun()],
      HEAD,
      "ui-primitives",
      designEvidence({ changedPaths: ["tsconfig.json"] }),
    );
    assert.equal(config.state, "failure");
    const missingEvent = interpretDesignChecks(
      [designRun()],
      HEAD,
      "ui-primitives",
      designEvidence({
        workflows: [
          {
            path: ".github/workflows/ui.yml",
            headSha: HEAD,
            runHeadSha: HEAD,
            event: "workflow_dispatch",
            checkSuiteId: 77,
            headBlobSha: BLOB,
            baseBlobSha: BLOB,
          },
        ],
      }),
    );
    assert.equal(missingEvent.state, "failure");
  });

  it("does not treat pull_request_target as proof without a pinned base-only workflow", () => {
    const base = "e".repeat(40);
    const proven = interpretDesignChecks(
      [designRun()],
      HEAD,
      "ui-primitives",
      designEvidence({
        changedPaths: [".npmrc", "package.json"],
        workflows: [
          {
            path: ".github/workflows/ui.yml",
            headSha: base,
            runHeadSha: base,
            baseSha: base,
            event: "pull_request_target",
            checkSuiteId: 77,
            headBlobSha: BLOB,
            baseBlobSha: BLOB,
          },
        ],
      }),
    );
    assert.equal(proven.state, "failure");
    const wrongHead = interpretDesignChecks(
      [designRun()],
      HEAD,
      "ui-primitives",
      designEvidence({
        workflows: [
          {
            path: ".github/workflows/ui.yml",
            headSha: HEAD,
            runHeadSha: HEAD,
            baseSha: base,
            event: "pull_request_target",
            checkSuiteId: 77,
            headBlobSha: BLOB,
            baseBlobSha: BLOB,
          },
        ],
      }),
    );
    assert.equal(wrongHead.state, "failure");
  });

  it("uses the latest design check and ignores an older success", () => {
    const older = designRun({
      id: 10,
      runId: 10,
      attempt: 5,
      startedAt: "2026-01-01T00:00:00Z",
      conclusion: "success",
    });
    const newer = designRun({
      id: 11,
      runId: 11,
      attempt: 1,
      startedAt: "2026-01-02T00:00:00Z",
      status: "completed",
      conclusion: "failure",
    });
    assert.equal(interpretDesignChecks([older, newer], HEAD, "ui-primitives", designEvidence()).state, "failure");
    const pending = designRun({
      id: 3,
      startedAt: "2026-01-03T00:00:00Z",
      status: "in_progress",
      conclusion: null,
    });
    assert.equal(interpretDesignChecks([older, pending], HEAD, "ui-primitives", designEvidence()).state, "pending");
    const unordered = interpretDesignChecks(
      [designRun({ conclusion: "success" }), designRun({ conclusion: "failure" })],
      HEAD,
      "ui-primitives",
      designEvidence(),
    );
    assert.equal(unordered.state, "failure");
  });

  it("rejects a check the pull request can forge", () => {
    const cases: { runs: DesignCheckRun[]; evidence: DesignCheckEvidence }[] = [
      { runs: [designRun({ appId: null })], evidence: designEvidence() },
      { runs: [designRun({ appId: 1 })], evidence: designEvidence() },
      { runs: [designRun({ appSlug: "other" })], evidence: designEvidence() },
      { runs: [designRun({ checkSuiteId: null })], evidence: designEvidence() },
      {
        runs: [designRun()],
        evidence: designEvidence({
          workflows: [
            {
              path: ".github/workflows/ui.yml",
              headSha: HEAD,
              checkSuiteId: 77,
              headBlobSha: "c".repeat(40),
              baseBlobSha: BLOB,
            },
          ],
        }),
      },
      {
        runs: [designRun()],
        evidence: designEvidence({
          workflows: [
            {
              path: ".github/workflows/ui.yml",
              headSha: HEAD,
              checkSuiteId: 77,
              headBlobSha: BLOB,
              baseBlobSha: null,
            },
          ],
        }),
      },
      {
        runs: [designRun()],
        evidence: designEvidence({
          workflows: [
            {
              path: "scripts/ui.yml",
              headSha: HEAD,
              checkSuiteId: 77,
              headBlobSha: BLOB,
              baseBlobSha: BLOB,
            },
          ],
        }),
      },
      { runs: [designRun()], evidence: designEvidence({ complete: false }) },
      { runs: [designRun({ headSha: "d".repeat(40) })], evidence: designEvidence() },
    ];
    for (const item of cases) {
      const result = interpretDesignChecks(item.runs, HEAD, "ui-primitives", item.evidence);
      assert.notEqual(result.state, "success");
    }
    const stale = interpretDesignChecks(
      [designRun({ headSha: "d".repeat(40) })],
      HEAD,
      "ui-primitives",
      designEvidence(),
    );
    assert.equal(stale.state, "missing");
    assert.match(stale.detail, /ignored/);
  });

  it("does not merge when the UI workflow on the pull request head differs from the base", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    let merged = false;
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({ headBlob: "c".repeat(40), baseBlob: BLOB, appId: GITHUB_ACTIONS_APP_ID }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
  });

  it("merges when the UI check is GitHub Actions and the workflow file matches the base", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    let merged = false;
    env.deps.cwd = checkoutWithOrigin(["docs"]);
    const productPack: string[] = [];
    env.deps.pack = {
      ...pack,
      agent: { url: WORKSPACE, trunk: "main" },
      design: {
        ...pack.design!,
        repos: [{ ...pack.design!.repos[0]!, proofPaths: ["vendor"] }],
      },
    };
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({
        headBlob: BLOB,
        baseBlob: BLOB,
        appId: GITHUB_ACTIONS_APP_ID,
        packText: packYaml("admin-web", ["src"]),
        productPack,
      }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, true);
    assert.equal(result.outcome, "landed");
    assert.deepEqual(productPack, []);
  });

  it("reads proof paths from the pull request base when origin points at a different repo", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    env.deps.cwd = checkoutWithOrigin(["."]);
    const productPack: string[] = [];
    env.deps.pack = {
      ...pack,
      agent: { url: WORKSPACE, trunk: "main" },
      design: {
        ...pack.design!,
        repos: [{ ...pack.design!.repos[0]!, proofPaths: ["."] }],
      },
    };
    let merged = false;
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({
        headBlob: BLOB,
        baseBlob: BLOB,
        appId: GITHUB_ACTIONS_APP_ID,
        packText: packYaml("admin-web", ["src/kept"]),
        productPack,
      }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
    assert.deepEqual(productPack, []);
    assert.match(env.comments.join("\n"), /not an independent|design check/);
  });

  it("sees a path past the compare cap of 300 files", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    const changedFiles = [...Array.from({ length: 300 }, (_, index) => `src/file-${index}.tsx`), "secret.ts"];
    env.deps.pack = {
      ...pack,
      agent: { url: WORKSPACE, trunk: "main" },
      design: {
        ...pack.design!,
        repos: [{ ...pack.design!.repos[0]!, proofPaths: ["src"] }],
      },
    };
    let merged = false;
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({
        headBlob: BLOB,
        baseBlob: BLOB,
        appId: GITHUB_ACTIONS_APP_ID,
        packText: packYaml("admin-web", ["src"]),
        changedFiles,
      }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
  });

  it("leaves the design check unverified when the agent repo is missing", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    const productPack: string[] = [];
    let merged = false;
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({
        headBlob: BLOB,
        baseBlob: BLOB,
        appId: GITHUB_ACTIONS_APP_ID,
        packText: packYaml("admin-web", ["."]),
        productPack,
      }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
    assert.deepEqual(productPack, []);
    assert.match(`${result.detail}\n${env.comments.join("\n")}`, /Needs owner: agent\.url and agent\.trunk/);
    assert.doesNotMatch(env.comments.join("\n"), /OWNER_HEAL/);
    assert.equal(env.prompts.some((prompt) => prompt.includes("agent.url")), false);
  });

  it("does not start a worker when the workspace trunk pack cannot be read", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    env.deps.pack = { ...pack, agent: { url: WORKSPACE, trunk: "main" } };
    let merged = false;
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({
        headBlob: BLOB,
        baseBlob: BLOB,
        appId: GITHUB_ACTIONS_APP_ID,
      }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
    assert.match(`${result.detail}\n${env.comments.join("\n")}`, /Needs owner: agent\.url and agent\.trunk/);
    assert.doesNotMatch(env.comments.join("\n"), /OWNER_HEAL/);
    assert.equal(env.prompts.some((prompt) => prompt.includes("agent.url")), false);
  });

  it("refuses the merge when the pack trunk moves after the design verdict", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    let reads = 0;
    let merged = false;
    env.deps.pack = {
      ...pack,
      agent: { url: WORKSPACE, trunk: "main" },
      design: {
        ...pack.design!,
        repos: [{ ...pack.design!.repos[0]!, proofPaths: ["src"] }],
      },
    };
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({
        headBlob: BLOB,
        baseBlob: BLOB,
        appId: GITHUB_ACTIONS_APP_ID,
        packText: packYaml("admin-web", ["src"]),
        nextTrunk: () => {
          reads += 1;
          return reads === 1 ? TRUNK : "1".repeat(40);
        },
      }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
    assert.ok(reads >= 2);
    assert.match(`${result.detail}\n${env.comments.join("\n")}`, /pack trunk moved/);
  });

  it("refuses the merge when the head moves after the design verdict", async () => {
    const env = harness(order(`**Design source:** \`${FRAME}\``));
    env.deps.figmaToken = "fixture-token";
    env.deps.figmaFetch = async () => Response.json({ name: "Home" });
    env.deps.lookupHead = () => null;
    let merged = false;
    env.deps.pack = {
      ...pack,
      agent: { url: WORKSPACE, trunk: "main" },
      design: {
        ...pack.design!,
        repos: [{ ...pack.design!.repos[0]!, proofPaths: ["src"] }],
      },
    };
    env.deps.forge = githubForge({
      token: "t",
      fetch: designFetch({
        headBlob: BLOB,
        baseBlob: BLOB,
        appId: GITHUB_ACTIONS_APP_ID,
        packText: packYaml("admin-web", ["src"]),
        movingHead: true,
      }, () => {
        merged = true;
      }),
    });
    const result = await runTicket(env.deps, ticket({ body: `Use ${FRAME}` }));
    assert.equal(merged, false);
    assert.notEqual(result.outcome, "landed");
    assert.match(`${result.detail}\n${env.comments.join("\n")}`, /head moved/);
  });
});

function packYaml(repoName: string, proofPaths: string[]): string {
  const lines = ["design:", "  repos:", `    - name: ${repoName}`, "      proofPaths:", ...proofPaths.map((path) => `        - ${path}`)];
  return `${lines.join("\n")}\n`;
}

/** Checkout whose origin is another repo. That repo and the working tree both list `originPaths`. */
function checkoutWithOrigin(originPaths: string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "proof-paths-"));
  const other = mkdtempSync(join(tmpdir(), "proof-origin-"));
  writeFileSync(join(other, "delivery-loop.yaml"), packYaml("admin-web", originPaths));
  const git = (dir: string, args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git(other, ["init", "-b", "main"]);
  git(other, ["config", "user.email", "dev@example.com"]);
  git(other, ["config", "user.name", "Dev"]);
  git(other, ["add", "delivery-loop.yaml"]);
  git(other, ["commit", "-m", "other pack"]);
  const bare = join(cwd, "other.git");
  const initBare = spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" });
  assert.equal(initBare.status, 0, initBare.stderr);
  git(other, ["remote", "add", "origin", bare]);
  git(other, ["push", "origin", "HEAD:refs/heads/main"]);
  git(cwd, ["init", "-b", "main"]);
  git(cwd, ["config", "user.email", "dev@example.com"]);
  git(cwd, ["config", "user.name", "Dev"]);
  writeFileSync(join(cwd, "delivery-loop.yaml"), packYaml("admin-web", originPaths));
  git(cwd, ["add", "delivery-loop.yaml"]);
  git(cwd, ["commit", "-m", "workspace pack"]);
  git(cwd, ["remote", "add", "origin", bare]);
  writeFileSync(join(cwd, "delivery-loop.yaml"), packYaml("admin-web", ["."]));
  return cwd;
}

function designFetch(
  input: {
    headBlob: string;
    baseBlob: string | null;
    appId: number | null;
    packText?: string;
    changedFiles?: string[];
    productPack?: string[];
    nextTrunk?: () => string;
    movingHead?: boolean;
  },
  onMerge: () => void,
): (url: string | URL, init?: RequestInit) => Promise<Response> {
  let pullReads = 0;
  return async (url, init) => {
    const href = String(url);
    if (href.includes(`/commits/${HEAD}/check-runs`)) {
      return Response.json({
        total_count: 1,
        check_runs: [
          {
            name: "ui-primitives",
            status: "completed",
            conclusion: "success",
            head_sha: HEAD,
            app: input.appId === null ? null : { id: input.appId, slug: "github-actions" },
            check_suite: { id: 77 },
          },
        ],
      });
    }
    if (href.includes("/repos/acme/workspace/commits/")) {
      return Response.json({ sha: input.nextTrunk ? input.nextTrunk() : TRUNK });
    }
    if (href.includes("/pulls/") && href.includes("/files")) {
      const page = Number(new URL(href).searchParams.get("page") ?? "1");
      const all = input.changedFiles ?? ["src/home.tsx"];
      const start = (page - 1) * 100;
      const slice = all.slice(start, start + 100);
      const headers = new Headers();
      if (start + 100 < all.length) {
        headers.set("link", `<https://api.github.com/repos/acme/admin-web/pulls/4/files?page=${page + 1}>; rel="next"`);
      }
      return new Response(JSON.stringify(slice.map((filename) => ({ filename }))), { status: 200, headers });
    }
    if (href.includes("/contents/")) {
      const url = new URL(href);
      const ref = url.searchParams.get("ref");
      if (url.pathname.endsWith("/delivery-loop.yaml")) {
        if (url.pathname.includes("/acme/admin-web/")) {
          input.productPack?.push(href);
          return Response.json({
            type: "file",
            encoding: "base64",
            content: Buffer.from(packYaml("admin-web", ["."])).toString("base64"),
          });
        }
        if (!url.pathname.includes("/acme/workspace/") || ref !== TRUNK || !input.packText) {
          return new Response("missing", { status: 404 });
        }
        return Response.json({
          type: "file",
          encoding: "base64",
          content: Buffer.from(input.packText).toString("base64"),
        });
      }
      const sha = ref === HEAD ? input.headBlob : ref === "development" ? input.baseBlob : null;
      if (!sha) return new Response("missing", { status: 404 });
      return Response.json({ type: "file", sha });
    }
    if (href.includes("/actions/runs")) {
      const requested = new URL(href).searchParams.get("head_sha") ?? HEAD;
      return Response.json({
        total_count: 2,
        workflow_runs: [
          {
            name: "quality",
            path: ".github/workflows/quality.yml",
            status: "completed",
            conclusion: "success",
            event: "pull_request",
            head_sha: requested,
            check_suite_id: 11,
            html_url: "https://example.test/quality",
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            name: "ui",
            path: ".github/workflows/ui.yml",
            status: "completed",
            conclusion: "success",
            event: "pull_request",
            head_sha: requested,
            check_suite_id: 77,
            html_url: "https://example.test/ui",
            created_at: "2026-01-01T00:00:00Z",
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
    if (href.includes("/compare/")) {
      const changed = input.changedFiles ?? ["src/home.tsx"];
      return Response.json({
        status: "ahead",
        base_commit: { sha: "e".repeat(40) },
        files: changed.slice(0, 300).map((filename) => ({ filename })),
      });
    }
    if (href.endsWith("/pulls/4") && (init?.method ?? "GET") === "GET") {
      pullReads += 1;
      const sha = input.movingHead && pullReads > 1 ? "b".repeat(40) : HEAD;
      return Response.json({ mergeable_state: "clean", mergeable: true, head: { sha } });
    }
    if (href.endsWith("/pulls/4/merge")) {
      onMerge();
      return Response.json({ sha: "c".repeat(40) });
    }
    return Response.json({});
  };
}
