// @ts-check
import { onClearLocalData } from "../../auth/local-data.js";
import { openDatabase, request, transaction } from "../../lib/idb.js";
import { LruCache } from "../../lib/lru.js";
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
 *
 * Recently opened (and hovered) pages are also kept in memory, exactly as
 * they were last written to disk, so going back to one opens it in the same
 * frame (`peekCachedDoc`), with no IndexedDB round trip and no loading
 * state. The copy in memory only ever follows the disk: it's replaced when
 * a write commits, and while a write of a page is still on its way, that
 * page is read from disk once the write has landed.
 */

const DB_NAME = "leaf.docs";
const DB_VERSION = 2;
const STORE = "docs";
/** Index on `savedAt`, so the background sync can list what's cached without loading it. */
const SAVED_AT = "savedAt";
const WRITE_DELAY = 300;
/** Snapshot bytes kept in memory, at most. */
const MEMORY_BUDGET = 48 << 20;
/** Documents kept in memory, at most. */
const MEMORY_ENTRIES = 64;

/**
 * @typedef {object} CachedDoc
 * @property {Uint8Array} snapshot
 * @property {[number, number][]} acked
 * @property {number} writer The client id of the last writer.
 * @property {number} savedAt
 */

/** @typedef {{ doc: Doc, acked: Map<number, number> }} LoadedDoc */

/** @type {LruCache<string, CachedDoc>} */
const memory = new LruCache({
  maxSize: MEMORY_BUDGET,
  maxEntries: MEMORY_ENTRIES,
  sizeOf: (entry) => entry.snapshot.byteLength,
});
/**
 * Per page, bumped whenever its copy in memory changes, so a disk read that
 * started earlier doesn't put an older copy back.
 * @type {Map<string, number>}
 */
const versions = new Map();
/** Writes still on their way to disk, per page. @type {Map<string, Set<Promise<void>>>} */
const pending = new Map();
/** Bumped on sign-out: work that started before mustn't fill the memory again. */
let generation = 0;

onClearLocalData(() => {
  generation++;
  memory.clear();
  versions.clear();
});

/** The database, created or upgraded as needed. */
export function openDocsDatabase() {
  return openDatabase(DB_NAME, DB_VERSION, (database, oldVersion, tx) => {
    if (oldVersion < 1 && !database.objectStoreNames.contains(STORE))
      database.createObjectStore(STORE);
    const store = tx.objectStore(STORE);
    if (!store.indexNames.contains(SAVED_AT)) store.createIndex(SAVED_AT, SAVED_AT);
  });
}

/** @param {string} pageId @param {CachedDoc} entry */
function remember(pageId, entry) {
  memory.set(pageId, entry);
  versions.set(pageId, (versions.get(pageId) ?? 0) + 1);
}

/** @param {string} pageId */
function forget(pageId) {
  memory.delete(pageId);
  versions.set(pageId, (versions.get(pageId) ?? 0) + 1);
}

/** @param {CachedDoc} entry @returns {LoadedDoc} */
function decode(entry) {
  return { doc: Doc.fromSnapshot(entry.snapshot), acked: new Map(entry.acked) };
}

/**
 * Counts a write of `pageId` as pending until it settles.
 * @param {string} pageId @param {Promise<unknown>} write
 */
function track(pageId, write) {
  const done = write.then(
    () => {},
    () => {},
  );
  let set = pending.get(pageId);
  if (!set) pending.set(pageId, (set = new Set()));
  set.add(done);
  void done.then(() => {
    set.delete(done);
    if (set.size === 0 && pending.get(pageId) === set) pending.delete(pageId);
  });
}

/** Resolves once no write of `pageId` is pending. @param {string} pageId */
async function settled(pageId) {
  for (let set = pending.get(pageId); set; set = pending.get(pageId)) await Promise.all(set);
}

/**
 * Reads a page's entry from disk, and keeps it in memory.
 * @param {string} pageId
 * @returns {Promise<CachedDoc | undefined>}
 */
async function readEntry(pageId) {
  const started = generation;
  const version = versions.get(pageId);
  const database = await openDocsDatabase();
  const entry = /** @type {CachedDoc | undefined} */ (
    await request(database.transaction(STORE, "readonly").objectStore(STORE).get(pageId))
  );
  if (entry && started === generation && versions.get(pageId) === version) remember(pageId, entry);
  return entry;
}

/**
 * The cached document of a page, from memory: right away, or null when it
 * isn't there (or a write of it hasn't landed yet). Each call returns a new
 * replica, so two editors never share one.
 * @param {string} pageId
 * @returns {LoadedDoc | null}
 */
export function peekCachedDoc(pageId) {
  if (pending.has(pageId)) return null;
  const entry = memory.get(pageId);
  if (!entry) return null;
  try {
    return decode(entry);
  } catch {
    forget(pageId);
    return null;
  }
}

/**
 * The cached document of a page, or null.
 * @param {string} pageId
 * @returns {Promise<LoadedDoc | null>}
 */
export async function readCachedDoc(pageId) {
  const fast = peekCachedDoc(pageId);
  if (fast) return fast;
  try {
    // A write that's on its way holds the newest copy.
    await settled(pageId);
    const entry = memory.get(pageId) ?? (await readEntry(pageId));
    return entry ? decode(entry) : null;
  } catch {
    return null;
  }
}

/**
 * Loads a page's cached document into memory ahead of time (the pointer is
 * on a link to it), so opening it doesn't wait for the disk.
 * @param {string} pageId
 */
export async function preloadCachedDoc(pageId) {
  if (memory.has(pageId) || pending.has(pageId)) return;
  try {
    await readEntry(pageId);
  } catch {
    // Nothing cached, or no IndexedDB: the page loads as usual.
  }
}

/**
 * Write a document to the cache, merged with what's there.
 * @param {string} pageId @param {Doc} doc @param {Map<number, number>} acked
 * @param {{ remember?: boolean }} [options] `remember`: keep it in memory
 *   too (an open page). Otherwise memory is only updated when it already
 *   has the page, so a background sync of the workspace doesn't push out
 *   the pages actually being used.
 */
export function writeCachedDoc(pageId, doc, acked, options) {
  const write = writeEntry(pageId, doc, acked, options);
  track(pageId, write);
  return write;
}

/**
 * @param {string} pageId @param {Doc} doc @param {Map<number, number>} acked
 * @param {{ remember?: boolean }} [options]
 */
async function writeEntry(pageId, doc, acked, { remember: keep = false } = {}) {
  const started = generation;
  const snapshot = doc.encodeSnapshot();
  const database = await openDocsDatabase();
  /** @type {CachedDoc | undefined} */
  let written;
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
      written = entry;
    };
  });
  // Committed (in order with every other write of the store): memory now
  // holds what the disk holds.
  if (written && started === generation && (keep || memory.has(pageId))) remember(pageId, written);
}

/**
 * When each cached document was saved, by page id. Reads only the
 * `savedAt` index, not the documents.
 * @returns {Promise<Map<string, number>>}
 */
export async function cachedDocTimes() {
  /** @type {Map<string, number>} */
  const times = new Map();
  try {
    const database = await openDocsDatabase();
    const index = database.transaction(STORE, "readonly").objectStore(STORE).index(SAVED_AT);
    await new Promise((resolve, reject) => {
      const cursor = index.openKeyCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return resolve(undefined);
        if (typeof at.primaryKey === "string" && typeof at.key === "number")
          times.set(at.primaryKey, at.key);
        at.continue();
      };
      cursor.onerror = () => reject(cursor.error);
    });
  } catch {
    // No cache yet.
  }
  return times;
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
      .then(() => writeCachedDoc(pageId, doc, snapshotAcked, { remember: true }))
      .catch(() => {})
      .finally(() => inflight--);
    // Pending from now on: reopening the page waits for this write.
    track(pageId, writing);
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
