// @ts-check
import { Decoder, Encoder } from "./encoding.js";
import { SEQ_CHILDREN, SEQ_ROOT, SEQ_TEXT } from "./sequence.js";

/**
 * Ops, transactions and their wire format (see docs/sync-protocol.md).
 *
 * A transaction is a run of ops by one client with consecutive clocks. Each
 * op uses `opLength(op)` clocks: one per character or placement it inserts,
 * one for everything else. A transaction also names `prev`, the last clock of
 * its author's previous transaction, so a receiver can tell when one is
 * missing.
 */

export const FORMAT_VERSION = 1;

/** Message kinds (second byte). */
export const KIND_UPDATE = 1;
export const KIND_SNAPSHOT = 2;
export const KIND_STATE_VECTOR = 3;

/** Op tags. */
export const OP_NEW_BLOCK = 1;
export const OP_INSERT = 2;
export const OP_DELETE = 3;
export const OP_MARK = 4;
export const OP_SET = 5;

/** Register scopes for OP_SET. */
export const SCOPE_META = 0;
export const SCOPE_ALIVE = 1;
export const SCOPE_TYPE = 2;
export const SCOPE_ATTR = 3;

/** @typedef {import("./ids.js").Id} Id */
/** @typedef {{ client: number, clock: number, len: number }} IdRange */
/** @typedef {{ len: number, marks: Record<string, unknown> }} MarkSpan */
/** @typedef {{ kind: number, block: Id | null }} SeqRef */

/**
 * @typedef {{ t: 1, type: string }} NewBlockOp
 * @typedef {{ t: 2, seq: SeqRef, origin: Id | null, text: string | null, spans: MarkSpan[] | null, blocks: Id[] | null }} InsertOp
 * @typedef {{ t: 3, ranges: IdRange[] }} DeleteOp
 * @typedef {{ t: 4, name: string, value: unknown, ranges: IdRange[] }} MarkOp
 * @typedef {{ t: 5, scope: number, block: Id | null, key: string | null, value: unknown }} SetOp
 * @typedef {NewBlockOp | InsertOp | DeleteOp | MarkOp | SetOp} Op
 */

/**
 * @typedef {object} Txn
 * @property {number} client
 * @property {number} prev Last clock of the author's previous transaction, 0 for the first.
 * @property {number} start Clock of the first op.
 * @property {number} end Last clock used (start + total op length - 1).
 * @property {Op[]} ops
 */

/** @param {Op} op */
export function opLength(op) {
  if (op.t === OP_INSERT)
    return op.text !== null ? op.text.length : /** @type {Id[]} */ (op.blocks).length;
  return 1;
}

/** @param {Op[]} ops */
export function opsLength(ops) {
  let n = 0;
  for (const op of ops) n += opLength(op);
  return n;
}

/**
 * Compress ids into runs of consecutive clocks per client, keeping order.
 *
 * @param {Id[]} ids
 * @returns {IdRange[]}
 */
export function toRanges(ids) {
  /** @type {IdRange[]} */
  const out = [];
  for (const { client, clock } of ids) {
    const last = out[out.length - 1];
    if (last && last.client === client && last.clock + last.len === clock) last.len++;
    else out.push({ client, clock, len: 1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Encoding

/**
 * Collects client ids into the message's client table.
 */
class ClientTable {
  /** @type {Map<number, number>} */
  index = new Map();

  /** @param {number} client */
  add(client) {
    if (!this.index.has(client)) this.index.set(client, 0);
  }

  /** Sort ascending and assign indices. */
  seal() {
    const ids = [...this.index.keys()].sort((a, b) => a - b);
    ids.forEach((id, i) => this.index.set(id, i));
    return ids;
  }

  /** @param {number} client */
  get(client) {
    return /** @type {number} */ (this.index.get(client));
  }
}

/** @param {Txn[]} txns @param {ClientTable} table */
function collectClients(txns, table) {
  for (const txn of txns) {
    table.add(txn.client);
    for (const op of txn.ops) {
      switch (op.t) {
        case OP_INSERT:
          if (op.seq.block) table.add(op.seq.block.client);
          if (op.origin) table.add(op.origin.client);
          if (op.blocks) for (const b of op.blocks) table.add(b.client);
          break;
        case OP_DELETE:
        case OP_MARK:
          for (const r of op.ranges) table.add(r.client);
          break;
        case OP_SET:
          if (op.block) table.add(op.block.client);
          break;
      }
    }
  }
}

/** @param {Encoder} enc @param {ClientTable} table @param {Id} id */
function writeId(enc, table, id) {
  enc.varuint(table.get(id.client));
  enc.varuint(id.clock);
}

/** @param {Encoder} enc @param {ClientTable} table @param {IdRange[]} ranges */
function writeRanges(enc, table, ranges) {
  enc.varuint(ranges.length);
  for (const r of ranges) {
    writeId(enc, table, r);
    enc.varuint(r.len);
  }
}

/** @param {Encoder} enc @param {ClientTable} table @param {Op} op */
function writeOp(enc, table, op) {
  enc.u8(op.t);
  switch (op.t) {
    case OP_NEW_BLOCK:
      enc.string(op.type);
      break;
    case OP_INSERT: {
      enc.u8(op.seq.kind);
      if (op.seq.kind !== SEQ_ROOT) writeId(enc, table, /** @type {Id} */ (op.seq.block));
      if (op.origin) {
        enc.u8(1);
        writeId(enc, table, op.origin);
      } else enc.u8(0);
      if (op.seq.kind === SEQ_TEXT) {
        enc.string(/** @type {string} */ (op.text));
        const spans = op.spans ?? [];
        enc.varuint(spans.length);
        for (const span of spans) {
          enc.varuint(span.len);
          const names = Object.keys(span.marks);
          enc.varuint(names.length);
          for (const name of names) {
            enc.string(name);
            enc.any(span.marks[name]);
          }
        }
      } else {
        const blocks = /** @type {Id[]} */ (op.blocks);
        enc.varuint(blocks.length);
        for (const b of blocks) writeId(enc, table, b);
      }
      break;
    }
    case OP_DELETE:
      writeRanges(enc, table, op.ranges);
      break;
    case OP_MARK:
      enc.string(op.name);
      enc.any(op.value);
      writeRanges(enc, table, op.ranges);
      break;
    case OP_SET:
      enc.u8(op.scope);
      if (op.scope !== SCOPE_META) writeId(enc, table, /** @type {Id} */ (op.block));
      if (op.scope === SCOPE_META || op.scope === SCOPE_ATTR)
        enc.string(/** @type {string} */ (op.key));
      enc.any(op.value);
      break;
  }
}

/**
 * Encode transactions as an update (or snapshot) message, in the given order.
 *
 * @param {Txn[]} txns
 * @param {number} [kind] KIND_UPDATE or KIND_SNAPSHOT
 */
export function encodeTxns(txns, kind = KIND_UPDATE) {
  const enc = new Encoder();
  enc.u8(FORMAT_VERSION);
  enc.u8(kind);
  const table = new ClientTable();
  collectClients(txns, table);
  const clients = table.seal();
  enc.varuint(clients.length);
  for (const c of clients) enc.varuint(c);
  enc.varuint(txns.length);
  for (const txn of txns) {
    enc.varuint(table.get(txn.client));
    enc.varuint(txn.prev);
    enc.varuint(txn.start - txn.prev);
    enc.varuint(txn.ops.length);
    for (const op of txn.ops) writeOp(enc, table, op);
  }
  return enc.finish();
}

// ---------------------------------------------------------------------------
// Decoding

/** @param {Decoder} dec @param {number[]} clients @returns {Id} */
function readId(dec, clients) {
  const i = dec.varuint();
  if (i >= clients.length) throw new RangeError(`client index ${i} out of range`);
  const clock = dec.varuint();
  if (clock === 0) throw new RangeError("clock 0 is reserved");
  return { client: clients[i], clock };
}

/** @param {Decoder} dec @param {number[]} clients @returns {IdRange[]} */
function readRanges(dec, clients) {
  const n = dec.varuint();
  if (n === 0) throw new RangeError("empty range list");
  /** @type {IdRange[]} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const { client, clock } = readId(dec, clients);
    const len = dec.varuint();
    if (len === 0 || !Number.isSafeInteger(clock + len)) throw new RangeError("bad range length");
    out.push({ client, clock, len });
  }
  return out;
}

/** @param {Decoder} dec @param {number[]} clients @returns {Op} */
function readOp(dec, clients) {
  const t = dec.u8();
  switch (t) {
    case OP_NEW_BLOCK:
      return { t, type: dec.string() };
    case OP_INSERT: {
      const kind = dec.u8();
      if (kind !== SEQ_ROOT && kind !== SEQ_TEXT && kind !== SEQ_CHILDREN)
        throw new RangeError(`bad sequence kind ${kind}`);
      const block = kind === SEQ_ROOT ? null : readId(dec, clients);
      const hasOrigin = dec.u8();
      if (hasOrigin > 1) throw new RangeError("bad origin flag");
      const origin = hasOrigin ? readId(dec, clients) : null;
      if (kind === SEQ_TEXT) {
        const text = dec.string();
        if (text.length === 0) throw new RangeError("empty text insert");
        const nSpans = dec.varuint();
        /** @type {MarkSpan[] | null} */
        let spans = null;
        if (nSpans > 0) {
          spans = [];
          let total = 0;
          for (let i = 0; i < nSpans; i++) {
            const len = dec.varuint();
            if (len === 0) throw new RangeError("empty mark span");
            const nMarks = dec.varuint();
            /** @type {Record<string, unknown>} */
            const marks = {};
            for (let j = 0; j < nMarks; j++) {
              const name = dec.string();
              Object.defineProperty(marks, name, {
                value: dec.any(),
                enumerable: true,
                writable: true,
                configurable: true,
              });
            }
            spans.push({ len, marks });
            total += len;
          }
          if (total !== text.length) throw new RangeError("mark spans don't cover the text");
        }
        return { t, seq: { kind, block }, origin, text, spans, blocks: null };
      }
      const n = dec.varuint();
      if (n === 0) throw new RangeError("empty block insert");
      /** @type {Id[]} */
      const blocks = [];
      for (let i = 0; i < n; i++) blocks.push(readId(dec, clients));
      return { t, seq: { kind, block }, origin, text: null, spans: null, blocks };
    }
    case OP_DELETE:
      return { t, ranges: readRanges(dec, clients) };
    case OP_MARK: {
      const name = dec.string();
      const value = dec.any();
      return { t, name, value, ranges: readRanges(dec, clients) };
    }
    case OP_SET: {
      const scope = dec.u8();
      if (scope > SCOPE_ATTR) throw new RangeError(`bad register scope ${scope}`);
      const block = scope === SCOPE_META ? null : readId(dec, clients);
      const key = scope === SCOPE_META || scope === SCOPE_ATTR ? dec.string() : null;
      return { t, scope, block, key, value: dec.any() };
    }
    default:
      throw new RangeError(`unknown op tag ${t}`);
  }
}

/** @param {Decoder} dec */
function readHeader(dec) {
  const version = dec.u8();
  if (version !== FORMAT_VERSION) throw new RangeError(`unsupported format version ${version}`);
  return dec.u8();
}

/**
 * Decode an update or snapshot message. Throws RangeError on malformed input
 * without returning anything partial.
 *
 * @param {Uint8Array} bytes
 * @returns {{ kind: number, txns: Txn[] }}
 */
export function decodeTxns(bytes) {
  const dec = new Decoder(bytes);
  const kind = readHeader(dec);
  if (kind !== KIND_UPDATE && kind !== KIND_SNAPSHOT)
    throw new RangeError(`not an update (kind ${kind})`);
  const nClients = dec.varuint();
  /** @type {number[]} */
  const clients = [];
  for (let i = 0; i < nClients; i++) {
    const c = dec.varuint();
    if (c === 0 || (i > 0 && c <= clients[i - 1]))
      throw new RangeError("client table must be ascending and non-zero");
    clients.push(c);
  }
  const nTxns = dec.varuint();
  /** @type {Txn[]} */
  const txns = [];
  for (let i = 0; i < nTxns; i++) {
    const ci = dec.varuint();
    if (ci >= clients.length) throw new RangeError(`client index ${ci} out of range`);
    const prev = dec.varuint();
    const delta = dec.varuint();
    if (delta === 0) throw new RangeError("transaction must start after prev");
    const start = prev + delta;
    const nOps = dec.varuint();
    if (nOps === 0) throw new RangeError("empty transaction");
    /** @type {Op[]} */
    const ops = [];
    for (let j = 0; j < nOps; j++) ops.push(readOp(dec, clients));
    const end = start + opsLength(ops) - 1;
    if (!Number.isSafeInteger(end)) throw new RangeError("clock overflow");
    txns.push({ client: clients[ci], prev, start, end, ops });
  }
  if (!dec.done) throw new RangeError("trailing bytes after update");
  return { kind, txns };
}

// ---------------------------------------------------------------------------
// State vectors

/**
 * @param {Map<number, number>} sv client → last clock applied
 */
export function encodeStateVector(sv) {
  const enc = new Encoder();
  enc.u8(FORMAT_VERSION);
  enc.u8(KIND_STATE_VECTOR);
  const entries = [...sv].filter(([, clock]) => clock > 0).sort((a, b) => a[0] - b[0]);
  enc.varuint(entries.length);
  for (const [client, clock] of entries) {
    enc.varuint(client);
    enc.varuint(clock);
  }
  return enc.finish();
}

/** @param {Uint8Array} bytes @returns {Map<number, number>} */
export function decodeStateVector(bytes) {
  const dec = new Decoder(bytes);
  const kind = readHeader(dec);
  if (kind !== KIND_STATE_VECTOR) throw new RangeError(`not a state vector (kind ${kind})`);
  const n = dec.varuint();
  /** @type {Map<number, number>} */
  const sv = new Map();
  let last = 0;
  for (let i = 0; i < n; i++) {
    const client = dec.varuint();
    if (client <= last) throw new RangeError("state vector clients must be ascending and non-zero");
    last = client;
    sv.set(client, dec.varuint());
  }
  if (!dec.done) throw new RangeError("trailing bytes after state vector");
  return sv;
}
