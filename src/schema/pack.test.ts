import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { loadPack } from "./pack.ts";

function write(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  const path = join(dir, "delivery-loop.yaml");
  writeFileSync(path, body);
  return path;
}

const base = `
schemaVersion: 2
tracker: linear
worker: cursor
eligibility:
  mode: none
landingStrategy: pull-request
promotionStages: []
status:
  complete: Dev Complete
repos:
  - name: api
    url: https://git.example/acme/api.git
    trunk: main
qualityCommand: npm test
`;

describe("pack requirements", () => {
  it("requires schemaVersion 2 and explicit v2 choices", () => {
    const migrationError = /delivery-loop.yaml requires schemaVersion: 2; migrate the client pack before running Delivery Loop v2/;
    assert.throws(() => loadPack(write(base.replace("schemaVersion: 2\n", ""))), migrationError);
    assert.throws(() => loadPack(write(base.replace("schemaVersion: 2", "schemaVersion: 1"))), migrationError);
    assert.throws(() => loadPack(write(base.replace("eligibility:\n  mode: none\n", ""))), /eligibility/);
    assert.throws(() => loadPack(write(base.replace("landingStrategy: pull-request\n", ""))), /landingStrategy/);
    assert.throws(() => loadPack(write(base.replace("promotionStages: []\n", ""))), /promotionStages/);
    assert.throws(() => loadPack(write(base.replace("  complete: Dev Complete\n", ""))), /status.complete/);
    assert.deepEqual(loadPack(write(base)).eligibility, { mode: "none" });
    const commandPack = loadPack(write(base.replace("mode: none", "mode: command\n  command: node scripts/policy.mjs")));
    assert.deepEqual(commandPack.eligibility, { mode: "command", command: "node scripts/policy.mjs" });
    assert.throws(() => loadPack(write(base.replace("mode: none", "mode: command"))), /eligibility/);
  });

  it("validates Jira configuration without embedding credentials", () => {
    const jira = base.replace("tracker: linear", "tracker: jira") + `jira:
  apiBaseUrl: https://jira.example.test
  authHeaderEnv: JIRA_AUTH_HEADER
  intakeJql: project = APP AND status = Open
  approvalFieldId: customfield_12345
`;
    const pack = loadPack(write(jira));
    assert.equal(pack.jira?.apiBaseUrl, "https://jira.example.test");
    assert.equal(pack.jira?.approvalFieldId, "customfield_12345");
    assert.throws(() => loadPack(write(jira.replace("https://jira.example.test", "http://jira.example.test"))), /apiBaseUrl/);
    assert.throws(() => loadPack(write(jira.replace("JIRA_AUTH_HEADER", "not an env"))), /authHeaderEnv/);
    assert.throws(() => loadPack(write(jira.replace("project = APP AND status = Open", "  "))), /intakeJql/);
    assert.throws(() => loadPack(write(jira.replace("customfield_12345", "not-a-field"))), /approvalFieldId/);
  });

  it("requires explicit ship-stage flags and a shipped status before writing status", () => {
    const stage = `promotionStages:
  - id: release
    target: production
    authorization: ship
    promoteCommand: ./scripts/promote.sh
    repos:
      - api
    verifyCommand: ./scripts/verify.sh
`;
    assert.throws(() => loadPack(write(base.replace("promotionStages: []", stage))), /parkSuccess and writeStatus/);
    const writesStatus = stage.replace(
      "verifyCommand: ./scripts/verify.sh",
      "verifyCommand: ./scripts/verify.sh\n    parkSuccess: false\n    writeStatus: true\n    approval:\n      source: label\n      label: approved",
    );
    assert.throws(() => loadPack(write(base.replace("promotionStages: []", writesStatus))), /status.shipped/);
    const shipped = base.replace("  complete: Dev Complete", "  complete: Dev Complete\n  shipped: Shipped");
    assert.equal(loadPack(write(shipped.replace("promotionStages: []", writesStatus))).status.shipped, "Shipped");
  });

  it("rejects ambiguous stage IDs, reversed authorization order, and v1 promotion fields", () => {
    const stage = (id: string, target: string, authorization: "deliver" | "ship") => `  - id: ${id}
    target: ${target}
    authorization: ${authorization}
    promoteCommand: ./scripts/promote.sh
    repos:
      - api
    verifyCommand: ./scripts/verify.sh${authorization === "ship" ? "\n    parkSuccess: false\n    writeStatus: false\n    approval:\n      source: label\n      label: approved" : ""}`;
    const duplicateId = base.replace("promotionStages: []", `promotionStages:\n${stage("dev", "dev", "deliver")}\n${stage("dev", "qa", "deliver")}`);
    assert.throws(() => loadPack(write(duplicateId)), /unique/);
    const duplicateTarget = base.replace("promotionStages: []", `promotionStages:\n${stage("dev", "dev", "deliver")}\n${stage("qa", "dev", "deliver")}`);
    assert.throws(() => loadPack(write(duplicateTarget)), /unique/);
    const reversed = base.replace("promotionStages: []", `promotionStages:\n${stage("ship", "prod", "ship")}\n${stage("dev", "dev", "deliver")}`);
    assert.throws(() => loadPack(write(reversed)), /deliver stages must precede ship stages/);
    assert.throws(() => loadPack(write(`${base}dev:\n  steps: []\n`)), /v1 promotion fields/);
    assert.throws(() => loadPack(write(base.replace("  complete: Dev Complete", "  complete: Dev Complete\n  prod: Prod"))), /v1 promotion fields/);
  });
  it("defaults the cursor key slot env names", () => {
    const pack = loadPack(write(base));
    assert.equal(pack.workerKeys?.primary, "CURSOR_API_KEY");
    assert.equal(pack.workerKeys?.fallback, "CURSOR_API_KEY_FALLBACK");
  });

  it("keeps the env var names a client sets for the key slots", () => {
    const pack = loadPack(
      write(`${base}
workerKeys:
  primary: PRIMARY_SLOT
  fallback: SECOND_SLOT
`),
    );
    assert.equal(pack.workerKeys?.primary, "PRIMARY_SLOT");
    assert.equal(pack.workerKeys?.fallback, "SECOND_SLOT");
  });

  it("refuses a workerKeys name that is not an env var", () => {
    assert.throws(() => loadPack(write(`${base}\nworkerKeys:\n  primary: "not an env"\n`)), /workerKeys/);
  });

  it("keeps a workerModel id and omits it when the key is absent", () => {
    const unset = loadPack(write(base));
    assert.equal(unset.workerModel, undefined);
    const pack = loadPack(write(`${base}workerModel: model-4.7\n`));
    assert.equal(pack.workerModel, "model-4.7");
  });

  it("defaults transient retries", () => {
    const pack = loadPack(write(base));
    assert.equal(pack.transient?.maxAttempts, 3);
    assert.equal(pack.transient?.maxWaitMs, 60_000);
    const named = loadPack(write(`${base}transient:\n  maxAttempts: 4\n  maxWaitMs: 1000\n`));
    assert.equal(named.transient?.maxAttempts, 4);
    assert.equal(named.transient?.maxWaitMs, 1000);
  });

  it("refuses a transient budget that is not a count or a wait", () => {
    assert.throws(() => loadPack(write(`${base}transient:\n  maxAttempts: 0\n`)), /transient.maxAttempts/);
    assert.throws(() => loadPack(write(`${base}transient:\n  maxWaitMs: -1\n`)), /transient.maxWaitMs/);
  });

  it("defaults the http worker wait inside the job budget", () => {
    const httpBase = base.replace("worker: cursor", "worker: http");
    const pack = loadPack(
      write(`${httpBase}
workerHttp:
  startUrl: https://host.example/start
  statusUrl: https://host.example/status/{id}
  startHeaders:
    Authorization: START_TOKEN
  statusHeaders:
    Authorization: mint
`),
    );
    assert.equal(pack.workerHttp?.pollMs, 15_000);
    assert.equal(pack.workerHttp?.maxWaitMs, 3_600_000);
    assert.equal(pack.workerHttp?.startHeaders?.Authorization, "START_TOKEN");
    assert.equal(pack.workerHttp?.statusHeaders?.Authorization, "mint");
    const named = loadPack(
      write(`${httpBase}
workerHttp:
  startUrl: https://host.example/start
  statusUrl: https://host.example/runs/{id}
  pollMs: 5000
  maxWaitMs: 120000
`),
    );
    assert.equal(named.workerHttp?.pollMs, 5000);
    assert.equal(named.workerHttp?.maxWaitMs, 120_000);
  });

  it("refuses an http worker wait outside the job budget", () => {
    const httpBase = base.replace("worker: cursor", "worker: http");
    const http = `
workerHttp:
  startUrl: https://host.example/start
  statusUrl: https://host.example/status/{id}
`;
    assert.throws(() => loadPack(write(`${httpBase}${http}  pollMs: 0\n`)), /workerHttp.pollMs/);
    assert.throws(
      () => loadPack(write(`${httpBase}${http}  pollMs: 2000\n  maxWaitMs: 1000\n`)),
      /workerHttp.maxWaitMs/,
    );
    assert.throws(
      () => loadPack(write(`${httpBase}${http}  maxWaitMs: 21600001\n`)),
      /job budget/,
    );
    assert.throws(
      () =>
        loadPack(
          write(`${httpBase}
workerHttp:
  startUrl: https://host.example/start
  statusUrl: https://host.example/status?run=1
`),
        ),
      /\{id\}/,
    );
    assert.throws(() => loadPack(write(httpBase)), /workerHttp.startUrl/);
    const stored = loadPack(
      write(`${httpBase}
workerHttp:
  startUrl: https://host.example/start
  statusStore:
    kind: forge
    repo: acme/store
    branch: results
    path: worker-results/{id}.json
`),
    );
    assert.equal(stored.workerHttp?.statusUrl, undefined);
    assert.equal(stored.workerHttp?.statusStore?.repo, "acme/store");
    assert.equal(stored.workerHttp?.statusStore?.path, "worker-results/{id}.json");
    const issue = loadPack(
      write(`${httpBase}
workerHttp:
  statusStore:
    kind: forge
    repo: acme/store
    branch: results
    path: worker-results/{id}.json
  request:
    kind: forge-issue
    repo: acme/signals
    assignee: relay-login
    labels:
      - run
`),
    );
    assert.equal(issue.workerHttp?.startUrl, undefined);
    assert.equal(issue.workerHttp?.request?.assignee, "relay-login");
    assert.deepEqual(issue.workerHttp?.request?.labels, ["run"]);
    assert.throws(
      () =>
        loadPack(
          write(`${httpBase}
workerHttp:
  startUrl: https://host.example/start
  request:
    kind: forge-issue
    repo: acme/signals
    assignee: relay-login
`),
        ),
      /request needs workerHttp.statusStore/,
    );
    assert.throws(
      () =>
        loadPack(
          write(`${httpBase}
workerHttp:
  startUrl: https://host.example/start
  statusStore:
    kind: forge
    repo: acme/store
    branch: results
    path: worker-results/result.json
`),
        ),
      /statusStore.path/,
    );
    assert.throws(
      () =>
        loadPack(
          write(`${httpBase}
workerHttp:
  startUrl: https://host.example/start
  statusUrl: https://host.example/status/{id}
  startHeaders:
    Authorization: "not a source"
`),
        ),
      /startHeaders/,
    );
  });

  it("refuses a workerModel value that is not a model id", () => {
    assert.throws(() => loadPack(write(`${base}workerModel: "not a model"\n`)), /workerModel/);
    assert.throws(() => loadPack(write(`${base}workerModel: 4\n`)), /workerModel/);
    assert.throws(() => loadPack(write(`${base}workerModel: ""\n`)), /workerModel/);
  });

  it("defaults the four slots without naming a project", () => {
    const pack = loadPack(write(base));
    assert.equal(pack.forge, "github");
    assert.equal(pack.check, "workflow");
    assert.equal(pack.runner, "gha");
    assert.equal(pack.tracker, "linear");
    assert.equal(pack.worker, "cursor");
  });

  it("accepts a git forge when the runner executes the quality command", () => {
    const pack = loadPack(write(`${base}\nforge: git\ncheck: command\nrunner: local\n`));
    assert.equal(pack.forge, "git");
    assert.equal(pack.check, "command");
    assert.equal(pack.runner, "local");
    assert.equal(pack.identity, undefined);
  });

  it("reads runner.identity mint and trusted requesters", () => {
    const pack = loadPack(write(`${base.replace("worker: cursor", "worker: http")}
runner:
  kind: gha
  identity: mint
workerHttp:
  statusStore:
    kind: forge
    repo: acme/store
    branch: results
    path: worker-results/{id}.json
  request:
    kind: forge-issue
    repo: acme/signals
    assignee: relay-login
    trustedRequesters:
      - relay-login
`));
    assert.equal(pack.runner, "gha");
    assert.equal(pack.identity, "mint");
    assert.deepEqual(pack.workerHttp?.request?.trustedRequesters, ["relay-login"]);
    assert.throws(
      () => loadPack(write(`${base}runner:\n  identity: other\n`)),
      /runner.identity must be mint/,
    );
  });

  it("accepts a user login or an app bot login and rejects anything else", () => {
    const http = base.replace("worker: cursor", "worker: http");
    const request = (logins: string[]) => `${http}
workerHttp:
  statusStore:
    kind: forge
    repo: acme/store
    branch: results
    path: worker-results/{id}.json
  request:
    kind: forge-issue
    repo: acme/signals
    assignee: relay-login
    trustedRequesters:
${logins.map((login) => `      - ${JSON.stringify(login)}`).join("\n")}
`;
    const pack = loadPack(write(request(["qws-delivery[bot]", "Madmaxme"])));
    assert.deepEqual(pack.workerHttp?.request?.trustedRequesters, ["qws-delivery[bot]", "Madmaxme"]);
    for (const login of ["foo[bot]x", "[bot]", "", "qws delivery", "a/b"]) {
      assert.throws(
        () => loadPack(write(request([login]))),
        /workerHttp.request.trustedRequesters is a list of logins/,
      );
    }
  });

  it("refuses a workflow check on a plain git forge", () => {
    assert.throws(() => loadPack(write(`${base}\nforge: git\ncheck: workflow\n`)), /forge github/);
  });

  it("keeps optional symbols and journey commands", () => {
    const pack = loadPack(write(`${base}
symbolsCommand: node scripts/code-graph.mjs --check
journeyCommand: node scripts/journey-proof.mjs
`));
    assert.equal(pack.symbolsCommand, "node scripts/code-graph.mjs --check");
    assert.equal(pack.journeyCommand, "node scripts/journey-proof.mjs");
    assert.equal(pack.journeySpec, "{e2e,integration_test,journey}/**");
  });

  it("keeps a journey spec pattern and treats a directory as that tree", () => {
    assert.equal(loadPack(write(base)).journeySpec, "{e2e,integration_test,journey}/**");
    assert.equal(loadPack(write(`${base}\njourneySpec: test/e2e\n`)).journeySpec, "test/e2e/**");
  });

  it("keeps a scoped promotion stage and its deploy refs", () => {
    const source = base.replace("promotionStages: []", `promotionStages:
  - id: dev
    target: dev
    authorization: deliver
    promoteCommand: ./scripts/promote.sh {repo}
    repos:
      - customer-app
    verifyCommand: ./scripts/verify.sh
    refs:
      customer-app:
        - dev-a
        - dev-b`);
    const loaded = loadPack(write(source));
    assert.equal(loaded.promotionStages[0]?.promoteCommand, "./scripts/promote.sh {repo}");
    assert.deepEqual(loaded.promotionStages[0]?.refs, { "customer-app": ["dev-a", "dev-b"] });
    assert.equal(loaded.promotionStages[0]?.verify, undefined);
    assert.equal(loaded.promotionStages[0]?.promote, undefined);
  });

  it("accepts a positive command timeout and rejects any other timeout value", () => {
    const stage = `promotionStages:
  - id: dev
    target: dev
    authorization: deliver
    promoteCommand: ./scripts/promote.sh
    promote:
      timeoutMs: 1500
    repos:
      - api
    verifyCommand: ./scripts/verify.sh
    verify:
      timeoutMs: 2500
    continueCommand: ./scripts/continue.sh
    continue:
      timeoutMs: 3500`;
    const loaded = loadPack(write(base.replace("promotionStages: []", stage)));
    assert.deepEqual(loaded.promotionStages[0]?.promote, { timeoutMs: 1500 });
    assert.deepEqual(loaded.promotionStages[0]?.verify, { timeoutMs: 2500 });
    assert.deepEqual(loaded.promotionStages[0]?.continue, { timeoutMs: 3500 });
    assert.throws(() => loadPack(write(base.replace("promotionStages: []", stage.replace("timeoutMs: 2500", "timeoutMs: 0")))), /verify\.timeoutMs/);
    assert.throws(() => loadPack(write(base.replace("promotionStages: []", stage.replace("timeoutMs: 1500", "timeoutMs: 1.5")))), /promote\.timeoutMs/);
    assert.throws(() => loadPack(write(base.replace("promotionStages: []", stage.replace("timeoutMs: 3500", "limit: 3500")))), /continue only allows timeoutMs/);
  });

  it("accepts dependsOn inside one authorization and rejects cycles and unknown ids", () => {
    const stage = (id: string, extra = "") => `  - id: ${id}
    target: ${id}-target
    authorization: deliver
    promoteCommand: ./scripts/promote.sh
    repos:
      - api
    verifyCommand: ./scripts/verify.sh${extra}`;
    const linked = loadPack(write(base.replace("promotionStages: []", `promotionStages:\n${stage("first")}\n${stage("second", "\n    dependsOn:\n      - first")}`)));
    assert.deepEqual(linked.promotionStages[1]?.dependsOn, ["first"]);
    assert.equal(linked.promotionStages[0]?.dependsOn, undefined);
    const cycle = base.replace("promotionStages: []", `promotionStages:\n${stage("first", "\n    dependsOn:\n      - second")}\n${stage("second", "\n    dependsOn:\n      - first")}`);
    assert.throws(() => loadPack(write(cycle)), /cycle/);
    const unknown = base.replace("promotionStages: []", `promotionStages:\n${stage("first", "\n    dependsOn:\n      - missing")}`);
    assert.throws(() => loadPack(write(unknown)), /unknown stage/);
    const ship = `  - id: ship-stage
    target: ship-target
    authorization: ship
    promoteCommand: ./scripts/promote.sh
    repos:
      - api
    verifyCommand: ./scripts/verify.sh
    parkSuccess: false
    writeStatus: false
    approval:
      source: label
      label: approved
    dependsOn:
      - first`;
    const shipped = base.replace("  complete: Dev Complete", "  complete: Dev Complete\n  shipped: Shipped");
    assert.throws(() => loadPack(write(shipped.replace("promotionStages: []", `promotionStages:\n${stage("first")}\n${ship}`))), /another authorization/);
  });

  it("rejects a ship stage without approval and rejects a bad approval shape", () => {
    const shipped = base.replace("  complete: Dev Complete", "  complete: Dev Complete\n  shipped: Shipped");
    const stage = (approval: string) => `promotionStages:
  - id: release
    target: production
    authorization: ship
    promoteCommand: ./scripts/promote.sh
    repos:
      - api
    verifyCommand: ./scripts/verify.sh
    parkSuccess: false
    writeStatus: false
${approval}`;
    const missing = stage("");
    assert.throws(() => loadPack(write(shipped.replace("promotionStages: []", missing))), /approval/);
    const shapes = [
      "    approval: {}",
      "    approval:\n      source: list",
      "    approval:\n      source: list\n      issues: []",
      "    approval:\n      source: list\n      issues:\n        - \"\"",
      "    approval:\n      source: list\n      issues:\n        - API-1\n        - API-1",
      "    approval:\n      source: label",
      "    approval:\n      source: label\n      label: \"\"",
      "    approval:\n      source: other\n      label: approved",
      "    approval:\n      source: list\n      issues:\n        - API-1\n      label: approved",
      "    approval:\n      source: label\n      label: approved\n      issues:\n        - API-1",
    ];
    for (const shape of shapes) {
      assert.throws(() => loadPack(write(shipped.replace("promotionStages: []", stage(shape)))), /approval/);
    }
    const listed = loadPack(write(shipped.replace("promotionStages: []", stage("    approval:\n      source: list\n      issues:\n        - API-1\n        - API-2"))));
    assert.deepEqual(listed.promotionStages[0]?.approval, { source: "list", issues: ["API-1", "API-2"] });
    const labeled = loadPack(write(shipped.replace("promotionStages: []", stage("    approval:\n      source: label\n      label: approved"))));
    assert.deepEqual(labeled.promotionStages[0]?.approval, { source: "label", label: "approved" });
    const deliver = `promotionStages:
  - id: dev
    target: dev
    authorization: deliver
    promoteCommand: ./scripts/promote.sh
    repos:
      - api
    verifyCommand: ./scripts/verify.sh
    approval:
      source: label
      label: approved`;
    assert.throws(() => loadPack(write(base.replace("promotionStages: []", deliver))), /approval is only valid on a ship stage/);
  });

  it("keeps heal caps and leaves an absent cap at the runner default", () => {
    const pack = loadPack(
      write(`${base}
heal:
  maxAttempts: 4
  caps:
    quality-red: 2
    ship-failed: 1
`),
    );
    assert.equal(pack.heal?.maxAttempts, 4);
    assert.equal(pack.heal?.caps?.["quality-red"], 2);
    assert.equal(pack.heal?.caps?.["ship-failed"], 1);
    assert.equal(loadPack(write(base)).heal, undefined);
  });

  it("keeps the design block and defaults the Figma token env name", () => {
    const pack = loadPack(
      write(`${base}
design:
  repos:
    - name: admin-web
      check: npm run check:ui-primitives
      checkName: ui-primitives
      tokenFile: src/tokens.scss
`),
    );
    assert.equal(pack.design?.figmaTokenEnv, "FIGMA_ACCESS_TOKEN");
    assert.equal(pack.design?.repos[0]?.checkName, "ui-primitives");
    assert.equal(pack.design?.repos[0]?.tokenFile, "src/tokens.scss");
  });

  it("refuses a design repo that omits its check", () => {
    assert.throws(
      () => loadPack(write(`${base}\ndesign:\n  repos:\n    - name: admin-web\n`)),
      /tokenFile/,
    );
  });

  it("refuses a tracker that is not a real queue", () => {
    assert.throws(() => loadPack(write(base.replace("tracker: linear", "tracker: files"))), /tracker/);
  });

  it("stays quiet when the pack omits bots", () => {
    const warnings = captureWarnings(() => {
      const pack = loadPack(write(base));
      assert.equal(Object.hasOwn(pack, "bots"), false);
      assert.equal(pack.qualityCommand, "npm test");
    });
    assert.deepEqual(warnings, []);
  });

  it("ignores a leftover bots key with a warning", () => {
    const extras = [
      "bots:\n  path: bots\n",
      "bots:\n  path: ../outside\n",
      "bots:\n  path: /tmp/missing-bots\n",
      "bots: {}\n",
      "bots:\n",
    ];
    for (const extra of extras) {
      const warnings = captureWarnings(() => {
        const pack = loadPack(write(`${base}\n${extra}`));
        assert.equal(Object.hasOwn(pack, "bots"), false);
        assert.equal(pack.qualityCommand, "npm test");
      });
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /bots is ignored/);
    }
  });
});

function captureWarnings(run: () => void): string[] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  try {
    run();
  } finally {
    console.warn = original;
  }
  return warnings;
}
