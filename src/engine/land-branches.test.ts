import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { confirmLandBranches, renderBranch } from "./land-branches.ts";

const repos = [{ name: "api", url: "https://github.com/acme/api", trunk: "main" }];

describe("land branches", () => {
  it("renders the install template", () => {
    assert.equal(renderBranch("cursor/{issue}-{repo}", "API-1", "api"), "cursor/api-1-api");
  });

  it("uses the template branch when origin has it and the worker reported nothing", () => {
    const landed = confirmLandBranches({
      issue: "API-1",
      repos: ["api"],
      packRepos: repos,
      template: "cursor/{issue}-{repo}",
      text: "",
      reported: [],
      lookup: (_url, branch) => (branch === "cursor/api-1-api" ? "abc1234" : null),
    });
    assert.equal(landed?.[0]?.branch, "cursor/api-1-api");
    assert.equal(landed?.[0]?.sha, "abc1234");
  });

  it("prefers a handoff branch that origin confirms", () => {
    const landed = confirmLandBranches({
      issue: "API-1",
      repos: ["api"],
      packRepos: repos,
      template: "cursor/{issue}-{repo}",
      text: "ARTIFACTS:\n- repo: api\n  branch: feature/pay\n",
      reported: [],
      lookup: (_url, branch) => (branch === "feature/pay" ? "def5678" : null),
    });
    assert.equal(landed?.[0]?.branch, "feature/pay");
  });

  it("returns nothing when origin does not have the branch", () => {
    assert.equal(
      confirmLandBranches({
        issue: "API-1",
        repos: ["api"],
        packRepos: repos,
        template: "cursor/{issue}-{repo}",
        text: "",
        reported: [],
        lookup: () => null,
      }),
      null,
    );
  });
});
