// @ts-check
import { createSignal } from "solid-js";
import { IS_TAURI, MOCK } from "../desktop/env.js";
import { deleteSecret, getSecret, setSecret } from "../desktop/secrets.js";
import { navigate } from "../lib/router/index.js";
import { readStorage, writeStorage } from "../lib/storage.js";
import { SIGN_IN_PATH, SIGN_UP_PATH } from "./guard.js";
import { clearLocalData } from "./local-data.js";
import { frontendApiFromKey } from "./scripts.js";

/**
 * Clerk for the desktop app.
 *
 * Unlike the web app (Clerk's script tags, cookie sessions), Clerk runs here
 * as a native client, the way Clerk's Expo and Chrome-extension SDKs do:
 *
 * - **Bundled.** `@clerk/clerk-js` and `@clerk/ui` ship inside the app (their
 *   `no-rhc` builds: no code fetched at runtime), loaded right after the
 *   first paint.
 * - **Header sessions.** Requests to Clerk's Frontend API carry
 *   `_is_native=1` and the client token in `Authorization`; Clerk answers
 *   with the (rotated) token in the same header. The token lives in the
 *   credential store (`desktop/secrets.js`), not in cookies, and the
 *   requests go out through the native HTTP client (`desktop/http.js`).
 *   Clerk's Native API has to be on for the instance (it is for both).
 * - **Instant start.** The signed-in user is remembered (`leaf.session`), so
 *   the app shows the last session from the local cache straight away,
 *   while Clerk loads behind it, and keeps working offline. Only Clerk
 *   itself saying "signed out" (with a client it actually fetched) ends the
 *   session and clears local data.
 * - **Sign in with Apple** happens in the system browser, which returns to
 *   `leaf://sso-callback` (see `signInWithOAuth`). The redirect URL has to be
 *   on the instance's allowlist (Clerk dashboard → Native applications).
 *
 * The rest of the app sees the same API as the web app's `clerk.js`:
 * `session()`, `getToken()`, `signOut()`, `mountAuthPage()`.
 */

/**
 * @typedef {object} AuthUser
 * @property {string} id Clerk user id.
 * @property {string} name Best display name Clerk has: full name, username, or email.
 * @property {string | null} email
 * @property {string | null} imageUrl Null when the user hasn't uploaded one.
 */

/**
 * @typedef {{ status: "loading" }
 *   | { status: "error", message: string }
 *   | { status: "signedOut" }
 *   | { status: "signedIn", user: AuthUser }} Session
 */

/** The subset of Clerk's browser API used here. Clerk owns the real types. */
/**
 * @typedef {object} ClerkInstance
 * @property {(options: Record<string, unknown>) => Promise<void>} load
 * @property {boolean} [loaded]
 * @property {boolean} isSignedIn
 * @property {ClerkUserResource | null | undefined} user
 * @property {{ getToken: (options?: { skipCache?: boolean }) => Promise<string | null> } | null | undefined} session
 * @property {any} [client]
 * @property {(callback: () => void) => () => void} addListener
 * @property {(options?: { redirectUrl?: string }) => Promise<void>} signOut
 * @property {(params: { session: string | null }) => Promise<void>} [setActive]
 * @property {(el: HTMLElement, props?: Record<string, unknown>) => void} mountSignIn
 * @property {(el: HTMLElement) => void} unmountSignIn
 * @property {(el: HTMLElement, props?: Record<string, unknown>) => void} mountSignUp
 * @property {(el: HTMLElement) => void} unmountSignUp
 * @property {(handler: (request: any) => void | Promise<void>) => void} [__internal_onBeforeRequest]
 * @property {(handler: (request: any, response: Response | undefined) => void | Promise<void>) => void} [__internal_onAfterResponse]
 */

/**
 * @typedef {object} ClerkUserResource
 * @property {string} id
 * @property {string | null} fullName
 * @property {string | null} username
 * @property {{ emailAddress: string } | null} primaryEmailAddress
 * @property {boolean} hasImage
 * @property {string} imageUrl
 */

/** The remembered signed-in user, for an instant (and offline) start. */
const SESSION_KEY = "leaf.session";
/** Where the system browser sends people back after Sign in with Apple. */
export const OAUTH_REDIRECT_URL = "leaf://sso-callback";
const CLIENT_SECRET = "clerk.client";
/** Whose data the local caches hold (survives an expired session, unlike `leaf.session`). */
const OWNER_KEY = "leaf.owner";

const remembered = readRememberedUser();

const [session, setSession] = createSignal(
  /** @type {Session} */ (
    remembered ? { status: "signedIn", user: remembered } : { status: "loading" }
  ),
  { equals: sameSession },
);
const [signingOut, setSigningOut] = createSignal(false);
/** True once Clerk has loaded and confirmed (or replaced) the session. */
const [authReady, setAuthReady] = createSignal(false);
/** A Sign in with Apple in the browser is under way, or failed. */
const [oauthState, setOAuthState] = createSignal(
  /** @type {{ status: "idle" } | { status: "waiting" } | { status: "finishing" } | { status: "error", message: string }} */ ({
    status: "idle",
  }),
);

/** The current session. Reactive. Starts as the remembered one, if any. */
/** True while `signOut()` runs; the guard leaves navigation to Clerk meanwhile. Reactive. */
/** Clerk has loaded and confirmed the session. Reactive. */
/** The state of a browser sign-in (Apple). Reactive. */
export { authReady, oauthState, session, signingOut };

/** @type {ClerkInstance | null} */
let clerk = null;
/** @type {Promise<ClerkInstance | null> | null} */
let started = null;
/** @type {Promise<string | null> | null} */
let refreshing = null;
/** @type {Promise<void> | null} */
let signOutInFlight = null;
/** The client token, mirrored from the credential store. @type {string | null} */
let clientToken = null;
let retryDelay = 2_000;
/** Clearing another user's local data. @type {Promise<void> | null} */
let switching = null;
const HANDLED_KEY = "leaf-oauth-handled";

/** Records an OAuth callback as handled; false when it already was. @param {string} id */
function markHandled(id) {
  try {
    const handled = JSON.parse(sessionStorage.getItem(HANDLED_KEY) ?? "[]");
    if (handled.includes(id)) return false;
    sessionStorage.setItem(HANDLED_KEY, JSON.stringify([...handled.slice(-20), id]));
  } catch {
    // Storage blocked: handle it (at worst Clerk rejects a reused nonce).
  }
  return true;
}

/**
 * Loads Clerk once. Resolves with the instance, or null when it can't load.
 * Without a remembered session `session()` then turns `error`; with one,
 * the app keeps running from the cache and Clerk is retried (offline).
 * @returns {Promise<ClerkInstance | null>}
 */
export function startAuth() {
  started ??= load().catch((err) => {
    console.error("Clerk failed to load:", err);
    started = null;
    if (session().status !== "signedIn") {
      setSession({ status: "error", message: err instanceof Error ? err.message : String(err) });
    } else {
      scheduleRetry();
    }
    return null;
  });
  return started;
}

function scheduleRetry() {
  const retry = () => {
    window.removeEventListener("online", retry);
    clearTimeout(timer);
    void startAuth();
  };
  const timer = setTimeout(retry, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 60_000);
  window.addEventListener("online", retry);
}

async function load() {
  // Mock mode runs without Clerk: a stand-in with the same API signs in "Mock User".
  const instance = MOCK ? (await import("./mock-clerk.js")).createMockClerk() : await loadClerk();
  clerk = instance;
  retryDelay = 2_000;

  const update = () => {
    const user = instance.isSignedIn ? instance.user : null;
    // Signed out only counts when Clerk actually has a client from the
    // server (with an id): an offline launch must never wipe the cache.
    if (!user && !MOCK && !instance.client?.id) {
      if (session().status === "loading") {
        setSession({
          status: "error",
          message: "Can't reach the sign-in service. Check your connection.",
        });
      }
      return;
    }
    if (user) {
      const authUser = toAuthUser(user);
      const owner = readStorage(OWNER_KEY);
      const show = () => {
        writeStorage(OWNER_KEY, authUser.id);
        writeStorage(SESSION_KEY, authUser);
        setSession({ status: "signedIn", user: authUser });
        setAuthReady(true);
      };
      // Someone else's data is on this machine: drop it before showing anything.
      if (typeof owner === "string" && owner !== authUser.id) {
        setSession({ status: "loading" });
        // Clerk emits on every change; clear once.
        switching ??= clearLocalData().finally(() => (switching = null));
        void switching.then(show);
      } else {
        show();
      }
      return;
    }
    // Signed out (an expired or revoked session). Local data stays until
    // someone else signs in, so edits made offline aren't lost if the same
    // person signs back in; it just isn't shown, and the next launch starts
    // at sign-in. Signing out on purpose clears everything (`signOut`).
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // Storage blocked: nothing remembered anyway.
    }
    setSession({ status: "signedOut" });
    setAuthReady(true);
  };
  instance.addListener(update);
  update();
  return instance;
}

/**
 * Loads the bundled Clerk as a native client.
 * @returns {Promise<ClerkInstance>}
 */
async function loadClerk() {
  const key = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY ?? "";
  if (!key)
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY isn't set. Add it to .env.local and restart.");
  if (!frontendApiFromKey(key))
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY doesn't look like a Clerk publishable key.");

  const [{ Clerk }, { ui }, token] = await Promise.all([
    import("@clerk/clerk-js/no-rhc"),
    import("@clerk/ui/no-rhc"),
    getSecret(CLIENT_SECRET),
  ]);
  clientToken = token;

  const instance = /** @type {ClerkInstance} */ (/** @type {unknown} */ (new Clerk(key)));
  instance.__internal_onBeforeRequest?.((request) => {
    request.credentials = "omit";
    request.url?.searchParams.append("_is_native", "1");
    if (clientToken) request.headers.set("authorization", clientToken);
  });
  instance.__internal_onAfterResponse?.(async (_request, response) => {
    const header = response?.headers.get("authorization");
    if (header && header !== clientToken) {
      clientToken = header;
      await setSecret(CLIENT_SECRET, header).catch((err) =>
        console.error("Couldn't store the Clerk session:", err),
      );
    }
  });

  await instance.load({
    ui,
    // Not a cookie-based browser session: no cookies, no dev-browser handshake.
    standardBrowser: false,
    // Offline, clerk-js would otherwise "load" with an empty client, which
    // reads as signed out. Throwing lands in `startAuth`'s retry instead.
    experimental: { rethrowOfflineNetworkErrors: true },
    signInUrl: SIGN_IN_PATH,
    signUpUrl: SIGN_UP_PATH,
    afterSignOutUrl: SIGN_IN_PATH,
    /** @param {string} to */
    routerPush: (to) => navigate(to),
    /** @param {string} to */
    routerReplace: (to) => navigate(to, { replace: true }),
  });
  return instance;
}

/**
 * A session token for the API, or null when signed out. `forceRefresh`
 * skips Clerk's cache; concurrent refreshes share one request. Throws while
 * Clerk can't be reached (offline), so requests fail like network errors
 * rather than as "signed out".
 * @param {{ forceRefresh?: boolean }} [options]
 * @returns {Promise<string | null>}
 */
export async function getToken({ forceRefresh = false } = {}) {
  const instance = await startAuth();
  if (!instance) throw new Error("Can't reach the sign-in service. Check your connection.");
  if (!instance.session) return null;
  if (!forceRefresh) return instance.session.getToken();
  refreshing ??= instance.session.getToken({ skipCache: true }).finally(() => (refreshing = null));
  return refreshing;
}

/**
 * Clears local data, then signs out of Clerk, which navigates to sign-in.
 * Safe to call repeatedly (several requests can hit a 401 at once).
 */
export function signOut() {
  signOutInFlight ??= (async () => {
    setSigningOut(true);
    try {
      await clearLocalData();
      const instance = clerk ?? (await startAuth());
      if (instance) await instance.signOut();
      else {
        // Offline: forget the session locally; Clerk's copy expires on its own.
        clientToken = null;
        await deleteSecret(CLIENT_SECRET).catch(() => {});
        setSession({ status: "signedOut" });
        navigate(SIGN_IN_PATH, { replace: true });
      }
    } finally {
      signOutInFlight = null;
      setSigningOut(false);
    }
  })();
  return signOutInFlight;
}

/**
 * Mounts Clerk's SignIn or SignUp component into `el`. Its own social
 * buttons are hidden: Sign in with Apple runs in the system browser
 * (`signInWithOAuth`), rendered next to it by the auth page.
 * @param {"sign-in" | "sign-up"} page
 * @param {HTMLElement} el
 * @param {{ redirectUrl: string, otherPageUrl: string, appearance: Record<string, any> }} options
 * @returns {() => void} Unmounts.
 */
export function mountAuthPage(page, el, { redirectUrl, otherPageUrl, appearance }) {
  if (!clerk) return () => {};
  const instance = clerk;
  const nativeAppearance = MOCK
    ? appearance
    : {
        ...appearance,
        elements: {
          ...appearance.elements,
          socialButtonsRoot: { display: "none" },
          socialButtons: { display: "none" },
          dividerRow: { display: "none" },
        },
      };
  if (page === "sign-in") {
    instance.mountSignIn(el, {
      routing: "path",
      path: SIGN_IN_PATH,
      signUpUrl: otherPageUrl,
      forceRedirectUrl: redirectUrl,
      signUpForceRedirectUrl: redirectUrl,
      appearance: nativeAppearance,
    });
    return () => instance.unmountSignIn(el);
  }
  instance.mountSignUp(el, {
    routing: "path",
    path: SIGN_UP_PATH,
    signInUrl: otherPageUrl,
    forceRedirectUrl: redirectUrl,
    signInForceRedirectUrl: redirectUrl,
    appearance: nativeAppearance,
  });
  return () => instance.unmountSignUp(el);
}

/** Whether Clerk is ready to mount its components. */
export function clerkLoaded() {
  return clerk !== null;
}

/**
 * The OAuth providers the instance offers (e.g. `["oauth_apple"]`).
 * @returns {string[]}
 */
export function oauthStrategies() {
  const environment =
    /** @type {any} */ (clerk)?.__internal_environment ??
    /** @type {any} */ (clerk)?.__unstable__environment;
  const strategies = environment?.userSettings?.authenticatableSocialStrategies;
  return Array.isArray(strategies) ? strategies : ["oauth_apple"];
}

/**
 * Sign in (or up) with an OAuth provider in the system browser, the way
 * Clerk's native SDKs do: start the sign-in with `leaf://sso-callback` as
 * the redirect, open the provider's page in the browser, and finish in
 * `completeOAuth()` when the browser hands the callback back to the app.
 * @param {string} strategy e.g. `oauth_apple`
 */
export async function signInWithOAuth(strategy) {
  const instance = clerk ?? (await startAuth());
  if (!instance?.client) {
    setOAuthState({
      status: "error",
      message: "Can't reach the sign-in service. Check your connection.",
    });
    return;
  }
  setOAuthState({ status: "waiting" });
  try {
    const signIn = instance.client.signIn;
    await signIn.create({
      strategy,
      redirectUrl: OAUTH_REDIRECT_URL,
      actionCompleteRedirectUrl: OAUTH_REDIRECT_URL,
    });
    const target = instance.client.signIn.firstFactorVerification?.externalVerificationRedirectURL;
    if (!target) throw new Error("Clerk didn't return a sign-in page to open.");
    await openInBrowser(String(target));
  } catch (err) {
    setOAuthState({ status: "error", message: clerkErrorMessage(err) });
  }
}

/** Forget a pending or failed browser sign-in. */
export function cancelOAuth() {
  setOAuthState({ status: "idle" });
}

/**
 * Finishes a browser sign-in from its `leaf://sso-callback?…` URL: trade the
 * nonce for the sign-in's result, create the account when the provider's
 * user is new (a "transfer" to sign-up), then activate the session.
 * @param {string} url
 */
export async function completeOAuth(url) {
  let params;
  try {
    params = new URL(url).searchParams;
  } catch {
    return;
  }
  // Each callback once: the deep-link plugin replays the launch URL after a
  // reload (sessionStorage survives a reload, not a relaunch, so a callback
  // that launches the app still counts).
  const nonce = params.get("rotating_token_nonce") ?? "";
  if (oauthState().status === "finishing" || !markHandled(nonce || url)) return;
  const instance = clerk ?? (await startAuth());
  if (!instance?.client) return;
  setOAuthState({ status: "finishing" });
  try {
    const signIn = instance.client.signIn;
    await signIn.reload(nonce ? { rotatingTokenNonce: nonce } : undefined);
    const current = instance.client.signIn;
    let sessionId = current.createdSessionId ?? null;
    if (!sessionId && current.firstFactorVerification?.status === "transferable") {
      await instance.client.signUp.create({ transfer: true });
      sessionId = instance.client.signUp.createdSessionId ?? null;
    }
    if (!sessionId) {
      const error = current.firstFactorVerification?.error;
      throw new Error(
        error?.longMessage ?? error?.message ?? "The sign-in didn't finish. Try again.",
      );
    }
    await instance.setActive?.({ session: sessionId });
    setOAuthState({ status: "idle" });
  } catch (err) {
    setOAuthState({ status: "error", message: clerkErrorMessage(err) });
  }
}

/** @param {string} url */
async function openInBrowser(url) {
  if (IS_TAURI) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

/** @param {unknown} err */
function clerkErrorMessage(err) {
  const first = /** @type {any} */ (err)?.errors?.[0];
  if (first) return first.longMessage ?? first.message ?? "Sign-in failed.";
  return err instanceof Error ? err.message : String(err);
}

/** @param {ClerkUserResource} user @returns {AuthUser} */
function toAuthUser(user) {
  const email = user.primaryEmailAddress?.emailAddress ?? null;
  return {
    id: user.id,
    name: user.fullName?.trim() || user.username || email || "Signed in",
    email,
    imageUrl: user.hasImage ? user.imageUrl : null,
  };
}

/** @returns {AuthUser | null} */
function readRememberedUser() {
  if (typeof window === "undefined") return null;
  const value = /** @type {any} */ (readStorage(SESSION_KEY));
  if (!value || typeof value.id !== "string" || typeof value.name !== "string") return null;
  return {
    id: value.id,
    name: value.name,
    email: typeof value.email === "string" ? value.email : null,
    imageUrl: typeof value.imageUrl === "string" ? value.imageUrl : null,
  };
}

/** Clerk emits on every resource change; only re-render when what we show changed. */
/** @param {Session} a @param {Session} b */
function sameSession(a, b) {
  if (a.status !== b.status) return false;
  if (a.status === "error" && b.status === "error") return a.message === b.message;
  if (a.status === "signedIn" && b.status === "signedIn") {
    return (
      a.user.id === b.user.id &&
      a.user.name === b.user.name &&
      a.user.email === b.user.email &&
      a.user.imageUrl === b.user.imageUrl
    );
  }
  return true;
}
