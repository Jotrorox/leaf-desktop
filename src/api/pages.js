// @ts-check
import { request } from "./transport.js";

/**
 * Workspace and page endpoints. Plain functions over `transport.js`, so
 * they hit the real API or the mock with the same paths and bodies.
 *
 * Endpoints marked "(proposed)" aren't in the architecture's API list yet;
 * the mock implements them and the backend needs to add them.
 */

/** @typedef {import("./types.js").Workspace} Workspace */
/** @typedef {import("./types.js").Page} Page */
/** @typedef {import("./types.js").TreeNode} TreeNode */
/** @typedef {{ signal?: AbortSignal }} ReadOptions */

/** @param {string} id */
const enc = (id) => encodeURIComponent(id);

/**
 * `GET /v1/workspaces`
 * @param {ReadOptions} [options]
 * @returns {Promise<Workspace[]>}
 */
export function listWorkspaces({ signal } = {}) {
  return request("GET", "/v1/workspaces", { signal });
}

/**
 * One level of the page tree: the non-archived children of `parentId`, or
 * the top-level pages when it's null.
 * `GET /v1/workspaces/:id/tree?parent_id=`
 * @param {string} workspaceId
 * @param {string | null} parentId
 * @param {ReadOptions} [options]
 * @returns {Promise<TreeNode[]>}
 */
export function getTree(workspaceId, parentId, { signal } = {}) {
  const query = parentId ? `?parent_id=${enc(parentId)}` : "";
  return request("GET", `/v1/workspaces/${enc(workspaceId)}/tree${query}`, { signal });
}

/**
 * Pages in the trash: each archived page that was moved there itself (not
 * its archived descendants), most recent first.
 * `GET /v1/workspaces/:id/trash` (proposed)
 * @param {string} workspaceId
 * @param {ReadOptions} [options]
 * @returns {Promise<Page[]>}
 */
export function listTrash(workspaceId, { signal } = {}) {
  return request("GET", `/v1/workspaces/${enc(workspaceId)}/trash`, { signal });
}

/**
 * Live pages whose title contains `query`, best first (for `@` mentions).
 * An empty query lists recently edited pages.
 * `GET /v1/workspaces/:id/pages?query=&limit=` (proposed)
 * @param {string} workspaceId
 * @param {string} query
 * @param {ReadOptions & { limit?: number }} [options]
 * @returns {Promise<import("./types.js").PageMatch[]>}
 */
export function searchPages(workspaceId, query, { signal, limit = 20 } = {}) {
  return request(
    "GET",
    `/v1/workspaces/${enc(workspaceId)}/pages?query=${encodeURIComponent(query)}&limit=${limit}`,
    { signal },
  );
}

/**
 * `GET /v1/pages/:id`. Archived pages are returned too, with `archived_at` set.
 * @param {string} id
 * @param {ReadOptions} [options]
 * @returns {Promise<Page>}
 */
export function getPage(id, { signal } = {}) {
  return request("GET", `/v1/pages/${enc(id)}`, { signal });
}

/**
 * `POST /v1/pages`
 * @param {import("./types.js").CreatePageInput} input
 * @returns {Promise<Page>}
 */
export function createPage(input) {
  return request("POST", "/v1/pages", { body: input });
}

/**
 * `PATCH /v1/pages/:id`
 * @param {string} id
 * @param {import("./types.js").UpdatePageInput} patch
 * @returns {Promise<Page>}
 */
export function updatePage(id, patch) {
  return request("PATCH", `/v1/pages/${enc(id)}`, { body: patch });
}

/**
 * Moves the page and its subtree to the trash.
 * `DELETE /v1/pages/:id`
 * @param {string} id
 * @returns {Promise<void>}
 */
export function trashPage(id) {
  return request("DELETE", `/v1/pages/${enc(id)}`);
}

/**
 * Deletes an archived page and its subtree for good.
 * `DELETE /v1/pages/:id?permanent=true` (proposed: the list has one DELETE)
 * @param {string} id
 * @returns {Promise<void>}
 */
export function deletePageForever(id) {
  return request("DELETE", `/v1/pages/${enc(id)}?permanent=true`);
}

/**
 * `POST /v1/pages/:id/move {parent_id, after_id}`
 * @param {string} id
 * @param {import("./types.js").MovePageInput} input
 * @returns {Promise<Page>}
 */
export function movePage(id, input) {
  return request("POST", `/v1/pages/${enc(id)}/move`, { body: input });
}

/**
 * Takes the page (and what was trashed with it) out of the trash. If its
 * parent is gone or still archived, it comes back at the top level.
 * `POST /v1/pages/:id/restore`
 * @param {string} id
 * @returns {Promise<Page>}
 */
export function restorePage(id) {
  return request("POST", `/v1/pages/${enc(id)}/restore`);
}

/**
 * Copies the page and its subtree, placing the copy right after it. `id`
 * is the copy's client-generated id.
 * `POST /v1/pages/:id/duplicate {id}` (proposed)
 * @param {string} id
 * @param {{ id: string }} input
 * @returns {Promise<Page>}
 */
export function duplicatePage(id, input) {
  return request("POST", `/v1/pages/${enc(id)}/duplicate`, { body: input });
}
