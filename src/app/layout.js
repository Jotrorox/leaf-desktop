// @ts-check
import { createSignal } from "solid-js";
import { readStorage, writeStorage } from "../lib/storage.js";

/**
 * Sidebar state shared by the shell, sidebar and top bar.
 *
 * Wide screens: the sidebar sits beside the content, can be collapsed, and
 * can be resized; width and collapsed state persist in localStorage.
 * Narrow screens: it's an overlay drawer, closed by default, and opening it
 * doesn't touch the persisted state.
 */

export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;
/** Desktop: a little wider than the web app's 240, for the macOS traffic lights. */
export const SIDEBAR_DEFAULT_WIDTH = 280;

const STORAGE_KEY = "leaf.sidebar";
const NARROW_QUERY = "(max-width: 767px)";

const saved = /** @type {{ width?: unknown, collapsed?: unknown } | undefined} */ (
  readStorage(STORAGE_KEY)
);

const [sidebarWidth, setWidth] = createSignal(
  clampSidebarWidth(typeof saved?.width === "number" ? saved.width : SIDEBAR_DEFAULT_WIDTH),
);
const [collapsed, setCollapsed] = createSignal(saved?.collapsed === true);
const [drawerOpen, setDrawerOpen] = createSignal(false);
const [resizing, setResizing] = createSignal(false);

const narrowMedia = window.matchMedia(NARROW_QUERY);
const [narrow, setNarrow] = createSignal(narrowMedia.matches);
narrowMedia.addEventListener("change", (event) => {
  setNarrow(event.matches);
  if (!event.matches) setDrawerOpen(false);
});

export { collapsed, drawerOpen, narrow, resizing, setResizing, sidebarWidth };

/** Whether the sidebar is on screen: the drawer is open, or (wide) it isn't collapsed. */
export function sidebarVisible() {
  return narrow() ? drawerOpen() : !collapsed();
}

/** @param {boolean} visible */
export function setSidebarVisible(visible) {
  if (narrow()) {
    setDrawerOpen(visible);
  } else {
    setCollapsed(!visible);
    persist();
  }
}

export function toggleSidebar() {
  setSidebarVisible(!sidebarVisible());
}

/**
 * @param {number} width
 * @param {{ persist?: boolean }} [options] Save to localStorage; skip while dragging and save once at the end.
 */
export function setSidebarWidth(width, { persist: save = true } = {}) {
  setWidth(clampSidebarWidth(width));
  if (save) persist();
}

/** @param {number} width */
export function clampSidebarWidth(width) {
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

function persist() {
  writeStorage(STORAGE_KEY, { width: sidebarWidth(), collapsed: collapsed() });
}
