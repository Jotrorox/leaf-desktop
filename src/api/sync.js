// @ts-check
import { IS_TAURI, WEB_ORIGIN } from "../desktop/env.js";
import { NativeSocket } from "../desktop/socket.js";
import { mockTransport, request } from "./transport.js";

/**
 * Opening a page's live sync socket (docs/sync-protocol.md, 13.1): get a
 * single-use ticket over the authenticated API, then connect to
 * `wss://<api>/v1/pages/:id/ws?ticket=…`. In mock mode, the mock's
 * in-process socket. In the desktop app the socket is opened natively, as
 * the web app's origin (the only one the API accepts sockets from).
 */

/** @typedef {import("../editor/sync/provider.js").SocketLike} SocketLike */

/**
 * @param {string} pageId
 * @returns {Promise<{ socket: SocketLike, readOnly: boolean }>}
 */
export async function openSyncSocket(pageId) {
  if (mockTransport) {
    const mock = await mockTransport;
    if (!mock.connectSync) throw new Error("the mock has no live sync");
    return mock.connectSync(pageId);
  }
  /** @type {{ ticket: string, read_only: boolean }} */
  const { ticket, read_only } = await request("POST", "/v1/ws-ticket", {
    body: { page_id: pageId },
  });
  const url = new URL(
    `/v1/pages/${encodeURIComponent(pageId)}/ws`,
    import.meta.env.VITE_API_URL || location.origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("ticket", ticket);
  if (IS_TAURI)
    return { socket: new NativeSocket(url.href, { origin: WEB_ORIGIN }), readOnly: read_only };
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  return {
    socket: /** @type {SocketLike} */ (/** @type {unknown} */ (socket)),
    readOnly: read_only,
  };
}
