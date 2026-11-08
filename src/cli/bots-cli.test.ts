import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function snapshot(dir: string): string {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(`${path}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
    }
  };
  walk(dir);
  return files.sort().join("\n");
}

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.http_proxy = "http://127.0.0.1:9";
  env.https_proxy = "http://127.0.0.1:9";
  env.HTTP_PROXY = "http://127.0.0.1:9";
  env.HTTPS_PROXY = "http://127.0.0.1:9";
  return env;
}

describe("bots command", () => {
  it("validates and lists without credentials, and does nothing when bots are unset", () => {
    const dir = project(pack);
    cpSync(templates, join(dir, "bots"), { recursive: true });
    writeFileSync(join(dir, "delivery-loop.yaml"), `${pack}\nbots:\n  path: bots\n`);
    const absent = project(pack);
    mkdirSync(join(absent, "bots"));
    writeFileSync(join(absent, "bots/manifest.yaml"), "token: present\n");
    assert.equal(botsCommand(["validate", "--dir", absent]), 1);
    const before = snapshot(dir);
    assert.equal(botsCommand(["list", "--dir", dir]), 0);
    assert.equal(botsCommand(["validate", "--dir", dir]), 0);
    assert.equal(snapshot(dir), before);

    const tsx = join(root, "node_modules/tsx/dist/cli.mjs");
    const main = join(root, "src/cli/main.ts");
    const env = scrubbedEnv();
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.LINEAR_API_KEY, undefined);
    const listed = spawnSync(process.execPath, [tsx, main, "bots", "list", "--dir", dir], {
      cwd: dir,
      encoding: "utf8",
      env,
      timeout: 15000,
    });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /id: delivery-agent/);
    assert.match(listed.stdout, /status: unreached/);
    assert.doesNotMatch(listed.stdout, /mustNot|squashMerge|GH_TOKEN|LINEAR_API_KEY/);
    assert.equal(snapshot(dir), before);
    const validated = spawnSync(process.execPath, [tsx, main, "bots", "validate", "--dir", dir], {
      cwd: dir,
      encoding: "utf8",
      env,
      timeout: 15000,
    });
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(validated.stdout, "valid\n");
    assert.equal(snapshot(dir), before);
    const skipped = spawnSync(process.execPath, [tsx, main, "bots", "validate", "--dir", absent], {
      cwd: absent,
      encoding: "utf8",
      env,
      timeout: 15000,
    });
    assert.equal(skipped.status, 1);
    assert.match(skipped.stderr, /bots\.path is not set/);
    assert.doesNotMatch(skipped.stderr, /token: present/);
  });
});
