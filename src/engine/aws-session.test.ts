import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  awsRoleForRefresh,
  ensureAwsSession,
  resetAwsRoleMemory,
  roleArnFromAssumedArn,
  type AwsRunner,
} from "./aws-session.ts";

const expired = new Error("expired");
(expired as Error & { stderr: string }).stderr =
  "aws: [ERROR]: An error occurred (ExpiredTokenException) when calling the GetCallerIdentity operation: The security token included in the request is expired";

function identity(arn: string): AwsRunner {
  return (args) => {
    assert.deepEqual(args.slice(0, 2), ["sts", "get-caller-identity"]);
    return JSON.stringify({ Arn: arn });
  };
}

describe("aws session", () => {
  it("turns an assumed-role ARN into the IAM role ARN", () => {
    assert.equal(
      roleArnFromAssumedArn("arn:aws:sts::123456789012:assumed-role/qws-gha-workspace/GitHubActions"),
      "arn:aws:iam::123456789012:role/qws-gha-workspace",
    );
    assert.equal(
      roleArnFromAssumedArn("arn:aws:sts::123456789012:assumed-role/team/qws-gha-workspace/GitHubActions"),
      "arn:aws:iam::123456789012:role/team/qws-gha-workspace",
    );
    assert.equal(roleArnFromAssumedArn("arn:aws:iam::123456789012:user/ci"), null);
  });

  it("remembers a live session and does not assume again", async () => {
    resetAwsRoleMemory();
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "ASIAOLD",
      AWS_SECRET_ACCESS_KEY: "old-secret",
      AWS_SESSION_TOKEN: "old-session",
    };
    let calls = 0;
    await ensureAwsSession(env, {
      run: (args) => {
        calls += 1;
        return identity("arn:aws:sts::123456789012:assumed-role/qws-gha-workspace/GitHubActions")(args, env);
      },
    });
    assert.equal(calls, 1);
    assert.equal(env.AWS_ACCESS_KEY_ID, "ASIAOLD");
    assert.equal(awsRoleForRefresh(env), "arn:aws:iam::123456789012:role/qws-gha-workspace");
    resetAwsRoleMemory();
  });

  it("replaces an expired session from the job OIDC token", async () => {
    resetAwsRoleMemory();
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "ASIAOLD",
      AWS_SECRET_ACCESS_KEY: "old-secret",
      AWS_SESSION_TOKEN: "old-session",
      AWS_REGION: "us-east-1",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/qws-gha-workspace",
    };
    const seen: { args: readonly string[]; hadOldSession: boolean }[] = [];
    const run: AwsRunner = (args, child) => {
      seen.push({ args, hadOldSession: child.AWS_SESSION_TOKEN === "old-session" });
      if (args[1] === "get-caller-identity") throw expired;
      assert.equal(args[1], "assume-role-with-web-identity");
      assert.equal(child.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(child.AWS_SESSION_TOKEN, undefined);
      assert.equal(child.AWS_REGION, "us-east-1");
      return JSON.stringify({
        Credentials: {
          AccessKeyId: "ASIANEW",
          SecretAccessKey: "new-secret",
          SessionToken: "new-session",
        },
      });
    };
    await ensureAwsSession(env, { run, readOidc: async () => "oidc-jwt" });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]?.hadOldSession, true);
    assert.equal(env.AWS_ACCESS_KEY_ID, "ASIANEW");
    assert.equal(env.AWS_SECRET_ACCESS_KEY, "new-secret");
    assert.equal(env.AWS_SESSION_TOKEN, "new-session");
    resetAwsRoleMemory();
  });

  it("uses the role learned while the session was live", async () => {
    resetAwsRoleMemory();
    const live: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "ASIAOLD",
      AWS_SESSION_TOKEN: "old-session",
    };
    await ensureAwsSession(live, {
      run: identity("arn:aws:sts::123456789012:assumed-role/qws-gha-workspace/GitHubActions"),
    });
    const later: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "ASIAOLD",
      AWS_SECRET_ACCESS_KEY: "old-secret",
      AWS_SESSION_TOKEN: "old-session",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    };
    await ensureAwsSession(later, {
      run(args) {
        if (args[1] === "get-caller-identity") throw expired;
        assert.equal(args[3], "arn:aws:iam::123456789012:role/qws-gha-workspace");
        return JSON.stringify({
          Credentials: { AccessKeyId: "ASIANEW", SecretAccessKey: "new-secret", SessionToken: "new-session" },
        });
      },
      readOidc: async () => "jwt",
    });
    assert.equal(later.AWS_ACCESS_KEY_ID, "ASIANEW");
    resetAwsRoleMemory();
  });

  it("leaves an expired session when the job cannot assume", async () => {
    resetAwsRoleMemory();
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "ASIAOLD",
      AWS_SESSION_TOKEN: "old-session",
    };
    let calls = 0;
    await ensureAwsSession(env, {
      run: () => {
        calls += 1;
        throw expired;
      },
    });
    assert.equal(calls, 1);
    assert.equal(env.AWS_ACCESS_KEY_ID, "ASIAOLD");
    resetAwsRoleMemory();
  });

  it("does not include the OIDC token when refresh fails", async () => {
    resetAwsRoleMemory();
    const env: NodeJS.ProcessEnv = {
      AWS_ACCESS_KEY_ID: "ASIAOLD",
      AWS_SESSION_TOKEN: "old-session",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
      AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/qws-gha-workspace",
    };
    await assert.rejects(
      () => ensureAwsSession(env, {
        run: (args) => {
          if (args[1] === "get-caller-identity") throw expired;
          throw new Error("web-identity-token oidc-jwt leaked");
        },
        readOidc: async () => "oidc-jwt",
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message, "aws session refresh failed");
        assert.equal(message.includes("oidc-jwt"), false);
        return true;
      },
    );
    resetAwsRoleMemory();
  });

  it("skips a key that is not a role session", async () => {
    let calls = 0;
    await ensureAwsSession({ AWS_ACCESS_KEY_ID: "AKIAONLY" }, {
      run: () => {
        calls += 1;
        return "";
      },
    });
    assert.equal(calls, 0);
  });

  it("renews the session before a stage command copies it", () => {
    const loop = readFileSync(new URL("./loop.ts", import.meta.url), "utf8");
    const stage = loop.slice(loop.indexOf("async function runStageCommand"), loop.indexOf("async function blockTimedOutStage"));
    assert.ok(stage.indexOf("await ensureAwsSession(process.env)") < stage.indexOf("commandEnvironment(deps.pack, true)"));
    const main = readFileSync(new URL("../cli/main.ts", import.meta.url), "utf8");
    assert.equal(main.split("await ensureAwsSession(process.env)").length - 1, 2);
  });
});
