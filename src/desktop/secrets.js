// @ts-check
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./env.js";

/**
 * The credential store (`src-tauri/src/secrets.rs`): a private file outside
 * the webview's storage. In a plain browser tab (development), localStorage
 * stands in.
 */

/** @typedef {"clerk.client"} SecretKey */

const BROWSER_PREFIX = "leaf-dev-secret.";

/**
 * The stored value, or null when there is none. Throws when the store can't
 * be read: that must not pass for "signed out" (Clerk would start a new
 * client and overwrite the saved session).
 * @param {SecretKey} key
 * @returns {Promise<string | null>}
 */
export async function getSecret(key) {
  if (!IS_TAURI) return localStorage.getItem(BROWSER_PREFIX + key);
  return /** @type {string | null} */ (await invoke("secret_get", { key }));
}

/** @param {SecretKey} key @param {string} value */
export async function setSecret(key, value) {
  if (!IS_TAURI) return localStorage.setItem(BROWSER_PREFIX + key, value);
  await invoke("secret_set", { key, value });
}

/** @param {SecretKey} key */
export async function deleteSecret(key) {
  if (!IS_TAURI) return localStorage.removeItem(BROWSER_PREFIX + key);
  await invoke("secret_delete", { key });
}
