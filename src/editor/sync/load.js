// @ts-check
import { getDoc } from "../../api/docs.js";
import { Doc } from "../model/doc.js";
import { readCachedDoc } from "./cache.js";

/**
 * Opening a page's document: from the local cache when it has the page
 * (instant, and offline too; the live sync then brings what changed), or
 * else from the server. A read-only page (in the trash) prefers the server,
 * which has the final word on what it held, and falls back to the cache.
 *
 * `acked` is what the server is known to hold; anything else in the
 * document is local and still to be sent.
 */

/**
 * @param {string} pageId
 * @param {{ readOnly?: boolean, signal?: AbortSignal }} [options]
 * @returns {Promise<{ doc: Doc, acked: Map<number, number>, cached: boolean }>}
 */
export async function loadDoc(pageId, { readOnly = false, signal } = {}) {
  if (!readOnly) {
    const cached = await readCachedDoc(pageId);
    if (cached) return { ...cached, cached: true };
  }
  try {
    const snapshot = await getDoc(pageId, { signal });
    const doc = snapshot ? Doc.fromSnapshot(snapshot) : new Doc();
    return { doc, acked: doc.stateVector(), cached: false };
  } catch (err) {
    const cached = readOnly ? await readCachedDoc(pageId) : null;
    if (cached) return { ...cached, cached: true };
    throw err;
  }
}
