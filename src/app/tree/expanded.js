// @ts-check
import { createSignal } from "solid-js";
import { onClearLocalData } from "../../auth/local-data.js";
import { readStorage, writeStorage } from "../../lib/storage.js";

/**
 * Which pages are expanded in the sidebar tree, saved in localStorage so
 * the tree looks the same after a reload. Page ids are unique across
 * workspaces, so one set covers all of them. Capped, oldest dropped first.
 */

const STORAGE_KEY = "leaf.tree.expanded";
const MAX_SAVED = 500;

const saved = readStorage(STORAGE_KEY);
const [expanded, setExpanded] = createSignal(
  new Set(Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : []),
);

// Sign-out clears the stored key; drop the in-memory copy too.
onClearLocalData(() => {
  setExpanded(new Set());
});

/** @param {string} id */
export function isExpanded(id) {
  return expanded().has(id);
}

/**
 * @param {string} id
 * @param {boolean} value
 */
export function setPageExpanded(id, value) {
  expandAll([id], value);
}

/** @param {string} id */
export function toggleExpanded(id) {
  setPageExpanded(id, !isExpanded(id));
}

/**
 * @param {readonly string[]} ids
 * @param {boolean} [value]
 */
export function expandAll(ids, value = true) {
  const current = expanded();
  if (ids.every((id) => current.has(id) === value)) return;
  const next = new Set(current);
  for (const id of ids) {
    // Re-insert so the set stays in least-recently-expanded order for the cap.
    next.delete(id);
    if (value) next.add(id);
  }
  while (next.size > MAX_SAVED) next.delete(/** @type {string} */ (next.values().next().value));
  setExpanded(next);
  writeStorage(STORAGE_KEY, [...next]);
}
