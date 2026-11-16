// @ts-check

import { IS_TAURI } from "../desktop/env.js";
import { nativeFetch } from "../desktop/http.js";
import { API_BASE, ApiError } from "./client.js";
import { loadedMock, mockTransport, request } from "./transport.js";

/**
 * Uploading files (images): ask for an upload URL, then PUT the bytes to it
 * with an XMLHttpRequest, which reports progress (fetch doesn't, for
 * uploads). A file is then known by its id: image blocks keep it in their
 * attrs, covers and icons as `file:<id>`, and `fileUrl(id)` is where it can
 * be read (by anyone who has the URL, so public pages show their images).
 */

/** @typedef {import("./types.js").UploadTicket} UploadTicket */
/**
 * @typedef {object} PutOptions
 * @property {Record<string, string>} headers
 * @property {(loaded: number, total: number) => void} [onProgress]
 * @property {AbortSignal} [signal]
 */

/** What can be uploaded (the server's list). */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
/** The server's limit. */
export const MAX_FILE_SIZE = 20 << 20;

const FILE_PREFIX = "file:";

/** A cover or icon value for an uploaded file. @param {string} id */
export const fileRef = (id) => `${FILE_PREFIX}${id}`;

/**
 * The file id in a cover or icon value, or null when it's something else.
 * @param {string | null | undefined} value
 */
export function fileIdOf(value) {
  return typeof value === "string" && value.startsWith(FILE_PREFIX)
    ? value.slice(FILE_PREFIX.length)
    : null;
}

/**
 * Where an uploaded file can be read.
 * @param {string} id
 */
export function fileUrl(id) {
  if (mockTransport) return loadedMock?.fileUrl?.(id) ?? "";
  return `${API_BASE}/v1/files/${encodeURIComponent(id)}`;
}

/**
 * Why a file can't be uploaded, or null when it can.
 * @param {Blob} file
 */
export function uploadProblem(file) {
  if (!IMAGE_TYPES.includes(file.type))
    return "Only PNG, JPEG, GIF, WebP and AVIF images can be uploaded.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_FILE_SIZE) return `Images can be at most ${MAX_FILE_SIZE >> 20} MB.`;
  return null;
}

/**
 * Asks for an upload URL. `POST /v1/files/upload-url`
 * @param {{ pageId: string, name: string, type: string, size: number }} input
 * @returns {Promise<UploadTicket>}
 */
export function requestUpload({ pageId, name, type, size }) {
  return request("POST", "/v1/files/upload-url", {
    body: { page_id: pageId, name, content_type: type, size },
  });
}

/**
 * Uploads a file for a page. `onTicket` hears the file's id as soon as it
 * has one (before the bytes are sent), so a block can point at it at once.
 * @param {File | Blob} file
 * @param {{
 *   pageId: string,
 *   onTicket?: (ticket: UploadTicket) => void,
 *   onProgress?: (loaded: number, total: number) => void,
 *   signal?: AbortSignal,
 * }} options
 * @returns {Promise<{ id: string }>}
 */
export async function uploadFile(file, { pageId, onTicket, onProgress, signal }) {
  const problem = uploadProblem(file);
  if (problem) throw new ApiError(400, "invalid_file", problem);
  const name = "name" in file && typeof file.name === "string" && file.name ? file.name : "image";
  const ticket = await requestUpload({ pageId, name, type: file.type, size: file.size });
  onTicket?.(ticket);
  const options = { headers: ticket.headers, onProgress, signal };
  if (mockTransport) {
    const mock = await mockTransport;
    if (!mock.putFile) throw new Error("the mock has no file uploads");
    await mock.putFile(ticket.upload_url, file, options);
  } else {
    await putWithProgress(`${API_BASE}${ticket.upload_url}`, file, options);
  }
  return { id: ticket.id };
}

/**
 * A PUT with upload progress.
 * @param {string} url @param {Blob} body @param {PutOptions} options
 * @returns {Promise<void>}
 */
function putWithProgress(url, body, { headers, onProgress, signal }) {
  if (IS_TAURI) return putNative(url, body, { headers, onProgress, signal });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) =>
      onProgress?.(event.loaded, event.lengthComputable ? event.total : body.size);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(body.size, body.size);
        resolve();
        return;
      }
      let code = `http_${xhr.status}`;
      let message = `Upload failed with status ${xhr.status}`;
      try {
        const error = JSON.parse(xhr.responseText)?.error;
        if (typeof error?.code === "string") code = error.code;
        if (typeof error?.message === "string") message = error.message;
      } catch {
        // Not JSON.
      }
      reject(new ApiError(xhr.status, code, message));
    };
    xhr.onerror = () =>
      reject(new ApiError(0, "network_error", "Couldn't reach the server to upload"));
    xhr.onabort = () => reject(new DOMException("The upload was aborted.", "AbortError"));
    if (signal) {
      if (signal.aborted) return reject(new DOMException("The upload was aborted.", "AbortError"));
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(body);
  });
}

/**
 * The desktop app's upload: a native PUT (the webview's XHR would be
 * refused by the API's CORS rules). There's no byte-level progress, just
 * the start and the end.
 * @param {string} url
 * @param {Blob} body
 * @param {PutOptions} options
 * @returns {Promise<void>}
 */
async function putNative(url, body, { headers, onProgress, signal }) {
  onProgress?.(0, body.size);
  let res;
  try {
    res = await nativeFetch(url, { method: "PUT", headers, body, signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError")
      throw new DOMException("The upload was aborted.", "AbortError");
    throw new ApiError(0, "network_error", "Couldn't reach the server to upload");
  }
  if (res.ok) {
    onProgress?.(body.size, body.size);
    return;
  }
  let code = `http_${res.status}`;
  let message = `Upload failed with status ${res.status}`;
  try {
    const error = (await res.json())?.error;
    if (typeof error?.code === "string") code = error.code;
    if (typeof error?.message === "string") message = error.message;
  } catch {
    // Not JSON.
  }
  throw new ApiError(res.status, code, message);
}
