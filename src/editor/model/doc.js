// @ts-check
import { valuesEqual } from "./encoding.js";
import { blockKey, createClientId, MAX_CLIENT_ID } from "./ids.js";
import {
  Item,
  newRegister,
  SEQ_CHILDREN,
  SEQ_ROOT,
  SEQ_TEXT,
  Sequence,
  writeRegister,
} from "./sequence.js";
import {
  decodeStateVector,
  decodeTxns,
  encodeStateVector,
  encodeTxns,
  KIND_SNAPSHOT,
  KIND_UPDATE,
  OP_DELETE,
  OP_INSERT,
  OP_MARK,
  OP_NEW_BLOCK,
  OP_SET,
  opLength,
  SCOPE_ALIVE,
  SCOPE_ATTR,
  SCOPE_META,
  SCOPE_TYPE,
  toRanges,
} from "./update.js";

/**
 * One page's document: `meta`, a registry of blocks, and the `root` list.
 * Each block has a type, attrs, rich text and a list of children.
 *
 * State is built only by applying ops, whether they're made here or arrive
 * from a peer, so every replica that has applied the same set of
 * transactions holds the same state (see docs/sync-protocol.md):
 *
 * - **Text and child lists** are RGA sequences (`sequence.js`).
 * - **Marks** are LWW registers per (character, mark name).
 * - **meta, type, attrs and "alive"** are LWW registers.
 * - **The tree.** A block's position is a placement item in some list. A
 *   move inserts a new placement (and tombstones the old ones). To
 *   materialize, every placement ever made is replayed in id order; each one
 *   re-parents its block unless that would put the block inside itself, in
 *   which case it's skipped. So the newest move wins, cycles can't form, and
 *   each block shows up exactly once. A block whose "alive" register is false
 *   is hidden, and so is everything under it.
 *
 * Local changes go through `transact(fn, origin)`; each one becomes a
 * transaction, and observers hear about it once, with the ids of the blocks
 * whose content changed.
 */

/** @typedef {import("./ids.js").Id} Id */
/** @typedef {import("./sequence.js").Register} Register */
/** @typedef {import("./update.js").Op} Op */
/** @typedef {import("./update.js").InsertOp} InsertOp */
/** @typedef {import("./update.js").Txn} Txn */
/** @typedef {import("./update.js").MarkSpan} MarkSpan */

/**
 * @typedef {object} Block
 * @property {string} id
 * @property {number} client
 * @property {number} clock
 * @property {Register} type
 * @property {Register} alive
 * @property {Map<string, Register>} attrs
 * @property {Sequence} text
 * @property {Sequence} children
 * @property {Item[]} placements Every placement of this block, tombstones included.
 */

/** @typedef {{ text: string, marks?: Record<string, unknown> }} TextRun */

/**
 * @typedef {object} BlockJSON
 * @property {string} id
 * @property {string} type
 * @property {Record<string, unknown>} attrs
 * @property {TextRun[]} text
 * @property {string[]} children
 */

/**
 * @typedef {object} DocJSON
 * @property {Record<string, unknown>} meta
 * @property {Record<string, BlockJSON>} blocks Visible blocks only.
 * @property {string[]} root
 */

/**
 * What a register write targets.
 * @typedef {{ scope: number, block: string | null, key: string | null }} RegisterTarget
 */

/**
 * What a local transaction did, in enough detail to invert it. Consumed by
 * `UndoManager`.
 *
 * @typedef {{ kind: "insert", items: Item[] }
 *   | { kind: "delete", entries: { item: Item, content: string, marks: Record<string, unknown> | null }[] }
 *   | { kind: "format", name: string, entries: { item: Item, before: unknown, after: unknown }[] }
 *   | { kind: "set", target: RegisterTarget, before: unknown, after: unknown }
 *   | { kind: "move", block: string, from: Item, to: Item }} ChangeRecord
 */

/**
 * @typedef {object} DocEvent
 * @property {unknown} origin What was passed to `transact` or `applyUpdate`.
 * @property {boolean} local Made on this replica (not applied from an update).
 * @property {Set<string>} changedBlockIds Blocks created, or whose type, attrs, text or marks changed.
 * @property {boolean} structureChanged Placements or alive flags changed: re-read `children()`.
 * @property {boolean} metaChanged
 * @property {ChangeRecord[]} records Local events only; what `UndoManager` needs.
 * @property {Uint8Array | null} update Local events only: the transaction as an update message.
 */

/** @typedef {(event: DocEvent) => void} Observer */

/**
 * @typedef {object} RelativePosition
 * @property {string} block
 * @property {Id | null} item The anchor character; null means the end (assoc >= 0) or the start (assoc < 0).
 * @property {number} assoc >= 0 sticks to the character after the position, < 0 to the one before.
 */

/**
 * @typedef {object} LocalTxn
 * @property {unknown} origin
 * @property {number} prev
 * @property {number} start
 * @property {number} next Clock for the next op.
 * @property {Op[]} ops
 * @property {ChangeRecord[]} records
 */

/** @typedef {{ blocks: Set<string>, structure: boolean, meta: boolean }} Changes */

/** @typedef {{ parent: Map<string, string | null>, chosen: Map<string, Item> }} Tree */

/** Mark names the editor uses. Others are allowed and synced the same way. */
export const MARKS = Object.freeze([
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
  "link",
  "color",
  "mention",
  "math",
]);

/** Replace lone surrogates with U+FFFD so text survives UTF-8 round trips. @param {string} s */
function wellFormed(s) {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/** @param {string} c */
const isHigh = (c) => c >= "\uD800" && c <= "\uDBFF";
/** @param {string} c */
const isLow = (c) => c >= "\uDC00" && c <= "\uDFFF";

/** @param {Item} item */
function marksOf(item) {
  if (item.marks === null) return null;
  /** @type {[string, unknown][]} */
  const entries = [];
  for (const [name, reg] of item.marks) if (reg.value !== null) entries.push([name, reg.value]);
  if (entries.length === 0) return null;
  entries.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(entries);
}

/**
 * Non-null entries of a marks object, or null if there are none.
 * @param {Record<string, unknown> | null | undefined} marks
 */
function cleanMarks(marks) {
  if (!marks) return null;
  /** @type {Record<string, unknown>} */
  const out = {};
  let any = false;
  for (const [k, v] of Object.entries(marks)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
    any = true;
  }
  return any ? out : null;
}

/** @param {(Record<string, unknown> | null)[]} perChar */
function toSpans(perChar) {
  if (perChar.every((m) => m === null)) return null;
  /** @type {MarkSpan[]} */
  const spans = [];
  for (const m of perChar) {
    const last = spans[spans.length - 1];
    const marks = m ?? {};
    if (last && valuesEqual(last.marks, marks)) last.len++;
    else spans.push({ len: 1, marks });
  }
  return spans;
}

export class Doc {
  /** @type {number} */
  clientId;

  #clock = 0;
  /** client → last clock applied. @type {Map<number, number>} */
  #sv = new Map();
  /** client → its transactions in order. @type {Map<number, Txn[]>} */
  #log = new Map();
  /** client → prev → a transaction waiting for its predecessor or dependencies. @type {Map<number, Map<number, Txn>>} */
  #pending = new Map();
  /** @type {Map<number, Map<number, Item>>} */
  #items = new Map();
  /** @type {Map<string, Block>} */
  #blocks = new Map();
  #root = new Sequence(SEQ_ROOT, null);
  /** @type {Map<string, Register>} */
  #meta = new Map();
  /** Every placement item, sorted by id. @type {Item[]} */
  #placements = [];
  /** @type {Tree | null} */
  #tree = null;
  /** @type {Set<Observer>} */
  #observers = new Set();
  /** @type {LocalTxn | null} */
  #local = null;
  #recording = true;
  /** @type {Changes} */
  #changes = { blocks: new Set(), structure: false, meta: false };

  /** @param {{ clientId?: number }} [options] */
  constructor(options = {}) {
    const id = options.clientId ?? createClientId();
    if (!Number.isSafeInteger(id) || id < 1 || id > MAX_CLIENT_ID)
      throw new RangeError(`bad client id ${id}`);
    this.clientId = id;
  }

  /** The Lamport clock: the largest clock this replica has seen or used. */
  get clock() {
    return this.#clock;
  }

  /** How many received transactions are waiting for missing predecessors. */
  get pendingCount() {
    let n = 0;
    for (const m of this.#pending.values()) n += m.size;
    return n;
  }

  // -------------------------------------------------------------------------
  // Observers and transactions

  /** @param {Observer} fn @returns {() => void} unsubscribe */
  observe(fn) {
    this.#observers.add(fn);
    return () => this.#observers.delete(fn);
  }

  /**
   * Run `fn`, grouping every change it makes into one transaction. Nested
   * calls join the outer transaction. If `fn` throws, the ops it already
   * made stay applied (and are committed), then the error propagates.
   *
   * @template T
   * @param {() => T} fn
   * @param {unknown} [origin]
   * @returns {T}
   */
  transact(fn, origin = null) {
    if (this.#local !== null) return fn();
    const prev = this.#sv.get(this.clientId) ?? 0;
    const start = this.#clock + 1;
    this.#local = { origin, prev, start, next: start, ops: [], records: [] };
    try {
      return fn();
    } finally {
      this.#commitLocal();
    }
  }

  #commitLocal() {
    const L = /** @type {LocalTxn} */ (this.#local);
    this.#local = null;
    if (L.ops.length === 0) return;
    /** @type {Txn} */
    const txn = {
      client: this.clientId,
      prev: L.prev,
      start: L.start,
      end: L.next - 1,
      ops: L.ops,
    };
    this.#appendLog(txn);
    this.#emit(L.origin, true, L.records, txn);
  }

  /** Placements or alive flags changed: drop the materialized tree. */
  #structureChanged() {
    this.#changes.structure = true;
    this.#tree = null;
  }

  /** @param {Txn} txn */
  #appendLog(txn) {
    let list = this.#log.get(txn.client);
    if (!list) this.#log.set(txn.client, (list = []));
    list.push(txn);
    this.#sv.set(txn.client, txn.end);
    if (txn.end > this.#clock) this.#clock = txn.end;
  }

  /**
   * @param {unknown} origin
   * @param {boolean} local
   * @param {ChangeRecord[]} records
   * @param {Txn | null} txn
   */
  #emit(origin, local, records, txn) {
    const c = this.#changes;
    this.#changes = { blocks: new Set(), structure: false, meta: false };
    if (!local && c.blocks.size === 0 && !c.structure && !c.meta) return;
    /** @type {Uint8Array | null} */
    let update = null;
    /** @type {DocEvent} */
    const event = {
      origin,
      local,
      changedBlockIds: c.blocks,
      structureChanged: c.structure,
      metaChanged: c.meta,
      records,
      get update() {
        if (update === null && txn !== null) update = encodeTxns([txn]);
        return update;
      },
    };
    /** @type {unknown[]} */
    const errors = [];
    for (const fn of [...this.#observers]) {
      try {
        fn(event);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "observers threw");
  }

  /**
   * Run `fn` inside a transaction (joining the current one if any).
   * @template T @param {() => T} fn @returns {T}
   */
  #auto(fn) {
    return this.#local !== null ? fn() : this.transact(fn, null);
  }

  /**
   * Apply a new local op and add it to the current transaction.
   * @param {Op} op @returns {number} the op's first clock
   */
  #push(op) {
    // Peers decode text from UTF-8, where a lone surrogate becomes U+FFFD, so
    // apply exactly that here too. (The edit API never splits a pair; undo
    // restoring half of one is the only way to get here with one.)
    if (op.t === OP_INSERT && op.text !== null) op = { ...op, text: wellFormed(op.text) };
    const L = /** @type {LocalTxn} */ (this.#local);
    const clock = L.next;
    L.next += opLength(op);
    this.#clock = L.next - 1;
    this.#applyOp(op, this.clientId, clock);
    L.ops.push(op);
    return clock;
  }

  /** @param {ChangeRecord} rec */
  #record(rec) {
    if (this.#recording && this.#local !== null) this.#local.records.push(rec);
  }

  // -------------------------------------------------------------------------
  // Applying ops (shared by local and remote paths)

  /** @param {Id} id */
  #item(id) {
    return this.#items.get(id.client)?.get(id.clock);
  }

  /** @param {Item} item */
  #addItem(item) {
    let m = this.#items.get(item.client);
    if (!m) this.#items.set(item.client, (m = new Map()));
    m.set(item.clock, item);
  }

  /** @param {Id} id */
  #blockById(id) {
    return this.#blocks.get(blockKey(id.client, id.clock));
  }

  /**
   * @param {Op} op
   * @param {number} client
   * @param {number} clock
   */
  #applyOp(op, client, clock) {
    switch (op.t) {
      case OP_NEW_BLOCK:
        this.#applyNewBlock(op.type, client, clock);
        break;
      case OP_INSERT:
        this.#applyInsert(op, client, clock);
        break;
      case OP_DELETE:
        for (const r of op.ranges) {
          for (let k = 0; k < r.len; k++) {
            const item = this.#item({ client: r.client, clock: r.clock + k });
            if (!item || !item.seq.delete(item)) continue;
            if (item.seq.kind === SEQ_TEXT)
              this.#changes.blocks.add(/** @type {Block} */ (item.seq.owner).id);
            else this.#structureChanged();
          }
        }
        break;
      case OP_MARK:
        for (const r of op.ranges) {
          for (let k = 0; k < r.len; k++) {
            const item = this.#item({ client: r.client, clock: r.clock + k });
            if (!item || item.seq.kind !== SEQ_TEXT) continue;
            if (item.marks === null) item.marks = new Map();
            let reg = item.marks.get(op.name);
            if (!reg) item.marks.set(op.name, (reg = newRegister()));
            if (writeRegister(reg, op.value, client, clock))
              this.#changes.blocks.add(/** @type {Block} */ (item.seq.owner).id);
          }
        }
        break;
      case OP_SET:
        this.#applySet(op.scope, op.block, op.key, op.value, client, clock);
        break;
    }
  }

  /** @param {string} type @param {number} client @param {number} clock */
  #applyNewBlock(type, client, clock) {
    const id = blockKey(client, clock);
    if (this.#blocks.has(id)) return;
    /** @type {Block} */
    const block = {
      id,
      client,
      clock,
      type: { value: type, client, clock },
      alive: { value: true, client, clock },
      attrs: new Map(),
      text: /** @type {any} */ (null),
      children: /** @type {any} */ (null),
      placements: [],
    };
    block.text = new Sequence(SEQ_TEXT, block);
    block.children = new Sequence(SEQ_CHILDREN, block);
    this.#blocks.set(id, block);
    this.#changes.blocks.add(id);
    this.#structureChanged();
  }

  /** @param {InsertOp} op @param {number} client @param {number} clock */
  #applyInsert(op, client, clock) {
    /** @type {Sequence | undefined} */
    let seq;
    if (op.seq.kind === SEQ_ROOT) seq = this.#root;
    else {
      const owner = op.seq.block ? this.#blockById(op.seq.block) : undefined;
      seq = owner && (op.seq.kind === SEQ_TEXT ? owner.text : owner.children);
    }
    // Ops that reference something that doesn't exist, or is in another list,
    // are malformed; every replica ignores them the same way.
    if (!seq) return;
    /** @type {Item | null} */
    let origin = null;
    if (op.origin) {
      origin = this.#item(op.origin) ?? null;
      if (origin === null || origin.seq !== seq) return;
    }
    if (seq.kind === SEQ_TEXT) {
      if (op.text === null) return;
      const block = /** @type {Block} */ (seq.owner);
      let spanIndex = 0;
      let spanLeft = op.spans ? op.spans[0].len : 0;
      for (let i = 0; i < op.text.length; i++) {
        const item = new Item(client, clock + i, seq, origin, op.text[i]);
        if (op.spans) {
          while (spanLeft === 0) spanLeft = op.spans[++spanIndex].len;
          spanLeft--;
          const marks = op.spans[spanIndex].marks;
          for (const name in marks) {
            if (marks[name] === null) continue;
            if (item.marks === null) item.marks = new Map();
            // Initial marks are stamped with the character's own id.
            item.marks.set(name, { value: marks[name], client, clock: clock + i });
          }
        }
        seq.integrate(item);
        this.#addItem(item);
        origin = item;
      }
      this.#changes.blocks.add(block.id);
    } else {
      if (op.blocks === null) return;
      for (let i = 0; i < op.blocks.length; i++) {
        const block = this.#blockById(op.blocks[i]);
        if (!block) continue;
        const item = new Item(client, clock + i, seq, origin, block.id);
        seq.integrate(item);
        this.#addItem(item);
        block.placements.push(item);
        this.#addPlacement(item);
        origin = item;
      }
      this.#structureChanged();
    }
  }

  /** Insert into #placements, keeping id order. @param {Item} item */
  #addPlacement(item) {
    const list = this.#placements;
    let i = list.length;
    while (i > 0) {
      const p = list[i - 1];
      if (p.clock < item.clock || (p.clock === item.clock && p.client < item.client)) break;
      i--;
    }
    list.splice(i, 0, item);
  }

  /**
   * @param {number} scope
   * @param {Id | null} blockId
   * @param {string | null} key
   * @param {unknown} value
   * @param {number} client
   * @param {number} clock
   */
  #applySet(scope, blockId, key, value, client, clock) {
    if (scope === SCOPE_META) {
      const k = /** @type {string} */ (key);
      let reg = this.#meta.get(k);
      if (!reg) this.#meta.set(k, (reg = newRegister()));
      if (writeRegister(reg, value, client, clock)) this.#changes.meta = true;
      return;
    }
    const block = blockId ? this.#blockById(blockId) : undefined;
    if (!block) return;
    if (scope === SCOPE_ALIVE) {
      if (writeRegister(block.alive, value, client, clock)) this.#structureChanged();
    } else if (scope === SCOPE_TYPE) {
      if (writeRegister(block.type, value, client, clock)) this.#changes.blocks.add(block.id);
    } else {
      const k = /** @type {string} */ (key);
      let reg = block.attrs.get(k);
      if (!reg) block.attrs.set(k, (reg = newRegister()));
      if (writeRegister(reg, value, client, clock)) this.#changes.blocks.add(block.id);
    }
  }

  // -------------------------------------------------------------------------
  // Remote transactions

  /**
   * Apply an update or snapshot message. Idempotent; transactions that
   * arrive before their predecessors or dependencies wait until those
   * arrive. Throws RangeError on malformed bytes (nothing is applied then).
   *
   * @param {Uint8Array} bytes
   * @param {unknown} [origin]
   */
  applyUpdate(bytes, origin = "remote") {
    if (this.#local !== null) throw new Error("can't apply an update inside a transaction");
    const { txns } = decodeTxns(bytes);
    for (const txn of txns) this.#enqueue(txn);
    this.#drain();
    this.#emit(origin, false, [], null);
  }

  /** @param {Txn} txn */
  #enqueue(txn) {
    const have = this.#sv.get(txn.client) ?? 0;
    // Already applied, or inconsistent with what was applied (which only a
    // client id collision could cause): drop.
    if (txn.prev < have) return;
    let m = this.#pending.get(txn.client);
    if (!m) this.#pending.set(txn.client, (m = new Map()));
    if (!m.has(txn.prev)) m.set(txn.prev, txn);
  }

  #drain() {
    let progress = true;
    while (progress) {
      progress = false;
      for (const [client, m] of this.#pending) {
        for (;;) {
          const have = this.#sv.get(client) ?? 0;
          const txn = m.get(have);
          if (!txn || !this.#ready(txn)) break;
          m.delete(have);
          this.#applyTxn(txn);
          progress = true;
        }
        const have = this.#sv.get(client) ?? 0;
        for (const prev of m.keys()) if (prev < have) m.delete(prev);
        if (m.size === 0) this.#pending.delete(client);
      }
    }
  }

  /**
   * Whether every id the transaction references has been applied (or is an
   * earlier op of the same transaction).
   *
   * @param {Txn} txn
   */
  #ready(txn) {
    let clock = txn.start;
    /** @param {number} c @param {number} k */
    const has = (c, k) =>
      c === txn.client
        ? k <= txn.prev || (k >= txn.start && k < clock)
        : (this.#sv.get(c) ?? 0) >= k;
    for (const op of txn.ops) {
      switch (op.t) {
        case OP_INSERT:
          if (op.seq.block && !has(op.seq.block.client, op.seq.block.clock)) return false;
          if (op.origin && !has(op.origin.client, op.origin.clock)) return false;
          if (op.blocks) for (const b of op.blocks) if (!has(b.client, b.clock)) return false;
          break;
        case OP_DELETE:
        case OP_MARK:
          for (const r of op.ranges) if (!has(r.client, r.clock + r.len - 1)) return false;
          break;
        case OP_SET:
          if (op.block && !has(op.block.client, op.block.clock)) return false;
          break;
      }
      clock += opLength(op);
    }
    return true;
  }

  /** @param {Txn} txn */
  #applyTxn(txn) {
    let clock = txn.start;
    for (const op of txn.ops) {
      this.#applyOp(op, txn.client, clock);
      clock += opLength(op);
    }
    this.#appendLog(txn);
  }

  // -------------------------------------------------------------------------
  // Sync

  /** client → last clock applied. */
  stateVector() {
    return new Map(this.#sv);
  }

  encodeStateVector() {
    return encodeStateVector(this.#sv);
  }

  /**
   * Every transaction the holder of `sv` is missing, as an update message,
   * in Lamport order (so it applies without buffering).
   *
   * @param {Map<number, number> | Uint8Array} [sv] Empty means everything.
   */
  encodeDiff(sv = new Map()) {
    const remote = sv instanceof Uint8Array ? decodeStateVector(sv) : sv;
    return encodeTxns(this.#txnsAfter(remote), KIND_UPDATE);
  }

  /** The whole document. Load with `Doc.fromSnapshot`. */
  encodeSnapshot() {
    return encodeTxns(this.#txnsAfter(new Map()), KIND_SNAPSHOT);
  }

  /**
   * A new replica holding a snapshot's state, with its own client id.
   *
   * @param {Uint8Array} bytes
   * @param {{ clientId?: number }} [options]
   */
  static fromSnapshot(bytes, options = {}) {
    const doc = new Doc(options);
    doc.applyUpdate(bytes, "snapshot");
    if (doc.pendingCount > 0)
      throw new RangeError("snapshot is incomplete: some transactions have missing dependencies");
    return doc;
  }

  /** @param {Map<number, number>} sv */
  #txnsAfter(sv) {
    /** @type {Txn[]} */
    const out = [];
    for (const [client, list] of this.#log) {
      const have = sv.get(client) ?? 0;
      // First transaction ending after `have` (binary search).
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (list[mid].end <= have) lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < list.length; i++) out.push(list[i]);
    }
    out.sort((a, b) => a.start - b.start || a.client - b.client);
    return out;
  }

  // -------------------------------------------------------------------------
  // Reading

  /** @param {string} id */
  #mustBlock(id) {
    const block = this.#blocks.get(id);
    if (!block) throw new Error(`no block ${id}`);
    return block;
  }

  /** Whether a block with this id exists (visible or not). @param {string} id */
  hasBlock(id) {
    return this.#blocks.has(id);
  }

  #getTree() {
    if (this.#tree === null) this.#tree = this.#computeTree();
    return this.#tree;
  }

  /** Replay every placement in id order, skipping ones that would make a cycle. */
  #computeTree() {
    /** @type {Map<string, string | null>} */
    const parent = new Map();
    /** @type {Map<string, Item>} */
    const chosen = new Map();
    for (const p of this.#placements) {
      const block = p.content;
      const target = p.seq.owner ? p.seq.owner.id : null;
      let cycle = false;
      for (
        let a = /** @type {string | null | undefined} */ (target);
        a !== null && a !== undefined;
        a = parent.get(a)
      ) {
        if (a === block) {
          cycle = true;
          break;
        }
      }
      if (cycle) continue;
      parent.set(block, target);
      chosen.set(block, p);
    }
    return { parent, chosen };
  }

  /**
   * The visible children of a block (or of the root, for null), in order.
   *
   * @param {string | null} [parentId]
   * @returns {string[]}
   */
  children(parentId = null) {
    const seq = parentId === null ? this.#root : this.#mustBlock(parentId).children;
    const { chosen } = this.#getTree();
    /** @type {string[]} */
    const out = [];
    for (let it = seq.head.next; it !== null; it = it.next) {
      if (
        chosen.get(it.content) === it &&
        /** @type {Block} */ (this.#blocks.get(it.content)).alive.value === true
      ) {
        out.push(it.content);
      }
    }
    return out;
  }

  /** The top-level blocks. */
  root() {
    return this.children(null);
  }

  /**
   * A block's parent id (null for top level), or undefined if it has none.
   * @param {string} id
   */
  parentOf(id) {
    return this.#getTree().parent.get(id);
  }

  /** Alive, and every ancestor alive. @param {string} id */
  isVisible(id) {
    const { parent } = this.#getTree();
    /** @type {string | null | undefined} */
    let a = id;
    while (typeof a === "string") {
      const block = this.#blocks.get(a);
      if (!block || block.alive.value !== true) return false;
      a = parent.get(a);
    }
    return a === null;
  }

  /** Visible block ids in document order (depth first). */
  visibleBlockIds() {
    /** @type {string[]} */
    const out = [];
    /** @param {string | null} id */
    const walk = (id) => {
      for (const child of this.children(id)) {
        out.push(child);
        walk(child);
      }
    };
    walk(null);
    return out;
  }

  /** @param {string} id */
  getType(id) {
    return /** @type {string} */ (this.#mustBlock(id).type.value);
  }

  /** @param {string} id @returns {Record<string, unknown>} */
  getAttrs(id) {
    /** @type {Record<string, unknown>} */
    const out = {};
    const keys = [...this.#mustBlock(id).attrs]
      .filter(([, r]) => r.value !== null)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [k, r] of keys) out[k] = r.value;
    return out;
  }

  /** @param {string} id */
  getText(id) {
    return this.#mustBlock(id).text.toString();
  }

  /** Length of a block's text in UTF-16 code units. @param {string} id */
  textLength(id) {
    return this.#mustBlock(id).text.length;
  }

  /**
   * The text as runs of equally marked characters.
   *
   * @param {string} id
   * @returns {TextRun[]}
   */
  getTextRuns(id) {
    /** @type {TextRun[]} */
    const runs = [];
    let key = "\0";
    /** @type {string[]} */
    let chars = [];
    /** @type {Record<string, unknown> | null} */
    let marks = null;
    const flush = () => {
      if (chars.length === 0) return;
      runs.push(marks ? { text: chars.join(""), marks } : { text: chars.join("") });
      chars = [];
    };
    for (const it of this.#mustBlock(id).text.items()) {
      if (it.deleted) continue;
      const m = marksOf(it);
      const k = m ? JSON.stringify(m) : "";
      if (k !== key) {
        flush();
        key = k;
        marks = m;
      }
      chars.push(it.content);
    }
    flush();
    return runs;
  }

  /**
   * @param {string} [key]
   * @returns {unknown} One value, or all meta as an object when no key is given.
   */
  getMeta(key) {
    if (key !== undefined) return this.#meta.get(key)?.value ?? null;
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, r] of [...this.#meta].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
      if (r.value !== null) out[k] = r.value;
    return out;
  }

  /** @param {string} id @returns {BlockJSON} */
  getBlock(id) {
    return {
      id,
      type: this.getType(id),
      attrs: this.getAttrs(id),
      text: this.getTextRuns(id),
      children: this.children(id),
    };
  }

  /** The materialized document: meta, root and every visible block. @returns {DocJSON} */
  toJSON() {
    /** @type {Record<string, BlockJSON>} */
    const blocks = {};
    for (const id of this.visibleBlockIds()) blocks[id] = this.getBlock(id);
    return {
      meta: /** @type {Record<string, unknown>} */ (this.getMeta()),
      blocks,
      root: this.root(),
    };
  }

  // -------------------------------------------------------------------------
  // Local edits. Each one joins the current transaction, or makes its own.

  /** @param {Block} block */
  #textRef(block) {
    return { kind: SEQ_TEXT, block: { client: block.client, clock: block.clock } };
  }

  /** @param {string | null} parent */
  #childrenRef(parent) {
    if (parent === null) return { kind: SEQ_ROOT, block: null };
    const b = this.#mustBlock(parent);
    return { kind: SEQ_CHILDREN, block: { client: b.client, clock: b.clock } };
  }

  /** @param {Sequence} seq @param {number} offset @param {string} name */
  #checkOffset(seq, offset, name = "offset") {
    if (!Number.isInteger(offset) || offset < 0 || offset > seq.length) {
      throw new RangeError(`${name} ${offset} out of range 0..${seq.length}`);
    }
  }

  /** Whether `offset` falls inside a surrogate pair. @param {Sequence} seq @param {number} offset */
  #splitsPair(seq, offset) {
    if (offset <= 0 || offset >= seq.length) return false;
    return (
      isHigh(/** @type {Item} */ (seq.itemAt(offset - 1)).content) &&
      isLow(/** @type {Item} */ (seq.itemAt(offset)).content)
    );
  }

  /**
   * The visible items in [offset, offset + length), widened so no surrogate
   * pair is split.
   *
   * @param {Sequence} seq @param {number} offset @param {number} length
   */
  #range(seq, offset, length) {
    this.#checkOffset(seq, offset);
    if (!Number.isInteger(length) || length < 0 || offset + length > seq.length) {
      throw new RangeError(
        `length ${length} out of range at ${offset} (text length ${seq.length})`,
      );
    }
    let end = offset + length;
    if (length > 0) {
      if (this.#splitsPair(seq, offset)) offset--;
      if (this.#splitsPair(seq, end)) end++;
    }
    /** @type {Item[]} */
    const items = [];
    if (end > offset) {
      let it = /** @type {Item | null} */ (seq.itemAt(offset));
      while (items.length < end - offset && it !== null) {
        if (!it.deleted) items.push(it);
        it = it.next;
      }
    }
    return { offset, items };
  }

  /**
   * Insert text at a UTF-16 offset. An offset inside a surrogate pair moves
   * to before the pair.
   *
   * @param {string} blockId
   * @param {number} offset
   * @param {string} text
   * @param {Record<string, unknown> | null} [marks] Marks for the new text (null values ignored).
   */
  insertText(blockId, offset, text, marks = null) {
    const block = this.#mustBlock(blockId);
    const seq = block.text;
    this.#checkOffset(seq, offset);
    text = wellFormed(String(text));
    if (text.length === 0) return;
    if (this.#splitsPair(seq, offset)) offset--;
    const clean = cleanMarks(marks);
    this.#auto(() => {
      const origin = offset === 0 ? null : /** @type {Item} */ (seq.itemAt(offset - 1));
      const clock = this.#push({
        t: OP_INSERT,
        seq: this.#textRef(block),
        origin: origin && { client: origin.client, clock: origin.clock },
        text,
        spans: clean ? [{ len: text.length, marks: clean }] : null,
        blocks: null,
      });
      /** @type {Item[]} */
      const items = [];
      for (let i = 0; i < text.length; i++)
        items.push(/** @type {Item} */ (this.#item({ client: this.clientId, clock: clock + i })));
      seq.cache = { item: items[items.length - 1], index: offset + text.length - 1 };
      this.#record({ kind: "insert", items });
    });
  }

  /**
   * Delete `length` UTF-16 code units at `offset` (widened to whole
   * surrogate pairs).
   *
   * @param {string} blockId @param {number} offset @param {number} length
   */
  deleteText(blockId, offset, length) {
    const seq = this.#mustBlock(blockId).text;
    const range = this.#range(seq, offset, length);
    if (range.items.length === 0) return;
    const before = range.offset > 0 ? seq.itemAt(range.offset - 1) : null;
    this.#auto(() => this.#deleteItems(range.items));
    if (before !== null) seq.cache = { item: before, index: range.offset - 1 };
  }

  /**
   * Set a mark on a range; null removes it.
   *
   * @param {string} blockId @param {number} offset @param {number} length
   * @param {string} name @param {unknown} value
   */
  format(blockId, offset, length, name, value) {
    if (typeof name !== "string" || name === "")
      throw new TypeError("mark name must be a non-empty string");
    const seq = this.#mustBlock(blockId).text;
    const { items } = this.#range(seq, offset, length);
    if (items.length === 0) return;
    const v = value === undefined ? null : value;
    this.#auto(() =>
      this.#formatItems(
        name,
        items.map((item) => ({ item, value: v })),
      ),
    );
  }

  /** @param {string} blockId @param {string} key @param {unknown} value null removes it. */
  setAttr(blockId, key, value) {
    if (typeof key !== "string") throw new TypeError("attr key must be a string");
    this.#mustBlock(blockId);
    this.#auto(() => this.#setRegister({ scope: SCOPE_ATTR, block: blockId, key }, value ?? null));
  }

  /** @param {string} blockId @param {string} type */
  setType(blockId, type) {
    if (typeof type !== "string" || type === "")
      throw new TypeError("block type must be a non-empty string");
    this.#mustBlock(blockId);
    this.#auto(() => this.#setRegister({ scope: SCOPE_TYPE, block: blockId, key: null }, type));
  }

  /** @param {string} key @param {unknown} value null removes it. */
  setMeta(key, value) {
    if (typeof key !== "string") throw new TypeError("meta key must be a string");
    this.#auto(() => this.#setRegister({ scope: SCOPE_META, block: null, key }, value ?? null));
  }

  /**
   * The placement to insert after, for a new position in `parent`.
   *
   * @param {string | null} parent
   * @param {string | null | undefined} after A visible child of `parent`; null for the start; undefined for the end.
   * @returns {Item | null}
   */
  #originFor(parent, after) {
    const { chosen } = this.#getTree();
    const seq = parent === null ? this.#root : this.#mustBlock(parent).children;
    if (after === undefined) {
      const kids = this.children(parent);
      return kids.length ? /** @type {Item} */ (chosen.get(kids[kids.length - 1])) : null;
    }
    if (after === null) return null;
    const p = chosen.get(after);
    if (!p || p.seq !== seq)
      throw new Error(`block ${after} is not a child of ${parent ?? "the root"}`);
    return p;
  }

  /**
   * Create a block. Returns its id.
   *
   * @param {object} spec
   * @param {string} spec.type
   * @param {string | null} [spec.parent] null for the top level.
   * @param {string | null} [spec.after] Sibling to insert after; null for first; omitted for last.
   * @param {Record<string, unknown>} [spec.attrs]
   * @param {string} [spec.text]
   * @param {Record<string, unknown>} [spec.marks] Marks for `text`.
   * @returns {string}
   */
  insertBlock({ type, parent = null, after, attrs, text, marks }) {
    if (typeof type !== "string" || type === "")
      throw new TypeError("block type must be a non-empty string");
    const origin = this.#originFor(parent, after);
    const ref = this.#childrenRef(parent);
    return this.#auto(() => {
      const clock = this.#push({ t: OP_NEW_BLOCK, type });
      const id = blockKey(this.clientId, clock);
      this.#push({
        t: OP_INSERT,
        seq: ref,
        origin: origin && { client: origin.client, clock: origin.clock },
        text: null,
        spans: null,
        blocks: [{ client: this.clientId, clock }],
      });
      // The block's initial content isn't recorded for undo: undoing the
      // creation only clears "alive", which hides all of it.
      const recording = this.#recording;
      this.#recording = false;
      try {
        for (const [k, v] of Object.entries(attrs ?? {})) {
          if (v !== null && v !== undefined)
            this.#setRegister({ scope: SCOPE_ATTR, block: id, key: k }, v);
        }
        if (text) this.insertText(id, 0, text, marks);
      } finally {
        this.#recording = recording;
      }
      this.#record({
        kind: "set",
        target: { scope: SCOPE_ALIVE, block: id, key: null },
        before: false,
        after: true,
      });
      return id;
    });
  }

  /** Hide a block and everything under it. @param {string} id */
  deleteBlock(id) {
    const block = this.#mustBlock(id);
    if (block.alive.value !== true) return;
    this.#auto(() => this.#setRegister({ scope: SCOPE_ALIVE, block: id, key: null }, false));
  }

  /**
   * Move a block (with its subtree). Throws if `parent` is the block itself
   * or inside it.
   *
   * @param {string} id
   * @param {{ parent?: string | null, after?: string | null }} to `after` as in `insertBlock`.
   */
  moveBlock(id, { parent = null, after }) {
    this.#mustBlock(id);
    const { parent: parents } = this.#getTree();
    for (
      let a = /** @type {string | null | undefined} */ (parent);
      a !== null && a !== undefined;
      a = parents.get(a)
    ) {
      if (a === id) throw new Error(`can't move block ${id} into itself`);
    }
    const origin = this.#originFor(parent, after);
    const seq = parent === null ? this.#root : this.#mustBlock(parent).children;
    this.#auto(() => this.#placeBlock(id, seq, origin));
  }

  /**
   * Tombstone a block's live placements and insert a new one after `origin`.
   *
   * @param {string} id @param {Sequence} seq @param {Item | null} origin
   */
  #placeBlock(id, seq, origin) {
    const block = this.#mustBlock(id);
    const from = this.#getTree().chosen.get(id);
    const live = block.placements.filter((p) => !p.deleted);
    if (live.length) this.#push({ t: OP_DELETE, ranges: toRanges(live) });
    const clock = this.#push({
      t: OP_INSERT,
      seq: seq.owner
        ? { kind: SEQ_CHILDREN, block: { client: seq.owner.client, clock: seq.owner.clock } }
        : { kind: SEQ_ROOT, block: null },
      origin: origin && { client: origin.client, clock: origin.clock },
      text: null,
      spans: null,
      blocks: [{ client: block.client, clock: block.clock }],
    });
    const to = /** @type {Item} */ (this.#item({ client: this.clientId, clock }));
    if (from) this.#record({ kind: "move", block: id, from, to });
    return to;
  }

  /** @param {Item[]} items Visible text items. */
  #deleteItems(items) {
    const live = items.filter((it) => !it.deleted && it.seq.kind === SEQ_TEXT);
    if (live.length === 0) return;
    const entries = live.map((item) => ({ item, content: item.content, marks: marksOf(item) }));
    this.#push({ t: OP_DELETE, ranges: toRanges(live) });
    this.#record({ kind: "delete", entries });
  }

  /**
   * @param {string} name
   * @param {{ item: Item, value: unknown }[]} entries
   */
  #formatItems(name, entries) {
    /** @type {Map<string, { value: unknown, items: Item[] }>} */
    const groups = new Map();
    /** @type {{ item: Item, before: unknown, after: unknown }[]} */
    const changes = [];
    for (const { item, value } of entries) {
      const before = item.marks?.get(name)?.value ?? null;
      if (!valuesEqual(before, value)) changes.push({ item, before, after: value });
      const key = JSON.stringify(value);
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { value, items: [] }));
      g.items.push(item);
    }
    for (const g of groups.values())
      this.#push({ t: OP_MARK, name, value: g.value, ranges: toRanges(g.items) });
    if (changes.length) this.#record({ kind: "format", name, entries: changes });
  }

  /** @param {RegisterTarget} target @param {unknown} value */
  #setRegister(target, value) {
    const before = this._register(target)?.value ?? null;
    const b = target.block !== null ? this.#mustBlock(target.block) : null;
    this.#push({
      t: OP_SET,
      scope: target.scope,
      block: b && { client: b.client, clock: b.clock },
      key: target.key,
      value,
    });
    if (!valuesEqual(before, value)) this.#record({ kind: "set", target, before, after: value });
  }

  // -------------------------------------------------------------------------
  // Relative positions

  /**
   * A position in a block's text that stays put through concurrent edits.
   * By default (assoc >= 0) it sticks to the character after it, so text
   * inserted at the position lands before it; with assoc < 0 it sticks to the
   * character before.
   *
   * @param {string} blockId @param {number} offset @param {number} [assoc]
   * @returns {RelativePosition}
   */
  createRelativePosition(blockId, offset, assoc = 0) {
    const seq = this.#mustBlock(blockId).text;
    this.#checkOffset(seq, offset);
    const anchor = assoc >= 0 ? seq.itemAt(offset) : offset > 0 ? seq.itemAt(offset - 1) : null;
    return {
      block: blockId,
      item: anchor && { client: anchor.client, clock: anchor.clock },
      assoc: assoc >= 0 ? 0 : -1,
    };
  }

  /**
   * The current offset of a relative position, or null if its block or
   * anchor doesn't exist here (yet).
   *
   * @param {RelativePosition} pos
   * @returns {{ blockId: string, offset: number } | null}
   */
  resolveRelativePosition(pos) {
    const block = this.#blocks.get(pos.block);
    if (!block) return null;
    const seq = block.text;
    if (pos.item === null) return { blockId: pos.block, offset: pos.assoc >= 0 ? seq.length : 0 };
    const item = this.#item(pos.item);
    if (!item || item.seq !== seq) return null;
    const before = seq.indexOf(item);
    return { blockId: pos.block, offset: pos.assoc >= 0 || item.deleted ? before : before + 1 };
  }

  // -------------------------------------------------------------------------
  // Hooks for UndoManager. They must run inside a transaction.

  /** @internal @param {RegisterTarget} target @returns {Register | undefined} */
  _register(target) {
    if (target.scope === SCOPE_META) return this.#meta.get(/** @type {string} */ (target.key));
    const block = this.#blocks.get(/** @type {string} */ (target.block));
    if (!block) return undefined;
    if (target.scope === SCOPE_ALIVE) return block.alive;
    if (target.scope === SCOPE_TYPE) return block.type;
    return block.attrs.get(/** @type {string} */ (target.key));
  }

  /** @internal @param {RegisterTarget} target @param {unknown} value */
  _setRegister(target, value) {
    this.#setRegister(target, value);
  }

  /** @internal @param {Item[]} items */
  _deleteItems(items) {
    this.#deleteItems(items);
  }

  /** @internal @param {string} name @param {{ item: Item, value: unknown }[]} entries */
  _formatItems(name, entries) {
    if (entries.length) this.#formatItems(name, entries);
  }

  /** @internal @param {string} id */
  _chosenPlacement(id) {
    return this.#getTree().chosen.get(id);
  }

  /**
   * Move a block to right after `anchor` (a placement, usually a tombstone),
   * in the anchor's list. Returns the new placement.
   *
   * @internal @param {string} id @param {Item} anchor
   */
  _placeAfter(id, anchor) {
    return this.#placeBlock(id, anchor.seq, anchor);
  }

  /**
   * Re-insert deleted characters, each right after its own tombstone, with
   * the given content and marks. Tombstones that are adjacent in the list
   * share one insert op, and so do the two halves of a surrogate pair.
   * Returns the new items, in `entries` order.
   *
   * @internal
   * @param {{ item: Item, content: string, marks: Record<string, unknown> | null }[]} entries
   * @returns {Item[]}
   */
  _restoreItems(entries) {
    /** @type {{ entries: typeof entries }[]} */
    const groups = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const prev = i > 0 ? entries[i - 1] : null;
      // Adjacent tombstones share an insert; so do the halves of a surrogate pair.
      const pair =
        prev !== null && isHigh(prev.content) && isLow(e.content) && prev.item.seq === e.item.seq;
      if (prev && (prev.item.next === e.item || pair)) groups[groups.length - 1].entries.push(e);
      else groups.push({ entries: [e] });
    }
    /** @type {Item[]} */
    const created = [];
    for (const g of groups) {
      const anchor = g.entries[0].item;
      const owner = /** @type {Block} */ (anchor.seq.owner);
      const text = g.entries.map((e) => e.content).join("");
      const clock = this.#push({
        t: OP_INSERT,
        seq: this.#textRef(owner),
        origin: { client: anchor.client, clock: anchor.clock },
        text,
        spans: toSpans(g.entries.map((e) => e.marks)),
        blocks: null,
      });
      for (let i = 0; i < text.length; i++)
        created.push(/** @type {Item} */ (this.#item({ client: this.clientId, clock: clock + i })));
    }
    if (created.length) this.#record({ kind: "insert", items: created });
    return created;
  }
}
