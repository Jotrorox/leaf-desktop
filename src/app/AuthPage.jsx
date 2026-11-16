// @ts-check
import {
  createEffect,
  createResource,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import {
  cancelOAuth,
  clerkLoaded,
  mountAuthPage,
  oauthState,
  oauthStrategies,
  signInWithOAuth,
  startAuth,
} from "../auth/clerk.js";
import {
  authUrl,
  IMPRINT_PATH,
  PRIVACY_PATH,
  redirectTarget,
  SIGN_IN_PATH,
  SIGN_UP_PATH,
  TERMS_PATH,
} from "../auth/guard.js";
import { MOCK, webUrl } from "../desktop/env.js";
import { location } from "../lib/router/index.js";
import Button from "../ui/Button.jsx";
import LogoMark from "../ui/LogoMark.jsx";
import styles from "./AuthPage.module.css";
import { resolvedTheme } from "./theme.js";

/** @type {string | null} */
let rememberedTarget = null;

/**
 * Where the auth page sends people after they sign in, once. Clerk's
 * sub-steps can drop the `?redirect=` query, so the guard asks here too.
 */
export function takeAuthPageTarget() {
  const target = rememberedTarget;
  rememberedTarget = null;
  return target;
}

const PROVIDERS =
  /** @type {Record<string, { label: string, icon: () => import("solid-js").JSX.Element }>} */ ({
    oauth_apple: { label: "Apple", icon: AppleIcon },
    oauth_google: { label: "Google", icon: () => null },
    oauth_github: { label: "GitHub", icon: () => null },
  });

/**
 * /sign-in and /sign-up: Clerk's SignIn or SignUp component, centered, with
 * no app chrome, as in the web app. Above it, the instance's OAuth
 * providers (Sign in with Apple), which finish in the system browser
 * (`auth/clerk.js`); Clerk's own social buttons would try to do it inside
 * the window. The legal pages open on the web.
 *
 * Clerk renders into its own element; it's remounted when the theme flips
 * so its colors follow ours.
 *
 * @param {{ page: "sign-in" | "sign-up" }} props
 */
export default function AuthPage(props) {
  /** @type {HTMLDivElement | undefined} */
  let el;
  const page = untrack(() => props.page);
  const target = untrack(() => redirectTarget(location().search));
  rememberedTarget = target;
  // Clerk is normally loaded already (signed out means it said so); after an
  // offline sign-out it may still be on its way.
  const [ready] = createResource(async () => (await startAuth()) !== null);

  onMount(() => {
    document.title = `${page === "sign-in" ? "Sign in" : "Sign up"} · leaf`;
    createEffect(
      on([resolvedTheme, () => ready()], () => {
        if (!el || !clerkLoaded()) return;
        const unmount = mountAuthPage(page, el, {
          redirectUrl: target ?? "/",
          otherPageUrl: authUrl(target, page === "sign-in" ? SIGN_UP_PATH : SIGN_IN_PATH),
          appearance: clerkAppearance(el),
        });
        onCleanup(unmount);
      }),
    );
  });

  const providers = () =>
    ready() && !MOCK ? oauthStrategies().filter((strategy) => strategy in PROVIDERS) : [];

  return (
    <div class={styles.page}>
      <div class={styles.dragRegion} data-tauri-drag-region />
      <div class={styles.brand}>
        <LogoMark size={26} />
        <span>leaf</span>
      </div>

      <Show when={providers().length > 0}>
        <div class={styles.oauth}>
          <Switch>
            <Match when={oauthState().status === "waiting" || oauthState().status === "finishing"}>
              <div class={styles.oauthWaiting} role="status">
                <span class={styles.spinner} aria-hidden="true" />
                <span>
                  {oauthState().status === "finishing"
                    ? "Finishing sign-in…"
                    : "Continue in your browser, then come back here."}
                </span>
                <Button variant="ghost" onClick={cancelOAuth}>
                  Cancel
                </Button>
              </div>
            </Match>
            <Match when={true}>
              <For each={providers()}>
                {(strategy) => {
                  const provider = PROVIDERS[strategy];
                  return (
                    <button
                      type="button"
                      class={styles.oauthButton}
                      onClick={() => void signInWithOAuth(strategy)}
                    >
                      {provider?.icon()}
                      <span>Continue with {provider?.label}</span>
                    </button>
                  );
                }}
              </For>
            </Match>
          </Switch>
          <Show when={oauthState().status === "error" ? oauthState() : null} keyed>
            {(state) => (
              <p class={styles.oauthError} role="alert">
                {"message" in state ? state.message : ""}
              </p>
            )}
          </Show>
          <div class={styles.divider} aria-hidden="true">
            <span>or</span>
          </div>
        </div>
      </Show>

      <Show
        when={ready() !== false}
        fallback={
          <div class={styles.offline} role="alert">
            <p>leaf can't reach its sign-in service. Check your connection.</p>
            <Button variant="primary" onClick={() => window.location.reload()}>
              Retry
            </Button>
          </div>
        }
      >
        <div ref={el} class={styles.clerk} />
      </Show>

      <nav class={styles.legal} aria-label="Legal">
        <a href={webUrl(TERMS_PATH)}>Terms</a>
        <a href={webUrl(PRIVACY_PATH)}>Privacy</a>
        <a href={webUrl(IMPRINT_PATH)}>Imprint</a>
      </nav>
    </div>
  );
}

function AppleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor">
      <path d="M11.18 8.5c-.02-1.66 1.36-2.46 1.42-2.5-.78-1.13-1.98-1.29-2.4-1.3-1.02-.1-2 .6-2.51.6-.52 0-1.32-.59-2.17-.57-1.11.02-2.14.65-2.72 1.65-1.16 2.01-.3 4.98.83 6.61.55.8 1.21 1.69 2.07 1.66.83-.03 1.15-.54 2.15-.54 1 0 1.29.54 2.17.52.9-.01 1.46-.81 2-1.61.64-.92.9-1.82.91-1.87-.02 0-1.73-.67-1.75-2.65ZM9.53 3.62c.46-.55.77-1.32.68-2.09-.66.03-1.46.44-1.93.99-.42.49-.8 1.28-.7 2.03.74.06 1.49-.37 1.95-.93Z" />
    </svg>
  );
}

/**
 * Clerk's appearance variables, read from our tokens. Tokens use
 * light-dark(), which only resolves on a real color property, so each one is
 * resolved through a probe element.
 * @param {HTMLElement} host
 */
function clerkAppearance(host) {
  const probe = document.createElement("span");
  probe.style.display = "none";
  host.append(probe);
  /** @param {string} token */
  const color = (token) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const variables = {
    colorPrimary: color("--color-accent"),
    colorPrimaryForeground: color("--color-text-on-accent"),
    colorDanger: color("--color-text-danger"),
    colorBackground: color("--color-bg-elevated"),
    colorForeground: color("--color-text"),
    colorMutedForeground: color("--color-text-secondary"),
    colorInput: color("--color-bg"),
    colorInputForeground: color("--color-text"),
    colorNeutral: color("--color-text"),
    fontFamily: getComputedStyle(host).fontFamily,
    borderRadius: "6px",
  };
  probe.remove();
  return { variables };
}
