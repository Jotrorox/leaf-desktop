// @ts-check
import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * A WebSocket opened by the Rust side (`src-tauri/src/net.rs`), shaped like
 * the subset of the browser's WebSocket the sync provider uses
 * (`SocketLike` in `editor/sync/provider.js`).
 *
 * The API only accepts sockets whose `Origin` is the web app's, which a
 * webview can't send; the native side can.
 */

const OPEN = 0;
const BINARY = 1;
const TEXT = 2;
const CLOSE = 3;
const ERROR = 4;

const decoder = new TextDecoder();

export class NativeSocket {
  /** 0 connecting, 1 open, 2 closing, 3 closed: as WebSocket. */
  readyState = 0;
  binaryType = "arraybuffer";
  /** @type {((event: any) => void) | null} */
  onopen = null;
  /** @type {((event: { data: ArrayBuffer | Uint8Array | string }) => void) | null} */
  onmessage = null;
  /** @type {((event: { code: number, reason?: string }) => void) | null} */
  onclose = null;
  /** @type {((event: any) => void) | null} */
  onerror = null;

  /** @type {number | null} */
  #id = null;
  /** close() before the id arrived. @type {[number | undefined, string | undefined] | null} */
  #pendingClose = null;
  /** The socket opened before `ws_connect` answered with its id. */
  #openedEarly = false;
  /** Sends go out one after another, in order (IPC calls can overtake each other). */
  #sending = Promise.resolve();

  /**
   * @param {string} url `wss://…`
   * @param {{ origin?: string }} [options]
   */
  constructor(url, { origin } = {}) {
    const channel = new Channel();
    channel.onmessage = (message) => this.#receive(/** @type {ArrayBuffer} */ (message));
    invoke("ws_connect", { url, origin: origin ?? null, onEvent: channel }).then(
      (id) => {
        this.#id = /** @type {number} */ (id);
        if (this.#pendingClose) this.close(...this.#pendingClose);
        else if (this.#openedEarly) this.#open();
      },
      (err) => {
        this.readyState = 3;
        this.onerror?.({ type: "error", message: String(err) });
        this.onclose?.({ code: 1006, reason: String(err) });
      },
    );
  }

  /** @param {ArrayBuffer | number[]} message */
  #receive(message) {
    const bytes =
      message instanceof ArrayBuffer ? new Uint8Array(message) : Uint8Array.from(message);
    const kind = bytes[0];
    const payload = bytes.subarray(1);
    switch (kind) {
      case OPEN:
        if (this.readyState !== 0) return;
        // Can't send without the id: open once it's here.
        if (this.#id === null) this.#openedEarly = true;
        else this.#open();
        return;
      case BINARY:
        if (this.readyState !== 1) return;
        this.onmessage?.({ data: payload.slice().buffer });
        return;
      case TEXT:
        if (this.readyState !== 1) return;
        this.onmessage?.({ data: decoder.decode(payload) });
        return;
      case ERROR:
        this.onerror?.({ type: "error", message: decoder.decode(payload) });
        return;
      case CLOSE: {
        if (this.readyState === 3) return;
        this.readyState = 3;
        const code = payload.length >= 2 ? (payload[0] << 8) | payload[1] : 1005;
        this.onclose?.({ code, reason: decoder.decode(payload.subarray(2)) });
        return;
      }
    }
  }

  #open() {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.onopen?.({ type: "open" });
  }

  /** @param {Uint8Array | ArrayBuffer} data */
  send(data) {
    if (this.readyState !== 1 || this.#id === null)
      throw new DOMException("The socket isn't open", "InvalidStateError");
    const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data);
    const id = this.#id;
    this.#sending = this.#sending.then(() =>
      invoke("ws_send", bytes, { headers: { "x-leaf-socket": String(id) } }).catch((err) => {
        this.onerror?.({ type: "error", message: String(err) });
      }),
    );
  }

  /** @param {number} [code] @param {string} [reason] */
  close(code, reason) {
    if (this.readyState >= 2) return;
    if (this.#id === null) {
      this.#pendingClose = [code, reason];
      return;
    }
    this.readyState = 2;
    const id = this.#id;
    // After whatever is still queued to send.
    this.#sending = this.#sending.then(() =>
      invoke("ws_close", { id, code: code ?? 1000, reason: reason ?? "" }).catch(() => {}),
    );
  }
}
