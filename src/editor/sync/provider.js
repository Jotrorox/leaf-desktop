// @ts-check
import { decodeStateVector } from "../model/update.js";
import {
  CLOSE,
  decodeMessage,
  encodeHello,
  encodeUpdate,
  NOTICE_GAP,
  NOTICE_READ_ONLY,
} from "./protocol.js";

/**
 * Live sync of one page's document over a WebSocket (docs/sync-protocol.md,
 * Section 13), with the HTTP save of Section 12 as the fallback and the way
 * out on page unload.
 *
 * - `acked` is what the server has confirmed. Everything the document has
 *   beyond it is the outbox: it's sent on every (re)connect, and it's in
 *   the local cache, so it survives a reload, a crash and going offline.
 * - On connect: HELLO with our state vector; the server's SYNC brings what
 *   we lack and its state vector, which becomes `acked`; then we send
 *   `encodeDiff(acked)`. After that, local changes go out as UPDATEs a
 *   moment after they're made, and others' changes arrive as UPDATEs.
 * - A dropped connection reconnects with exponential backoff and jitter (at
 *   once when the browser says it's back online; after a short random delay
 *   when the server says it's restarting). While the socket is down,
 *   unsaved changes also go over HTTP, so they're saved even where
 *   WebSockets are blocked.
 *
 * - A read-only provider (the user may only view the page, or it's in the
 *   trash) only listens: it gets everyone's changes and presence, and
 *   shares its own presence, but never sends a change.
 * - Presence (`awareness`) goes over the same socket once it's synced.
 *
 * DOM-free: the socket, the HTTP save, the cache and the timers are passed
 * in, so it runs under `node --test`.
 */

/** @typedef {import("../model/doc.js").Doc} Doc */
/** @typedef {import("./status.js").SaveStatus} SaveStatus */

/**
 * The socket API the provider uses: the browser's WebSocket fits it, and so
 * does the mock's.
 * @typedef {object} SocketLike
 * @property {number} readyState 1 when open.
 * @property {(data: Uint8Array) => void} send
 * @property {(code?: number, reason?: string) => void} close
 * @property {((event: any) => void) | null} onopen
 * @property {((event: { data: ArrayBuffer | Uint8Array }) => void) | null} onmessage
 * @property {((event: { code: number, reason?: string }) => void) | null} onclose
 * @property {((event: any) => void) | null} onerror
 */

/**
 * @typedef {object} ProviderOptions
 * @property {Doc} doc
 * @property {Map<number, number>} acked What the server is known to hold when this starts.
 * @property {() => Promise<{ socket: SocketLike, readOnly: boolean }>} connect Get a ticket and open a socket.
 * @property {(update: Uint8Array, options: { keepalive: boolean }) => Promise<Uint8Array>} saveHttp POST the update; resolves to the server's state vector.
 * @property {(update: Uint8Array) => void} [applyRemote] Merge others' changes (the editor keeps the selection). Default: `doc.applyUpdate`.
 * @property {boolean} [readOnly] Only listen: never send a change.
 * @property {import("./awareness.js").Awareness} [awareness] Presence, shared over the socket.
 * @property {(status: SaveStatus) => void} [onStatus]
 * @property {(state: { acked: Map<number, number> }) => void} [onPersist] Store the document and `acked` locally (debounced by the caller).
 * @property {() => void} [onReadOnly] The page went to the trash (or can't be edited): stop editing.
 * @property {() => void} [onTooLarge] The server refuses the document as too large: nothing more is saved.
 * @property {() => void} [onGone] The page was deleted.
 * @property {() => number} [random]
 * @property {typeof setTimeout} [setTimer]
 * @property {typeof clearTimeout} [clearTimer]
 */

export const SEND_DELAY = 30;
const RECONNECT_MIN = 500;
const RECONNECT_MAX = 30_000;
const RESTART_SPREAD = 1500;
const HTTP_FALLBACK_DELAY = 2000;
const HTTP_RETRY_MAX = 30_000;
/** Browsers cap keepalive request bodies at 64 KiB in total. */
const KEEPALIVE_LIMIT = 60_000;
/** An empty update message: header, no clients, no transactions. */
const EMPTY_UPDATE_LENGTH = 4;

/** @param {Map<number, number>} into @param {Map<number, number>} from */
function raise(into, from) {
  for (const [client, clock] of from) if (clock > (into.get(client) ?? 0)) into.set(client, clock);
  return into;
}

/** Whether `a` has anything `b` doesn't. @param {Map<number, number>} a @param {Map<number, number>} b */
function ahead(a, b) {
  for (const [client, clock] of a) if (clock > (b.get(client) ?? 0)) return true;
  return false;
}

export class SyncProvider {
  #doc;
  #acked;
  /** What's been sent on the current connection. @type {Map<number, number>} */
  #sent = new Map();
  #seq = 0;
  #opts;
  /** @type {SocketLike | null} */
  #socket = null;
  /** SYNC received on the current socket. */
  #live = false;
  #connecting = false;
  #attempt = 0;
  /** The last connection or save attempt failed (we're probably offline). */
  #failing = false;
  /**
   * The last HTTP save worked: the server is reachable even if sockets
   * aren't (a proxy that blocks WebSockets).
   */
  #httpOk = false;
  /** Nothing more can be saved: the page is read-only, or the document is too large. */
  #readOnly = false;
  /** Only listening, from the start (the user can't edit). */
  #listener = false;
  #stopped = false;
  /** @type {SaveStatus} */
  #status = "saved";
  #httpInflight = false;
  #httpRetry = HTTP_FALLBACK_DELAY;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #sendTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #reconnectTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #httpTimer;
  #unobserve;

  /** @param {ProviderOptions} options */
  constructor(options) {
    this.#opts = options;
    this.#doc = options.doc;
    this.#acked = new Map(options.acked);
    this.#listener = options.readOnly === true;
    this.#unobserve = this.#doc.observe((e) => {
      if (e.local) this.#changed();
      else this.#opts.onPersist?.({ acked: this.acked });
    });
    this.#connect();
  }

  get status() {
    return this.#status;
  }

  /** What the server has confirmed. */
  get acked() {
    return new Map(this.#acked);
  }

  /** Local changes the server hasn't confirmed. */
  get dirty() {
    return !this.#listener && ahead(this.#doc.stateVector(), this.#acked);
  }

  get connected() {
    return this.#live;
  }

  // --- Status ---------------------------------------------------------------

  #updateStatus() {
    if (this.#listener) return;
    const reachable = this.#live || !this.#failing || this.#httpOk;
    /** @type {SaveStatus} */
    const next = this.#readOnly
      ? "error"
      : !reachable
        ? "offline"
        : this.dirty
          ? "saving"
          : "saved";
    if (next === this.#status) return;
    this.#status = next;
    this.#opts.onStatus?.(next);
  }

  // --- Local changes ----------------------------------------------------------

  #changed() {
    if (this.#stopped || this.#listener) return;
    this.#opts.onPersist?.({ acked: this.acked });
    this.#updateStatus();
    if (this.#live) {
      if (this.#sendTimer === undefined)
        this.#sendTimer = this.#timer(() => this.#flushSocket(), SEND_DELAY);
    } else {
      this.#scheduleHttp(HTTP_FALLBACK_DELAY);
    }
  }

  /** Send what the server hasn't been sent on this connection. */
  #flushSocket() {
    this.#clear(this.#sendTimer);
    this.#sendTimer = undefined;
    const socket = this.#socket;
    if (!socket || !this.#live || this.#readOnly || this.#listener || socket.readyState !== 1)
      return;
    const local = this.#doc.stateVector();
    if (!ahead(local, this.#sent)) return;
    const update = this.#doc.encodeDiff(this.#sent);
    try {
      socket.send(encodeUpdate(++this.#seq, update));
    } catch {
      return; // the close handler takes it from here
    }
    raise(this.#sent, local);
  }

  // --- Connection -------------------------------------------------------------

  async #connect() {
    if (this.#stopped || this.#readOnly || this.#connecting || this.#socket) return;
    this.#connecting = true;
    /** @type {{ socket: SocketLike, readOnly: boolean }} */
    let opened;
    try {
      opened = await this.#opts.connect();
    } catch (err) {
      this.#connecting = false;
      if (this.#stopped) return;
      // 404: the page is gone.
      if (/** @type {any} */ (err)?.status === 404) {
        this.#gone();
        return;
      }
      this.#failed();
      return;
    }
    this.#connecting = false;
    if (this.#stopped) {
      opened.socket.close(1000);
      return;
    }
    const socket = opened.socket;
    this.#socket = socket;
    socket.onopen = () => {
      socket.send(encodeHello(this.#doc.encodeStateVector()));
    };
    socket.onmessage = (event) => {
      if (this.#socket !== socket) return;
      const data = event.data instanceof Uint8Array ? event.data : new Uint8Array(event.data);
      this.#receive(data);
    };
    socket.onclose = (event) => {
      if (this.#socket !== socket) return;
      this.#closed(event.code);
    };
    socket.onerror = () => {};
    if (socket.readyState === 1) socket.onopen?.({});
  }

  /** @param {Uint8Array} data */
  #receive(data) {
    let msg;
    try {
      msg = decodeMessage(data);
    } catch {
      this.#socket?.close(CLOSE.protocol, "bad message");
      return;
    }
    switch (msg.type) {
      case "sync": {
        const gained =
          msg.update.length > EMPTY_UPDATE_LENGTH ? this.#applyRemote(msg.update) : null;
        this.#acked = decodeStateVector(msg.sv);
        if (gained) raise(this.#acked, gained);
        this.#sent = new Map(this.#acked);
        this.#live = true;
        this.#failing = false;
        this.#httpOk = false;
        this.#attempt = 0;
        this.#clear(this.#httpTimer);
        this.#httpTimer = undefined;
        this.#opts.onPersist?.({ acked: this.acked });
        this.#flushSocket();
        this.#updateStatus();
        const socket = this.#socket;
        this.#opts.awareness?.connect((bytes) => {
          if (this.#socket === socket && socket?.readyState === 1) socket.send(bytes);
        });
        return;
      }
      case "awareness":
        this.#opts.awareness?.receive(msg.entries);
        return;
      case "update": {
        if (msg.update.length <= EMPTY_UPDATE_LENGTH) return;
        const gained = this.#applyRemote(msg.update);
        if (gained.size > 0) {
          raise(this.#acked, gained);
          this.#updateStatus();
        }
        return;
      }
      case "ack":
        raise(this.#acked, decodeStateVector(msg.sv));
        this.#opts.onPersist?.({ acked: this.acked });
        this.#updateStatus();
        return;
      case "notice":
        if (msg.code === NOTICE_READ_ONLY) {
          // Expected when only listening; news otherwise (the page went to the trash).
          if (this.#listener) return;
          this.#readOnly = true;
          this.#updateStatus();
          this.#opts.onReadOnly?.();
        } else if (msg.code === NOTICE_GAP && msg.sv) {
          // The server lacks something an update needed: send everything it lacks.
          this.#sent = decodeStateVector(msg.sv);
          this.#flushSocket();
        }
        return;
      default:
        this.#socket?.close(CLOSE.protocol, "unexpected message");
    }
  }

  /**
   * Merge what the server sent. Returns how far it took each client: the
   * server has all of that (it only takes a client's transactions in chain
   * order), so it needn't be sent back, even before the next ACK.
   * @param {Uint8Array} update
   */
  #applyRemote(update) {
    const before = this.#doc.stateVector();
    try {
      if (this.#opts.applyRemote) this.#opts.applyRemote(update);
      else this.#doc.applyUpdate(update, "server");
    } catch {
      this.#socket?.close(CLOSE.protocol, "bad update");
    }
    /** @type {Map<number, number>} */
    const gained = new Map();
    for (const [client, clock] of this.#doc.stateVector())
      if (clock > (before.get(client) ?? 0)) gained.set(client, clock);
    return gained;
  }

  /** @param {number} code */
  #closed(code) {
    this.#socket = null;
    this.#live = false;
    this.#opts.awareness?.disconnect();
    this.#clear(this.#sendTimer);
    this.#sendTimer = undefined;
    if (this.#stopped) return;
    if (code === CLOSE.gone) {
      this.#gone();
      return;
    }
    if (code === CLOSE.tooLarge) {
      this.#tooLarge();
      return;
    }
    if (code === CLOSE.restart) {
      // Every client of the old instance reconnects; spread them out.
      this.#failing = true;
      this.#updateStatus();
      this.#reconnect(this.#random() * RESTART_SPREAD);
      return;
    }
    this.#failed();
  }

  #failed() {
    this.#failing = true;
    this.#updateStatus();
    const delay = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** this.#attempt);
    this.#attempt++;
    this.#reconnect(delay * (0.5 + this.#random() / 2));
    if (this.dirty) this.#scheduleHttp(HTTP_FALLBACK_DELAY);
  }

  /** @param {number} delay */
  #reconnect(delay) {
    if (this.#stopped) return;
    this.#clear(this.#reconnectTimer);
    this.#reconnectTimer = this.#timer(() => {
      this.#reconnectTimer = undefined;
      void this.#connect();
    }, delay);
  }

  /**
   * The server won't store the document (over its size limit). Retrying
   * can't help: stop sending, and say so. Edits stay in the local cache.
   */
  #tooLarge() {
    this.#readOnly = true;
    this.#clear(this.#reconnectTimer);
    this.#clear(this.#httpTimer);
    this.#httpTimer = undefined;
    this.#updateStatus();
    this.#opts.onTooLarge?.();
  }

  #gone() {
    this.#stopped = true;
    this.#readOnly = true;
    this.#updateStatus();
    this.#opts.onGone?.();
  }

  /** The browser says it's back online: try now instead of waiting out the backoff. */
  retryNow() {
    if (this.#stopped || this.#live) return;
    this.#attempt = 0;
    this.#httpRetry = HTTP_FALLBACK_DELAY;
    this.#reconnect(0);
    if (this.dirty) this.#scheduleHttp(0);
  }

  // --- HTTP fallback ------------------------------------------------------------

  /** @param {number} delay */
  #scheduleHttp(delay) {
    if (
      this.#stopped ||
      this.#readOnly ||
      this.#listener ||
      this.#live ||
      this.#httpTimer !== undefined
    )
      return;
    this.#httpTimer = this.#timer(() => {
      this.#httpTimer = undefined;
      void this.#saveHttp(false);
    }, delay);
  }

  /** @param {boolean} keepalive */
  async #saveHttp(keepalive) {
    if (this.#readOnly || this.#listener || !this.dirty) return;
    if (this.#httpInflight && !keepalive) return;
    const local = this.#doc.stateVector();
    const update = this.#doc.encodeDiff(this.#acked);
    if (keepalive && update.length >= KEEPALIVE_LIMIT) return;
    if (!keepalive) this.#httpInflight = true;
    try {
      const sv = decodeStateVector(await this.#opts.saveHttp(update, { keepalive }));
      if (keepalive) return;
      // The server has what it says and (committed) everything we sent.
      raise(raise(this.#acked, sv), local);
      this.#failing = false;
      this.#httpOk = true;
      this.#httpRetry = HTTP_FALLBACK_DELAY;
      this.#opts.onPersist?.({ acked: this.acked });
      this.#updateStatus();
    } catch (err) {
      if (keepalive || this.#stopped) return;
      const e = /** @type {any} */ (err);
      if (e?.code === "page_archived" || e?.code === "read_only") {
        this.#readOnly = true;
        this.#updateStatus();
        this.#opts.onReadOnly?.();
        return;
      }
      if (e?.status === 404) {
        this.#gone();
        return;
      }
      if (e?.status === 413) {
        this.#tooLarge();
        return;
      }
      if (e?.code === "doc_gap") {
        // The server's copy lacks what our update builds on and we don't
        // have it either: the socket's SYNC sorts that out; retry later.
      }
      this.#failing = true;
      this.#httpOk = false;
      this.#updateStatus();
      this.#httpRetry = Math.min(HTTP_RETRY_MAX, this.#httpRetry * 2);
      this.#scheduleHttp(this.#httpRetry * (0.75 + this.#random() / 2));
    } finally {
      if (!keepalive) this.#httpInflight = false;
    }
  }

  /**
   * The page is going away: send what the server lacks over HTTP with
   * `keepalive` (a socket message might not make it out), and over the
   * socket too.
   */
  flushOnUnload() {
    if (!this.dirty || this.#readOnly || this.#listener) return;
    this.#flushSocket();
    void this.#saveHttp(true);
  }

  /** Stop syncing; unsent changes go out one last time. */
  destroy() {
    if (this.#stopped) return;
    this.flushOnUnload();
    this.#stopped = true;
    this.#clear(this.#sendTimer);
    this.#clear(this.#reconnectTimer);
    this.#clear(this.#httpTimer);
    this.#unobserve();
    const socket = this.#socket;
    this.#socket = null;
    this.#live = false;
    this.#opts.awareness?.disconnect();
    socket?.close(1000, "done");
  }

  // --- Helpers -------------------------------------------------------------------

  /** @param {() => void} fn @param {number} ms */
  #timer(fn, ms) {
    return (this.#opts.setTimer ?? setTimeout)(fn, ms);
  }

  /** @param {ReturnType<typeof setTimeout> | undefined} t */
  #clear(t) {
    if (t !== undefined) (this.#opts.clearTimer ?? clearTimeout)(t);
  }

  #random() {
    return (this.#opts.random ?? Math.random)();
  }
}
