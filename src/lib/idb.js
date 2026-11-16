// @ts-check

/**
 * A small promise wrapper around IndexedDB: open a database (with an
 * upgrade callback), and run a function inside one transaction.
 *
 * Inside `transaction`, the callback works with the raw object stores and
 * requests: IndexedDB commits a transaction as soon as nothing is pending,
 * so nothing may be awaited in between. `request()` turns one request into
 * a promise for use outside transactions' critical parts.
 *
 * Databases are named `leaf.*`, so sign-out deletes them (auth/local-data.js).
 */

/** @type {Map<string, Promise<IDBDatabase>>} */
const open = new Map();

/**
 * @param {string} name
 * @param {number} version
 * @param {(db: IDBDatabase, oldVersion: number) => void} upgrade
 * @returns {Promise<IDBDatabase>}
 */
export function openDatabase(name, version, upgrade) {
  const key = `${name}@${version}`;
  let pending = open.get(key);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB isn't available"));
      return;
    }
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = (event) => upgrade(req.result, event.oldVersion);
    req.onsuccess = () => {
      const db = req.result;
      // Another tab is upgrading or deleting it (sign-out): let go.
      db.onversionchange = () => {
        db.close();
        open.delete(key);
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked by another tab`));
  });
  pending.catch(() => open.delete(key));
  open.set(key, pending);
  return pending;
}

/**
 * Run `fn` in one transaction; resolves with its result once committed.
 * @template T
 * @param {IDBDatabase} db
 * @param {string | string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => T} fn
 * @returns {Promise<T>}
 */
export function transaction(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    /** @type {T} */
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
    try {
      result = fn(tx);
    } catch (err) {
      tx.abort();
      reject(err);
    }
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
