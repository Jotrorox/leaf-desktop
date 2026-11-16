// @ts-check
import {
  CONNECT_PATH,
  IMPRINT_PATH,
  PRIVACY_PATH,
  REPORT_PATH,
  SHARED_PATH_PREFIX,
  TERMS_PATH,
} from "../auth/guard.js";
import { location, setNavigateRewrite } from "../lib/router/index.js";
import { writeStorage } from "../lib/storage.js";
import { IS_TAURI, PLATFORM, WEB_ORIGIN } from "./env.js";
import { LAST_ROUTE_KEY } from "./restore-route.js";

/**
 * What makes the web app's UI behave like a desktop app:
 *
 * - Pages only the web app has (legal texts, the AI-assistant guide,
 *   published pages) and links to other sites open in the default browser;
 *   the window itself only ever shows the app (the Rust side enforces it).
 * - The window appears once the first frame is painted, so there's no
 *   blank flash.
 * - The last page is reopened on launch (`restore-route.js`).
 * - `<html>` gets `platform-*` and `titlebar-overlay` classes, so the layout
 *   can leave room for the macOS traffic lights.
 */

const WEB_ONLY_PATHS = [IMPRINT_PATH, PRIVACY_PATH, TERMS_PATH, REPORT_PATH, CONNECT_PATH];

/** @param {string} pathname */
function isWebOnly(pathname) {
  const path = pathname.replace(/(.)\/$/, "$1");
  return WEB_ONLY_PATHS.includes(path) || path.startsWith(SHARED_PATH_PREFIX);
}

/** Opens a URL in the default browser (or a new tab, outside Tauri). @param {string} url */
export async function openExternal(url) {
  if (!IS_TAURI) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url).catch((err) => console.error("Couldn't open", url, err));
}

/**
 * Runs before the first render.
 */
export function installDesktopShell() {
  const root = document.documentElement;
  root.classList.add(`platform-${PLATFORM}`);
  if (IS_TAURI) root.classList.add("desktop");
  if (IS_TAURI && PLATFORM === "mac") root.classList.add("titlebar-overlay");

  // In-app navigation to a web-only page goes to the web app instead.
  setNavigateRewrite((to) => {
    try {
      const url = new URL(to, window.location.href);
      if (url.origin === window.location.origin && isWebOnly(url.pathname))
        return WEB_ORIGIN + url.pathname + url.search + url.hash;
    } catch {
      // Leave it to navigate().
    }
    return to;
  });

  if (!IS_TAURI) return;

  // Links to other sites (in pages, `target="_blank"`, `window.open`) open
  // in the browser. Capture phase, before the editor or router see the click.
  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented || event.button > 1) return;
      const anchor = /** @type {Element | null} */ (
        event.target instanceof Element ? event.target : null
      )?.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = safeUrl(anchor.href);
      if (!url) return;
      const external = url.origin !== window.location.origin;
      const webOnly = !external && isWebOnly(url.pathname);
      if (!external && !webOnly) return;
      // Inside the editor, a plain click on a link edits text; the editor
      // opens links itself on mod+click (through window.open, below).
      if (anchor.closest("[contenteditable='true']") && !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      event.stopPropagation();
      void openExternal(webOnly ? WEB_ORIGIN + url.pathname + url.search + url.hash : url.href);
    },
    true,
  );
  window.open = (url) => {
    const target = url ? safeUrl(String(url)) : null;
    if (target && /^(https?|mailto|tel):$/.test(target.protocol)) void openExternal(target.href);
    return null;
  };

  // Files dropped anywhere but an editor shouldn't replace the app with the file.
  for (const type of ["dragover", "drop"]) {
    window.addEventListener(type, (event) => {
      const target = /** @type {Element | null} */ (
        event.target instanceof Element ? event.target : null
      );
      if (!target?.closest("[contenteditable='true'], input, textarea")) event.preventDefault();
    });
  }

  void trackFullscreen();
}

/** Shows the window once the first frame is on screen. */
export function revealWindow() {
  if (!IS_TAURI) return;
  requestAnimationFrame(() =>
    requestAnimationFrame(async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow()
        .show()
        .catch((err) => console.error("Couldn't show the window:", err));
    }),
  );
}

/** Saves the current route; call from a reactive scope. */
export function rememberRoute() {
  const { pathname, search } = location();
  if (pathname.startsWith("/sign-")) return;
  writeStorage(LAST_ROUTE_KEY, pathname + search);
}

/** No traffic lights in full screen, so no room left for them either. */
async function trackFullscreen() {
  if (PLATFORM !== "mac") return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const window_ = getCurrentWindow();
  const update = async () => {
    const fullscreen = await window_.isFullscreen().catch(() => false);
    document.documentElement.classList.toggle("fullscreen", fullscreen);
  };
  await window_.onResized(() => void update());
  void update();
}

/**
 * Native menu commands (`src-tauri/src/lib.rs`) and `leaf://` links.
 * @param {Record<string, () => void>} handlers By menu item id.
 * @returns {Promise<() => void>} Unlistens.
 */
export async function listenForMenu(handlers) {
  if (!IS_TAURI) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen("menu", (event) => handlers[/** @type {string} */ (event.payload)]?.());
}

/**
 * Calls `handler` with every `leaf://` URL the app is opened with, including
 * the one that launched it.
 * @param {(url: string) => void} handler
 */
export async function listenForDeepLinks(handler) {
  if (!IS_TAURI) return;
  const { getCurrent, onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
  await onOpenUrl((urls) => {
    for (const url of urls) handler(url);
  });
  const initial = await getCurrent().catch(() => null);
  for (const url of initial ?? []) handler(url);
}

/** @param {string} href */
function safeUrl(href) {
  try {
    return new URL(href, window.location.href);
  } catch {
    return null;
  }
}
