import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubForge, interpretMergeability } from "./forge-github.ts";

describe("github mergeability", () => {
  it("maps the host state onto the land decision", () => {
    assert.equal(
      interpretMergeability({ mergeable: false, mergeable_state: "dirty", head: { sha: "abc" } }).state,
      "conflict",
    );
    assert.equal(interpretMergeability({ mergeable_state: "behind", head: { sha: "abc" } }).state, "behind");
    assert.equal(interpretMergeability({ mergeable_state: "unstable" }).state, "clean");
    assert.equal(interpretMergeability({ mergeable_state: "blocked" }).state, "blocked");
    assert.equal(
      interpretMergeability({ mergeable: null, mergeable_state: "unknown" }).state,
      "unknown",
    );
  });

  it("treats an already up-to-date branch as updated", async () => {
    const calls: string[] = [];
    const forge = githubForge({
      token: "token",
      fetch: async (url, init) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(
          JSON.stringify({ message: "There are no new commits on the base branch." }),
          { status: 422 },
        );
      },
    });
    await forge.updateBranch({
      repoUrl: "https://github.com/acme/api",
      number: 4,
      expectedHeadSha: "abc",
    });
    assert.match(calls[0] ?? "", /PUT .*\/pulls\/4\/update-branch$/);
  });
});
