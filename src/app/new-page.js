// @ts-check
import { addRow } from "../data/databases.js";
import { createPage } from "../data/pages.js";
import { navigate } from "../lib/router/index.js";
import { setPageExpanded } from "./tree/expanded.js";

/**
 * "New page": creates it (optimistically), reveals it in the tree, opens
 * it, and asks the page header to focus its title.
 */

/** @type {string | null} */
let pendingTitleFocus = null;

/**
 * @param {{ workspaceId: string, parentId?: string | null, kind?: "page" | "database" }} input
 * @returns {string} The new page's id.
 */
export function openNewPage({ workspaceId, parentId = null, kind = "page" }) {
  const id = createPage({ workspaceId, parentId, kind });
  if (parentId) setPageExpanded(parentId, true);
  pendingTitleFocus = id;
  navigate(`/p/${encodeURIComponent(id)}`);
  return id;
}

/**
 * True once for the page `openNewPage` just opened: its title should take focus.
 * @param {string} id
 */
export function takeTitleFocus(id) {
  if (pendingTitleFocus !== id) return false;
  pendingTitleFocus = null;
  return true;
}

/**
 * "New row" from the sidebar: adds it at the end of the database
 * (optimistically), reveals it in the tree, and opens it like a new page.
 * @param {{ workspaceId: string, databaseId: string }} input
 * @returns {string} The new row's id.
 */
export function openNewRow({ workspaceId, databaseId }) {
  const id = addRow({ workspaceId, databaseId });
  setPageExpanded(databaseId, true);
  pendingTitleFocus = id;
  navigate(`/p/${encodeURIComponent(id)}`);
  return id;
}
