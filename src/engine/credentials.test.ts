import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

import type { ProjectPack } from "../schema/pack.ts";
import { ownerHealPrompt } from "./stall.ts";
import {
  credentialAuditFailed,
  formatCredentialAudit,
  inspectCredentials,
  stageGitPassword,
  type CredentialInspection,
} from "./credentials.ts";

const pack: ProjectPack = {
  schemaVersion: 2,
  tracker: "github",
  worker: "http",
  identity: "mint",
  repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main" }],
  qualityCommand: "npm test",
  qualityWorkflow: "quality",
  invariantsFile: "invariants.md",
  eligibility: { mode: "none" },
  landingStrategy: "pull-request",
  promotionStages: [],
  status: { intake: "Todo", complete: "Dev Complete" },
  connectors: [],
  commitActorTokenEnv: "COMMIT_ACTOR_TOKEN",
  design: { figmaTokenEnv: "FIGMA_ACCESS_TOKEN", repos: [] },
  workerHttp: {
    startUrl: "https://host.example/start",
    startHeaders: { "X-Worker": "WORKER_HEADER_ENV" },
  },
};

const secret = "super-secret-mint";
const actorSecret = "super-secret-actor";

function mintStdout(expiresAt: string): string {
  return JSON.stringify({ token: secret, expires_at: expiresAt });
}

describe("credential audit", () => {
  it("warns inside the window, fails when expired or rejected, and reports unknown expiry", async () => {
    const now = Date.parse("2026-11-12T00:00:00.000Z");
    const env = {
      DELIVERY_LOOP_GITHUB_MINT: "mint-command",
      DELIVERY_LOOP_CREDENTIAL_EXPIRY_DAYS: "14",
      COMMIT_ACTOR_TOKEN: actorSecret,
      FIGMA_ACCESS_TOKEN: "super-secret-figma",
      WORKER_HEADER_ENV: "super-secret-header",
    };
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      const href = String(url);
      calls.push(href);
      if (href.includes("api.github.com")) return new Response("unauthorized", { status: 401 });
      if (href.includes("api.figma.com")) return new Response(JSON.stringify({ handle: "ok" }), { status: 200 });
      throw new Error(`unexpected identity call ${href}`);
    };
    const warned = await inspectCredentials({
      pack,
      env,
      nowMs: now,
      runMint: () => ({ status: 0, stdout: mintStdout("2026-11-20T00:00:00.000Z") }),
      fetch: fetchImpl,
    });
    const warnText = formatCredentialAudit(warned);
    assert.match(warnText, /credential DELIVERY_LOOP_GITHUB_MINT warn expiry 2026-11-20T00:00:00.000Z/);
    assert.match(warnText, /credential COMMIT_ACTOR_TOKEN invalid expiry unknown/);
    assert.match(warnText, /credential FIGMA_ACCESS_TOKEN unknown expiry unknown/);
    assert.match(warnText, /credential WORKER_HEADER_ENV unknown expiry unknown/);
    assert.equal(warnText.includes(secret), false);
    assert.equal(warnText.includes(actorSecret), false);
    assert.equal(warnText.includes("super-secret-figma"), false);
    assert.equal(warnText.includes("super-secret-header"), false);
    assert.equal(credentialAuditFailed(warned), true);
    assert.deepEqual(calls.sort(), ["https://api.figma.com/v1/me", "https://api.github.com/user"]);

    const expired = await inspectCredentials({
      pack,
      env,
      nowMs: now,
      runMint: () => ({ status: 0, stdout: mintStdout("2026-11-01T00:00:00.000Z") }),
      fetch: async () => new Response("{}", { status: 200 }),
    });
    const expiredRow = expired.find((row) => row.name === "DELIVERY_LOOP_GITHUB_MINT") as CredentialInspection;
    assert.equal(expiredRow.state, "expired");
    assert.equal(credentialAuditFailed(expired), true);
    assert.equal(formatCredentialAudit(expired).includes(secret), false);
  });
});

describe("stage git password", () => {
  it("uses only the minted token when identity is mint", () => {
    const password = stageGitPassword(
      pack,
      { DELIVERY_LOOP_GITHUB_MINT: "mint-command", GH_TOKEN: "other-token" },
      () => ({ status: 0, stdout: mintStdout("2026-12-01T00:00:00.000Z") }),
      Date.parse("2026-11-12T00:00:00.000Z"),
    );
    assert.equal(password, secret);
    assert.throws(
      () => stageGitPassword(pack, { GH_TOKEN: "other-token" }, () => ({ status: 1, stdout: "" })),
      /stage: DELIVERY_LOOP_GITHUB_MINT is required/,
    );
  });
});

describe("heal prompt", () => {
  it("names commitActorTokenEnv from config", () => {
    const prompt = ownerHealPrompt({ reason: "no", tokenEnv: "COMMIT_ACTOR_TOKEN" });
    assert.match(prompt, /COMMIT_ACTOR_TOKEN/);
    assert.equal(/madmaxme/i.test(prompt), false);
  });
});

describe("engine names", () => {
  it("finds no client or person names outside tests, CODEOWNERS, and the changelog", () => {
    const root = join(import.meta.dirname, "../..");
    const hits: string[] = [];
    const skipDir = new Set(["node_modules", ".git", "dist"]);
    function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        if (skipDir.has(name)) continue;
        const path = join(dir, name);
        const info = statSync(path);
        if (info.isDirectory()) {
          walk(path);
          continue;
        }
        const rel = relative(root, path);
        if (rel.includes(".test.") || rel.endsWith("CODEOWNERS") || /changelog/i.test(rel)) continue;
        if (!/\.(ts|mjs|js|md|yml|yaml|json|sh|mdc)$/.test(rel)) continue;
        const text = readFileSync(path, "utf8");
        if (/madmaxme/i.test(text)) hits.push(rel);
      }
    }
    walk(root);
    assert.deepEqual(hits, []);
  });
});
