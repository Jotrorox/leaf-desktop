// @ts-check
import { APP_STORAGE_PREFIX } from "../lib/storage.js";

/**
 * Clears what the app keeps in this browser, on sign-out or when a different
 * user signs in: registered in-memory caches (the query cache from M3, the
 * `/v1/me` result), `leaf.*` keys in localStorage and sessionStorage, and
 * IndexedDB databases named `leaf.*`. Clerk's own storage is left alone;
 * Clerk clears it in `signOut()`.
 *
 * Pure apart from the defaults in `clearLocalData()`, so it runs under `node --test`.
 */

/** @typedef {Pick<Storage, "length" | "key" | "removeItem">} KeyedStorage */
/** @typedef {Pick<IDBFactory, "databases" | "deleteDatabase">} DatabaseFactory */

/** @type {Set<() => void | Promise<void>>} */
const cleanups = new Set();

/**
 * Registers in-memory state to drop on sign-out (caches, user data).
 * @param {() => void | Promise<void>} fn
 * @returns {() => void} Unregisters.
 */
export function onClearLocalData(fn) {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

/**
 * Removes every key starting with `prefix`.
 * @param {KeyedStorage} storage
 * @param {string} [prefix]
 * @returns {string[]} The removed keys.
 */
export function clearStorageKeys(storage, prefix = APP_STORAGE_PREFIX) {
  /** @type {string[]} */
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
  return keys;
}

/**
 * Deletes every IndexedDB database whose name starts with `prefix`. A delete
 * that's blocked by a connection still open in another tab is queued by the
 * browser and finishes when that tab lets go, so it isn't waited for.
 * @param {DatabaseFactory} idb
 * @param {string} [prefix]
 * @returns {Promise<string[]>} The deleted (or queued) database names.
 */
export async function deleteAppDatabases(idb, prefix = APP_STORAGE_PREFIX) {
  if (typeof idb.databases !== "function") return [];
  const names = (await idb.databases())
    .map((info) => info.name)
    .filter((name) => typeof name === "string" && name.startsWith(prefix));
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          const request = idb.deleteDatabase(/** @type {string} */ (name));
          request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined);
        }),
    ),
  );
  return /** @type {string[]} */ (names);
}

/**
 * Runs every step even when one fails, so one broken cache can't leave
 * another user's data behind.
 * @param {{ storages?: KeyedStorage[], idb?: DatabaseFactory | null }} [deps] Browser globals by default.
 */
export async function clearLocalData(deps = {}) {
  const storages = deps.storages ?? browserStorages();
  const idb = deps.idb !== undefined ? deps.idb : (globalThis.indexedDB ?? null);
  const steps = [
    ...[...cleanups].map((fn) => async () => fn()),
    ...storages.map((storage) => async () => clearStorageKeys(storage)),
    async () => idb && (await deleteAppDatabases(idb)),
  ];
  const results = await Promise.allSettled(steps.map((step) => step()));
  for (const result of results) {
    if (result.status === "rejected") console.error("Clearing local data failed:", result.reason);
  }
}

/** localStorage and sessionStorage, minus any the browser blocks. */
function browserStorages() {
  /** @type {KeyedStorage[]} */
  const list = [];
  for (const name of /** @type {const} */ (["localStorage", "sessionStorage"])) {
    try {
      const storage = globalThis[name];
      if (storage) list.push(storage);
    } catch {
      // Blocked (privacy settings): nothing stored there to clear.
    }
  }
  return list;
}
