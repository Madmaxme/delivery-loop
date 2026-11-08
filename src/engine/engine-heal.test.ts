import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GITHUB_ACTIONS_APP_ID } from "./github-actions.ts";
import {
  engineHealAutoMergePath,
  engineHealBumpInstruction,
  engineHealFilesNeedReview,
  engineHealMergeArgs,
  engineHealBumpVersion,
  engineHealFileNeedsReview,
  engineHealQualityState,
  engineHealTag,
  gitBlobSha,
  gitChangedFiles,
  highestReleaseVersion,
  latestQualityProof,
  isEngineHealPull,
  nextPatchVersion,
  observeQualityRun,
  planEngineHealRelease,
  QUALITY_WORKFLOW_PATH,
  qualityRunIsBaseWorkflow,
  releaseTagExists,
  shouldMergeEngineHeal,
  type EngineHealFile,
  type QualityRunProof,
} from "./engine-heal.ts";

const head = "a".repeat(40);
const blob = "b".repeat(40);

const open = {
  pullState: "OPEN" as const,
  tagExists: false,
  branch: "engine-heal/APP-1",
  branchTip: head,
  prNumber: 41,
  qualityOnTip: "success" as const,
  qualityTrusted: true,
  qualityKnown: true,
  filesNeedReview: false as boolean | null,
};

function proof(overrides: Partial<QualityRunProof> = {}): QualityRunProof {
  return {
    id: 9,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    headSha: head,
    path: QUALITY_WORKFLOW_PATH,
    appId: GITHUB_ACTIONS_APP_ID,
    appSlug: "github-actions",
    workflowBlobSha: blob,
    mainWorkflowBlobSha: blob,
    ...overrides,
  };
}

describe("engine heal release", () => {
  it("merges only a green pull request that targets this package", () => {
    const base = {
      event: "pull_request",
      conclusion: "success",
      headRepo: "Madmaxme/delivery-loop",
      baseRepo: "Madmaxme/delivery-loop",
    };
    assert.equal(
      shouldMergeEngineHeal({ ...base, branch: "engine-heal/APP-1", labels: ["engine-heal"] }),
      true,
    );
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "engine-heal/APP-1", labels: [] }), false);
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "feature", labels: ["engine-heal"] }), false);
    assert.equal(
      shouldMergeEngineHeal({ ...base, branch: "engine-heal/APP-1", labels: ["Engine-Heal"] }),
      true,
    );
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "cursor/methodology", labels: [] }), false);
    assert.equal(shouldMergeEngineHeal({ ...base, branch: "engine-heal-notes", labels: ["engine-heal"] }), false);
    assert.equal(
      shouldMergeEngineHeal({
        ...base,
        conclusion: "failure",
        branch: "engine-heal/APP-1",
        labels: ["engine-heal"],
      }),
      false,
    );
    assert.equal(
      shouldMergeEngineHeal({ ...base, event: "push", branch: "engine-heal/APP-1", labels: ["engine-heal"] }),
      false,
    );
    assert.equal(
      shouldMergeEngineHeal({
        ...base,
        branch: "engine-heal/APP-1",
        labels: ["engine-heal"],
        headRepo: "other/delivery-loop",
      }),
      false,
    );
    assert.equal(isEngineHealPull({ branch: "engine-heal/APP-1", labels: ["engine-heal"] }), true);
    assert.equal(isEngineHealPull({ branch: "engine-heal/APP-1" }), false);
    assert.equal(isEngineHealPull({ branch: "feature", labels: ["engine-heal"] }), false);
  });

  it("takes the next patch after the highest tag and stops when that tag exists", () => {
    assert.equal(nextPatchVersion("1.0.0"), "1.0.1");
    assert.equal(nextPatchVersion("1.2.9"), "1.2.10");
    assert.throws(() => nextPatchVersion("1.0"), /bad version/);
    assert.equal(highestReleaseVersion(["refs/tags/v1.0.0", "refs/tags/v1.0.0^{}", "refs/tags/v0.9.0"]), "1.0.0");
    assert.equal(engineHealBumpVersion(["v1.0.0"]), "1.0.1");
    assert.equal(engineHealBumpVersion(["refs/tags/v1.0.0", "refs/tags/v1.0.2"]), "1.0.3");
    assert.equal(engineHealTag("1.0.1"), "v1.0.1");
    assert.equal(releaseTagExists("1.0.1", ["refs/tags/v1.0.1"]), true);
    assert.throws(() => engineHealBumpVersion([]), /no release tag/);
    assert.match(engineHealBumpInstruction(["v1.0.0"]), /Set package.json and package-lock.json to 1.0.1/);
    assert.match(engineHealBumpInstruction(), /v1\.0\.0 becomes 1\.0\.1/);
  });

  it("comments when the pull request has no bump and does not push one", () => {
    const missing = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.0",
    });
    assert.equal(missing.action, "comment");
    if (missing.action !== "comment") return;
    assert.match(missing.body, /does not bump package.json/);
    assert.match(missing.body, /does not push a commit/);
  });

  it("comments when the bumped version is already tagged", () => {
    const collision = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      tagExists: true,
    });
    assert.equal(collision.action, "comment");
    if (collision.action !== "comment") return;
    assert.match(collision.body, /Tag v1\.0\.1 already exists/);
  });

  it("waits for pull_request quality on the bumped tip and does not merge before that", () => {
    const waiting = planEngineHealRelease({
      ...open,
      qualityOnTip: "none",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: head,
    });
    assert.deepEqual(waiting, { action: "wait-for-quality", branch: "engine-heal/APP-1", sha: head });
    const pending = planEngineHealRelease({
      ...open,
      qualityOnTip: "pending",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: head,
    });
    assert.equal(pending.action, "wait-for-quality");
    const failed = planEngineHealRelease({
      ...open,
      qualityOnTip: "failure",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
    });
    assert.equal(failed.action, "fail");
  });

  it("pins the squash merge to the green head sha", () => {
    const sha = "a".repeat(40);
    assert.deepEqual(engineHealMergeArgs("acme/loop", 4, sha), [
      "pr",
      "merge",
      "4",
      "--repo",
      "acme/loop",
      "--squash",
      "--match-head-commit",
      sha,
      "--delete-branch",
    ]);
    assert.throws(() => engineHealMergeArgs("acme/loop", 4, "def222"), /head sha/);
  });

  it("squash-merges only when the bumped tip is green, then tags that version", () => {
    const merge = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      branchTip: "def222",
    });
    assert.deepEqual(merge, { action: "merge-and-tag", version: "1.0.1", tag: "v1.0.1" });
    const behind = planEngineHealRelease({
      ...open,
      qualityOnTip: "success",
      mainVersion: "1.0.2",
      tipVersion: "1.0.1",
    });
    assert.equal(behind.action, "comment");
  });

  it("tags a merged pull request and does not open another bump", () => {
    const tag = planEngineHealRelease({
      ...open,
      pullState: "MERGED",
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
    });
    assert.deepEqual(tag, { action: "tag-merged", version: "1.0.1", tag: "v1.0.1" });
    const done = planEngineHealRelease({
      ...open,
      pullState: "MERGED",
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      tagExists: true,
    });
    assert.equal(done.action, "skip");
    const closed = planEngineHealRelease({
      ...open,
      pullState: "CLOSED",
      qualityOnTip: "success",
      mainVersion: "1.0.0",
      tipVersion: "1.0.0",
    });
    assert.equal(closed.action, "skip");
  });

  it("does not push a commit", () => {
    const script = readFileSync(new URL("../../scripts/engine-heal.ts", import.meta.url), "utf8");
    const workflow = readFileSync(new URL("../../.github/workflows/engine-heal.yml", import.meta.url), "utf8");
    assert.equal(script.includes("HEAD:main"), false);
    assert.equal(script.includes("npm version"), false);
    assert.equal(script.includes("workflow_dispatch"), false);
    assert.equal(workflow.includes("workflow_dispatch"), false);
    assert.match(script, /refs\/tags\//);
    assert.match(script, /pr", "comment"/);
    assert.equal(qualityRunIsBaseWorkflow(proof({ event: "push" }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ event: "pull_request" }), head), true);
  });

  it("reads the quality check on the tip", () => {
    assert.equal(engineHealQualityState([]), "none");
    assert.equal(engineHealQualityState([{ status: "completed", conclusion: "success" }]), "success");
    assert.equal(
      engineHealQualityState([
        { status: "completed", conclusion: "failure" },
        { status: "completed", conclusion: "success" },
      ]),
      "none",
    );
    assert.equal(
      engineHealQualityState([
        { id: 1, attempt: 1, createdAt: "2026-01-01T00:00:00Z", status: "completed", conclusion: "success" },
        { id: 2, attempt: 2, createdAt: "2026-01-02T00:00:00Z", status: "completed", conclusion: "failure" },
      ]),
      "failure",
    );
    assert.equal(
      engineHealQualityState([
        { id: 1, attempt: 1, createdAt: "2026-01-01T00:00:00Z", status: "completed", conclusion: "success" },
        { id: 2, attempt: 2, createdAt: "2026-01-02T00:00:00Z", status: "in_progress", conclusion: "" },
      ]),
      "pending",
    );
    const older = proof({
      id: 10,
      attempt: 9,
      runStartedAt: "2026-01-01T00:00:00Z",
      createdAt: "2026-01-01T00:00:00Z",
    });
    const newer = proof({
      id: 11,
      attempt: 1,
      runStartedAt: "2026-01-02T00:00:00Z",
      createdAt: "2026-01-02T00:00:00Z",
      conclusion: "failure",
    });
    assert.equal(latestQualityProof([older, newer])?.id, 11);
    assert.equal(latestQualityProof([older, newer], 11)?.conclusion, "failure");
    assert.equal(latestQualityProof([older, newer], 10), null);
    assert.equal(qualityRunIsBaseWorkflow(latestQualityProof([older, newer]), head), false);
    assert.equal(engineHealQualityState([{ status: "in_progress", conclusion: "" }]), "pending");
    assert.equal(engineHealQualityState([{ status: "action_required", conclusion: "" }]), "pending");
    assert.equal(engineHealQualityState([{ status: "completed", conclusion: "failure" }]), "failure");
  });

  it("trusts a quality run only when the base workflow matches this head", () => {
    assert.equal(qualityRunIsBaseWorkflow(proof(), head), true);
    assert.equal(observeQualityRun(proof(), head).trusted, true);
    const other = "c".repeat(40);
    assert.equal(qualityRunIsBaseWorkflow(proof({ headSha: other }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ workflowBlobSha: other }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ mainWorkflowBlobSha: null }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ path: ".github/workflows/other.yml" }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ appId: 1 }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ appId: null }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ appSlug: "not-actions" }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ event: "workflow_dispatch" }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ event: "push" }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ id: null }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof({ status: "in_progress" }), head), false);
    assert.equal(qualityRunIsBaseWorkflow(null, head), false);
    assert.equal(qualityRunIsBaseWorkflow(proof(), "abc"), false);
    const unread = observeQualityRun(null, head);
    assert.equal(unread.known, false);
    assert.equal(unread.trusted, false);
  });

  it("routes a self-certified or sensitive pull request to review", () => {
    const bumped = { mainVersion: "1.0.0", tipVersion: "1.0.1" };
    const workflow = planEngineHealRelease({
      ...open,
      ...bumped,
      filesNeedReview: true,
    });
    assert.equal(workflow.action, "review");
    if (workflow.action !== "review") return;
    assert.match(workflow.body, /normal review/);
    assert.match(workflow.body, /will not squash-merge or tag/);
    const scripts = planEngineHealRelease({
      ...open,
      ...bumped,
      qualityTrusted: true,
      filesNeedReview: true,
    });
    assert.equal(scripts.action, "review");
    const unknownFiles = planEngineHealRelease({
      ...open,
      ...bumped,
      filesNeedReview: null,
    });
    assert.equal(unknownFiles.action, "review");
    const untrusted = planEngineHealRelease({
      ...open,
      ...bumped,
      qualityTrusted: false,
    });
    assert.equal(untrusted.action, "review");
    const unreadable = planEngineHealRelease({
      ...open,
      ...bumped,
      qualityOnTip: "none",
      qualityKnown: false,
      qualityTrusted: false,
    });
    assert.equal(unreadable.action, "review");
    const sensitiveMerged = planEngineHealRelease({
      ...open,
      ...bumped,
      pullState: "MERGED",
      filesNeedReview: true,
    });
    assert.equal(sensitiveMerged.action, "review");
    const manifest: EngineHealFile = {
      path: "package.json",
      baseText: JSON.stringify({ name: "loop", version: "1.0.0", scripts: { test: "tsx --test" } }),
      headText: JSON.stringify({ name: "loop", version: "1.0.1", scripts: { test: "exit 0" } }),
    };
    assert.equal(engineHealFileNeedsReview(manifest), true);
    const versionOnly: EngineHealFile = {
      path: "package.json",
      baseText: JSON.stringify({ name: "loop", version: "1.0.0", scripts: { test: "tsx --test" } }),
      headText: JSON.stringify({ scripts: { test: "tsx --test" }, version: "1.0.1", name: "loop" }),
    };
    assert.equal(engineHealFileNeedsReview(versionOnly), false);
    const postinstall: EngineHealFile = {
      path: "package.json",
      baseText: JSON.stringify({ name: "loop", version: "1.0.0", scripts: { test: "tsx --test" } }),
      headText: JSON.stringify({
        name: "loop",
        version: "1.0.1",
        scripts: { test: "tsx --test", postinstall: "exit 0" },
      }),
    };
    assert.equal(engineHealFileNeedsReview(postinstall), true);
    const deps: EngineHealFile = {
      path: "package.json",
      baseText: JSON.stringify({ name: "loop", version: "1.0.0", dependencies: { tsx: "^4.0.0" } }),
      headText: JSON.stringify({ name: "loop", version: "1.0.1", dependencies: { tsx: "^9.0.0" } }),
    };
    assert.equal(engineHealFileNeedsReview(deps), true);
    const lock = {
      name: "loop",
      version: "1.0.0",
      packages: { "": { version: "1.0.0", dependencies: { tsx: "^4.0.0" } } },
    };
    const lockBump = {
      ...lock,
      version: "1.0.1",
      packages: { "": { version: "1.0.1", dependencies: { tsx: "^4.0.0" } } },
    };
    assert.equal(
      engineHealFileNeedsReview({
        path: "package-lock.json",
        baseText: JSON.stringify(lock),
        headText: JSON.stringify(lockBump),
      }),
      false,
    );
    const lockDep = {
      ...lockBump,
      packages: { "": { version: "1.0.1", dependencies: { tsx: "^9.0.0" } } },
    };
    assert.equal(
      engineHealFileNeedsReview({
        path: "package-lock.json",
        baseText: JSON.stringify(lock),
        headText: JSON.stringify(lockDep),
      }),
      true,
    );
    assert.equal(
      engineHealFileNeedsReview({
        path: "package-lock.json",
        baseText: JSON.stringify({
          version: "1.0.0",
          packages: { "": { version: "1.0.0" }, "node_modules/tsx": { version: "4.0.0" } },
        }),
        headText: JSON.stringify({
          version: "1.0.1",
          packages: { "": { version: "1.0.1" }, "node_modules/tsx": { version: "9.0.0" } },
        }),
      }),
      true,
    );
    assert.equal(engineHealFileNeedsReview({ path: ".github/workflows/quality.yml", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "scripts/engine-heal.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/engine/engine-heal.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/engine/loop.test.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/engine/loop.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/engine/design-gate.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/engine/github-actions.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/engine/land-branches.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/adapters/forge-github.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/schema/pack.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/bots/load.ts", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "src/connectors/catalog.ts", baseText: null, headText: null }), false);
    assert.equal(engineHealAutoMergePath(".npmrc"), false);
    assert.equal(engineHealAutoMergePath("tsconfig.json"), false);
    assert.equal(engineHealAutoMergePath("vitest.config.ts"), false);
    assert.equal(
      engineHealFileNeedsReview({ path: ".npmrc", baseText: null, headText: "script-shell=/bin/true\n" }),
      true,
    );
    const npmrc = planEngineHealRelease({
      ...open,
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      filesNeedReview: engineHealFileNeedsReview({
        path: ".npmrc",
        baseText: null,
        headText: "script-shell=/bin/true\n",
      }),
    });
    assert.equal(npmrc.action, "review");
    assert.equal(engineHealFileNeedsReview({ path: "../quality.yml", baseText: null, headText: null }), true);
    assert.equal(engineHealFileNeedsReview({ path: "package.json", baseText: null, headText: "{}" }), true);
    assert.equal(engineHealFilesNeedReview(null), null);
    assert.equal(
      engineHealFilesNeedReview([{ path: "src/connectors/catalog.ts", baseText: null, headText: null }]),
      false,
    );
  });

  it("reads a real git diff and refuses a rewritten quality workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "heal-gate-"));
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git("init", "-b", "main");
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "loop", version: "1.0.0", scripts: { test: "tsx --test" } }));
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    writeFileSync(join(root, ".github/workflows/quality.yml"), "name: quality\non: pull_request\n");
    mkdirSync(join(root, "src/connectors"), { recursive: true });
    writeFileSync(join(root, "src/connectors", "note.ts"), "export const note = true;\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("checkout", "-b", "engine-heal/APP-1");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "loop", version: "1.0.1", scripts: { test: "tsx --test" } }));
    writeFileSync(join(root, ".github/workflows/quality.yml"), "name: quality\non: pull_request\n# exit 0\n");
    git("add", ".");
    git("commit", "-m", "weaken quality");
    const tip = git("rev-parse", "HEAD");
    const files = gitChangedFiles(root, "main", tip);
    assert.equal(engineHealFilesNeedReview(files), true);
    const mainBlob = gitBlobSha(root, "main", QUALITY_WORKFLOW_PATH);
    const headBlob = gitBlobSha(root, tip, QUALITY_WORKFLOW_PATH);
    assert.ok(mainBlob);
    assert.ok(headBlob);
    assert.notEqual(mainBlob, headBlob);
    const seen = observeQualityRun(
      proof({ headSha: tip, workflowBlobSha: headBlob, mainWorkflowBlobSha: mainBlob }),
      tip,
    );
    assert.equal(seen.trusted, false);
    assert.equal(seen.onTip, "success");
    const plan = planEngineHealRelease({
      ...open,
      branchTip: tip,
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      qualityOnTip: seen.onTip,
      qualityTrusted: seen.trusted,
      qualityKnown: seen.known,
      filesNeedReview: engineHealFilesNeedReview(files),
    });
    assert.equal(plan.action, "review");

    git("checkout", "main");
    git("checkout", "-b", "engine-heal/APP-2");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "loop", version: "1.0.1", scripts: { test: "tsx --test" } }));
    writeFileSync(join(root, "src/connectors", "note.ts"), "export const note = false;\n");
    git("add", ".");
    git("commit", "-m", "bump only");
    const cleanTip = git("rev-parse", "HEAD");
    const cleanFiles = gitChangedFiles(root, "main", cleanTip);
    assert.equal(engineHealFilesNeedReview(cleanFiles), false);
    const sameBlob = gitBlobSha(root, cleanTip, QUALITY_WORKFLOW_PATH);
    assert.equal(sameBlob, mainBlob);
    const clean = observeQualityRun(
      proof({ headSha: cleanTip, workflowBlobSha: sameBlob, mainWorkflowBlobSha: mainBlob }),
      cleanTip,
    );
    assert.equal(clean.trusted, true);
    const merge = planEngineHealRelease({
      ...open,
      branch: "engine-heal/APP-2",
      branchTip: cleanTip,
      mainVersion: "1.0.0",
      tipVersion: "1.0.1",
      qualityOnTip: clean.onTip,
      qualityTrusted: clean.trusted,
      qualityKnown: clean.known,
      filesNeedReview: engineHealFilesNeedReview(cleanFiles),
    });
    assert.equal(merge.action, "merge-and-tag");

    git("checkout", "main");
    git("checkout", "-b", "engine-heal/APP-3");
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "loop", version: "1.0.1", scripts: { test: "tsx --test" } }));
    writeFileSync(join(root, ".npmrc"), "script-shell=/bin/true\n");
    git("add", ".");
    git("commit", "-m", "make npm test a no-op");
    const npmTip = git("rev-parse", "HEAD");
    assert.equal(engineHealFilesNeedReview(gitChangedFiles(root, "main", npmTip)), true);
  });
});
