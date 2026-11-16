// @ts-check
import { valuesEqual } from "./encoding.js";

/**
 * Undo and redo for one replica's own changes.
 *
 * Only local transactions are tracked (optionally only some origins), and
 * changes within `captureTimeout` ms of the previous one join its step.
 * Undoing a step applies inverse ops as a new local transaction, so it syncs
 * like any other edit. The inverses never undo someone else's work:
 *
 * - **Inserted text** is deleted, but only characters still visible.
 * - **Deleted text** is re-inserted as new characters, each right after its
 *   tombstone, with the marks it had. The visible result is the exact
 *   previous text. Old items are mapped to their replacements so older steps
 *   can still find them.
 * - **Marks and registers** (meta, type, attrs, alive) go back to their
 *   previous value only if the current value is still ours and still the one
 *   the step wrote. If someone else wrote since, theirs stays.
 * - **Moves** put the block back right after its previous placement, unless
 *   someone else has moved it since.
 * - **Created blocks** are hidden (alive = false) and **deleted blocks**
 *   shown again; their content was never removed, so it comes back intact.
 *
 * Undoing a step records the transaction it made, and that record is the
 * redo step. Redo works the same way in the other direction.
 */

/** @typedef {import("./doc.js").Doc} Doc */
/** @typedef {import("./doc.js").DocEvent} DocEvent */
/** @typedef {import("./doc.js").ChangeRecord} ChangeRecord */
/** @typedef {import("./sequence.js").Item} Item */

/**
 * @typedef {object} StackItem
 * @property {ChangeRecord[]} records
 * @property {Map<string, unknown>} meta For the editor, e.g. the selection before the step.
 */

/**
 * @typedef {object} UndoEvent
 * @property {"added" | "updated" | "undo" | "redo"} type
 * "added"/"updated": a tracked change opened or joined an undo step.
 * "undo"/"redo": a step was applied; `item` is the step that was popped.
 * @property {StackItem} item
 */

export class UndoManager {
  #doc;
  #timeout;
  #now;
  /** @type {Set<unknown> | null} */
  #tracked;
  /** @type {StackItem[]} */
  #undo = [];
  /** @type {StackItem[]} */
  #redo = [];
  #last = -Infinity;
  /** Records from our own undo/redo transaction. @type {ChangeRecord[] | null} */
  #captured = null;
  /** Item → the item that replaced it when it was restored. @type {Map<Item, Item>} */
  #replaced = new Map();
  /** @type {Set<(e: UndoEvent) => void>} */
  #listeners = new Set();
  #unobserve;

  /**
   * @param {Doc} doc
   * @param {object} [options]
   * @param {number} [options.captureTimeout] ms within which changes join one step (default 500)
   * @param {Iterable<unknown> | null} [options.trackedOrigins] Track only these origins (default: every local transaction)
   * @param {() => number} [options.now] Clock, for tests.
   */
  constructor(doc, { captureTimeout = 500, trackedOrigins = null, now = Date.now } = {}) {
    this.#doc = doc;
    this.#timeout = captureTimeout;
    this.#now = now;
    this.#tracked = trackedOrigins ? new Set(trackedOrigins) : null;
    this.#unobserve = doc.observe((e) => this.#onEvent(e));
  }

  /** @param {DocEvent} e */
  #onEvent(e) {
    if (!e.local || e.records.length === 0) return;
    if (e.origin === this) {
      this.#captured?.push(...e.records);
      return;
    }
    if (e.origin instanceof UndoManager) return;
    if (this.#tracked !== null && !this.#tracked.has(e.origin)) return;
    const now = this.#now();
    const top = this.#undo[this.#undo.length - 1];
    /** @type {UndoEvent["type"]} */
    let type;
    if (top && now - this.#last < this.#timeout) {
      top.records.push(...e.records);
      type = "updated";
    } else {
      this.#undo.push({ records: [...e.records], meta: new Map() });
      type = "added";
    }
    this.#last = now;
    this.#redo.length = 0;
    this.#notify({ type, item: /** @type {StackItem} */ (this.#undo[this.#undo.length - 1]) });
  }

  /** The next change starts a new step. */
  stopCapturing() {
    this.#last = -Infinity;
  }

  canUndo() {
    return this.#undo.length > 0;
  }

  canRedo() {
    return this.#redo.length > 0;
  }

  /** Undo the latest step. Returns false if there was nothing to undo. */
  undo() {
    return this.#apply(this.#undo, this.#redo, "undo");
  }

  /** Redo the latest undone step. Returns false if there was nothing to redo. */
  redo() {
    return this.#apply(this.#redo, this.#undo, "redo");
  }

  clear() {
    this.#undo.length = 0;
    this.#redo.length = 0;
    this.#replaced.clear();
  }

  destroy() {
    this.clear();
    this.#unobserve();
    this.#listeners.clear();
  }

  /** @param {(e: UndoEvent) => void} fn @returns {() => void} */
  observe(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  /** @param {UndoEvent} e */
  #notify(e) {
    for (const fn of [...this.#listeners]) fn(e);
  }

  /**
   * Pop steps until one changes something (a step can be entirely
   * superseded by other people's edits), and push its inverse on `to`.
   *
   * @param {StackItem[]} from @param {StackItem[]} to @param {"undo" | "redo"} type
   */
  #apply(from, to, type) {
    while (from.length > 0) {
      const item = /** @type {StackItem} */ (from.pop());
      /** @type {ChangeRecord[]} */
      const captured = [];
      this.#captured = captured;
      try {
        this.#doc.transact(() => {
          for (let i = item.records.length - 1; i >= 0; i--) this.#invert(item.records[i]);
        }, this);
      } finally {
        this.#captured = null;
      }
      if (captured.length > 0) {
        to.push({ records: captured, meta: item.meta });
        this.#last = -Infinity;
        this.#notify({ type, item });
        return true;
      }
    }
    return false;
  }

  /** The latest replacement of an item. @param {Item} item */
  #resolve(item) {
    let r = item;
    for (let next = this.#replaced.get(r); next !== undefined; next = this.#replaced.get(r))
      r = next;
    if (r !== item) this.#replaced.set(item, r);
    return r;
  }

  /** @param {ChangeRecord} rec */
  #invert(rec) {
    const doc = this.#doc;
    const me = doc.clientId;
    switch (rec.kind) {
      case "insert": {
        doc._deleteItems(rec.items.map((it) => this.#resolve(it)).filter((it) => !it.deleted));
        break;
      }
      case "delete": {
        /** @type {{ item: Item, content: string, marks: Record<string, unknown> | null }[]} */
        const list = [];
        for (const e of rec.entries) {
          const item = this.#resolve(e.item);
          if (item.deleted) list.push({ item, content: e.content, marks: e.marks });
        }
        if (list.length === 0) break;
        const copies = doc._restoreItems(list);
        for (let i = 0; i < list.length; i++) this.#replaced.set(list[i].item, copies[i]);
        break;
      }
      case "format": {
        /** @type {{ item: Item, value: unknown }[]} */
        const list = [];
        for (const e of rec.entries) {
          const item = this.#resolve(e.item);
          // No register means "unset since the character was inserted", so its
          // author wrote that null (initial marks are stamped with the character's id).
          const reg = item.marks?.get(rec.name);
          const author = reg ? reg.client : item.client;
          const value = reg ? reg.value : null;
          if (author === me && valuesEqual(value, e.after)) list.push({ item, value: e.before });
        }
        doc._formatItems(rec.name, list);
        break;
      }
      case "set": {
        const reg = doc._register(rec.target);
        if (reg && reg.client === me && valuesEqual(reg.value, rec.after))
          doc._setRegister(rec.target, rec.before);
        break;
      }
      case "move": {
        const to = this.#resolve(rec.to);
        if (doc._chosenPlacement(rec.block) !== to) break;
        const from = this.#resolve(rec.from);
        this.#replaced.set(from, doc._placeAfter(rec.block, from));
        break;
      }
    }
  }
}
