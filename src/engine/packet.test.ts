import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  invariantExists,
  journeyEvidenceBlocksBuild,
  journeyEvidenceProven,
  parseJourneyEvidence,
  parseJourneyProofs,
  parsePriorRequest,
  parseVerdict,
  parseWorkOrder,
  priorRequestBlocksBuild,
  parkStateForVerdict,
} from "./packet.ts";

const PACKET = `
**Verdict:** BUILDABLE
<!-- BUILD_PACKET
**Repos:** \`api\`
**Allowlist:** \`api/src/pay.ts\`
**Invariant:** \`charges-are-idempotent\`
**Decision:** Keep the charge idempotent by extending the existing handler.
**Symbols:** \`api/src/pay.ts#charge\`
**Validation:** \`npm test\`
**Stop:** The same handler is the only charge path.
BUILD_PACKET -->
`;

describe("prior request", () => {
  it("allows none, kept, and replaced with any ticket id", () => {
    assert.deepEqual(parsePriorRequest("**Prior request:** none — cleanup"), { kind: "none" });
    assert.deepEqual(parsePriorRequest("**Prior request:** kept"), { kind: "kept" });
    assert.deepEqual(parsePriorRequest("**Prior request:** replaced ACME-100 — undo"), {
      kind: "replaced",
      identifier: "ACME-100",
    });
    assert.equal(priorRequestBlocksBuild("**Prior request:** none"), null);
    assert.equal(priorRequestBlocksBuild("**Prior request:** replaced API-9"), null);
  });

  it("records ask as allowed, and still blocks a missing line and replaced without an id", () => {
    assert.equal(priorRequestBlocksBuild("**Prior request:** ask — keep the rule"), null);
    assert.equal(priorRequestBlocksBuild("**Prior request:** kept"), null);
    assert.equal(priorRequestBlocksBuild("**Prior request:** replaced — no id"), "replaced");
    assert.equal(priorRequestBlocksBuild("**Verdict:** BUILDABLE"), "missing");
  });
});

describe("journey evidence", () => {
  it("blocks a missing line and a blocked line", () => {
    assert.equal(parseJourneyEvidence("**Journey evidence:** recorded"), "recorded");
    assert.equal(parseJourneyEvidence("**Journey evidence:** not-applicable"), "not-applicable");
    assert.equal(journeyEvidenceBlocksBuild("**Journey evidence:** not-applicable"), null);
    assert.equal(journeyEvidenceBlocksBuild("**Journey evidence:** blocked"), "blocked");
    assert.equal(journeyEvidenceBlocksBuild("**Verdict:** BUILDABLE"), "missing");
  });

  it("reads a recording URL and a route-test path, and ignores a sentence", () => {
    const text = [
      "**Journey proof:** `https://example.test/artifacts/signup.mp4`",
      "**Journey proof:** `api/test/signup_route_test.dart`",
      "**Journey proof:** the journey was walked",
    ].join("\n");
    assert.deepEqual(parseJourneyProofs(text), [
      { kind: "recording", url: "https://example.test/artifacts/signup.mp4" },
      { kind: "route-test", repo: "api", path: "test/signup_route_test.dart" },
    ]);
  });

  it("accepts not-applicable and a receipt that contains the recording", () => {
    const declared = "**Journey evidence:** recorded\n**Journey proof:** `https://example.test/walk.png`";
    assert.equal(journeyEvidenceProven("**Journey evidence:** not-applicable", "", () => false), true);
    assert.equal(journeyEvidenceProven(declared, declared, () => false), true);
    assert.equal(journeyEvidenceProven(declared, "walked the journey", () => false), false);
  });

  it("accepts a route test only when the file is on the commit", () => {
    const declared = "**Journey evidence:** recorded\n**Journey proof:** `api/test/signup_route_test.dart`";
    assert.equal(
      journeyEvidenceProven(declared, "", (repo, path) => repo === "api" && path === "test/signup_route_test.dart"),
      true,
    );
    assert.equal(journeyEvidenceProven(declared, declared, () => false), false);
  });

  it("keeps an already-shipped journey in intake until the proof is real", () => {
    const text = "**Verdict:** ALREADY SHIPPED\n**Repos:** `api`\n**Journey evidence:** recorded\n";
    const input = { verdict: "ALREADY SHIPPED" as const, text, priorComments: [], devStatus: "Dev", trunkCommit: true };
    assert.equal(parkStateForVerdict(input), null);
    assert.equal(parkStateForVerdict({ ...input, journeyProven: true }), "Dev");
    assert.equal(
      parkStateForVerdict({
        ...input,
        text: text.replace("recorded", "not-applicable"),
      }),
      "Dev",
    );
  });
});

describe("work order", () => {
  it("parses a buildable packet", () => {
    assert.equal(parseVerdict(PACKET), "BUILDABLE");
    const order = parseWorkOrder(PACKET);
    assert.ok(order);
    assert.deepEqual(order?.repos, ["api"]);
    assert.equal(order?.invariant, "charges-are-idempotent");
    assert.equal(order?.symbols[0], "api/src/pay.ts#charge");
  });

  it("rejects a packet that does not cite an invariant", () => {
    assert.equal(parseWorkOrder("**Verdict:** BUILDABLE\n**Repos:** `api`"), null);
  });

  it("reads a GROUNDING_HANDOFF packet and ignores a bare mention of BUILDABLE", () => {
    const handoff = `
<!-- GROUNDING_HANDOFF
VERDICT: BUILDABLE
TIER: B
COMMENT:
**Codebase audit:** **BUILDABLE**
BUILD_PACKET:
**Repos:** \`api, customer-web\`
**Invariant:** \`billing/commission-resolution\`
**Decision:** Keep the one commission snapshot (\`billing/commission-resolution\`).
**Symbols:** \`api/src/pay.ts#charge\`
## Allowlist
- \`api/src/pay.ts\`
## Validation
\`\`\`bash
npm test
\`\`\`
## Stop
One commission path remains.
GROUNDING_HANDOFF -->
The prompt says BUILDABLE, NEEDS DIAGNOSIS.
`;
    assert.equal(parseVerdict(handoff), "BUILDABLE");
    const order = parseWorkOrder(handoff);
    assert.deepEqual(order?.repos, ["api", "customer-web"]);
    const separate = handoff.replace("**Repos:** `api, customer-web`", "**Repos:** `api` `customer-web`");
    assert.deepEqual(parseWorkOrder(separate)?.repos, ["api", "customer-web"]);
    assert.equal(order?.invariant, "billing/commission-resolution");
    assert.equal(order?.validation[0], "npm test");
    assert.equal(parseVerdict("The prompt lists BUILDABLE as a choice."), null);
  });

  it("matches an invariant heading", () => {
    const doc = "# Invariants\n\n## charges-are-idempotent\n\nKeep it.\n";
    assert.equal(invariantExists(doc, "charges-are-idempotent"), true);
    assert.equal(invariantExists(doc, "other"), false);
  });

  it("resolves prefix/slug from a heading file the pack lists", () => {
    const root = mkdtempSync(join(tmpdir(), "delivery-loop-"));
    mkdirSync(join(root, "rules"));
    writeFileSync(join(root, "rules/billing.md"), "## Commission resolution\n");
    const headings = [{ prefix: "billing", file: "rules/billing.md" }];
    assert.equal(invariantExists("# none\n", "billing/commission-resolution", root, headings), true);
    assert.equal(invariantExists("# none\n", "billing/other", root, headings), false);
    assert.equal(invariantExists("# none\n", "billing/commission-resolution", root, []), false);
  });
});
