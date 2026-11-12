import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * Linear schema, introspected 2026-11-12 against api.linear.app:
 * IDComparator.eq is ID. IssueLabelCreateInput.teamId is String.
 */
const schema = {
  "IDComparator.eq": "ID",
  "IssueLabelCreateInput.teamId": "String",
} as const;

const src = readFileSync(new URL("./trackers.ts", import.meta.url), "utf8");

describe("Linear label team id", () => {
  it("looks up a label with ID and creates one with String", () => {
    const lookup = src.match(
      /query\(\$name: String!, \$teamId: ([A-Za-z!]+)\) \{\s*issueLabels\(filter: \{ name: \{ eqIgnoreCase: \$name \}, team: \{ id: \{ eq: \$teamId \} \} \}/,
    );
    const create = src.match(
      /mutation\(\$name: String!, \$teamId: ([A-Za-z!]+)\) \{\s*issueLabelCreate\(input: \{ name: \$name, teamId: \$teamId \}\)/,
    );
    assert.ok(lookup, "label lookup query");
    assert.ok(create, "label create mutation");
    assert.equal(lookup[1], `${schema["IDComparator.eq"]}!`);
    assert.equal(create[1], `${schema["IssueLabelCreateInput.teamId"]}!`);
  });
});
