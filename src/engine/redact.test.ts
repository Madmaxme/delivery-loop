import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createStreamRedactor, registerSecret, redactSecrets } from "./redact.ts";

describe("secret redaction", () => {
  it("redacts a secret split across chunks, including base64 and url forms", () => {
    const secret = "minted-token-value";
    registerSecret(secret);
    const encoded = Buffer.from(secret).toString("base64");
    const redactor = createStreamRedactor([secret, encoded, encodeURIComponent(secret)]);
    const split = Math.ceil(secret.length / 2);
    const first = redactor.push(`before ${secret.slice(0, split)}`);
    const second = redactor.push(`${secret.slice(split)} after ${encoded}`);
    const tail = redactor.flush();
    const text = `${first}${second}${tail}`;
    assert.equal(text.includes(secret), false);
    assert.equal(text.includes(encoded), false);
    assert.match(text, /before \[redacted\] after \[redacted\]/);
    assert.equal(redactSecrets(`url ${encodeURIComponent(secret)}`, [encodeURIComponent(secret)]), "url [redacted]");
  });
});
