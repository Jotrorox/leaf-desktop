// @ts-check

import { Doc } from "../../editor/model/doc.js";
import {
  decodeMessage,
  encodeAck,
  encodeAwareness,
  encodeNotice,
  encodeSync,
  encodeUpdate,
  NOTICE_GAP,
  NOTICE_READ_ONLY,
} from "../../editor/sync/protocol.js";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64.js";
import { ApiError } from "../client.js";
import { canEdit } from "../roles.js";
import { MOCK_USER_ID } from "./db.js";

/**
 * The mock backend's live sync (docs/sync-protocol.md, Sections 13 and 14),
 * in process: `connect(pageId)` returns a socket-like object talking to an
 * in-memory room per page. Updates are stored with the mock db's `saveDoc`
 * (so the HTTP routes and the sockets share the document), acknowledged at
 * once, and forwarded to the page's other sockets. Presence is relayed
 * like the real server does it, with the connection's user id filled in.
 *
 * Messages take about half the configured latency each way. With `jitter`,
 * each one takes up to that much longer at random, so messages overtake
 * each other (a stress test for the merge; a real socket keeps its order).
 *
 * `setOffline(true)` drops every socket and refuses new ones, like a lost
 * network. Pure apart from timers: runs under `node --test`.
 */

/** @typedef {import("./db.js").MockDb} MockDb */
/** @typedef {import("../../editor/sync/provider.js").SocketLike} SocketLike */
/** @typedef {import("../../editor/sync/protocol.js").AwarenessEntry} AwarenessEntry */

export { MOCK_USER_ID };

/**
 * @param {{
 *   db: () => MockDb,
 *   latency?: () => number,
 *   jitter?: () => number,
 *   random?: () => number,
 *   offline?: () => boolean,
 *   onWrite?: () => void,
 * }} options
 */
export function createMockSync({
  db,
  latency = () => 0,
  jitter = () => 0,
  random = Math.random,
  offline = () => false,
  onWrite,
}) {
  /** @type {Map<string, Set<ServerSide>>} */
  const rooms = new Map();

  const delay = () => Math.max(0, latency() / 2 + random() * jitter());

  /**
   * The server's end of one socket.
   * @typedef {object} ServerSide
   * @property {string} pageId
   * @property {string} userId
   * @property {(bytes: Uint8Array) => void} send
   * @property {(code: number, reason: string) => void} close
   * @property {boolean} hello
   * @property {boolean} readOnly
   * @property {boolean} presence It takes part in presence (has sent some).
   * @property {number} session Presence: the session it speaks for (0: none yet).
   * @property {number} awClock
   * @property {string} awState
   */

  /** @param {string} pageId */
  function storedDoc(pageId) {
    const { snapshot } = db().getDoc(pageId);
    return snapshot
      ? Doc.fromSnapshot(base64ToBytes(snapshot), { clientId: 1 })
      : new Doc({ clientId: 1 });
  }

  /** @param {ServerSide} from @param {AwarenessEntry} entry */
  function broadcastAwareness(from, entry) {
    const bytes = encodeAwareness([entry]);
    for (const other of rooms.get(from.pageId) ?? [])
      if (other !== from && other.presence) other.send(bytes);
  }

  /**
   * A connection's presence entries (Section 14's rules). Presence only
   * goes to connections that send some; the first one brings everyone here.
   * @param {ServerSide} conn @param {AwarenessEntry[]} entries
   */
  function awareness(conn, entries) {
    if (!conn.presence) {
      conn.presence = true;
      /** @type {AwarenessEntry[]} */
      const present = [];
      for (const other of rooms.get(conn.pageId) ?? []) {
        if (other !== conn && other.session !== 0 && other.awState !== "") {
          present.push({
            session: other.session,
            clock: other.awClock,
            user: other.userId,
            state: other.awState,
          });
        }
      }
      if (present.length > 0) conn.send(encodeAwareness(present));
    }
    for (const e of entries) {
      if (e.session === 0 || e.clock === 0) continue;
      if (conn.session === 0) {
        let taken = false;
        for (const other of rooms.get(conn.pageId) ?? []) {
          if (other === conn || other.session !== e.session) continue;
          if (other.userId !== conn.userId) taken = true;
          else {
            other.session = 0;
            other.awState = "";
          }
        }
        if (taken) continue;
        conn.session = e.session;
      } else if (e.session !== conn.session || e.clock <= conn.awClock) continue;
      conn.awClock = e.clock;
      conn.awState = e.state;
      broadcastAwareness(conn, {
        session: e.session,
        clock: e.clock,
        user: conn.userId,
        state: e.state,
      });
    }
  }

  /** @param {ServerSide} conn */
  function leave(conn) {
    rooms.get(conn.pageId)?.delete(conn);
    if (conn.session !== 0 && conn.awState !== "") {
      broadcastAwareness(conn, {
        session: conn.session,
        clock: conn.awClock + 1,
        user: conn.userId,
        state: "",
      });
    }
    conn.session = 0;
    conn.awState = "";
  }

  /** @param {ServerSide} conn @param {Uint8Array} bytes */
  function receive(conn, bytes) {
    let msg;
    try {
      msg = decodeMessage(bytes);
    } catch {
      conn.close(4400, "bad message");
      return;
    }
    if (!conn.hello) {
      if (msg.type !== "hello") {
        conn.close(4400, "expected hello");
        return;
      }
      conn.hello = true;
      let doc;
      try {
        doc = storedDoc(conn.pageId);
      } catch {
        conn.close(4004, "the page doesn't exist");
        return;
      }
      conn.send(encodeSync(doc.encodeStateVector(), doc.encodeDiff(msg.sv)));
      if (conn.readOnly) conn.send(encodeNotice(NOTICE_READ_ONLY));
      return;
    }
    if (msg.type === "awareness") {
      awareness(conn, msg.entries);
      return;
    }
    if (msg.type !== "update" || msg.seq < 1) {
      conn.close(4400, "expected an update");
      return;
    }
    if (conn.readOnly) return;
    try {
      const { state_vector } = db().saveDoc(conn.pageId, { update: bytesToBase64(msg.update) });
      onWrite?.();
      conn.send(encodeAck(msg.seq, base64ToBytes(state_vector)));
      for (const other of rooms.get(conn.pageId) ?? []) {
        if (other !== conn && other.hello) other.send(encodeUpdate(0, msg.update));
      }
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e?.code === "doc_gap")
        conn.send(encodeNotice(NOTICE_GAP, storedDoc(conn.pageId).encodeStateVector()));
      else if (e?.code === "page_archived" || e?.code === "read_only") {
        conn.readOnly = true;
        conn.send(encodeNotice(NOTICE_READ_ONLY));
      } else if (e?.status === 404) conn.close(4004, "the page doesn't exist");
      else if (e?.code === "doc_too_large") conn.close(4413, "the document is too large");
      else conn.close(4400, "bad update");
    }
  }

  return {
    /**
     * Open a socket to a page, as `POST /v1/ws-ticket` and `new WebSocket` would.
     * @param {string} pageId
     * @param {{ userId?: string, readOnly?: boolean }} [options] Who's connecting (the mock's user by default),
     *   and whether they may only view (besides the page's own role).
     * @returns {Promise<{ socket: SocketLike, readOnly: boolean }>}
     */
    async connect(pageId, { userId = MOCK_USER_ID, readOnly: viewer = false } = {}) {
      await new Promise((r) => setTimeout(r, delay()));
      if (offline())
        throw new ApiError(0, "network_error", "Can't reach the server (mock API is offline)");
      const page = db().getPage(pageId);
      const readOnly = viewer || page.archived_at !== null || !canEdit(page.role);

      /** @type {SocketLike} */
      const socket = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data) {
          if (socket.readyState !== 1) throw new Error("socket isn't open");
          const copy = data.slice();
          setTimeout(() => {
            if (socket.readyState === 1) receive(conn, copy);
          }, delay());
        },
        close(code = 1000, reason = "") {
          if (socket.readyState >= 2) return;
          finish(code, reason);
        },
      };

      /** @param {number} code @param {string} reason */
      const finish = (code, reason) => {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        leave(conn);
        setTimeout(() => socket.onclose?.({ code, reason }), 0);
      };

      /** @type {ServerSide} */
      const conn = {
        pageId,
        userId,
        hello: false,
        readOnly,
        presence: false,
        session: 0,
        awClock: 0,
        awState: "",
        send(bytes) {
          const copy = bytes.slice();
          setTimeout(() => {
            if (socket.readyState === 1) socket.onmessage?.({ data: copy });
          }, delay());
        },
        close(code, reason) {
          setTimeout(() => finish(code, reason), delay());
        },
      };

      let room = rooms.get(pageId);
      if (!room) rooms.set(pageId, (room = new Set()));
      room.add(conn);
      setTimeout(() => {
        if (socket.readyState !== 0) return;
        socket.readyState = 1;
        socket.onopen?.({});
      }, delay());
      return { socket, readOnly };
    },

    /** Drop every socket (going offline) with code 1006, like a dead network. */
    dropAll() {
      for (const room of rooms.values()) for (const conn of [...room]) conn.close(1006, "");
    },

    /**
     * Drop the sockets of one user (or, with `session`, the one speaking
     * for that presence session), like that client losing its network.
     * @param {{ userId?: string, session?: number }} which
     */
    drop(which) {
      for (const room of rooms.values()) {
        for (const conn of [...room]) {
          if (
            (which.userId === undefined || conn.userId === which.userId) &&
            (which.session === undefined || conn.session === which.session)
          ) {
            conn.close(1006, "");
          }
        }
      }
    },

    /** After a trash, restore or delete: open pages in the trash turn read-only, deleted ones close. */
    refresh() {
      for (const [pageId, room] of rooms) {
        let page;
        try {
          page = db().getPage(pageId);
        } catch {
          for (const conn of [...room]) conn.close(4004, "the page was deleted");
          continue;
        }
        if (page.archived_at === null) continue;
        for (const conn of room) {
          if (conn.readOnly) continue;
          conn.readOnly = true;
          conn.send(encodeNotice(NOTICE_READ_ONLY));
        }
      }
    },
  };
}
