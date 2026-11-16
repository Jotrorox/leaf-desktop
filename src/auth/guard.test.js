// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authPageFor,
  authUrl,
  guardRedirect,
  publicPageFor,
  redirectTarget,
  safeOAuthRedirect,
  safeRedirect,
  sharedPageFor,
} from "./guard.js";

/** @param {string} href */
function loc(href) {
  const url = new URL(href, "http://localhost");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

test("auth pages include Clerk's sub-paths", () => {
  assert.equal(authPageFor("/sign-in"), "sign-in");
  assert.equal(authPageFor("/sign-in/factor-one"), "sign-in");
  assert.equal(authPageFor("/sign-up/verify-email-address"), "sign-up");
  assert.equal(authPageFor("/sign-inside"), null);
  assert.equal(authPageFor("/"), null);
});

test("signed out: app routes redirect to sign-in with the way back", () => {
  assert.equal(
    guardRedirect("signedOut", loc("/p/abc?x=1#h")),
    "/sign-in?redirect=%2Fp%2Fabc%3Fx%3D1%23h",
  );
  assert.equal(guardRedirect("signedOut", loc("/trash")), "/sign-in?redirect=%2Ftrash");
  assert.equal(guardRedirect("signedOut", loc("/sign-in?redirect=%2Ftrash")), null);
  assert.equal(guardRedirect("signedOut", loc("/sign-up")), null);
});

test("signed out: the root goes to sign-in (the desktop app has no landing page)", () => {
  assert.equal(guardRedirect("signedOut", loc("/")), "/sign-in");
  assert.equal(guardRedirect("signedOut", loc("/?lang=de")), "/sign-in?redirect=%2F%3Flang%3Dde");
});

test("public pages never redirect", () => {
  assert.equal(publicPageFor("/imprint"), "imprint");
  assert.equal(publicPageFor("/privacy/"), "privacy");
  assert.equal(publicPageFor("/privacy/x"), null);
  assert.equal(publicPageFor("/terms"), "terms");
  assert.equal(publicPageFor("/report"), "report");
  assert.equal(publicPageFor("/connect/", true), "connect");
  assert.equal(publicPageFor("/connect/private", true), null);
  assert.equal(publicPageFor("/"), null);
  for (const status of /** @type {const} */ (["signedIn", "signedOut"])) {
    assert.equal(guardRedirect(status, loc("/imprint")), null);
    assert.equal(guardRedirect(status, loc("/privacy?lang=de#hosting")), null);
    assert.equal(
      guardRedirect(status, loc("/report?url=https%3A%2F%2Fleaf.jotrorox.com%2Fs%2Fx")),
      null,
    );
  }
});

test("the AI-assistant guide is public only when the feature is on", () => {
  assert.equal(publicPageFor("/connect"), null);
  assert.equal(publicPageFor("/connect", false), null);
  assert.equal(
    guardRedirect("signedOut", loc("/connect?lang=de")),
    "/sign-in?redirect=%2Fconnect%3Flang%3Dde",
  );
  assert.equal(guardRedirect("signedIn", loc("/connect")), null);
});

const oauthKey = `pk_test_${btoa("clerk.leaf.test$")}`;
const oauthReturn =
  "https://clerk.leaf.test/oauth/authorize?client_id=client&state=opaque&code_challenge=challenge";

test("OAuth returns allow only the key's HTTPS Frontend API and OAuth path", () => {
  assert.equal(safeOAuthRedirect(oauthReturn, oauthKey), oauthReturn);
  assert.equal(safeOAuthRedirect(oauthReturn, "invalid"), null);
  assert.equal(safeOAuthRedirect(oauthReturn, ""), null);
  for (const value of [
    "https://evil.test/oauth/authorize",
    "https://clerk.leaf.test.evil.test/oauth/authorize",
    "http://clerk.leaf.test/oauth/authorize",
    "//clerk.leaf.test/oauth/authorize",
    "https://clerk.leaf.test:444/oauth/authorize",
    "https://user@clerk.leaf.test/oauth/authorize",
    "https://clerk.leaf.test/settings",
    "https://clerk.leaf.test/oauth-evil/authorize",
    "https://clerk.leaf.test/oauth",
    "https://clerk.leaf.test/oauth/../settings",
    "https://clerk.leaf.test/oauth/%2e%2e/settings",
    "https://clerk.leaf.test/oauth/a%2fb",
    "https://clerk.leaf.test/oauth/a%5cb",
    "https://clerk.leaf.test/oauth/authorize#fragment",
    "https://clerk.leaf.test\\@evil.test/oauth/authorize",
    "https://clerk.leaf.test/\noauth/authorize",
    "/p/abc",
    "javascript:alert(1)",
    "",
    null,
  ])
    assert.equal(safeOAuthRedirect(value, oauthKey), null, String(value));
});

test("OAuth returns survive sign-up and Clerk substeps without widening ordinary redirects", () => {
  const search = `?redirect_url=${encodeURIComponent(oauthReturn)}`;
  assert.equal(redirectTarget(search, oauthKey), oauthReturn);
  assert.equal(redirectTarget(`?redirect=${encodeURIComponent(oauthReturn)}`, oauthKey), null);
  assert.equal(redirectTarget(search), null);
  assert.equal(authUrl(oauthReturn, "/sign-up", oauthKey), `/sign-up${search}`);
  assert.equal(authUrl("https://evil.test/oauth/authorize", "/sign-up", oauthKey), "/sign-up");
  assert.equal(guardRedirect("signedIn", loc(`/sign-in${search}`), null, oauthKey), oauthReturn);
  assert.equal(
    guardRedirect("signedIn", loc("/sign-up/continue"), oauthReturn, oauthKey),
    oauthReturn,
  );
  assert.equal(guardRedirect("signedIn", loc("/sign-in"), "https://evil.test/", oauthKey), "/");
  assert.equal(
    redirectTarget("?redirect_url=https%3A%2F%2Fevil.test&redirect=%2Ftrash", oauthKey),
    "/trash",
  );
});

test("signed in: auth pages redirect to the target, or home", () => {
  assert.equal(guardRedirect("signedIn", loc("/sign-in")), "/");
  assert.equal(guardRedirect("signedIn", loc("/sign-up/continue")), "/");
  assert.equal(
    guardRedirect("signedIn", loc("/sign-in?redirect=%2Fp%2Fabc%3Fx%3D1")),
    "/p/abc?x=1",
  );
  assert.equal(guardRedirect("signedIn", loc("/sign-in/factor-one"), "/trash"), "/trash");
  assert.equal(guardRedirect("signedIn", loc("/p/abc")), null);
});

test("redirect targets must stay on this origin and off the auth pages", () => {
  assert.equal(safeRedirect("/p/abc"), "/p/abc");
  assert.equal(safeRedirect("https://evil.test/"), null);
  assert.equal(safeRedirect("//evil.test/"), null);
  assert.equal(safeRedirect("/\\evil.test/"), null);
  assert.equal(safeRedirect("javascript:alert(1)"), null);
  assert.equal(safeRedirect("/sign-in"), null);
  assert.equal(safeRedirect(""), null);
  assert.equal(safeRedirect(null), null);
  assert.equal(guardRedirect("signedIn", loc("/sign-in?redirect=https%3A%2F%2Fevil.test")), "/");
});

test("authUrl leaves out a redirect home", () => {
  assert.equal(authUrl(null), "/sign-in");
  assert.equal(authUrl("/"), "/sign-in");
  assert.equal(authUrl("/trash", "/sign-up"), "/sign-up?redirect=%2Ftrash");
});

test("published pages are open to everyone", () => {
  assert.equal(sharedPageFor("/s/pg_1"), "pg_1");
  assert.equal(sharedPageFor("/s/a%20b/"), "a b");
  assert.equal(sharedPageFor("/s/"), null);
  assert.equal(sharedPageFor("/s/a/b"), null);
  assert.equal(sharedPageFor("/s/%E0"), null);
  assert.equal(guardRedirect("signedOut", loc("/s/pg_1")), null);
  assert.equal(guardRedirect("signedIn", loc("/s/pg_1")), null);
});
