// @ts-check
import { api } from "./client.js";

/**
 * Where API requests go: the real client, or, with `VITE_API_MOCK=1`, the
 * in-memory mock backend in `mock/` (same paths, same JSON, same errors).
 * The flag is replaced at build time, so a normal build doesn't contain the
 * mock at all.
 */

/** @typedef {import("./client.js").HttpMethod} HttpMethod */
/** @typedef {import("./client.js").RequestOptions} RequestOptions */
/**
 * @typedef {object} Transport
 * @property {<T = unknown>(method: HttpMethod, path: string, options?: RequestOptions) => Promise<T>} request
 * @property {(pageId: string) => Promise<{ socket: import("../editor/sync/provider.js").SocketLike, readOnly: boolean }>} [connectSync]
 * @property {(path: string, file: Blob, options: import("./files.js").PutOptions) => Promise<void>} [putFile] An upload URL's PUT.
 * @property {(id: string) => string | null} [fileUrl] Where an uploaded file can be read.
 */

// Spelled out without `?.`, so Vite folds it and drops the mock from normal
// builds. (This module only runs under Vite; tests import the mock directly.)
/** @type {Promise<Transport> | null} */
const mock =
  import.meta.env.VITE_API_MOCK === "1"
    ? import("./mock/index.js").then((module) => module.mockApi)
    : null;

/**
 * @template [T=unknown]
 * @param {HttpMethod} method
 * @param {string} path
 * @param {RequestOptions} [options]
 * @returns {Promise<T>}
 */
export function request(method, path, options) {
  if (mock) return mock.then((transport) => transport.request(method, path, options));
  return api.request(method, path, options);
}

/** The mock backend, in mock mode (for live sync and files); null otherwise. */
export const mockTransport = mock;

/** The mock backend once it has loaded (files' URLs are needed synchronously). @type {Transport | null} */
export let loadedMock = null;
void mock?.then((transport) => (loadedMock = transport));
