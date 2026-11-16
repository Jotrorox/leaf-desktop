// @ts-check
import { createSignal } from "solid-js";
import { onClearLocalData } from "../../auth/local-data.js";
import { readStorage, writeStorage } from "../../lib/storage.js";

/**
 * Which databases list their rows in the sidebar tree, as subpages. Off by
 * default (rows aren't tree children: docs/databases.md); turned on per
 * database from its "…" menu, in the sidebar or the top bar. Saved in
 * localStorage, like the expand state, so it's per browser. Capped, oldest
 * dropped first.
 */

const STORAGE_KEY = "leaf.tree.rowPages";
const MAX_SAVED = 500;

const saved = readStorage(STORAGE_KEY);
const [shown, setShown] = createSignal(
  new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []),
);

onClearLocalData(() => {
  setShown(new Set());
});

/** @param {string} databaseId */
export function showsRowPages(databaseId) {
  return shown().has(databaseId);
}

/**
 * @param {string} databaseId
 * @param {boolean} value
 */
export function setShowsRowPages(databaseId, value) {
  if (shown().has(databaseId) === value) return;
  const next = new Set(shown());
  next.delete(databaseId);
  if (value) next.add(databaseId);
  while (next.size > MAX_SAVED) next.delete(/** @type {string} */ (next.values().next().value));
  setShown(next);
  writeStorage(STORAGE_KEY, [...next]);
}
