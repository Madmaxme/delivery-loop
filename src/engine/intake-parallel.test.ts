import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { INTAKE_PARALLEL_LIMIT, selectIntakeStarts, type IntakeCandidate } from "./intake-parallel.ts";

const edge = [{ producer: "api", consumers: ["admin-web", "customer-web", "customer-app", "operator-app"] }];

function candidate(id: string, repos: string[] | null): IntakeCandidate {
  return { id, repos };
}

describe("selectIntakeStarts", () => {
  it("starts operator-app and infra together", () => {
    assert.deepEqual(
      selectIntakeStarts([
        candidate("QUI-1", ["operator-app"]),
        candidate("QUI-2", ["infra"]),
      ], []),
      ["QUI-1", "QUI-2"],
    );
  });

  it("holds a second operator-app ticket", () => {
    assert.deepEqual(
      selectIntakeStarts([
        candidate("QUI-1", ["operator-app"]),
        candidate("QUI-2", ["operator-app"]),
      ], []),
      ["QUI-1"],
    );
  });

  it("holds api behind admin-web and admin-web behind api", () => {
    assert.deepEqual(
      selectIntakeStarts(
        [candidate("QUI-2", ["api"])],
        [candidate("QUI-1", ["admin-web"])],
        edge,
      ),
      [],
    );
    assert.deepEqual(
      selectIntakeStarts(
        [candidate("QUI-2", ["admin-web"])],
        [candidate("QUI-1", ["api"])],
        edge,
      ),
      [],
    );
  });

  it("starts customer-web and operator-app together", () => {
    assert.deepEqual(
      selectIntakeStarts([
        candidate("QUI-1", ["customer-web"]),
        candidate("QUI-2", ["operator-app"]),
      ], [], edge),
      ["QUI-1", "QUI-2"],
    );
  });

  it("runs a ticket with no recorded repos alone", () => {
    assert.deepEqual(
      selectIntakeStarts([
        candidate("QUI-1", null),
        candidate("QUI-2", ["infra"]),
      ], []),
      ["QUI-1"],
    );
    assert.deepEqual(
      selectIntakeStarts(
        [candidate("QUI-2", null)],
        [candidate("QUI-1", ["infra"])],
      ),
      [],
    );
  });

  it("leaves a third disjoint ticket waiting at the capacity", () => {
    assert.equal(INTAKE_PARALLEL_LIMIT, 2);
    assert.deepEqual(
      selectIntakeStarts([
        candidate("QUI-1", ["infra"]),
        candidate("QUI-2", ["notes"]),
        candidate("QUI-3", ["billing"]),
      ], []),
      ["QUI-1", "QUI-2"],
    );
  });
});
