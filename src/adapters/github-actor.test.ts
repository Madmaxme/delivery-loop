import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertCommitActor, commitActorLogin, githubRepoKey } from "./github-actor.ts";

describe("commit actor", () => {
  it("matches a repo url to the configured login", () => {
    const actors = [{ login: "Madmaxme", repos: ["https://github.com/Madmaxme/delivery-loop.git"] }];
    assert.equal(githubRepoKey("git@github.com:Madmaxme/delivery-loop.git"), "madmaxme/delivery-loop");
    assert.equal(commitActorLogin(actors, "https://github.com/Madmaxme/delivery-loop"), "Madmaxme");
    assert.equal(commitActorLogin(actors, "https://github.com/Quickwash-tech/api"), null);
  });

  it("refuses a token that is not the commit actor", () => {
    assert.throws(
      () => assertCommitActor("https://github.com/Madmaxme/delivery-loop", null, "Madmaxme"),
      /token login is not a user, commit actor is Madmaxme/,
    );
  });
});
