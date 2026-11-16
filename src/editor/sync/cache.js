// @ts-check
import { openDatabase, request, transaction } from "../../lib/idb.js";
import { Doc } from "../model/doc.js";

/**
 * Page documents cached in IndexedDB (`leaf.docs`), for opening a page
 * instantly and offline, and as the persistent outbox: a cached document
 * holds every local change, and `acked` says which ones the server has
 * confirmed (docs/sync-protocol.md, 13.3). Sign-out deletes the database.
 *
 * Two tabs may write the same page. A write merges with what's stored (the
 * documents are CRDTs, so the union loses nothing), inside the IndexedDB
 * transaction, so neither tab's unconfirmed changes can be overwritten.
 */

const DB_NAME = "leaf.docs";
const STORE = "docs";
const WRITE_DELAY = 300;

/**
 * @typedef {object} CachedDoc
 * @property {Uint8Array} snapshot
 * @property {[number, number][]} acked
 * @property {number} writer The client id of the last writer.
 * @property {number} savedAt
 */

function db() {
  return openDatabase(DB_NAME, 1, (database) => {
    if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
  });
}

/**
 * The cached document of a page, or null.
 * @param {string} pageId
 * @returns {Promise<{ doc: Doc, acked: Map<number, number> } | null>}
 */
export async function readCachedDoc(pageId) {
  try {
    const database = await db();
    const entry = /** @type {CachedDoc | undefined} */ (
      await request(database.transaction(STORE, "readonly").objectStore(STORE).get(pageId))
    );
    if (!entry) return null;
    return { doc: Doc.fromSnapshot(entry.snapshot), acked: new Map(entry.acked) };
  } catch {
    return null;
  }
}

/**
 * Write a document to the cache, merged with what's there.
 * @param {string} pageId @param {Doc} doc @param {Map<number, number>} acked
 */
export async function writeCachedDoc(pageId, doc, acked) {
  const snapshot = doc.encodeSnapshot();
  const database = await db();
  await transaction(database, STORE, "readwrite", (tx) => {
    const store = tx.objectStore(STORE);
    const get = store.get(pageId);
    get.onsuccess = () => {
      const old = /** @type {CachedDoc | undefined} */ (get.result);
      let bytes = snapshot;
      const merged = new Map(acked);
      if (old) {
        for (const [client, clock] of old.acked)
          if (clock > (merged.get(client) ?? 0)) merged.set(client, clock);
        // Our document already holds everything we wrote before.
        if (old.writer !== doc.clientId) {
          try {
            const union = Doc.fromSnapshot(snapshot, { clientId: 1 });
            union.applyUpdate(old.snapshot);
            if (union.pendingCount === 0) bytes = union.encodeSnapshot();
          } catch {
            // A broken entry is replaced.
          }
        }
      }
      /** @type {CachedDoc} */
      const entry = {
        snapshot: bytes,
        acked: [...merged],
        writer: doc.clientId,
        savedAt: Date.now(),
      };
      store.put(entry, pageId);
    };
  });
}

/**
 * Debounced writes of one page's document, for the sync provider's
 * `onPersist`. `flush()` writes now (on pagehide).
 * @param {string} pageId @param {Doc} doc
 */
export function createDocCache(pageId, doc) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Map<number, number>} */
  let acked = new Map();
  let dirty = false;
  let inflight = 0;
  let writing = Promise.resolve();

  const write = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty) return writing;
    dirty = false;
    const snapshotAcked = new Map(acked);
    inflight++;
    writing = writing
      .then(() => writeCachedDoc(pageId, doc, snapshotAcked))
      .catch(() => {})
      .finally(() => inflight--);
    return writing;
  };

  return {
    /** @param {{ acked: Map<number, number> }} state */
    persist(state) {
      acked = state.acked;
      dirty = true;
      if (timer === undefined) timer = setTimeout(write, WRITE_DELAY);
    },
    flush: write,
    /** Whether everything so far is written. */
    saved: () => !dirty && inflight === 0,
  };
}
