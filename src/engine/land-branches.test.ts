import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { confirmLandBranches, lookupRemoteHead, renderBranch } from "./land-branches.ts";

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

  it("passes a GitHub token to git through the environment, not the remote URL", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-ask-"));
    const argsFile = join(dir, "args");
    const tokenFile = join(dir, "token");
    const askFile = join(dir, "ask");
    const token = "secret-token-value";
    writeFileSync(
      join(dir, "git"),
      `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}
printf '%s\\n' "\${DELIVERY_LOOP_GIT_TOKEN-unset}" > ${JSON.stringify(tokenFile)}
printf '%s\\n' "\${GH_TOKEN-unset}" > ${JSON.stringify(join(dir, "ambient"))}
printf '%s\\n' "$GIT_ASKPASS" > ${JSON.stringify(askFile)}
printf '%s\\n' "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/heads/main"
`,
      { mode: 0o755 },
    );
    const previousPath = process.env.PATH;
    const previousGh = process.env.GH_TOKEN;
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    process.env.GH_TOKEN = "ambient-token";
    try {
      const sha = lookupRemoteHead("https://github.com/acme/api", "main", token);
      assert.equal(sha, "a".repeat(40));
      const args = readFileSync(argsFile, "utf8");
      assert.equal(args.includes(token), false);
      assert.equal(args.includes("ambient-token"), false);
      assert.match(args, /https:\/\/github.com\/acme\/api/);
      assert.equal(readFileSync(tokenFile, "utf8").trim(), token);
      assert.equal(readFileSync(join(dir, "ambient"), "utf8").trim(), "unset");
      assert.ok(readFileSync(askFile, "utf8").trim().endsWith("askpass.sh"));
      const plain = lookupRemoteHead("https://github.com/acme/api", "main");
      assert.equal(plain, "a".repeat(40));
      assert.equal(readFileSync(tokenFile, "utf8").trim(), "unset");
      assert.equal(readFileSync(join(dir, "ambient"), "utf8").trim(), "unset");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousGh === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = previousGh;
    }
  });
});
