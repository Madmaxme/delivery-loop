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

  it("keeps a scoped promote command on the dev block", () => {
    const pack = loadPack(
      write(`${base}\ndev:\n  promote:\n    command: ./scripts/promote.sh dev --repo {repo}\n    repos:\n      - customer-app\n`),
    );
    assert.equal(pack.dev?.promote?.command, "./scripts/promote.sh dev --repo {repo}");
    assert.deepEqual(pack.dev?.promote?.repos, ["customer-app"]);
  });

  it("refuses a tracker that is not a real queue", () => {
    assert.throws(() => loadPack(write(base.replace("tracker: linear", "tracker: files"))), /tracker/);
  });
});
