// @ts-check
import { Decoder, Encoder } from "../model/encoding.js";

/**
 * The live sync messages (docs/sync-protocol.md, Section 13.2): one binary
 * WebSocket message each, a type byte, then the payload. State vectors and
 * updates are the model's own messages, embedded whole.
 *
 * Pure: shared by the provider, the mock server and the tests.
 */

export const HELLO = 0x01;
export const SYNC = 0x02;
export const UPDATE = 0x03;
export const ACK = 0x04;
export const NOTICE = 0x05;
export const AWARENESS = 0x06;

export const NOTICE_READ_ONLY = 1;
export const NOTICE_GAP = 2;

/** Close codes the server uses (13.4). */
export const CLOSE = Object.freeze({
  restart: 4000,
  ticket: 4001,
  gone: 4004,
  protocol: 4400,
  noHello: 4408,
  tooLarge: 4413,
});

/**
 * @typedef {{ type: "hello", sv: Uint8Array }
 *   | { type: "sync", sv: Uint8Array, update: Uint8Array }
 *   | { type: "update", seq: number, update: Uint8Array }
 *   | { type: "ack", seq: number, sv: Uint8Array }
 *   | { type: "notice", code: number, sv: Uint8Array | null }
 *   | { type: "awareness", entries: AwarenessEntry[] }} Message
 */

/**
 * One session's presence (Section 14): `session` is its document's client
 * id, `clock` counts its states, `user` is filled in by the server (clients
 * send ""), and `state` is JSON, or "" when the session has left.
 * @typedef {{ session: number, clock: number, user: string, state: string }} AwarenessEntry
 */

/** @param {number} type @param {(enc: Encoder) => void} [body] */
function message(type, body) {
  const enc = new Encoder();
  enc.u8(type);
  body?.(enc);
  return enc.finish();
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** @param {Uint8Array} sv */
export const encodeHello = (sv) => concat(message(HELLO), sv);

/** @param {Uint8Array} sv @param {Uint8Array} update */
export const encodeSync = (sv, update) =>
  concat(
    message(SYNC, (enc) => enc.varuint(sv.length)),
    concat(sv, update),
  );

/** @param {number} seq @param {Uint8Array} update */
export const encodeUpdate = (seq, update) =>
  concat(
    message(UPDATE, (enc) => enc.varuint(seq)),
    update,
  );

/** @param {number} seq @param {Uint8Array} sv */
export const encodeAck = (seq, sv) =>
  concat(
    message(ACK, (enc) => enc.varuint(seq)),
    sv,
  );

/** @param {number} code @param {Uint8Array} [sv] */
export const encodeNotice = (code, sv) =>
  concat(
    message(NOTICE, (enc) => enc.u8(code)),
    sv ?? new Uint8Array(),
  );

/** @param {AwarenessEntry[]} entries */
export const encodeAwareness = (entries) =>
  message(AWARENESS, (enc) => {
    enc.varuint(entries.length);
    for (const e of entries) {
      enc.varuint(e.session);
      enc.varuint(e.clock);
      enc.string(e.user);
      enc.string(e.state);
    }
  });

/**
 * @param {Uint8Array} bytes
 * @returns {Message}
 * @throws {RangeError} on a malformed message.
 */
export function decodeMessage(bytes) {
  const dec = new Decoder(bytes);
  const type = dec.u8();
  const rest = () => bytes.subarray(dec.pos);
  switch (type) {
    case HELLO:
      return { type: "hello", sv: rest() };
    case SYNC: {
      const n = dec.varuint();
      if (dec.pos + n > bytes.length) throw new RangeError("SYNC state vector runs past the end");
      const sv = bytes.subarray(dec.pos, dec.pos + n);
      return { type: "sync", sv, update: bytes.subarray(dec.pos + n) };
    }
    case UPDATE:
      return { type: "update", seq: dec.varuint(), update: rest() };
    case ACK:
      return { type: "ack", seq: dec.varuint(), sv: rest() };
    case NOTICE: {
      const code = dec.u8();
      return { type: "notice", code, sv: dec.done ? null : rest() };
    }
    case AWARENESS: {
      const n = dec.varuint();
      /** @type {AwarenessEntry[]} */
      const entries = [];
      for (let i = 0; i < n; i++)
        entries.push({
          session: dec.varuint(),
          clock: dec.varuint(),
          user: dec.string(),
          state: dec.string(),
        });
      if (!dec.done) throw new RangeError("trailing bytes after AWARENESS");
      return { type: "awareness", entries };
    }
    default:
      throw new RangeError(`unknown message type ${type}`);
  }
}
