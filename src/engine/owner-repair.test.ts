import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import type { DeliveryState, Ticket } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";
import { landOwnerRepair, type LoopDeps } from "./loop.ts";

it("owns exact-SHA cold quality, landing and native release handoff for different clients", async () => {
  for (const client of ["alpha-api", "beta-web"])
    for (const mode of [
      "passed",
      "already-landed",
      "quality-fails",
      "dirty-quality",
      "trunk-moved",
      "requirements-moved",
      "policy-denied",
      "candidate-moved",
      "deadline",
      "no-change",
      "foreign-repo",
      "pull-request-only",
    ]) {
      const directory = mkdtempSync(join(tmpdir(), "owner-repair-contract-"));
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, {
          cwd: directory,
          encoding: "utf8",
          timeout: 30_000,
        });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      try {
        git("init", "-b", "main");
        git("config", "user.email", "test@example.invalid");
        git("config", "user.name", "Test");
        writeFileSync(join(directory, "owner.txt"), "before\n");
        writeFileSync(join(directory, ".gitignore"), "node_modules/\n");
        git("add", ".");
        git("commit", "-m", "Base owner");
        const base = git("rev-parse", "HEAD");
        git("checkout", "-b", "owner-repair");
        writeFileSync(join(directory, "owner.txt"), "after\n");
        git("add", "owner.txt");
        git("commit", "-m", "Repair owner");
        const head = git("rev-parse", "HEAD");
        git("checkout", "main");
        if (mode === "already-landed") git("merge", "--ff-only", "owner-repair");
        mkdirSync(join(directory, "node_modules"));
        writeFileSync(join(directory, "node_modules", "keep"), "shared dependencies\n");
        const repo = { name: client, url: `https://github.com/agnostic/${client}`, trunk: "main" };
        const pack: ProjectPack = {
          schemaVersion: 2,
          tracker: "github",
          worker: "http",
          repos: [repo],
          agent: { url: repo.url, trunk: repo.trunk },
          qualityCommand: "quality",
          qualityWorkflow: "quality",
          invariantsFile: "invariants.md",
          eligibility: { mode: "none" },
          landingStrategy: "fast-forward",
          promotionStages: [],
          status: { intake: "Todo", complete: "Dev Complete", hold: "Shaping" },
          connectors: [],
        };
        const ticket: Ticket = {
          id: "1",
          identifier: "TEST-1",
          title: "Repair",
          body: "",
          stateName: "Todo",
          labels: [],
          issueType: null,
          assigneeId: null,
          fieldValues: {},
          attachments: [],
          criteriaRevision: "a".repeat(64),
          blockedBy: [],
          comments: [],
        };
        const rows = [
          { repo: client, sha: base },
          { repo: "untouched-dependency", sha: "b".repeat(40) },
        ];
        const createdAt = new Date(0).toISOString();
        let state: DeliveryState = {
          schemaVersion: 2,
          markers: [
            { kind: "landed-commits", body: JSON.stringify(rows), createdAt },
            {
              kind: "land-resume",
              body: JSON.stringify({
                kind: "wait",
                hold: false,
                rows,
                declared: "Original acceptance",
                receipt: "Original receipt",
              }),
              createdAt,
            },
            { kind: "owner-repair-pending", body: "{}", createdAt },
            {
              kind: "owner-heal",
              body: JSON.stringify({ type: "promote-failed", attempt: "reserved" }),
              createdAt,
            },
          ],
          stageReceipts: [
            {
              stageId: "dev",
              target: "dev",
              outcome: "passed",
              reason: "Historical evidence",
              criteriaRevision: ticket.criteriaRevision,
              deployed: [rows[0]],
              criteria: [],
            },
          ],
        };
        let quality = 0,
          lands = 0,
          writes = 0;
        let trunk =
          mode === "already-landed" ? head : mode === "trunk-moved" ? "c".repeat(40) : base;
        const originalState = structuredClone(state);
        const deps: LoopDeps = {
          pack,
          cwd: directory,
          report() {},
          tracker: {
            kind: "github",
            async listIntake() {
              return [ticket];
            },
            async get() {
              return {
                ...ticket,
                criteriaRevision:
                  mode === "requirements-moved" ? "d".repeat(64) : ticket.criteriaRevision,
              };
            },
            async comment() {},
            async setState() {
              assert.fail("Landing is not completion");
            },
            async addLabel() {},
            async removeLabel() {},
            stateStore: {
              async readDeliveryState() {
                return structuredClone(state);
              },
              async writeDeliveryState(_id, value) {
                writes++;
                state = structuredClone(value);
              },
            },
          },
          worker: {
            kind: "http",
            async start() {
              assert.fail("Landing must not start another model");
            },
            async join() {
              assert.fail("Landing must not start another model");
            },
          },
          forge: {
            async compare() {
              assert.equal(quality, 1);
              return "ahead";
            },
            async directLand(input) {
              assert.equal(quality, 1);
              assert.equal(input.expectedHeadSha, head);
              assert.equal(input.expectedBaseSha, base);
              lands++;
              git("update-ref", "refs/heads/main", head, base);
              trunk = head;
              return head;
            },
            async openPullRequest() {
              assert.fail();
            },
            async quality() {
              assert.fail();
            },
            async requestQualityRun() {
              return null;
            },
            async mergeability() {
              assert.fail();
            },
            async updateBranch() {},
            async squashMerge() {
              assert.fail();
            },
            async dispatch() {},
          },
          lookupHead(_url, branch) {
            return branch === "main" ? trunk : mode === "candidate-moved" ? "e".repeat(40) : head;
          },
          async validateOwnerRepair() {
            if (mode === "policy-denied") throw Error("Client policy denied repair");
          },
          runCommand(_command, cwd, env, timeout) {
            quality++;
            assert(cwd !== directory);
            assert(
              !existsSync(join(cwd, "node_modules")),
              "Quality must not inherit shared dependencies",
            );
            assert.equal(env?.CI, "true");
            assert(timeout && timeout <= 600_000);
            assert.equal(
              spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).stdout.trim(),
              head,
            );
            if (mode === "dirty-quality") writeFileSync(join(cwd, "uncommitted.txt"), "unsafe");
            return { status: mode === "quality-fails" ? 1 : 0, stdout: "", stderr: "" };
          },
        };
        if (mode === "pull-request-only") pack.landingStrategy = "pull-request";
        const candidate = {
          repoUrl: mode === "foreign-repo" ? "https://github.com/other/repo" : repo.url,
          branch: "owner-repair",
          head: mode === "no-change" ? base : head,
        };
        const run = () =>
          landOwnerRepair(
            deps,
            ticket,
            candidate,
            base,
            Date.now() + (mode === "deadline" ? -1 : 60_000),
          );
        if (mode === "passed" || mode === "already-landed") {
          await run();
          assert.equal(quality, 1);
          assert.equal(lands, mode === "passed" ? 1 : 0);
          assert.equal(writes, 1);
          const landed = JSON.parse(
            state.markers.find((marker) => marker.kind === "landed-commits")!.body,
          );
          const resume = JSON.parse(
            state.markers.find((marker) => marker.kind === "land-resume")!.body,
          );
          assert.deepEqual(landed, [{ repo: client, sha: head }, rows[1]]);
          assert.deepEqual(resume.rows, landed);
          assert.equal(resume.receipt, "Original receipt");
          assert(!state.markers.some((marker) => marker.kind === "owner-repair-pending"));
          assert.deepEqual(state.stageReceipts, originalState.stageReceipts);
          assert.deepEqual(
            state.markers.find((marker) => marker.kind === "owner-heal"),
            originalState.markers.find((marker) => marker.kind === "owner-heal"),
          );
        } else {
          await assert.rejects(run);
          assert.equal(lands, 0);
          assert.equal(writes, 0);
          assert.deepEqual(state, originalState);
        }
        assert(
          existsSync(join(directory, "node_modules", "keep")),
          "Shared dependencies must remain untouched",
        );
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
});
