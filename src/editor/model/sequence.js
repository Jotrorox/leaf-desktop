// @ts-check

/**
 * The sequence CRDT: an RGA list with tombstones, used for block text (one
 * item per UTF-16 code unit) and for child lists (one item per placement of
 * a block). Items live in a doubly linked list in document order.
 *
 * Every item is inserted "after" an origin item (null = the list head). The
 * list is the pre-order walk of the tree formed by origins, with siblings
 * sorted newest first. Because a Lamport id is larger than the id of
 * everything its author had seen, an item's id is larger than its origin's,
 * so integration only needs one rule: starting right after the origin, skip
 * every item whose id is newer than the new item's, and insert before the
 * first older one. A run typed left to right forms a chain (each character's
 * origin is the previous one), so runs by different users never interleave.
 *
 * Deleting only sets a tombstone flag. Tombstones keep their place, so later
 * inserts relative to them still land in the right spot.
 */

/** Sequence kinds, as on the wire. */
export const SEQ_ROOT = 0;
export const SEQ_TEXT = 1;
export const SEQ_CHILDREN = 2;

/**
 * A last-writer-wins register: the value written by the newest op.
 * `client = 0, clock = 0` means never written.
 *
 * @typedef {{ value: unknown, client: number, clock: number }} Register
 */

/** @param {unknown} [value] @returns {Register} */
export function newRegister(value = null) {
  return { value, client: 0, clock: 0 };
}

/**
 * Apply a write if it's newer than the register's current one.
 *
 * @param {Register} reg
 * @param {unknown} value
 * @param {number} client
 * @param {number} clock
 * @returns {boolean} Whether the write won.
 */
export function writeRegister(reg, value, client, clock) {
  if (clock < reg.clock || (clock === reg.clock && client <= reg.client)) return false;
  reg.value = value;
  reg.client = client;
  reg.clock = clock;
  return true;
}

export class Item {
  /**
   * @param {number} client
   * @param {number} clock
   * @param {Sequence} seq
   * @param {Item | null} origin
   * @param {string} content A UTF-16 code unit (text) or a block id (child lists).
   */
  constructor(client, clock, seq, origin, content) {
    this.client = client;
    this.clock = clock;
    this.seq = seq;
    this.origin = origin;
    this.content = content;
    this.deleted = false;
    /** @type {Item | null} */
    this.prev = null;
    /** @type {Item | null} */
    this.next = null;
    /** Per-mark LWW registers, text items only. @type {Map<string, Register> | null} */
    this.marks = null;
  }
}

/** @param {Item} a @param {Item} b */
function newer(a, b) {
  return a.clock > b.clock || (a.clock === b.clock && a.client > b.client);
}

export class Sequence {
  /**
   * @param {number} kind SEQ_ROOT, SEQ_TEXT or SEQ_CHILDREN
   * @param {any} owner The owning block, or null for the root list.
   */
  constructor(kind, owner) {
    this.kind = kind;
    /** @type {import("./doc.js").Block | null} */
    this.owner = owner;
    /** Sentinel before the first item. Never visible. */
    this.head = new Item(0, 0, this, null, "");
    this.head.deleted = true;
    /** Number of visible (non-deleted) items. */
    this.length = 0;
    /**
     * A visible item and its index, so sequential lookups (typing at the
     * end, a cursor moving) don't walk from the head. Cleared on any change
     * that could shift indices; `Doc` re-seeds it after local edits.
     * @type {{ item: Item, index: number } | null}
     */
    this.cache = null;
  }

  /**
   * Link `item` into the list after its origin (RGA integration).
   *
   * @param {Item} item
   */
  integrate(item) {
    let left = item.origin ?? this.head;
    let right = left.next;
    while (right !== null && newer(right, item)) {
      left = right;
      right = right.next;
    }
    item.prev = left;
    item.next = right;
    left.next = item;
    if (right !== null) right.prev = item;
    if (!item.deleted) this.length++;
    this.cache = null;
  }

  /** @param {Item} item @returns {boolean} Whether it was visible. */
  delete(item) {
    if (item.deleted) return false;
    item.deleted = true;
    this.length--;
    this.cache = null;
    return true;
  }

  /**
   * The visible item at `index`, or null when out of range.
   *
   * @param {number} index
   * @returns {Item | null}
   */
  itemAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) return null;
    /** @type {Item} */
    let item = this.head;
    let i = -1;
    const c = this.cache;
    if (c !== null && !c.item.deleted && Math.abs(c.index - index) <= index) {
      item = c.item;
      i = c.index;
    }
    while (i < index) {
      item = /** @type {Item} */ (item.next);
      if (!item.deleted) i++;
    }
    while (i > index) {
      item = /** @type {Item} */ (item.prev);
      if (!item.deleted) i--;
    }
    this.cache = { item, index };
    return item;
  }

  /**
   * How many visible items come before `item` (its index if it's visible).
   *
   * @param {Item} item
   */
  indexOf(item) {
    const c = this.cache;
    let n = 0;
    for (let it = item.prev; it !== null; it = it.prev) {
      if (c !== null && it === c.item) return n + c.index + 1;
      if (!it.deleted) n++;
    }
    return n;
  }

  /** Every item after the head, tombstones included. */
  *items() {
    for (let it = this.head.next; it !== null; it = it.next) yield it;
  }

  /** The visible items' contents joined (the text of a text sequence). */
  toString() {
    /** @type {string[]} */
    const parts = [];
    for (let it = this.head.next; it !== null; it = it.next)
      if (!it.deleted) parts.push(it.content);
    return parts.join("");
  }
}
