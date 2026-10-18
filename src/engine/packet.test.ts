import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { invariantExists, parseVerdict, parseWorkOrder } from "./packet.ts";

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
