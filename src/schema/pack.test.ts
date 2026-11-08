import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { loadPack, proofPathsFromTrustedRef } from "./pack.ts";

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
    const lines: string[] = [];
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    let pack;
    try {
      pack = loadPack(
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
    } finally {
      process.stderr.write = writeErr;
    }
    assert.equal(pack.symbolsCommand, "node scripts/code-graph.mjs --check");
    assert.equal(pack.journeyCommand, "node scripts/journey-proof.mjs");
    assert.equal(pack.ship?.afterDev, true);
    assert.equal(pack.ship?.markStatus, false);
    assert.deepEqual(pack.ship?.steps, ["./scripts/ship.sh"]);
    assert.match(lines.join(""), /journeyCommand is ignored/);
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
    const lines: string[] = [];
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return true;
    }) as typeof process.stderr.write;
    try {
      loadPack(
        write(`${base}
design:
  repos:
    - name: admin-web
      check: npm run check:ui-primitives
      checkName: ui-primitives
      tokenFile: src/tokens.scss
`),
      );
    } finally {
      process.stderr.write = writeErr;
    }
    assert.match(lines.join(""), /admin-web has no proofPaths/);
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

  it("validates a bots directory inside the client directory and keeps only the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    cpSync(join(root, "bots/templates"), join(dir, "bots"), { recursive: true });
    writeFileSync(join(dir, "delivery-loop.yaml"), `${base}\nbots:\n  path: bots\n`);
    const pack = loadPack(join(dir, "delivery-loop.yaml"));
    assert.deepEqual(pack.bots, { path: "bots" });
    assert.equal(pack.qualityCommand, "npm test");
    assert.equal("definitions" in (pack.bots as object), false);
  });

  it("accepts a directory whose name starts with two dots", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    cpSync(join(root, "bots/templates"), join(dir, "..foo"), { recursive: true });
    writeFileSync(join(dir, "delivery-loop.yaml"), `${base}\nbots:\n  path: ..foo\n`);
    assert.deepEqual(loadPack(join(dir, "delivery-loop.yaml")).bots, { path: "..foo" });
  });

  it("refuses a bots path that leaves the client directory", () => {
    const parent = mkdtempSync(join(tmpdir(), "pack-"));
    const client = join(parent, "client");
    mkdirSync(client);
    cpSync(join(root, "bots/templates"), join(parent, "outside"), { recursive: true });
    writeFileSync(join(client, "delivery-loop.yaml"), `${base}\nbots:\n  path: ../outside\n`);
    assert.throws(() => loadPack(join(client, "delivery-loop.yaml")), /escapes the client directory/);
  });

  it("refuses a bots symlink that points outside the client directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    const outside = join(mkdtempSync(join(tmpdir(), "pack-out-")), "bundle");
    cpSync(join(root, "bots/templates"), outside, { recursive: true });
    symlinkSync(outside, join(dir, "linked"));
    writeFileSync(join(dir, "delivery-loop.yaml"), `${base}\nbots:\n  path: linked\n`);
    assert.throws(() => loadPack(join(dir, "delivery-loop.yaml")), /symlink escapes the client directory/);
  });

  it("refuses an absolute bots path outside the client directory", () => {
    const outside = join(mkdtempSync(join(tmpdir(), "pack-abs-")), "bundle");
    cpSync(join(root, "bots/templates"), outside, { recursive: true });
    assert.throws(() => loadPack(write(`${base}\nbots:\n  path: ${outside}\n`)), /relative/);
  });

  it("refuses bots without a path", () => {
    assert.throws(() => loadPack(write(`${base}\nbots: {}\n`)), /bots.path/);
  });

  it("reads proof paths from the forge at the pull request base when origin is another repo", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pack-origin-"));
    const other = mkdtempSync(join(tmpdir(), "pack-other-"));
    const wide = "design:\n  repos:\n    - name: admin-web\n      proofPaths:\n        - .\n";
    writeFileSync(join(other, "delivery-loop.yaml"), wide);
    const git = (dir: string, args: string[]) => {
      const result = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git(other, ["init", "-b", "main"]);
    git(other, ["config", "user.email", "dev@example.com"]);
    git(other, ["config", "user.name", "Dev"]);
    git(other, ["add", "delivery-loop.yaml"]);
    git(other, ["commit", "-m", "wide"]);
    const bare = join(cwd, "other.git");
    assert.equal(spawnSync("git", ["init", "--bare", "-b", "main", bare], { encoding: "utf8" }).status, 0);
    git(other, ["remote", "add", "origin", bare]);
    git(other, ["push", "origin", "HEAD:refs/heads/main"]);
    git(cwd, ["init", "-b", "main"]);
    git(cwd, ["remote", "add", "origin", bare]);
    writeFileSync(join(cwd, "delivery-loop.yaml"), wide);
    const baseSha = "b".repeat(40);
    const headSha = "a".repeat(40);
    let sawRef = "";
    const forge = {
      async pullBaseSha() {
        return baseSha;
      },
      async readTextFile(input: { repoUrl: string; path: string; ref: string }) {
        sawRef = input.ref;
        assert.equal(input.repoUrl, "https://github.com/acme/admin-web");
        assert.equal(input.path, "delivery-loop.yaml");
        return "design:\n  repos:\n    - name: admin-web\n      proofPaths:\n        - src/kept\n";
      },
    };
    const previous = process.cwd();
    process.chdir(cwd);
    try {
      const paths = await proofPathsFromTrustedRef(
        forge,
        "https://github.com/acme/admin-web",
        "development",
        headSha,
        "admin-web",
      );
      assert.deepEqual(paths, ["src/kept"]);
      assert.equal(sawRef, baseSha);
    } finally {
      process.chdir(previous);
    }
  });
});
