import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadPack } from "./pack.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function write(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  const path = join(dir, "delivery-loop.yaml");
  writeFileSync(path, body);
  return path;
}

const base = `
tracker: linear
worker: cursor
repos:
  - name: api
    url: https://git.example/acme/api.git
    trunk: main
qualityCommand: npm test
`;

describe("pack requirements", () => {
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
  });

  it("refuses a workflow check on a plain git forge", () => {
    assert.throws(() => loadPack(write(`${base}\nforge: git\ncheck: workflow\n`)), /forge github/);
  });

  it("keeps optional symbol, journey, and ship-after-dev commands", () => {
    const pack = loadPack(
      write(`${base}
symbolsCommand: node scripts/code-graph.mjs --check
journeyCommand: node scripts/journey-proof.mjs
ship:
  markStatus: false
  afterDev: true
  steps:
    - ./scripts/ship.sh
`),
    );
    assert.equal(pack.symbolsCommand, "node scripts/code-graph.mjs --check");
    assert.equal(pack.journeyCommand, "node scripts/journey-proof.mjs");
    assert.equal(pack.ship?.afterDev, true);
    assert.equal(pack.ship?.markStatus, false);
    assert.deepEqual(pack.ship?.steps, ["./scripts/ship.sh"]);
  });

  it("keeps a scoped promote command on the dev block", () => {
    const pack = loadPack(
      write(`${base}\ndev:\n  promote:\n    command: ./scripts/promote.sh dev --repo {repo}\n    repos:\n      - customer-app\n`),
    );
    assert.equal(pack.dev?.promote?.command, "./scripts/promote.sh dev --repo {repo}");
    assert.deepEqual(pack.dev?.promote?.repos, ["customer-app"]);
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

  it("does not read a bots directory when the pack omits bots", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    writeFileSync(join(dir, "delivery-loop.yaml"), base);
    mkdirSync(join(dir, "bots"));
    writeFileSync(join(dir, "bots/manifest.yaml"), "token: present\n");
    const pack = loadPack(join(dir, "delivery-loop.yaml"));
    assert.equal(pack.bots, undefined);
    assert.equal(pack.qualityCommand, "npm test");
  });

  it("validates a relative bots directory and keeps only the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    const rel = relative(dir, join(root, "bots/templates"));
    writeFileSync(join(dir, "delivery-loop.yaml"), `${base}\nbots:\n  path: ${rel}\n`);
    const pack = loadPack(join(dir, "delivery-loop.yaml"));
    assert.deepEqual(pack.bots, { path: rel });
    assert.equal(pack.qualityCommand, "npm test");
    assert.equal("definitions" in (pack.bots as object), false);
  });

  it("follows a bots directory symlink and still confines reads to that directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    symlinkSync(join(root, "bots/templates"), join(dir, "linked"));
    writeFileSync(join(dir, "delivery-loop.yaml"), `${base}\nbots:\n  path: linked\n`);
    assert.deepEqual(loadPack(join(dir, "delivery-loop.yaml")).bots, { path: "linked" });
  });

  it("refuses an absolute bots path", () => {
    assert.throws(() => loadPack(write(`${base}\nbots:\n  path: /tmp/bots\n`)), /relative/);
  });

  it("refuses bots without a path", () => {
    assert.throws(() => loadPack(write(`${base}\nbots: {}\n`)), /bots.path/);
  });
});
