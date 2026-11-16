// @ts-check

/**
 * Where the app runs. Pure apart from reading globals, so modules can import
 * it anywhere (it also loads under `node --test`, where nothing is native).
 *
 * The app normally runs inside the Tauri shell. `pnpm dev` also opens it in
 * a plain browser tab (handy with `pnpm dev:mock`); then everything falls
 * back to the browser's own fetch, WebSocket and storage.
 */

const env = /** @type {Record<string, string | undefined>} */ (import.meta.env ?? {});

/** True inside the Tauri shell. */
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** The platform, from the user agent (good enough for styling). */
export const PLATFORM = (() => {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Mac OS X|Macintosh/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  return "linux";
})();

/** The leaf API's base URL, without a trailing slash. */
export const API_URL = (env.VITE_API_URL ?? "").replace(/\/+$/, "");

/**
 * The web app's origin. Links people copy and share point there (the
 * desktop app's own origin means nothing outside it), pages that only the
 * web app has (legal texts, the AI-assistant guide) open there, and the
 * API's live-sync sockets are opened as that origin, the only one it accepts.
 */
export const WEB_ORIGIN = (env.VITE_WEB_ORIGIN || "https://leaf.jotrorox.com").replace(/\/+$/, "");

/** Mock mode (`pnpm dev:mock`): the in-memory backend and a stand-in for Clerk. */
export const MOCK = env.VITE_API_MOCK === "1";

/**
 * A URL on the web app for an in-app path: what "Copy link" copies.
 * @param {string} path e.g. `/p/123`
 */
export function webUrl(path) {
  return `${WEB_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}
