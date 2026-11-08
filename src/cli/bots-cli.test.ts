import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { botsCommand } from "./main.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const templates = join(root, "bots/templates");

const pack = `
tracker: linear
worker: cursor
repos:
  - name: api
    url: https://git.example/acme/api.git
    trunk: main
qualityCommand: npm test
`;

function project(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bots-cli-"));
  writeFileSync(join(dir, "delivery-loop.yaml"), body);
  return dir;
}

describe("bots command", () => {
  it("validates and lists without credentials, and does nothing when bots are unset", () => {
    const dir = project(pack);
    const rel = relative(dir, templates);
    writeFileSync(join(dir, "delivery-loop.yaml"), `${pack}\nbots:\n  path: ${rel}\n`);
    const absent = project(pack);
    mkdirSync(join(absent, "bots"));
    writeFileSync(join(absent, "bots/manifest.yaml"), "token: present\n");
    assert.equal(botsCommand(["validate", "--dir", absent]), 1);
    assert.equal(botsCommand(["list", "--dir", dir]), 0);
    assert.equal(botsCommand(["validate", "--dir", dir]), 0);

    const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
    const main = join(root, "src/cli/main.ts");
    const env = {
      ...process.env,
      GH_TOKEN: "sentinel-token-value",
      LINEAR_API_KEY: "sentinel-linear-value",
    };
    const listed = spawnSync(process.execPath, [tsx, main, "bots", "list", "--dir", dir], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /id: delivery-agent/);
    assert.match(listed.stdout, /status: unreached/);
    assert.doesNotMatch(listed.stdout, /mustNot|squashMerge|sentinel/);
    assert.doesNotMatch(listed.stderr, /sentinel/);
    const validated = spawnSync(process.execPath, [tsx, main, "bots", "validate", "--dir", dir], {
      cwd: dir,
      encoding: "utf8",
      env,
    });
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(validated.stdout, "valid\n");
    assert.doesNotMatch(`${validated.stdout}${validated.stderr}`, /sentinel/);
    const skipped = spawnSync(process.execPath, [tsx, main, "bots", "validate", "--dir", absent], {
      cwd: absent,
      encoding: "utf8",
      env,
    });
    assert.equal(skipped.status, 1);
    assert.match(skipped.stderr, /bots\.path is not set/);
    assert.doesNotMatch(skipped.stderr, /token: present|sentinel/);
  });
});
