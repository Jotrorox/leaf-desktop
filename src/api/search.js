// @ts-check
import { request } from "./transport.js";

/**
 * Search (the ⌘K palette) and the text it searches. The server doesn't read
 * documents itself; editors send a page's plain text after changing it
 * (`editor/sync/text.js`).
 */

/**
 * Pages the user can reach whose title (or title and text) match `query`,
 * best first; recently edited ones for an empty query.
 * `GET /v1/search?query=&limit=`
 * @param {string} query
 * @param {{ signal?: AbortSignal, limit?: number }} [options]
 * @returns {Promise<import("./types.js").SearchResult[]>}
 */
export function search(query, { signal, limit = 20 } = {}) {
  return request("GET", `/v1/search?query=${encodeURIComponent(query)}&limit=${limit}`, { signal });
}

/**
 * `PUT /v1/pages/:id/text { text, files, state }`: the document's text, the
 * uploaded files it shows, and the base64 state vector they were read from.
 * @param {string} pageId
 * @param {{ text: string, files: string[], state: string }} report
 * @param {{ keepalive?: boolean }} [options]
 * @returns {Promise<void>}
 */
export function savePageText(pageId, { text, files, state }, { keepalive } = {}) {
  return request("PUT", `/v1/pages/${encodeURIComponent(pageId)}/text`, {
    body: { text, files, state },
    keepalive,
  });
}
