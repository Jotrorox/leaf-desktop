// @ts-check
import { createSignal } from "solid-js";

/**
 * Router state: a `location` signal fed by the History API, `navigate()`, and
 * scroll restoration per history entry.
 *
 * Every entry gets a random `key` in `history.state`. When we leave an entry
 * its scroll offset is saved under that key; when back/forward returns to it,
 * the offset is restored. Offsets are mirrored to sessionStorage on
 * `pagehide`, so they survive a reload too. The scroll container is the
 * document unless the layout registers its own with `setScrollContainer()`.
 */

/**
 * @typedef {object} RouterLocation
 * @property {string} pathname Percent-encoded, as in `window.location`.
 * @property {string} search
 * @property {string} hash
 * @property {string} key Identifies the history entry.
 */

/**
 * @typedef {object} NavigateOptions
 * @property {boolean} [replace] Replace the current entry instead of pushing one.
 * @property {boolean} [scroll] Scroll to the hash target or the top afterwards. Default true.
 */

const STORAGE_KEY = "leaf.router.scroll";
const MAX_SAVED_POSITIONS = 100;
const RESTORE_FRAMES = 30;

/** @type {Map<string, number>} */
const scrollPositions = loadScrollPositions();
/** @type {() => Element | null} */
let getScrollContainer = () => document.scrollingElement;
let restoreFrame = 0;

history.scrollRestoration = "manual";
ensureKey();

const [location, setLocation] = createSignal(readLocation());

/** The current location. Reactive. */
export { location };

window.addEventListener("popstate", () => {
  const previous = location();
  saveScroll(previous.key);
  // Plain `#fragment` links create entries without our key.
  ensureKey();
  const next = readLocation();
  setLocation(next);

  const saved = scrollPositions.get(next.key);
  if (saved !== undefined) scrollTo(saved);
  else if (next.hash) scrollToHash(next.hash);
  else if (next.pathname !== previous.pathname) scrollTo(0);
});

window.addEventListener("pagehide", () => {
  saveScroll(location().key);
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...scrollPositions]));
  } catch {
    // Storage full or blocked: positions just won't survive the reload.
  }
});

/**
 * Navigates within the app. Same-origin only; other URLs do a full page load.
 * Navigating to the current URL replaces the entry, like a native link does.
 * @param {string} to Path with optional search and hash; relative paths resolve against the current URL.
 * @param {NavigateOptions} [options]
 */
export function navigate(to, { replace = false, scroll = true } = {}) {
  const url = new URL(rewrite ? rewrite(to) : to, window.location.href);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.href);
    return;
  }
  const previous = location();
  const href = url.pathname + url.search + url.hash;
  if (href === previous.pathname + previous.search + previous.hash) replace = true;

  if (replace) scrollPositions.delete(previous.key);
  else saveScroll(previous.key);
  history[replace ? "replaceState" : "pushState"]({ key: createKey() }, "", href);
  setLocation(readLocation());

  if (!scroll) return;
  if (url.hash) scrollToHash(url.hash);
  else scrollTo(0);
}

/** @type {((to: string) => string) | null} */
let rewrite = null;

/**
 * Rewrites where `navigate()` goes, until set back to null (a public
 * page's readers stay on public pages: `/p/:id` becomes `/s/:id`).
 * @param {((to: string) => string) | null} fn
 */
export function setNavigateRewrite(fn) {
  rewrite = fn;
}

/**
 * Sets the element that scrolls the page content, and restores its offset
 * for the current entry (after a reload). Pass null to go back to the document.
 * @param {Element | null} element
 */
export function setScrollContainer(element) {
  getScrollContainer = element ? () => element : () => document.scrollingElement;
  const saved = scrollPositions.get(location().key);
  if (saved !== undefined) scrollTo(saved);
}

/** @returns {RouterLocation} */
function readLocation() {
  const { pathname, search, hash } = window.location;
  return { pathname, search, hash, key: history.state?.key ?? "" };
}

function ensureKey() {
  if (!history.state?.key) history.replaceState({ ...history.state, key: createKey() }, "");
}

function createKey() {
  return Math.random().toString(36).slice(2, 10);
}

/** @param {string} key */
function saveScroll(key) {
  const container = getScrollContainer();
  if (!key || !container) return;
  // Re-insert so the Map stays in least-recently-saved order for pruning.
  scrollPositions.delete(key);
  scrollPositions.set(key, container.scrollTop);
  if (scrollPositions.size > MAX_SAVED_POSITIONS) {
    scrollPositions.delete(/** @type {string} */ (scrollPositions.keys().next().value));
  }
}

/**
 * Scrolls the container to `top`. The new route renders synchronously, but
 * content that arrives later may not be tall enough yet, so keep trying for
 * a few frames until the offset sticks.
 * @param {number} top
 */
function scrollTo(top) {
  cancelAnimationFrame(restoreFrame);
  const container = getScrollContainer();
  if (!container) return;
  let frames = 0;
  const attempt = () => {
    container.scrollTop = top;
    if (Math.abs(container.scrollTop - top) > 1 && ++frames < RESTORE_FRAMES) {
      restoreFrame = requestAnimationFrame(attempt);
    }
  };
  attempt();
}

/** @param {string} hash */
function scrollToHash(hash) {
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // Use the raw fragment.
  }
  const target = id && document.getElementById(id);
  if (target) {
    cancelAnimationFrame(restoreFrame);
    target.scrollIntoView();
  } else {
    scrollTo(0);
  }
}

/** @returns {Map<string, number>} */
function loadScrollPositions() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    const entries = raw ? JSON.parse(raw) : [];
    return new Map(Array.isArray(entries) ? entries : []);
  } catch {
    return new Map();
  }
}
