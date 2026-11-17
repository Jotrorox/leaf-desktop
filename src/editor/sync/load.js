// @ts-check
import { getDoc } from "../../api/docs.js";
import { Doc } from "../model/doc.js";
import { peekCachedDoc, readCachedDoc } from "./cache.js";

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
 * The page's document right away, when the cache has it in memory (a page
 * opened or hovered recently), or null. Read-only pages prefer the server,
 * so they never come from here.
 * @param {string} pageId
 * @param {{ readOnly?: boolean }} [options]
 * @returns {{ doc: Doc, acked: Map<number, number>, cached: boolean } | null}
 */
export function peekDoc(pageId, { readOnly = false } = {}) {
  if (readOnly) return null;
  const cached = peekCachedDoc(pageId);
  return cached ? { ...cached, cached: true } : null;
}

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
