import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_JOURNEY_SPEC,
  journeySpecPattern,
  matchesJourneySpec,
  proofLinesFor,
} from "../../scripts/journey-proof.mjs";

describe("journey proof", () => {
  it("uses the journey tree when the pack omits a pattern", () => {
    assert.equal(DEFAULT_JOURNEY_SPEC, "{e2e,integration_test,journey}/**");
    assert.equal(journeySpecPattern(""), DEFAULT_JOURNEY_SPEC);
    assert.equal(journeySpecPattern("test/e2e"), "test/e2e/**");
    assert.equal(matchesJourneySpec("e2e/signup.spec.ts"), true);
    assert.equal(matchesJourneySpec("integration_test/signup_test.dart"), true);
    assert.equal(matchesJourneySpec("journey/walk/signup.test.ts"), true);
    assert.equal(matchesJourneySpec("test/pay.spec.ts"), false);
    assert.equal(matchesJourneySpec("src/users.spec.ts"), false);
    assert.equal(matchesJourneySpec("test/e2e/signup.spec.ts", "test/e2e"), true);
    assert.equal(matchesJourneySpec("e2e/signup.spec.ts", "test/e2e"), false);
  });

  it("keeps a recording url that sits inside a fenced handoff", () => {
    const url = "https://example.test/dl/calendar-journey.webm";
    const text = [
      "```text",
      "<!-- BUILD_HANDOFF",
      `\`${url}\``,
      "BUILD_HANDOFF -->",
      "```",
    ].join("\n");
    assert.deepEqual(proofLinesFor(text), [`**Journey proof:** \`${url}\``]);
  });

  it("prints a journey spec and leaves an api unit spec out", () => {
    const text = [
      "**Journey proof:** `api/test/pay.spec.ts`",
      "**Journey proof:** `api/e2e/signup.spec.ts`",
      "**Journey proof:** `https://example.test/artifacts/signup.mp4`",
    ].join("\n");
    assert.deepEqual(proofLinesFor(text), [
      "**Journey proof:** `api/e2e/signup.spec.ts`",
      "**Journey proof:** `https://example.test/artifacts/signup.mp4`",
    ]);
    const dir = mkdtempSync(join(tmpdir(), "journey-proof-"));
    writeFileSync(join(dir, "delivery-loop.yaml"), "journeySpec: test/e2e\n");
    const script = join(process.cwd(), "scripts/journey-proof.mjs");
    const result = spawnSync(process.execPath, [script, "api/test/pay.spec.ts", "api/test/e2e/signup.spec.ts"], {
      cwd: dir,
      encoding: "utf8",
      input: "**Journey proof:** `api/src/users.spec.ts`\n",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /api\/test\/e2e\/signup\.spec\.ts/);
    assert.doesNotMatch(result.stdout, /pay\.spec\.ts/);
    assert.doesNotMatch(result.stdout, /users\.spec\.ts/);
  });
});
