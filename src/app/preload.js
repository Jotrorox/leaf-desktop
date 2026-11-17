// @ts-check
import { prefetchPage } from "../data/pages.js";
import { preloadCachedDoc } from "../editor/sync/cache.js";

/**
 * Gets a page ready before it's opened: its details into the query cache
 * (from the server, unless they're fresh) and its document from disk into
 * memory, so the click shows it in the same frame.
 *
 * `installLinkPreload()` does this for any link to a page that the pointer
 * rests on, or that gets keyboard focus: the sidebar, breadcrumbs, home,
 * mentions in a document.
 */

/** How long the pointer rests on a link before it counts as intent. */
const HOVER_DELAY = 60;
/** Pages preloaded recently, so sweeping over the sidebar doesn't repeat the work. */
const recent = new Map();
const RECENT_FOR = 10_000;

/**
 * @param {string | null | undefined} pageId
 */
export function preloadPage(pageId) {
  if (!pageId) return;
  const now = Date.now();
  if (now - (recent.get(pageId) ?? 0) < RECENT_FOR) return;
  recent.set(pageId, now);
  if (recent.size > 200) recent.delete(recent.keys().next().value);
  void preloadCachedDoc(pageId);
  void prefetchPage(pageId).catch(() => {});
}

/**
 * The page a link points to, or null.
 * @param {EventTarget | null} target
 */
function pageOfLink(target) {
  if (!(target instanceof Element)) return null;
  const href = target.closest("a[href]")?.getAttribute("href");
  const match = href?.match(/^\/p\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Preloads pages whose links are hovered or focused, anywhere in the app.
 * @returns {() => void} Stops.
 */
export function installLinkPreload() {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {string | null} */
  let hovered = null;

  /** @param {PointerEvent} event */
  const onOver = (event) => {
    const pageId = pageOfLink(event.target);
    if (pageId === hovered) return;
    clearTimeout(timer);
    hovered = pageId;
    if (pageId) timer = setTimeout(() => preloadPage(pageId), HOVER_DELAY);
  };
  /** @param {FocusEvent} event */
  const onFocus = (event) => preloadPage(pageOfLink(event.target));

  document.addEventListener("pointerover", onOver, { passive: true });
  document.addEventListener("focusin", onFocus);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("focusin", onFocus);
  };
}
