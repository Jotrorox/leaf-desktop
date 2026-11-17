// @ts-check
// First: puts the last page back in the URL before the router reads it.
import "./desktop/restore-route.js";
import { render } from "solid-js/web";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/desktop.css";
import { setTokenProvider, setUnauthorizedHandler } from "./api/client.js";
import { clearRecent } from "./app/recent.js";
import {
  completeOAuth,
  getToken,
  OAUTH_REDIRECT_URL,
  session,
  signOut,
  startAuth,
} from "./auth/clerk.js";
import { onClearLocalData } from "./auth/local-data.js";
import { frontendApiFromKey } from "./auth/scripts.js";
import { API_URL } from "./desktop/env.js";
import { hostOf, installNativeFetch } from "./desktop/http.js";
import { installDesktopShell, listenForDeepLinks, revealWindow } from "./desktop/shell.js";
import { clearAll, queryClient } from "./lib/query/index.js";
import { persistQueryCache, restoreQueryCache } from "./lib/query/persist.js";
import "./app/theme.js";
import App from "./app/App.jsx";

/**
 * Boot, in the order that gets the first frame up fastest:
 *
 * 1. Route the API's and Clerk's requests through the native HTTP client.
 *    (Nothing calls `fetch` while modules load.)
 * 2. Restore the query cache from disk when someone was signed in, so the
 *    first render already has the sidebar and the last page's data.
 * 3. Render, then show the window. Clerk loads behind the first frame.
 */

installNativeFetch([
  hostOf(API_URL),
  frontendApiFromKey(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "") ?? "",
]);

// Every API request carries a Clerk session token. A 401 that survives a
// token refresh means the session is gone: sign out.
setTokenProvider(({ forceRefresh }) => getToken({ forceRefresh }));
setUnauthorizedHandler(() => void signOut().catch((err) => console.error("Sign-out failed:", err)));
// Sign-out (and a different user signing in) drops every cached query.
onClearLocalData(clearAll);
onClearLocalData(clearRecent);

installDesktopShell();
const restored = session().status === "signedIn" ? await restoreQueryCache(queryClient) : [];
persistQueryCache(queryClient, { restored });

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing");
render(() => <App />, root);
revealWindow();

// Clerk after the first frame: it's big, and a remembered session covers the wait.
requestAnimationFrame(() => setTimeout(() => void startAuth(), 0));
void listenForDeepLinks((url) => {
  if (url.startsWith(OAUTH_REDIRECT_URL) || isLoopbackCallback(url)) void completeOAuth(url);
});

/** The loopback sign-in callback of debug builds (`src-tauri/src/oauth.rs`). @param {string} url */
function isLoopbackCallback(url) {
  return /^http:\/\/127\.0\.0\.1:\d+\/sso-callback(\?|$)/.test(url);
}
