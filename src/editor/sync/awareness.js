// @ts-check
import { encodeAwareness } from "./protocol.js";

/**
 * Presence ("awareness", docs/sync-protocol.md Section 14): who else has a
 * page open, and where their cursor is. It rides on the page's sync socket
 * but isn't part of the document: nothing is stored, and a session's state
 * is just its latest message.
 *
 * - The local state is any JSON value. Changes go out at most every 50 ms
 *   (the last one always goes out), and the state is repeated every 15 s,
 *   so the others know the session is still there.
 * - Remote states expire 30 s after their last message, and are dropped
 *   when the server says a session left, or when our connection drops (on
 *   reconnect the server sends everyone who's there).
 * - Each session numbers its states (`clock`); an older or repeated state
 *   is ignored. The clock keeps counting across reconnects.
 *
 * DOM-free: the provider connects it to the socket (`connect(send)` once
 * synced, `disconnect()` when the socket goes), and timers can be injected,
 * so it runs under `node --test`.
 */

/** @typedef {import("./protocol.js").AwarenessEntry} AwarenessEntry */

/**
 * A remote session's presence.
 * @typedef {object} Peer
 * @property {number} session Its document's client id.
 * @property {string} user Its user id (vouched for by the server).
 * @property {unknown} state Whatever it shares (parsed JSON).
 * @property {number} clock
 * @property {number} seen When its last message arrived (ms).
 */

/**
 * @typedef {object} AwarenessChange
 * @property {number[]} added
 * @property {number[]} updated
 * @property {number[]} removed
 */

export const THROTTLE = 50;
export const HEARTBEAT = 15_000;
export const TIMEOUT = 30_000;
const SWEEP = 5_000;

export class Awareness {
  /** Our session: the document's client id. */
  session;
  /** @type {unknown} */
  #local = null;
  #clock = 0;
  /** @type {Map<number, Peer>} */
  #peers = new Map();
  /** @type {Set<(change: AwarenessChange) => void>} */
  #observers = new Set();
  /** @type {((bytes: Uint8Array) => void) | null} */
  #send = null;
  /** What was last sent, to skip repeats (JSON). @type {string | null} */
  #sent = null;
  #lastSendAt = -Infinity;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #throttleTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #heartbeat;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  #sweep;
  #opts;

  /**
   * @param {number} session
   * @param {{
   *   now?: () => number,
   *   setTimer?: typeof setTimeout,
   *   clearTimer?: typeof clearTimeout,
   *   setRepeat?: typeof setInterval,
   *   clearRepeat?: typeof clearInterval,
   * }} [options]
   */
  constructor(session, options = {}) {
    this.session = session;
    this.#opts = options;
  }

  /** Our state, as last set. */
  get local() {
    return this.#local;
  }

  /** Everyone else who's here, by session. */
  get peers() {
    return /** @type {ReadonlyMap<number, Peer>} */ (this.#peers);
  }

  /** Whether we're connected (our state goes out). */
  get connected() {
    return this.#send !== null;
  }

  /**
   * Set our state. It goes out right away, or at the end of the current
   * 50 ms window.
   * @param {unknown} state
   */
  setLocal(state) {
    this.#local = state;
    this.#schedule();
  }

  /**
   * @param {(change: AwarenessChange) => void} fn
   * @returns {() => void}
   */
  observe(fn) {
    this.#observers.add(fn);
    return () => this.#observers.delete(fn);
  }

  // --- Transport (the provider) ----------------------------------------------

  /**
   * The socket is synced: send our state now, and from now on.
   * @param {(bytes: Uint8Array) => void} send
   */
  connect(send) {
    // Peers that arrived already (before SYNC) stay.
    this.#clearTimers();
    this.#send = send;
    this.#sent = null;
    this.#flush();
    this.#heartbeat = (this.#opts.setRepeat ?? setInterval)(() => {
      this.#sent = null; // repeat even if unchanged
      this.#flush();
    }, HEARTBEAT);
    this.#sweep = (this.#opts.setRepeat ?? setInterval)(() => this.#expire(), SWEEP);
  }

  /** The socket is gone: stop sending, and forget everyone (they're resent on reconnect). */
  disconnect() {
    this.#send = null;
    this.#clearTimers();
    const removed = [...this.#peers.keys()];
    this.#peers.clear();
    this.#emit({ added: [], updated: [], removed });
  }

  /** @param {AwarenessEntry[]} entries From the server. */
  receive(entries) {
    /** @type {AwarenessChange} */
    const change = { added: [], updated: [], removed: [] };
    const now = this.#now();
    for (const e of entries) {
      if (e.session === this.session) continue;
      const known = this.#peers.get(e.session);
      if (e.state === "") {
        if (known) {
          this.#peers.delete(e.session);
          change.removed.push(e.session);
        }
        continue;
      }
      if (known && e.clock <= known.clock) continue;
      let state;
      try {
        state = JSON.parse(e.state);
      } catch {
        continue;
      }
      this.#peers.set(e.session, {
        session: e.session,
        user: e.user,
        state,
        clock: e.clock,
        seen: now,
      });
      (known ? change.updated : change.added).push(e.session);
    }
    this.#emit(change);
  }

  /** Stop for good. The server tells the others we left when the socket closes. */
  destroy() {
    this.disconnect();
    this.#observers.clear();
  }

  // --- Internals ---------------------------------------------------------------

  #schedule() {
    if (!this.#send || this.#throttleTimer !== undefined) return;
    const wait = this.#lastSendAt + THROTTLE - this.#now();
    if (wait <= 0) {
      this.#flush();
      return;
    }
    this.#throttleTimer = (this.#opts.setTimer ?? setTimeout)(() => {
      this.#throttleTimer = undefined;
      this.#flush();
    }, wait);
  }

  #flush() {
    const send = this.#send;
    if (!send || this.#local === null || this.#local === undefined) return;
    const json = JSON.stringify(this.#local);
    if (json === this.#sent) return;
    this.#sent = json;
    this.#lastSendAt = this.#now();
    try {
      send(
        encodeAwareness([{ session: this.session, clock: ++this.#clock, user: "", state: json }]),
      );
    } catch {
      // The socket is closing; the provider disconnects us.
    }
  }

  #expire() {
    const cutoff = this.#now() - TIMEOUT;
    /** @type {number[]} */
    const removed = [];
    for (const [session, peer] of this.#peers) {
      if (peer.seen < cutoff) {
        this.#peers.delete(session);
        removed.push(session);
      }
    }
    this.#emit({ added: [], updated: [], removed });
  }

  /** @param {AwarenessChange} change */
  #emit(change) {
    if (change.added.length + change.updated.length + change.removed.length === 0) return;
    for (const fn of [...this.#observers]) fn(change);
  }

  #clearTimers() {
    if (this.#throttleTimer !== undefined)
      (this.#opts.clearTimer ?? clearTimeout)(this.#throttleTimer);
    if (this.#heartbeat !== undefined) (this.#opts.clearRepeat ?? clearInterval)(this.#heartbeat);
    if (this.#sweep !== undefined) (this.#opts.clearRepeat ?? clearInterval)(this.#sweep);
    this.#throttleTimer = this.#heartbeat = this.#sweep = undefined;
  }

  #now() {
    return (this.#opts.now ?? Date.now)();
  }
}
