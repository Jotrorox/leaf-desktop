// @ts-check

import { onClearLocalData } from "../../auth/local-data.js";
import { openDatabase, request, transaction } from "../idb.js";
import { hashKey } from "./key.js";

/**
 * Saves the query cache to IndexedDB (`leaf.queries`) and restores it on
 * launch, so the sidebar, pages and databases show the moment the window
 * opens, before any request; the restored entries then refresh in the
 * background (`hydrate` marks them stale).
 *
 * One record per query, keyed by its hash, and only the entries whose
 * confirmed data changed are written: typing a title or moving a page
 * writes that page and that tree level, not the whole cache. (Optimistic
 * changes aren't saved at all until the server confirms them.) Writes are
 * debounced and also flushed when the window hides or closes.
 *
 * Sign-out deletes the database with every other `leaf.*` one
 * (`auth/local-data.js`).
 */

const DB_NAME = "leaf.queries";
const DB_VERSION = 2;
const STORE = "entries";
/** Version 1 kept every entry in one array, in this store and record. */
const LEGACY_STORE = "snapshot";
const LEGACY_RECORD = "v1";
const WRITE_DELAY = 1_500;
/** The most recently updated entries kept on disk. */
const MAX_ENTRIES = 2_000;

/** @typedef {import("./core.js").QueryClient} QueryClient */
/** @typedef {{ key: import("./key.js").QueryKey, data: unknown, updatedAt: number }} SavedEntry */

function db() {
  return openDatabase(DB_NAME, DB_VERSION, (database, _oldVersion, tx) => {
    const store = database.objectStoreNames.contains(STORE)
      ? tx.objectStore(STORE)
      : database.createObjectStore(STORE);
    if (!database.objectStoreNames.contains(LEGACY_STORE)) return;
    // Split the old single record into one per entry.
    const get = tx.objectStore(LEGACY_STORE).get(LEGACY_RECORD);
    get.onsuccess = () => {
      if (Array.isArray(get.result)) {
        for (const item of get.result) {
          try {
            if (Array.isArray(item?.key)) store.put(item, hashKey(item.key));
          } catch {
            // Skip an entry that doesn't fit.
          }
        }
      }
      database.deleteObjectStore(LEGACY_STORE);
    };
  });
}

/**
 * Restores the saved cache into `client`. Gives up after `timeout` ms so a
 * slow disk never holds up the first paint.
 * @param {QueryClient} client
 * @param {{ timeout?: number }} [options]
 * @returns {Promise<SavedEntry[]>} The restored entries, for `persistQueryCache`.
 */
export async function restoreQueryCache(client, { timeout = 400 } = {}) {
  const read = (async () => {
    const database = await db();
    const saved = await request(
      database.transaction(STORE, "readonly").objectStore(STORE).getAll(),
    );
    return /** @type {SavedEntry[]} */ (saved.filter((item) => Array.isArray(item?.key)));
  })();
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeout));
  try {
    const saved = /** @type {SavedEntry[] | null} */ (await Promise.race([read, timer]));
    if (!saved) return [];
    saved.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const kept = saved.slice(0, MAX_ENTRIES);
    client.hydrate(kept);
    void prune(saved.slice(MAX_ENTRIES));
    return kept;
  } catch (err) {
    console.warn("Couldn't restore the local cache:", err);
    return [];
  }
}

/**
 * Deletes saved entries past the limit (the oldest).
 * @param {SavedEntry[]} entries
 */
async function prune(entries) {
  if (entries.length === 0) return;
  try {
    const database = await db();
    await transaction(database, STORE, "readwrite", (tx) => {
      const store = tx.objectStore(STORE);
      for (const item of entries) store.delete(hashKey(item.key));
    });
  } catch {
    // Next launch tries again.
  }
}

/**
 * Keeps the saved cache up to date with `client` from now on.
 * @param {QueryClient} client
 * @param {{ restored?: SavedEntry[] }} [options] What `restoreQueryCache`
 *   put in, which is on disk already.
 * @returns {() => void} Stops (after a last write).
 */
export function persistQueryCache(client, { restored = [] } = {}) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** Entries changed since the last write, by hash. @type {Set<string>} */
  const dirty = new Set();
  /** The confirmed data last written for each entry, by hash. @type {Map<string, unknown>} */
  const written = new Map();
  /** Bumped on sign-out: a write that started before must not land after. */
  let generation = 0;

  for (const item of restored) {
    const hash = hashKey(item.key);
    if (client.dehydrateEntry(hash)?.data === item.data) written.set(hash, item.data);
  }

  const write = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (dirty.size === 0) return;
    const started = generation;
    /** @type {[string, SavedEntry | null][]} */
    const changes = [];
    for (const hash of dirty) {
      const entry = client.dehydrateEntry(hash);
      // Unchanged confirmed data (an optimistic layer came or went), or nothing to delete.
      if (entry ? written.get(hash) === entry.data : !written.has(hash)) continue;
      changes.push([hash, entry]);
      if (entry) written.set(hash, entry.data);
      else written.delete(hash);
    }
    dirty.clear();
    if (changes.length === 0) return;
    try {
      const database = await db();
      if (started !== generation) return;
      await transaction(database, STORE, "readwrite", (tx) => {
        const store = tx.objectStore(STORE);
        for (const [hash, entry] of changes) {
          if (!entry) {
            store.delete(hash);
            continue;
          }
          try {
            store.put(entry, hash);
          } catch {
            // It holds something IndexedDB can't clone: store it as JSON.
            try {
              store.put(JSON.parse(JSON.stringify(entry)), hash);
            } catch {
              // Not JSON either: leave it out.
            }
          }
        }
      });
    } catch (err) {
      if (started !== generation) return;
      console.warn("Couldn't save the local cache:", err);
      // Written with the next change.
      for (const [hash] of changes) {
        written.delete(hash);
        dirty.add(hash);
      }
    }
  };

  const stopChanges = client.onChange((hash) => {
    dirty.add(hash);
    if (timer === undefined) timer = setTimeout(() => void write(), WRITE_DELAY);
  });
  const flush = () => {
    if (document.visibilityState === "hidden") void write();
  };
  const onHide = () => void write();
  document.addEventListener("visibilitychange", flush);
  window.addEventListener("pagehide", onHide);
  // Sign-out: drop a pending write, so the old user's data doesn't go back to disk.
  const stopClear = onClearLocalData(() => {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    dirty.clear();
    written.clear();
  });

  return () => {
    stopChanges();
    stopClear();
    document.removeEventListener("visibilitychange", flush);
    window.removeEventListener("pagehide", onHide);
    void write();
  };
}
