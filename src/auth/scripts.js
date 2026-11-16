// @ts-check

/**
 * Where to load Clerk's browser bundles from. Pure: runs under `node --test`.
 *
 * This follows Clerk's documented script-tag install: two bundles served by
 * the instance's Frontend API, `@clerk/ui` (the prebuilt components) and then
 * `@clerk/clerk-js`. The docs pin major versions; we pin exact ones so a
 * Clerk release can't change the app under us. Bump both together: they're
 * released in lockstep.
 */

export const CLERK_JS_VERSION = "6.39.0";
export const CLERK_UI_VERSION = "1.40.0";

/**
 * The Frontend API host encoded in a publishable key: `pk_test_` or
 * `pk_live_`, then base64 of the host followed by `$`.
 * @param {string} key
 * @returns {string | null} null when the key is malformed.
 */
export function frontendApiFromKey(key) {
  const match = /^pk_(test|live)_([A-Za-z0-9+/=_-]+)$/.exec(key.trim());
  if (!match) return null;
  let decoded;
  try {
    decoded = atob(match[2].replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return null;
  }
  if (!decoded.endsWith("$")) return null;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? host : null;
}

/**
 * @param {string} frontendApi Host, e.g. `clerk.example.com`.
 */
export function clerkScriptUrls(frontendApi) {
  const origin = `https://${frontendApi}/npm`;
  return {
    ui: `${origin}/@clerk/ui@${CLERK_UI_VERSION}/dist/ui.browser.js`,
    clerk: `${origin}/@clerk/clerk-js@${CLERK_JS_VERSION}/dist/clerk.browser.js`,
  };
}
