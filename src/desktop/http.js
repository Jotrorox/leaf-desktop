// @ts-check
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./env.js";

/**
 * `fetch`, performed by the Rust side (`src-tauri/src/net.rs`).
 *
 * The webview's own fetch would send the app's origin (`tauri://localhost`),
 * which the leaf API's CORS rules refuse and which Clerk would write into
 * session tokens. A native request carries no origin, like a mobile app's,
 * and reuses one pooled HTTP/2 connection per host.
 *
 * `installNativeFetch(hosts)` routes the global `fetch` for those hosts
 * through here, so code written for the browser (the API client, Clerk)
 * works unchanged. Everything else keeps the webview's fetch.
 */

const decoder = new TextDecoder();

/**
 * @param {RequestInfo | URL} input
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export async function nativeFetch(input, init = {}) {
  const request = input instanceof Request ? input : null;
  const url = request ? request.url : String(input);
  const method = (init.method ?? request?.method ?? "GET").toUpperCase();
  const headers = new Headers(request?.headers);
  for (const [name, value] of new Headers(init.headers)) headers.set(name, value);
  const signal = init.signal ?? request?.signal ?? null;
  signal?.throwIfAborted();

  let body = init.body ?? null;
  if (body === null && request && method !== "GET" && method !== "HEAD")
    body = await request.arrayBuffer();
  const bytes = await toBytes(body, headers);

  const spec = { url, method, headers: [...headers] };
  const call = invoke("http_fetch", bytes, {
    headers: { "x-leaf-request": encodeURIComponent(JSON.stringify(spec)) },
  });

  /** @type {ArrayBuffer} */
  let raw;
  try {
    raw = /** @type {ArrayBuffer} */ (await abortable(call, signal));
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    // Like the browser's fetch: network failures are TypeErrors.
    throw new TypeError(
      typeof err === "string" ? err : err instanceof Error ? err.message : "Network request failed",
    );
  }

  const view = new DataView(raw);
  const metaLength = view.getUint32(0);
  /** @type {{ status: number, url: string, headers: [string, string][] }} */
  const meta = JSON.parse(decoder.decode(new Uint8Array(raw, 4, metaLength)));
  const payload = raw.slice(4 + metaLength);
  const nullBody =
    meta.status === 204 || meta.status === 205 || meta.status === 304 || method === "HEAD";
  const response = new Response(nullBody ? null : payload, {
    status: meta.status,
    headers: meta.headers,
  });
  Object.defineProperty(response, "url", { value: meta.url });
  return response;
}

/**
 * @param {BodyInit | null} body
 * @param {Headers} headers Gets a Content-Type for bodies that imply one.
 * @returns {Promise<Uint8Array>}
 */
async function toBytes(body, headers) {
  if (body === null || body === undefined) return new Uint8Array();
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return new TextEncoder().encode(body);
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type"))
      headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return new TextEncoder().encode(body.toString());
  }
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body))
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof Blob) {
    if (!headers.has("content-type") && body.type) headers.set("content-type", body.type);
    return new Uint8Array(await body.arrayBuffer());
  }
  // FormData (Clerk sends its forms this way): let the browser encode it.
  const encoded = new Response(/** @type {BodyInit} */ (body));
  const type = encoded.headers.get("content-type");
  if (type && !headers.has("content-type")) headers.set("content-type", type);
  return new Uint8Array(await encoded.arrayBuffer());
}

/**
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal | null} signal
 * @returns {Promise<T>}
 */
function abortable(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () =>
      reject(
        signal.reason instanceof DOMException
          ? signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Routes the global `fetch` for these hosts through the native client.
 * Safe to call more than once; hosts accumulate.
 * @param {string[]} hosts e.g. `["api.leaf.jotrorox.com"]`
 */
export function installNativeFetch(hosts) {
  if (!IS_TAURI) return;
  for (const host of hosts) if (host) nativeHosts.add(host.toLowerCase());
  if (installed) return;
  installed = true;
  const browserFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    let host = "";
    try {
      host = new URL(url, window.location.href).host.toLowerCase();
    } catch {
      // Not a URL fetch understands either; let it fail there.
    }
    return nativeHosts.has(host) ? nativeFetch(input, init) : browserFetch(input, init);
  };
}

/** @type {Set<string>} */
const nativeHosts = new Set();
let installed = false;

/** The host of a URL, or "" when it isn't one. @param {string} url */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}
