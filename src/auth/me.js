// @ts-check
import { createSignal } from "solid-js";
import { ApiError } from "../api/client.js";
import { request } from "../api/transport.js";
import { readStorage, writeStorage } from "../lib/storage.js";
import { onClearLocalData } from "./local-data.js";

/** @typedef {import("../api/types.js").Me} Me */

/**
 * `GET /v1/me`, kept in a signal. The shell waits for it, and shows an error
 * screen with a retry when it fails.
 *
 * Desktop: the last answer is remembered (`leaf.me`), so the shell opens
 * at once on launch; the request then refreshes it in the background. A
 * background refresh that fails (offline) keeps the remembered answer.
 */

/**
 * @typedef {{ status: "idle" }
 *   | { status: "loading" }
 *   | { status: "ready", data: Me }
 *   | { status: "error", error: ApiError }} MeState
 */

const STORAGE_KEY = "leaf.me";

const [me, setMe] = createSignal(/** @type {MeState} */ (initialState()));

/** The `/v1/me` request's state. Reactive. */
export { me };

/** Whether the ready answer came from the cache and hasn't been refreshed yet. */
let fromCache = me().status === "ready";

/** @type {AbortController | null} */
let controller = null;

/** True when the cached answer still needs its background refresh. */
export function meNeedsRefresh() {
  return fromCache;
}

/**
 * Fetches `/v1/me`, replacing any request in flight. With an answer
 * already showing, it refreshes quietly instead of going back to "loading".
 * (A different user signing in clears it first: `onClearLocalData`.)
 */
export async function loadMe() {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  const previous = me();
  const quiet = previous.status === "ready";
  if (!quiet) setMe({ status: "loading" });
  fromCache = false;
  try {
    const data = await request("GET", "/v1/me", { signal: current.signal });
    if (current.signal.aborted) return;
    if (!isMe(data))
      throw new ApiError(
        200,
        "invalid_response",
        "The server sent an unexpected response for /v1/me.",
      );
    writeStorage(STORAGE_KEY, data);
    setMe({ status: "ready", data });
  } catch (err) {
    if (current.signal.aborted) return;
    const error =
      err instanceof ApiError
        ? err
        : new ApiError(0, "unknown", err instanceof Error ? err.message : String(err));
    // Offline (or the server hiccuped): keep showing what we had.
    if (quiet && error.status !== 401 && error.status !== 403) return;
    setMe({ status: "error", error });
  } finally {
    if (controller === current) controller = null;
  }
}

/** Drops the result and cancels a request in flight. */
export function resetMe() {
  controller?.abort();
  controller = null;
  fromCache = false;
  setMe({ status: "idle" });
}

onClearLocalData(resetMe);

/** @returns {MeState} */
function initialState() {
  if (typeof window === "undefined") return { status: "idle" };
  const cached = readStorage(STORAGE_KEY);
  return isMe(cached) ? { status: "ready", data: cached } : { status: "idle" };
}

/** @param {unknown} data @returns {data is Me} */
function isMe(data) {
  return (
    typeof data === "object" && data !== null && typeof (/** @type {any} */ (data).id) === "string"
  );
}
