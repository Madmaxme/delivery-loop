import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { githubForge, interpretCompare, interpretMergeability } from "./forge-github.ts";

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

  it("reads the compare status and the squash commit", async () => {
    assert.equal(interpretCompare("ahead"), "ahead");
    assert.equal(interpretCompare("diverged"), "diverged");
    assert.equal(interpretCompare(""), "unknown");
    const forge = githubForge({
      token: "token",
      fetch: async (url, init) => {
        if ((init?.method ?? "GET") === "PUT" && url.includes("/merge")) {
          return new Response(JSON.stringify({ sha: "deadbeef" }), { status: 200 });
        }
        return new Response(JSON.stringify({ status: "identical" }), { status: 200 });
      },
    });
    assert.equal(
      await forge.compare({
        repoUrl: "https://github.com/acme/api",
        base: "development",
        head: "cursor/qui-1-api",
      }),
      "identical",
    );
    assert.equal(
      await forge.squashMerge({ repoUrl: "https://github.com/acme/api", number: 4 }),
      "deadbeef",
    );
  });
});
