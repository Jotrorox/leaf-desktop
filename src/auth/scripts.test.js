// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { clerkScriptUrls, frontendApiFromKey } from "./scripts.js";

/** @param {string} host @param {"test" | "live"} [env] */
const keyFor = (host, env = "test") => `pk_${env}_${btoa(`${host}$`)}`;

test("decodes the Frontend API host from test and live keys", () => {
  assert.equal(
    frontendApiFromKey(keyFor("happy-leaf-12.clerk.accounts.dev")),
    "happy-leaf-12.clerk.accounts.dev",
  );
  assert.equal(frontendApiFromKey(keyFor("clerk.example.com", "live")), "clerk.example.com");
  assert.equal(frontendApiFromKey(`  ${keyFor("clerk.example.com")}\n`), "clerk.example.com");
});

test("rejects malformed keys", () => {
  assert.equal(frontendApiFromKey(""), null);
  assert.equal(frontendApiFromKey("sk_test_abc"), null);
  assert.equal(frontendApiFromKey("pk_test_!!!"), null);
  assert.equal(frontendApiFromKey(`pk_test_${btoa("clerk.example.com")}`), null, "missing $");
  assert.equal(frontendApiFromKey(`pk_test_${btoa("not a host$")}`), null);
});

test("script URLs pin exact versions on the Frontend API", () => {
  const urls = clerkScriptUrls("clerk.example.com");
  assert.match(
    urls.ui,
    /^https:\/\/clerk\.example\.com\/npm\/@clerk\/ui@\d+\.\d+\.\d+\/dist\/ui\.browser\.js$/,
  );
  assert.match(
    urls.clerk,
    /^https:\/\/clerk\.example\.com\/npm\/@clerk\/clerk-js@\d+\.\d+\.\d+\/dist\/clerk\.browser\.js$/,
  );
});
