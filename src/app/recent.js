// @ts-check
import { createSignal } from "solid-js";
import { readStorage, writeStorage } from "../lib/storage.js";

/**
 * Recently visited pages, newest first, for quick find (⌘K): kept in
 * localStorage per browser (cleared on sign-out with the other `leaf.` keys).
 * Each keeps the title, icon and path it had when last seen; quick find
 * prefers what the cache knows now.
 */

/**
 * @typedef {object} RecentPage
 * @property {string} id
 * @property {string} title
 * @property {string | null} icon
 * @property {string} [kind]
 * @property {string[]} path Ancestors' titles, outermost first.
 * @property {number} at When it was visited (ms).
 */

const KEY = "leaf.recent-pages";
const MAX = 20;

/** @param {unknown} value @returns {RecentPage[]} */
function parse(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item) =>
      item &&
      typeof item.id === "string" &&
      typeof item.title === "string" &&
      Array.isArray(item.path) &&
      typeof item.at === "number",
  );
}

const [recent, setRecent] = createSignal(parse(readStorage(KEY)));

/** Recently visited pages, newest first. Reactive. */
export { recent };

/**
 * Remembers a visit (or updates what a recent page looks like).
 * @param {Omit<RecentPage, "at">} page
 * @param {number} [at]
 */
export function rememberPage(page, at = Date.now()) {
  const next = [{ ...page, at }, ...recent().filter((item) => item.id !== page.id)].slice(0, MAX);
  setRecent(next);
  writeStorage(KEY, next);
}

/** Forgets a page (deleted, or no longer reachable). @param {string} id */
export function forgetPage(id) {
  if (!recent().some((item) => item.id === id)) return;
  const next = recent().filter((item) => item.id !== id);
  setRecent(next);
  writeStorage(KEY, next);
}

/** Forgets everything (sign-out clears storage; this clears memory too). */
export function clearRecent() {
  setRecent([]);
}
