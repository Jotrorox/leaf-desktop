// @ts-check

/**
 * Thin fetch wrapper for the leaf API: base URL, JSON in and out, typed
 * errors, AbortSignal passthrough, and bearer-token auth.
 *
 * Auth: once a token provider is set, every request carries
 * `Authorization: Bearer <token>`, and none goes out without one (it fails
 * with a 401 `signed_out` ApiError instead), unless anonymous requests are
 * allowed (`setAnonymousAllowed`, for public pages). On a 401 response the client asks
 * the provider for a fresh token and retries once; if that's rejected too, it
 * calls the unauthorized handler (auth signs out there) and throws.
 *
 * Pure module: no Solid, no DOM beyond `fetch`, so it runs under `node --test`.
 */

/** @typedef {"GET" | "POST" | "PUT" | "PATCH" | "DELETE"} HttpMethod */

/**
 * @typedef {object} RequestOptions
 * @property {unknown} [body] Serialized as JSON when not `undefined`.
 * @property {Record<string, string>} [headers]
 * @property {AbortSignal} [signal]
 * @property {boolean} [keepalive] Let the request outlive the page (a save on unload).
 */

/**
 * Returns the current access token, or null when signed out. `forceRefresh`
 * asks for a new token instead of a cached one (after a 401).
 * @typedef {(options: { forceRefresh: boolean }) => string | null | undefined | Promise<string | null | undefined>} TokenProvider
 */

export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, or 0 when the request never got a response.
   * @param {string} code Machine-readable error code.
   * @param {string} message
   */
  constructor(status, code, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{ baseUrl?: string }} [options]
 */
export function createApiClient({ baseUrl = "" } = {}) {
  const base = baseUrl.replace(/\/+$/, "");
  /** @type {TokenProvider | null} */
  let tokenProvider = null;
  /** @type {(() => void) | null} */
  let onUnauthorized = null;
  let anonymousAllowed = false;

  /** @param {boolean} forceRefresh */
  async function token(forceRefresh) {
    if (!tokenProvider) return null;
    let value;
    try {
      value = await tokenProvider({ forceRefresh });
    } catch (err) {
      throw new ApiError(0, "token_unavailable", err instanceof Error ? err.message : String(err));
    }
    if (!value) {
      if (anonymousAllowed) return null;
      throw new ApiError(401, "signed_out", "Not signed in");
    }
    return value;
  }

  /**
   * @template [T=unknown]
   * @param {HttpMethod} method
   * @param {string} path Absolute path, e.g. `/v1/pages`.
   * @param {RequestOptions} [options]
   * @returns {Promise<T>}
   */
  async function request(method, path, { body, headers, signal, keepalive } = {}) {
    const init = /** @type {RequestInit & { headers: Headers }} */ ({
      method,
      headers: new Headers(headers),
      signal,
    });
    if (keepalive) init.keepalive = true;
    init.headers.set("Accept", "application/json");
    if (body !== undefined) {
      init.headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }

    const first = await token(false);
    let res = await send(base + path, init, first);
    // (An anonymous request's 401 just means the route needs a user.)
    if (first !== null && res.status === 401) {
      signal?.throwIfAborted();
      res = await send(base + path, init, await token(true));
      if (res.status === 401) onUnauthorized?.();
    }

    const data = await readBody(res);
    if (!res.ok) throw toApiError(res, data);
    return /** @type {T} */ (data);
  }

  return {
    request,
    /** @param {TokenProvider | null} fn */
    setTokenProvider(fn) {
      tokenProvider = fn;
    },
    /**
     * While true, a signed-out client sends requests without a token instead
     * of refusing to (a public page's readers). Off by default.
     * @param {boolean} allowed
     */
    setAnonymousAllowed(allowed) {
      anonymousAllowed = allowed;
    },
    /**
     * Called when a request is still rejected with 401 after a token refresh.
     * @param {(() => void) | null} fn
     */
    setUnauthorizedHandler(fn) {
      onUnauthorized = fn;
    },
    /** @template [T=unknown] @param {string} path @param {Omit<RequestOptions, "body">} [options] @returns {Promise<T>} */
    get: (path, options) => request("GET", path, options),
    /** @template [T=unknown] @param {string} path @param {unknown} [body] @param {Omit<RequestOptions, "body">} [options] @returns {Promise<T>} */
    post: (path, body, options) => request("POST", path, { ...options, body }),
    /** @template [T=unknown] @param {string} path @param {unknown} [body] @param {Omit<RequestOptions, "body">} [options] @returns {Promise<T>} */
    put: (path, body, options) => request("PUT", path, { ...options, body }),
    /** @template [T=unknown] @param {string} path @param {unknown} [body] @param {Omit<RequestOptions, "body">} [options] @returns {Promise<T>} */
    patch: (path, body, options) => request("PATCH", path, { ...options, body }),
    /** @template [T=unknown] @param {string} path @param {Omit<RequestOptions, "body">} [options] @returns {Promise<T>} */
    delete: (path, options) => request("DELETE", path, options),
  };
}

/**
 * @param {string} url
 * @param {RequestInit & { headers: Headers }} init
 * @param {string | null} token
 */
async function send(url, init, token) {
  if (token) init.headers.set("Authorization", `Bearer ${token}`);
  try {
    return await fetch(url, init);
  } catch (err) {
    // Let aborts surface unchanged so callers can check `err.name === "AbortError"`.
    if (err instanceof Error && err.name === "AbortError") throw err;
    throw new ApiError(0, "network_error", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Parses JSON bodies, returns text for anything else, and undefined for empty bodies.
 * @param {Response} res
 */
async function readBody(res) {
  const text = await res.text();
  if (!text) return undefined;
  if (!(res.headers.get("Content-Type") ?? "").includes("json")) return text;
  try {
    return JSON.parse(text);
  } catch {
    if (res.ok) throw new ApiError(res.status, "invalid_json", "Response body is not valid JSON");
    return text;
  }
}

/**
 * Accepts `{ error: { code, message } }` or `{ code, message }` error bodies.
 * @param {Response} res
 * @param {unknown} data
 */
function toApiError(res, data) {
  const obj = isRecord(data) && isRecord(data.error) ? data.error : isRecord(data) ? data : {};
  const code = typeof obj.code === "string" ? obj.code : `http_${res.status}`;
  const message =
    typeof obj.message === "string"
      ? obj.message
      : res.statusText || `Request failed with status ${res.status}`;
  return new ApiError(res.status, code, message);
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// `import.meta.env` only exists under Vite; under `node --test` it's undefined.
export const api = createApiClient({ baseUrl: import.meta.env?.VITE_API_URL ?? "" });
export const setTokenProvider = api.setTokenProvider;
export const setUnauthorizedHandler = api.setUnauthorizedHandler;
export const setAnonymousAllowed = api.setAnonymousAllowed;
/** The API's base URL ("" for the page's own origin). */
export const API_BASE = (import.meta.env?.VITE_API_URL ?? "").replace(/\/+$/, "");
