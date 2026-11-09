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
    assert.equal(pack.journeySpec, "{e2e,integration_test,journey}/**");
    assert.equal(pack.ship?.afterDev, true);
    assert.equal(pack.ship?.markStatus, false);
    assert.deepEqual(pack.ship?.steps, ["./scripts/ship.sh"]);
  });

  it("keeps a journey spec pattern and treats a directory as that tree", () => {
    assert.equal(loadPack(write(base)).journeySpec, "{e2e,integration_test,journey}/**");
    assert.equal(loadPack(write(`${base}\njourneySpec: test/e2e\n`)).journeySpec, "test/e2e/**");
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
