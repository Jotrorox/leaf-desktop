// @ts-check
import { base64ToBytes, bytesToBase64 } from "../lib/base64.js";
import { request } from "./transport.js";

/**
 * Page documents (docs/sync-protocol.md). The bytes travel as base64 inside
 * JSON, so they go through the same client (auth, errors) as everything else.
 */

/** @typedef {{ signal?: AbortSignal }} ReadOptions */

/** @param {string} id */
const enc = (id) => encodeURIComponent(id);

/**
 * The page's whole document as a snapshot, or null when nothing has been
 * saved yet. `GET /v1/pages/:id/doc`
 * @param {string} pageId
 * @param {ReadOptions} [options]
 * @returns {Promise<Uint8Array | null>}
 */
export async function getDoc(pageId, { signal } = {}) {
  /** @type {{ snapshot: string | null }} */
  const res = await request("GET", `/v1/pages/${enc(pageId)}/doc`, { signal });
  return res.snapshot ? base64ToBytes(res.snapshot) : null;
}

/**
 * Merge an update into the stored document. Answers the state vector the
 * server now holds. A 409 `doc_gap` means the update depends on changes the
 * server doesn't have; send them first. `POST /v1/pages/:id/doc`
 * @param {string} pageId
 * @param {Uint8Array} update
 * @param {{ keepalive?: boolean }} [options]
 * @returns {Promise<Uint8Array>}
 */
export async function saveDoc(pageId, update, { keepalive } = {}) {
  /** @type {{ state_vector: string }} */
  const res = await request("POST", `/v1/pages/${enc(pageId)}/doc`, {
    body: { update: bytesToBase64(update) },
    keepalive,
  });
  return base64ToBytes(res.state_vector);
}
