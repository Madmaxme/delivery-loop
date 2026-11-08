import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ForgeTreeReader } from "../adapters/types.ts";
import type { ProjectPack } from "../schema/pack.ts";
import { textFromTrustedRef } from "../schema/trusted-ref.ts";
import { parse } from "yaml";

const pack = {
  agent: { url: "https://github.com/acme/loop", trunk: "main" },
  repos: [{ name: "api", url: "https://github.com/acme/api", trunk: "main" }],
} as ProjectPack;

describe("textFromTrustedRef", () => {
  it("reads actors from the pinned sha and ignores any other ref", async () => {
    const forge: ForgeTreeReader = {
      async trunkSha() {
        return "b".repeat(40);
      },
      async readTextFile(input) {
        assert.equal(input.ref, "b".repeat(40));
        assert.equal(input.path, "delivery-loop.yaml");
        return "commitActors:\n  - login: owner\n    repos: []\n";
      },
    };
    const read = await textFromTrustedRef(forge, pack, "delivery-loop.yaml");
    const actors = (parse(read.text) as { commitActors?: { login: string }[] }).commitActors ?? [];
    assert.equal(actors[0]?.login, "owner");
    assert.equal(read.trunkSha, "b".repeat(40));
  });

  it("refuses when the forge does not return a sha", async () => {
    const forge: ForgeTreeReader = {
      async trunkSha() {
        return null;
      },
      async readTextFile() {
        return "commitActors: []\n";
      },
    };
    await assert.rejects(() => textFromTrustedRef(forge, pack, "delivery-loop.yaml"), /trusted trunk sha is absent/);
  });
});
