// @ts-check
import { AI_ASSISTANTS } from "../lib/features.js";
import { frontendApiFromKey } from "./scripts.js";

/**
 * Route guard rules. Pure: runs under `node --test`.
 *
 * The public pages (imprint, privacy policy, terms, the report form) and published pages
 * (`/s/:id`, readable by anyone with the link) never redirect. Signed out:
 * everything but the auth pages (in the desktop app, `/` too) redirects to
 * `/sign-in?redirect=<where you were>`. Signed in: the auth pages redirect to
 * that `redirect` target, or `/`. Clerk's components own sub-paths
 * (`/sign-in/factor-one`, `/sign-up/verify-email-address`, …), so those
 * count as auth pages too.
 */

/** @typedef {"sign-in" | "sign-up"} AuthPage */
/** @typedef {"imprint" | "privacy" | "terms" | "report" | "connect"} PublicPage */
/** @typedef {{ pathname: string, search: string, hash: string }} GuardLocation */

export const SIGN_IN_PATH = "/sign-in";
export const SIGN_UP_PATH = "/sign-up";
export const IMPRINT_PATH = "/imprint";
export const PRIVACY_PATH = "/privacy";
export const TERMS_PATH = "/terms";
export const REPORT_PATH = "/report";
export const CONNECT_PATH = "/connect";
export const SHARED_PATH_PREFIX = "/s/";

/**
 * The page id of a published page's path (`/s/:id`), or null.
 * @param {string} pathname
 */
export function sharedPageFor(pathname) {
  const match = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * The public page at `pathname`, open to everyone whether signed in or not.
 * @param {string} pathname
 * @param {boolean} [aiAssistants] Whether the AI-assistant guide is on (`lib/features.js`).
 * @returns {PublicPage | null}
 */
export function publicPageFor(pathname, aiAssistants = AI_ASSISTANTS) {
  const path = pathname.replace(/(.)\/$/, "$1");
  if (path === IMPRINT_PATH) return "imprint";
  if (path === PRIVACY_PATH) return "privacy";
  if (path === TERMS_PATH) return "terms";
  if (path === REPORT_PATH) return "report";
  if (aiAssistants && path === CONNECT_PATH) return "connect";
  return null;
}

/**
 * @param {string} pathname
 * @returns {AuthPage | null}
 */
export function authPageFor(pathname) {
  for (const [path, page] of /** @type {const} */ ([
    [SIGN_IN_PATH, "sign-in"],
    [SIGN_UP_PATH, "sign-up"],
  ])) {
    if (pathname === path || pathname.startsWith(`${path}/`)) return page;
  }
  return null;
}

/**
 * A redirect target we're willing to follow: a same-origin absolute path
 * that isn't itself an auth page. Anything else (full URLs, `//host`,
 * `/\host`, junk) is dropped, so `?redirect=` can't send people off-site.
 * @param {string | null | undefined} value
 * @returns {string | null}
 */
export function safeRedirect(value) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\"))
    return null;
  let url;
  try {
    url = new URL(value, "http://leaf.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://leaf.invalid" || authPageFor(url.pathname)) return null;
  return url.pathname + url.search + url.hash;
}

/**
 * The same-origin `redirect` or trusted Clerk OAuth `redirect_url` target.
 * @param {string} search
 * @param {string} [publishableKey]
 */
export function redirectTarget(search, publishableKey = "") {
  const params = new URLSearchParams(search);
  return (
    safeOAuthRedirect(params.get("redirect_url"), publishableKey) ??
    safeRedirect(params.get("redirect"))
  );
}

/** @param {string | null | undefined} value @param {string} publishableKey */
export function safeOAuthRedirect(value, publishableKey) {
  const host = frontendApiFromKey(publishableKey);
  if (!host || !value || !value.startsWith("https://") || /[\\\s]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.origin !== `https://${host.toLowerCase()}` ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/oauth/") ||
      /%(?:2e|2f|5c)/i.test(url.pathname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * The sign-in (or sign-up) URL that comes back to `target` afterwards.
 * @param {string | null} target
 * @param {string} [path]
 * @param {string} [publishableKey]
 */
export function authUrl(target, path = SIGN_IN_PATH, publishableKey = "") {
  const oauth = safeOAuthRedirect(target, publishableKey);
  const safe = oauth ?? safeRedirect(target);
  return safe && safe !== "/"
    ? `${path}?${oauth ? "redirect_url" : "redirect"}=${encodeURIComponent(safe)}`
    : path;
}

/**
 * Where the guard sends this visitor, or null to render the location as is.
 * @param {"signedIn" | "signedOut"} status
 * @param {GuardLocation} location
 * @param {string | null} [remembered] The target the auth page was opened
 *   with; Clerk's sub-steps can drop the query string.
 * @param {string} [publishableKey]
 * @returns {string | null}
 */
export function guardRedirect(status, location, remembered = null, publishableKey = "") {
  if (publicPageFor(location.pathname) || sharedPageFor(location.pathname)) return null;
  const page = authPageFor(location.pathname);
  if (status === "signedOut") {
    // Desktop: no landing page; signed out, "/" is the sign-in page too.
    if (page) return null;
    return authUrl(safeRedirect(location.pathname + location.search + location.hash));
  }
  return page
    ? (redirectTarget(location.search, publishableKey) ??
        safeOAuthRedirect(remembered, publishableKey) ??
        safeRedirect(remembered) ??
        "/")
    : null;
}
