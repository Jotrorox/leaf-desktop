// @ts-check
import { request } from "./transport.js";

/**
 * Database endpoints (docs/databases.md, Section 4). Rows are pages: their
 * title, icon and values change with `updatePage` (`api/pages.js`), and they
 * go to the trash like any page.
 */

/** @typedef {import("./types.js").Database} Database */
/** @typedef {import("./types.js").View} View */
/** @typedef {import("./types.js").Row} Row */
/** @typedef {import("./types.js").RowPage} RowPage */
/** @typedef {import("./types.js").Property} Property */
/** @typedef {import("./types.js").PropertyValue} PropertyValue */
/** @typedef {{ signal?: AbortSignal }} ReadOptions */

/** @param {string} id */
const enc = (id) => encodeURIComponent(id);

/**
 * `GET /v1/databases/:id`
 * @param {string} id
 * @param {ReadOptions} [options]
 * @returns {Promise<Database>}
 */
export function getDatabase(id, { signal } = {}) {
  return request("GET", `/v1/databases/${enc(id)}`, { signal });
}

/**
 * One page of a database's rows that match `filter` (and `group`: a board
 * column), in `sorts` order.
 * `POST /v1/databases/:id/query`
 * @param {string} id
 * @param {{ filter: View["filter"], sorts: View["sorts"], group?: import("./types.js").RowGroup | null, offset: number, limit: number }} query
 * @param {ReadOptions} [options]
 * @returns {Promise<RowPage>}
 */
export function queryDatabase(id, query, { signal } = {}) {
  return request("POST", `/v1/databases/${enc(id)}/query`, { body: query, signal });
}

/**
 * `POST /v1/databases/:id/rows`. `after_id` null: first; omitted: last.
 * @param {string} id
 * @param {{ id: string, title?: string, icon?: string | null, properties?: Record<string, PropertyValue | null>, after_id?: string | null }} input
 * @returns {Promise<Row>}
 */
export function createRow(id, input) {
  return request("POST", `/v1/databases/${enc(id)}/rows`, { body: input });
}

/**
 * A card moved on a board: its values (its column) and its place in the
 * manual order (`after_id` null: first; omitted: unchanged), together.
 * `POST /v1/databases/:id/rows/:rid/move`
 * @param {string} id
 * @param {string} rowId
 * @param {{ after_id?: string | null, properties?: Record<string, PropertyValue | null> }} input
 * @returns {Promise<Row>}
 */
export function moveRow(id, rowId, input) {
  return request("POST", `/v1/databases/${enc(id)}/rows/${enc(rowId)}/move`, { body: input });
}

/**
 * `POST /v1/databases/:id/properties`
 * @param {string} id
 * @param {{ id: string, name: string, type: Property["type"], options?: Property["options"] }} input
 * @returns {Promise<Database>}
 */
export function addProperty(id, input) {
  return request("POST", `/v1/databases/${enc(id)}/properties`, { body: input });
}

/**
 * Renames a property, changes its type (the server converts the values),
 * or replaces its options.
 * `PATCH /v1/databases/:id/properties/:pid`
 * @param {string} id
 * @param {string} propertyId
 * @param {{ name?: string, type?: Property["type"], options?: Property["options"] }} patch
 * @returns {Promise<Database>}
 */
export function updateProperty(id, propertyId, patch) {
  return request("PATCH", `/v1/databases/${enc(id)}/properties/${enc(propertyId)}`, {
    body: patch,
  });
}

/**
 * `DELETE /v1/databases/:id/properties/:pid`
 * @param {string} id
 * @param {string} propertyId
 * @returns {Promise<Database>}
 */
export function deleteProperty(id, propertyId) {
  return request("DELETE", `/v1/databases/${enc(id)}/properties/${enc(propertyId)}`);
}

/** @typedef {Partial<Pick<View, "name" | "type" | "filter" | "sorts" | "columns" | "group_by" | "card_properties" | "hidden_groups" | "page_size">>} ViewPatch */

/**
 * `POST /v1/databases/:id/views`
 * @param {string} id
 * @param {{ id: string, name: string } & ViewPatch} input
 * @returns {Promise<View>}
 */
export function createView(id, input) {
  return request("POST", `/v1/databases/${enc(id)}/views`, { body: input });
}

/**
 * `PATCH /v1/databases/:id/views/:vid`
 * @param {string} id
 * @param {string} viewId
 * @param {ViewPatch} patch
 * @returns {Promise<View>}
 */
export function updateView(id, viewId, patch) {
  return request("PATCH", `/v1/databases/${enc(id)}/views/${enc(viewId)}`, { body: patch });
}

/**
 * `DELETE /v1/databases/:id/views/:vid`
 * @param {string} id
 * @param {string} viewId
 * @returns {Promise<void>}
 */
export function deleteView(id, viewId) {
  return request("DELETE", `/v1/databases/${enc(id)}/views/${enc(viewId)}`);
}

/**
 * `GET /v1/workspaces/:id/members`
 * @param {string} workspaceId
 * @param {ReadOptions} [options]
 * @returns {Promise<import("./types.js").Member[]>}
 */
export function listMembers(workspaceId, { signal } = {}) {
  return request("GET", `/v1/workspaces/${enc(workspaceId)}/members`, { signal });
}

/**
 * Tells the server how others should see you (`PATCH /v1/me`).
 * @param {{ name?: string | null, avatar_url?: string | null }} profile
 */
export function updateProfile(profile) {
  return request("PATCH", "/v1/me", { body: profile });
}
