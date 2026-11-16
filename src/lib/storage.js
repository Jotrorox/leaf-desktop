// @ts-check

/**
 * JSON in localStorage that never throws. Storage can be unavailable (private
 * mode, disabled cookies, quota): reads fall back to `undefined` and writes
 * are dropped.
 *
 * Every key the app stores (localStorage, sessionStorage) and every
 * IndexedDB database it creates starts with `APP_STORAGE_PREFIX`, so sign-out
 * can find and clear them all without touching other scripts' data (Clerk's).
 */

export const APP_STORAGE_PREFIX = "leaf.";

/**
 * @param {string} key
 * @returns {unknown}
 */
export function readStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} key
 * @param {unknown} value
 */
export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory value still applies for this session.
  }
}
