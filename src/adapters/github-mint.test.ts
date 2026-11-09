import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  INSTALLATION_TOKEN_REFRESH_SKEW_MS,
  INSTALLATION_TOKEN_TTL_MS,
  credentialDue,
  interpretMintOutput,
} from "./github-mint.ts";

describe("github mint output", () => {
  it("treats a bare token as an installation token that expires in one hour", () => {
    const minted = interpretMintOutput("checks-token-a\n", 1_000);
    assert.equal(minted?.token, "checks-token-a");
    assert.equal(minted?.expiresAtMs, 1_000 + INSTALLATION_TOKEN_TTL_MS);
  });

  it("reads token and expires_at from a JSON mint", () => {
    const minted = interpretMintOutput(
      JSON.stringify({ token: "checks-token-b", expires_at: "1970-01-01T00:20:00.000Z" }),
      0,
    );
    assert.equal(minted?.token, "checks-token-b");
    assert.equal(minted?.expiresAtMs, 20 * 60 * 1000);
  });

  it("uses an ISO line as the expiry and the other line as the token", () => {
    const minted = interpretMintOutput("1970-01-01T00:30:00.000Z\nchecks-token-c\n", 0);
    assert.equal(minted?.token, "checks-token-c");
    assert.equal(minted?.expiresAtMs, 30 * 60 * 1000);
  });

  it("is due once the refresh skew remains", () => {
    const expiresAtMs = 60 * 60 * 1000;
    assert.equal(credentialDue(expiresAtMs, expiresAtMs - INSTALLATION_TOKEN_REFRESH_SKEW_MS - 1), false);
    assert.equal(credentialDue(expiresAtMs, expiresAtMs - INSTALLATION_TOKEN_REFRESH_SKEW_MS), true);
  });
});
