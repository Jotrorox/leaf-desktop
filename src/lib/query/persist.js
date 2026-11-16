// @ts-check

import { onClearLocalData } from "../../auth/local-data.js";
import { openDatabase, request, transaction } from "../idb.js";

/**
 * Saves the query cache to IndexedDB (`leaf.queries`) and restores it on
 * launch, so the sidebar, pages and databases show the moment the window
 * opens, before any request; the restored entries then refresh in the
 * background (`hydrate` marks them stale).
 *
 * Writes are debounced and also flushed when the window hides or closes.
 * Sign-out deletes the database with every other `leaf.*` one
 * (`auth/local-data.js`).
 */

const DB_NAME = "leaf.queries";
const STORE = "snapshot";
const RECORD = "v1";
const WRITE_DELAY = 1_500;
/** The most recently updated entries kept on disk. */
const MAX_ENTRIES = 2_000;

/** @typedef {import("./core.js").QueryClient} QueryClient */

function db() {
  return openDatabase(DB_NAME, 1, (database) => {
    if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE);
  });
}

/**
 * Restores the saved cache into `client`. Gives up after `timeout` ms so a
 * slow disk never holds up the first paint.
 * @param {QueryClient} client
 * @param {{ timeout?: number }} [options]
 */
export async function restoreQueryCache(client, { timeout = 400 } = {}) {
  const read = (async () => {
    const database = await db();
    const saved = await request(
      database.transaction(STORE, "readonly").objectStore(STORE).get(RECORD),
    );
    return Array.isArray(saved) ? saved : [];
  })();
  const timer = new Promise((resolve) => setTimeout(() => resolve(null), timeout));
  try {
    const saved = await Promise.race([read, timer]);
    if (Array.isArray(saved)) client.hydrate(saved);
  } catch (err) {
    console.warn("Couldn't restore the local cache:", err);
  }
}

/**
 * Keeps the saved cache up to date with `client` from now on.
 * @param {QueryClient} client
 * @returns {() => void} Stops (after a last write).
 */
export function persistQueryCache(client) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let dirty = false;
  /** Bumped on sign-out: a write that started before must not land after. */
  let generation = 0;

  /** @param {unknown} snapshot @param {number} started */
  const put = async (snapshot, started) => {
    const database = await db();
    if (started !== generation) return;
    await transaction(database, STORE, "readwrite", (tx) => {
      tx.objectStore(STORE).put(snapshot, RECORD);
    });
  };

  const write = async () => {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty) return;
    dirty = false;
    const started = generation;
    const snapshot = client.dehydrate(MAX_ENTRIES);
    try {
      await put(snapshot, started);
    } catch (err) {
      // Some entry held something IndexedDB can't clone: store it as JSON.
      try {
        await put(JSON.parse(JSON.stringify(snapshot)), started);
      } catch {
        console.warn("Couldn't save the local cache:", err);
      }
    }
  };

  const stopChanges = client.onChange(() => {
    dirty = true;
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
    dirty = false;
  });

  return () => {
    stopChanges();
    stopClear();
    document.removeEventListener("visibilitychange", flush);
    window.removeEventListener("pagehide", onHide);
    void write();
  };
}
