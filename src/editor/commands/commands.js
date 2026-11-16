// @ts-check
import {
  CALLOUT_ICON,
  hasText,
  isPlainText,
  isTablePart,
  MATH_MARK,
  MATH_MARKS,
  spec,
} from "../blocks/schema.js";
import { filterMarks, formatText, insertRuns, marksAt, marksOfChar, sliceRuns } from "./runs.js";
import { CELL, cellPlace, fillCells, ROW, TABLE, tableOf } from "./table.js";

/**
 * Editing commands. Each one reads and changes the document through its
 * public API and returns where the caret (or selection) goes next. The
 * editor runs each command inside one `doc.transact()`, so one user action
 * is one transaction and one undo step.
 *
 * Pure: no DOM, so they run under `node --test`.
 *
 * Positions are `{ block, offset }`, an offset in UTF-16 code units in a
 * block's text. "Flat order" is the order blocks appear on screen: depth
 * first, skipping the children of closed toggles.
 *
 * A table acts as one block for block commands (move, duplicate, delete,
 * indent): its rows and cells are never split, joined, turned into
 * something else or moved on their own. Text commands work in cells as in
 * any text block, and a selection across cells clears their text rather
 * than removing them (table.js has the commands that change a table's shape).
 */

/** @typedef {import("../model/doc.js").Doc} Doc */
/** @typedef {import("../model/doc.js").TextRun} TextRun */
/** @typedef {{ block: string, offset: number }} Pos */
/** @typedef {{ anchor: Pos, focus: Pos }} Sel */

/**
 * @typedef {object} Ctx
 * @property {Doc} doc
 * @property {(id: string) => boolean} isOpen Whether a toggle shows its children.
 * @property {(id: string, open: boolean) => void} [setOpen]
 */

/**
 * @typedef {object} SliceBlock
 * @property {string} type
 * @property {Record<string, unknown>} attrs
 * @property {TextRun[]} text
 * @property {number} depth 0 for the shallowest block in the slice.
 */

/**
 * What's copied and pasted. `inline` is a piece of one block's text: it
 * pastes into the text at the caret instead of as blocks.
 * @typedef {{ blocks: SliceBlock[], inline: boolean }} Slice
 */

// ---------------------------------------------------------------------------
// Reading

/** @param {Ctx} ctx @param {string} id */
export function showsChildren(ctx, id) {
  const type = ctx.doc.getType(id);
  return type === "toggle" ? ctx.isOpen(id) : type !== CELL;
}

/**
 * The children a block shows: all of them, except that a table shows only
 * its rows and a row only its cells (anything else in them is from an
 * older client, and isn't drawn).
 * @param {Doc} doc @param {string | null} parent
 */
export function shownChildren(doc, parent) {
  const kids = doc.children(parent);
  const type = parent === null ? null : doc.getType(parent);
  if (type === TABLE) return kids.filter((id) => doc.getType(id) === ROW);
  if (type === ROW) return kids.filter((id) => doc.getType(id) === CELL);
  return kids;
}

/** Visible block ids in screen order. @param {Ctx} ctx */
export function flatBlocks(ctx) {
  /** @type {string[]} */
  const out = [];
  /** @param {string | null} parent */
  const walk = (parent) => {
    for (const id of shownChildren(ctx.doc, parent)) {
      out.push(id);
      if (showsChildren(ctx, id)) walk(id);
    }
  };
  walk(null);
  return out;
}

/** Text blocks in screen order. @param {Ctx} ctx */
export function textBlocks(ctx) {
  return flatBlocks(ctx).filter((id) => hasText(ctx.doc.getType(id)));
}

/** @param {Sel} sel */
export function isCollapsed(sel) {
  return sel.anchor.block === sel.focus.block && sel.anchor.offset === sel.focus.offset;
}

/** @param {Pos} pos @returns {Sel} */
export const caret = (pos) => ({ anchor: pos, focus: pos });

/**
 * The selection's ends in screen order.
 * @param {Ctx} ctx @param {Sel} sel
 * @returns {{ from: Pos, to: Pos, flat: string[], fromIndex: number, toIndex: number }}
 */
export function ordered(ctx, sel) {
  const flat = flatBlocks(ctx);
  const ai = flat.indexOf(sel.anchor.block);
  const fi = flat.indexOf(sel.focus.block);
  const forward = ai < fi || (ai === fi && sel.anchor.offset <= sel.focus.offset);
  return forward
    ? { from: sel.anchor, to: sel.focus, flat, fromIndex: ai, toIndex: fi }
    : { from: sel.focus, to: sel.anchor, flat, fromIndex: fi, toIndex: ai };
}

/**
 * Whether a position still points into a visible text block, within its text.
 * @param {Ctx} ctx @param {Pos} pos
 */
export function isValidPos(ctx, pos) {
  const { doc } = ctx;
  if (!doc.hasBlock(pos.block) || !doc.isVisible(pos.block) || !hasText(doc.getType(pos.block)))
    return false;
  return pos.offset >= 0 && pos.offset <= doc.textLength(pos.block);
}

/**
 * The blocks a selection touches, outermost only (a block whose ancestor is
 * also touched is left out: it moves with that ancestor). A table's rows
 * and cells stand for the table.
 * @param {Ctx} ctx @param {Sel} sel
 */
export function selectedBlocks(ctx, sel) {
  const { flat, fromIndex, toIndex } = ordered(ctx, sel);
  const ids = [
    ...new Set(
      flat
        .slice(fromIndex, toIndex + 1)
        .map((id) => (isTablePart(ctx.doc.getType(id)) ? (tableOf(ctx.doc, id) ?? id) : id)),
    ),
  ];
  const set = new Set(ids);
  return ids.filter((id) => {
    for (let p = ctx.doc.parentOf(id); typeof p === "string"; p = ctx.doc.parentOf(p))
      if (set.has(p)) return false;
    return true;
  });
}

/** Whether blocks can be put inside a block of this type (not a table or its parts). @param {string} type */
export const holdsBlocks = (type) => type !== TABLE && !isTablePart(type);

/** The sibling before a block, or null. @param {Doc} doc @param {string} id */
function previousSibling(doc, id) {
  const siblings = doc.children(doc.parentOf(id) ?? null);
  const i = siblings.indexOf(id);
  return i > 0 ? siblings[i - 1] : null;
}

/** @param {Doc} doc @param {string} id */
const parentOf = (doc, id) => doc.parentOf(id) ?? null;

// ---------------------------------------------------------------------------
// Text

/**
 * Delete what's between two positions (in screen order). Blocks wholly
 * inside go; what follows the end in its block joins the start's block.
 * Visible blocks after the range whose parent is deleted move under the
 * start block, so nothing outside the selection disappears.
 *
 * When an end is in a table, the cells in the range are emptied instead
 * (tables wholly inside go), and nothing joins across the table's edge.
 *
 * @param {Ctx} ctx @param {Pos} from @param {Pos} to
 * @returns {Pos}
 */
export function deleteRange(ctx, from, to) {
  const { doc } = ctx;
  if (from.block === to.block) {
    if (to.offset > from.offset) doc.deleteText(from.block, from.offset, to.offset - from.offset);
    return from;
  }
  const fromTable = doc.getType(from.block) === CELL ? tableOf(doc, from.block) : null;
  const toTable = doc.getType(to.block) === CELL ? tableOf(doc, to.block) : null;
  if (fromTable !== null || toTable !== null)
    return deleteAcrossTables(ctx, from, to, fromTable, toTable);
  const flat = flatBlocks(ctx);
  const fi = flat.indexOf(from.block);
  const ti = flat.indexOf(to.block);
  const removed = flat.slice(fi + 1, ti + 1);
  const removedSet = new Set(removed);
  let tail = hasText(doc.getType(to.block)) ? sliceRuns(doc.getTextRuns(to.block), to.offset) : [];
  if (!spec(doc.getType(from.block)).marks) tail = filterMarks(tail, () => true);
  const fromLength = doc.textLength(from.block);
  if (fromLength > from.offset) doc.deleteText(from.block, from.offset, fromLength - from.offset);
  insertRuns(doc, from.block, from.offset, tail);
  /** @type {string | null} */
  let after = null;
  for (const id of flat.slice(ti + 1)) {
    if (!removedSet.has(parentOf(doc, id))) continue;
    doc.moveBlock(id, { parent: from.block, after });
    after = id;
  }
  for (const id of removed) if (!removedSet.has(parentOf(doc, id))) doc.deleteBlock(id);
  return from;
}

/**
 * `deleteRange` when an end is in a table: the text from `from` to `to`
 * goes, cell by cell; blocks in between go, except those holding `to`.
 * @param {Ctx} ctx @param {Pos} from @param {Pos} to @param {string | null} fromTable @param {string | null} toTable
 * @returns {Pos}
 */
function deleteAcrossTables(ctx, from, to, fromTable, toTable) {
  const { doc } = ctx;
  const flat = flatBlocks(ctx);
  const fi = flat.indexOf(from.block);
  const ti = flat.indexOf(to.block);
  /** @param {string} id @param {string} ancestor */
  const within = (id, ancestor) => {
    for (
      let a = /** @type {string | null | undefined} */ (id);
      typeof a === "string";
      a = doc.parentOf(a)
    )
      if (a === ancestor) return true;
    return false;
  };
  const keep = new Set();
  for (
    let a = /** @type {string | null | undefined} */ (to.block);
    typeof a === "string";
    a = doc.parentOf(a)
  )
    keep.add(a);
  for (
    let a = /** @type {string | null | undefined} */ (from.block);
    typeof a === "string";
    a = doc.parentOf(a)
  )
    keep.add(a);
  /** @type {Set<string>} */
  const doomed = new Set();
  /** The outermost deleted block holding `id`, if any. @param {string} id */
  const doomedAncestor = (id) => {
    /** @type {string | null} */
    let found = null;
    for (let a = doc.parentOf(id); typeof a === "string"; a = doc.parentOf(a))
      if (doomed.has(a)) found = a;
    return found;
  };
  for (const id of flat.slice(fi, ti + 1)) {
    const start = id === from.block ? from.offset : 0;
    const end = id === to.block ? to.offset : null;
    const inTable =
      (fromTable !== null && within(id, fromTable)) || (toTable !== null && within(id, toTable));
    if (id === from.block || id === to.block || (inTable && doc.getType(id) === CELL)) {
      const length = doc.textLength(id);
      const stop = end ?? length;
      if (stop > start) doc.deleteText(id, start, stop - start);
      continue;
    }
    if (inTable || keep.has(id) || doomedAncestor(id) !== null) continue;
    doomed.add(id);
  }
  // Blocks after the range under a deleted one move up, so they stay.
  /** @type {Map<string, string>} */
  const lastMoved = new Map();
  for (const id of flat.slice(ti + 1)) {
    // (One whose parent moved out already went along with it.)
    const at = doomedAncestor(id);
    if (at === null) continue;
    doc.moveBlock(id, { parent: doc.parentOf(at) ?? null, after: lastMoved.get(at) ?? at });
    lastMoved.set(at, id);
  }
  for (const id of doomed) doc.deleteBlock(id);
  return from;
}

/**
 * Delete the selection, if it isn't collapsed. Returns the caret.
 * @param {Ctx} ctx @param {Sel} sel
 */
export function deleteSelection(ctx, sel) {
  if (isCollapsed(sel)) return sel.focus;
  const { from, to } = ordered(ctx, sel);
  return deleteRange(ctx, from, to);
}

/**
 * Type text over the selection. `marks` null means "like the text before
 * the caret". Code blocks never get marks.
 *
 * @param {Ctx} ctx @param {Sel} sel @param {string} text
 * @param {Record<string, unknown> | null} [marks]
 * @returns {Pos}
 */
export function insertText(ctx, sel, text, marks = null) {
  const { doc } = ctx;
  const at = deleteSelection(ctx, sel);
  if (!text) return at;
  const m = spec(doc.getType(at.block)).marks ? (marks ?? marksAt(doc, at.block, at.offset)) : null;
  doc.insertText(at.block, at.offset, text, m);
  return { block: at.block, offset: at.offset + text.length };
}

// ---------------------------------------------------------------------------
// Blocks

/**
 * Create a block after `after` (in its parent), with text.
 * @param {Doc} doc
 * @param {{ type: string, parent: string | null, after: string | null | undefined, attrs?: Record<string, unknown>, text?: TextRun[] }} spec_
 */
export function createBlock(doc, { type, parent, after, attrs, text }) {
  const id = doc.insertBlock({ type, parent, after, attrs: { ...defaultAttrs(type), ...attrs } });
  if (text?.length) insertRuns(doc, id, 0, text);
  return id;
}

/** @param {string} type @returns {Record<string, unknown>} */
function defaultAttrs(type) {
  return type === "callout" ? { icon: CALLOUT_ICON } : {};
}

/**
 * Enter: split the block at the caret. The part after the caret goes to a
 * new block below (a list item makes another list item; anything else makes
 * text). At the very start of a non-empty block, an empty block goes above
 * instead and the caret stays. In an empty list item, Enter outdents it, or
 * at the top level turns it into text. In code and equations, Enter is a
 * line break, except that a third Enter at the end (after two empty lines)
 * leaves the block for a paragraph below. In a table cell, Enter is a
 * line break in the cell.
 *
 * @param {Ctx} ctx @param {Sel} sel
 * @returns {Pos}
 */
export function splitBlock(ctx, sel) {
  const { doc } = ctx;
  const pos = deleteSelection(ctx, sel);
  const id = pos.block;
  const type = doc.getType(id);
  if (type === CELL) return insertText(ctx, caret(pos), "\n");
  if (isPlainText(type)) {
    // Enter on a second empty line at the end leaves the block.
    const text = doc.getText(id);
    if (pos.offset === text.length && text.endsWith("\n\n")) {
      doc.deleteText(id, text.length - 2, 2);
      return exitBlock(ctx, id);
    }
    return insertText(ctx, caret(pos), "\n");
  }
  const length = doc.textLength(id);
  const s = spec(type);
  const parent = parentOf(doc, id);

  if (length === 0 && s.list) {
    if (parent !== null && spec(doc.getType(parent)).list) outdent(ctx, [id]);
    else turnInto(ctx, [id], "p");
    return pos;
  }

  const nextType = s.continues ? type : "p";
  if (pos.offset === 0 && length > 0) {
    createBlock(doc, { type: nextType, parent, after: previousSibling(doc, id) });
    return pos;
  }

  const tail = sliceRuns(doc.getTextRuns(id), pos.offset);
  if (pos.offset < length) doc.deleteText(id, pos.offset, length - pos.offset);
  // An open toggle, or a block showing children, gets the new block as its
  // first child; otherwise it's the next sibling.
  const intoChildren = showsChildren(ctx, id) && (doc.children(id).length > 0 || type === "toggle");
  const newId = createBlock(doc, {
    type: nextType,
    parent: intoChildren ? id : parent,
    after: intoChildren ? null : id,
    text: tail,
  });
  return { block: newId, offset: 0 };
}

/**
 * Join block `id` onto the end of `into` (a text block): its text is
 * appended, its children move to where it was, and it's deleted.
 * @param {Ctx} ctx @param {string} into @param {string} id
 * @returns {Pos}
 */
function mergeInto(ctx, into, id) {
  const { doc } = ctx;
  const offset = doc.textLength(into);
  const runs = doc.getTextRuns(id);
  insertRuns(
    doc,
    into,
    offset,
    spec(doc.getType(into)).marks ? runs : filterMarks(runs, () => true),
  );
  const parent = parentOf(doc, id);
  let after = id;
  for (const child of doc.children(id)) {
    doc.moveBlock(child, { parent, after });
    after = child;
  }
  doc.deleteBlock(id);
  return { block: into, offset };
}

/**
 * Backspace at the start of a block: a typed block (heading, list item,
 * quote…) turns into text first; text joins the block above. A divider
 * above is deleted instead. Below an equation, the caret moves into it
 * (an empty line goes away), so text never pours into the formula. The
 * same goes below a table; and at the start of a cell nothing happens.
 *
 * @param {Ctx} ctx @param {string} id
 * @returns {Pos}
 */
export function joinBackward(ctx, id) {
  const { doc } = ctx;
  const here = { block: id, offset: 0 };
  if (doc.getType(id) === CELL) return here;
  if (doc.getType(id) !== "p") {
    turnInto(ctx, [id], "p");
    return here;
  }
  const flat = flatBlocks(ctx);
  const prev = flat[flat.indexOf(id) - 1];
  if (prev === undefined) return here;
  if (doc.getType(prev) === "equation" || doc.getType(prev) === CELL) {
    if (doc.textLength(id) === 0 && doc.children(id).length === 0) doc.deleteBlock(id);
    return { block: prev, offset: doc.textLength(prev) };
  }
  if (hasText(doc.getType(prev))) return mergeInto(ctx, prev, id);
  // A divider (or other non-text block) right above goes away.
  doc.deleteBlock(prev);
  return here;
}

/**
 * Delete at the end of a block: the block below joins this one (a divider
 * below is deleted). Equations don't join: at the end of one nothing
 * happens, and above one the caret moves into it (an empty line goes away).
 * Tables are the same: at the end of a cell nothing happens, and above a
 * table the caret moves into its first cell.
 * @param {Ctx} ctx @param {string} id
 * @returns {Pos}
 */
export function joinForward(ctx, id) {
  const { doc } = ctx;
  const end = { block: id, offset: doc.textLength(id) };
  const flat = flatBlocks(ctx);
  const index = flat.indexOf(id);
  let next = flat[index + 1];
  if (next === undefined || doc.getType(id) === "equation" || doc.getType(id) === CELL) return end;
  if (doc.getType(next) === TABLE)
    next =
      flat.slice(index + 1).find((b) => doc.getType(b) === CELL && tableOf(doc, b) === next) ??
      next;
  if (doc.getType(next) === "equation" || doc.getType(next) === CELL) {
    if (doc.getType(id) === "p" && doc.textLength(id) === 0 && doc.children(id).length === 0)
      doc.deleteBlock(id);
    return { block: next, offset: 0 };
  }
  if (!hasText(doc.getType(next))) {
    doc.deleteBlock(next);
    return end;
  }
  return mergeInto(ctx, id, next);
}

/**
 * Change blocks' type, keeping their text. Formatting is dropped when
 * turning into code or an equation; to-do state is dropped when leaving to-do.
 * @param {Ctx} ctx @param {string[]} ids @param {string} type
 */
export function turnInto(ctx, ids, type) {
  const { doc } = ctx;
  if (isTablePart(type)) return;
  for (const id of ids) {
    const before = doc.getType(id);
    if (!hasText(before) || before === type || isTablePart(before)) continue;
    doc.setType(id, type);
    const attrs = doc.getAttrs(id);
    if (type !== "todo" && "checked" in attrs) doc.setAttr(id, "checked", null);
    if (type === "callout" && !attrs.icon) doc.setAttr(id, "icon", CALLOUT_ICON);
    if (type === "toggle") ctx.setOpen?.(id, true);
    if (isPlainText(type)) {
      const runs = doc.getTextRuns(id);
      let offset = 0;
      for (const r of runs) {
        for (const name of Object.keys(r.marks ?? {}))
          doc.format(id, offset, r.text.length, name, null);
        offset += r.text.length;
      }
    }
  }
}

/**
 * Tab: each block becomes the last child of the sibling above it (blocks
 * without one stay put).
 * @param {Ctx} ctx @param {string[]} ids Outermost selected blocks, in order.
 */
export function indent(ctx, ids) {
  const { doc } = ctx;
  for (const id of ids) {
    if (isTablePart(doc.getType(id))) continue;
    const prev = previousSibling(doc, id);
    if (prev === null || !holdsBlocks(doc.getType(prev))) continue;
    doc.moveBlock(id, { parent: prev });
    if (doc.getType(prev) === "toggle") ctx.setOpen?.(prev, true);
  }
}

/**
 * Shift+Tab: blocks move out of their parent, to right after it. Siblings
 * below the last of them move under it, so the order on screen is kept.
 * @param {Ctx} ctx @param {string[]} ids Outermost selected blocks, in order.
 */
export function outdent(ctx, ids) {
  const { doc } = ctx;
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  for (const id of ids) {
    const parent = parentOf(doc, id);
    if (parent === null || isTablePart(doc.getType(id))) continue;
    let g = groups.get(parent);
    if (!g) groups.set(parent, (g = []));
    g.push(id);
  }
  for (const [parent, group] of groups) {
    const last = group[group.length - 1];
    const kids = doc.children(parent);
    for (const sibling of kids.slice(kids.indexOf(last) + 1)) {
      if (!group.includes(sibling)) doc.moveBlock(sibling, { parent: last });
    }
    const grandparent = parentOf(doc, parent);
    let after = parent;
    for (const id of group) {
      doc.moveBlock(id, { parent: grandparent, after });
      after = id;
    }
  }
}

/** @param {Ctx} ctx @param {string} id */
export function toggleChecked(ctx, id) {
  const { doc } = ctx;
  if (doc.getType(id) !== "todo") return;
  doc.setAttr(id, "checked", doc.getAttrs(id).checked === true ? null : true);
}

// ---------------------------------------------------------------------------
// Marks

/**
 * The text ranges a selection covers, per text block that takes marks.
 * @param {Ctx} ctx @param {Sel} sel
 * @returns {{ block: string, start: number, end: number }[]}
 */
export function textRanges(ctx, sel) {
  const { doc } = ctx;
  const { from, to, flat, fromIndex, toIndex } = ordered(ctx, sel);
  /** @type {{ block: string, start: number, end: number }[]} */
  const out = [];
  for (const id of flat.slice(fromIndex, toIndex + 1)) {
    if (!spec(doc.getType(id)).marks) continue;
    const start = id === from.block ? from.offset : 0;
    const end = id === to.block ? to.offset : doc.textLength(id);
    if (end > start) out.push({ block: id, start, end });
  }
  return out;
}

/**
 * Whether every selected character has `name` set (to `value`, if given).
 * @param {Ctx} ctx @param {Sel} sel @param {string} name @param {unknown} [value]
 */
export function hasMark(ctx, sel, name, value) {
  const ranges = textRanges(ctx, sel);
  if (ranges.length === 0) return false;
  // Formulas don't take formatting, so they don't count either way.
  const skipMath = !MATH_MARKS.includes(name);
  let any = false;
  for (const { block, start, end } of ranges) {
    const runs = ctx.doc.getTextRuns(block);
    for (let i = start; i < end; i++) {
      const marks = marksOfChar(runs, i);
      if (skipMath && marks?.[MATH_MARK] !== undefined) continue;
      any = true;
      const v = marks?.[name];
      if (
        v === undefined ||
        v === null ||
        (value !== undefined && JSON.stringify(v) !== JSON.stringify(value))
      )
        return false;
    }
  }
  return any;
}

/**
 * Set a mark on the selection; or, if every character already has it,
 * remove it. Returns false when there's nothing to format (a caret).
 * @param {Ctx} ctx @param {Sel} sel @param {string} name @param {unknown} [value]
 */
export function toggleMark(ctx, sel, name, value = true) {
  const ranges = textRanges(ctx, sel);
  if (ranges.length === 0) return false;
  const next = hasMark(ctx, sel, name, value === true ? undefined : value) ? null : value;
  for (const { block, start, end } of ranges)
    formatText(ctx.doc, block, start, end - start, name, next);
  return true;
}

/**
 * Set (or with null clear) a mark on the selection.
 * @param {Ctx} ctx @param {Sel} sel @param {string} name @param {unknown} value
 */
export function setMark(ctx, sel, name, value) {
  for (const { block, start, end } of textRanges(ctx, sel))
    formatText(ctx.doc, block, start, end - start, name, value);
}

// ---------------------------------------------------------------------------
// Clipboard slices

/**
 * The selection as a slice: whole blocks in between, partial text at the
 * ends. Inside one block, it's an inline slice. A table the selection
 * starts or ends in comes whole in shape: its rows from the first touched
 * to the last, with the cells outside the selection empty.
 * @param {Ctx} ctx @param {Sel} sel
 * @returns {Slice}
 */
export function getSlice(ctx, sel) {
  const { doc } = ctx;
  const { from, to, flat, fromIndex, toIndex } = ordered(ctx, sel);
  if (from.block === to.block) {
    const id = from.block;
    return {
      inline: true,
      blocks: [
        {
          type: doc.getType(id),
          attrs: doc.getAttrs(id),
          text: sliceRuns(doc.getTextRuns(id), from.offset, to.offset),
          depth: 0,
        },
      ],
    };
  }
  /** @type {{ id: string, empty?: boolean, attrs?: Record<string, unknown> }[]} */
  let entries = flat.slice(fromIndex, toIndex + 1).map((id) => ({ id }));
  const start = doc.getType(from.block) === CELL ? cellPlace(doc, from.block) : null;
  if (start) {
    const row = /** @type {string} */ (doc.parentOf(from.block));
    // Without its first row, the table has no header row.
    const { header_row: _, ...rest } = doc.getAttrs(start.table);
    const attrs = start.row > 0 ? rest : doc.getAttrs(start.table);
    entries = [
      { id: start.table, attrs },
      { id: row },
      ...start.grid[start.row].slice(0, start.col).map((id) => ({ id, empty: true })),
      ...entries,
    ];
  }
  const end = doc.getType(to.block) === CELL ? cellPlace(doc, to.block) : null;
  if (end) entries.push(...end.grid[end.row].slice(end.col + 1).map((id) => ({ id, empty: true })));
  /** @param {string} id */
  const depthOf = (id) => {
    let d = 0;
    for (let p = doc.parentOf(id); typeof p === "string"; p = doc.parentOf(p)) d++;
    return d;
  };
  const depths = entries.map((e) => depthOf(e.id));
  const min = Math.min(...depths);
  return {
    inline: false,
    blocks: entries.map(({ id, empty, attrs }, i) => {
      const runs = hasText(doc.getType(id)) && !empty ? doc.getTextRuns(id) : [];
      const text =
        id === from.block
          ? sliceRuns(runs, from.offset)
          : id === to.block
            ? sliceRuns(runs, 0, to.offset)
            : runs;
      return {
        type: doc.getType(id),
        attrs: attrs ?? doc.getAttrs(id),
        text,
        depth: depths[i] - min,
      };
    }),
  };
}

/**
 * A slice's blocks with tables made whole: a stray row or cell (cut out of
 * its table) becomes a paragraph, anything inside a table that isn't a row
 * (or in a row that isn't a cell, or in a cell) is left out, and so are
 * rows without cells and tables without rows.
 * @param {SliceBlock[]} blocks
 * @returns {SliceBlock[]}
 */
export function wholeTables(blocks) {
  /** @type {SliceBlock[]} */
  const kept = [];
  /** @type {string[]} The kept ancestors' types, by depth. */
  const stack = [];
  /** @type {number | null} Leaving out everything deeper than this. */
  let skip = null;
  const base = blocks.length ? Math.min(...blocks.map((b) => b.depth)) : 0;
  for (const b of blocks) {
    if (skip !== null && b.depth > skip) continue;
    skip = null;
    const depth = Math.min(b.depth - base, stack.length);
    stack.length = depth;
    const parent = depth > 0 ? stack[depth - 1] : null;
    if (
      (parent === TABLE && b.type !== ROW) ||
      (parent === ROW && b.type !== CELL) ||
      parent === CELL
    ) {
      skip = b.depth;
      continue;
    }
    const type =
      (b.type === ROW && parent !== TABLE) || (b.type === CELL && parent !== ROW) ? "p" : b.type;
    kept.push(type === b.type ? { ...b, depth } : { type, attrs: {}, text: b.text, depth });
    stack.push(type);
  }
  /** @param {SliceBlock[]} list @param {string} type */
  const dropEmpty = (list, type) =>
    list.filter(
      (b, i) => b.type !== type || (list[i + 1] !== undefined && list[i + 1].depth > b.depth),
    );
  return dropEmpty(dropEmpty(kept, ROW), TABLE);
}

/**
 * A table's cells in a slice, by row, given the index of the table block.
 * @param {SliceBlock[]} blocks @param {number} index
 * @returns {TextRun[][][]}
 */
export function sliceCells(blocks, index) {
  const table = blocks[index];
  /** @type {TextRun[][][]} */
  const rows = [];
  for (let i = index + 1; i < blocks.length && blocks[i].depth > table.depth; i++) {
    const b = blocks[i];
    if (b.type === ROW && b.depth === table.depth + 1) rows.push([]);
    else if (b.type === CELL && b.depth === table.depth + 2 && rows.length)
      rows[rows.length - 1].push(b.text);
  }
  return rows;
}

/**
 * Paste a slice over the selection. The first block's text goes in at the
 * caret (an empty text block also takes its type); the rest become blocks
 * after this one, nested by depth; the text that was after the caret ends
 * up after the pasted text. In a code block or an equation everything goes
 * in as plain text.
 *
 * @param {Ctx} ctx @param {Sel} sel @param {Slice} slice
 * @returns {Pos}
 */
export function insertSlice(ctx, sel, slice) {
  const { doc } = ctx;
  const at = deleteSelection(ctx, sel);
  slice = slice.inline ? slice : { ...slice, blocks: wholeTables(slice.blocks) };
  if (slice.blocks.length === 0) return at;
  const type = doc.getType(at.block);
  if (isPlainText(type)) {
    const text = slice.blocks.map((b) => b.text.map((r) => r.text).join("")).join("\n");
    return insertText(ctx, caret(at), text, null);
  }
  if (type === CELL && tableOf(doc, at.block) !== null) return insertIntoCell(ctx, at, slice);
  /** @param {TextRun[]} runs */
  const clean = (runs) => (spec(type).marks ? runs : filterMarks(runs, () => true));

  const [first, ...rest] = slice.blocks;
  if (slice.inline || rest.length === 0) {
    if (!hasText(first.type)) {
      const id = createBlock(doc, {
        type: first.type,
        parent: parentOf(doc, at.block),
        after: at.block,
        attrs: first.attrs,
      });
      return afterBlock(ctx, id);
    }
    if (!slice.inline) adoptType(doc, at.block, first);
    const end = insertRuns(doc, at.block, at.offset, clean(first.text));
    return { block: at.block, offset: end };
  }

  const length = doc.textLength(at.block);
  const tail = sliceRuns(doc.getTextRuns(at.block), at.offset);
  if (at.offset < length) doc.deleteText(at.block, at.offset, length - at.offset);
  // A first block without text (a table) goes in below, like the rest.
  const textFirst = hasText(first.type);
  if (textFirst) {
    adoptType(doc, at.block, first);
    insertRuns(doc, at.block, at.offset, clean(first.text));
  }

  // One level per depth below the first block's: where the next block at
  // that depth goes. A block can nest at most one level deeper than the one
  // before it.
  /** @type {{ parent: string | null, last: string | null }[]} */
  const levels = [{ parent: parentOf(doc, at.block), last: at.block }];
  let last = at.block;
  for (const b of textFirst ? rest : slice.blocks) {
    const d = Math.max(0, Math.min(b.depth - first.depth, levels.length));
    if (d === levels.length) levels.push({ parent: last, last: null });
    else levels.length = d + 1;
    const level = levels[d];
    const id = createBlock(doc, {
      type: b.type,
      parent: level.parent,
      after: level.last,
      attrs: b.attrs,
      text: hasText(b.type) ? clean(b.text) : [],
    });
    if (b.type === "toggle") ctx.setOpen?.(id, true);
    level.last = id;
    last = id;
  }
  // The text after the caret never goes into a table's last cell.
  last = doc.getType(last) === CELL ? (tableOf(doc, last) ?? last) : last;
  if (!hasText(doc.getType(last))) {
    last = createBlock(doc, { type: "p", parent: parentOf(doc, last), after: last });
  }
  const offset = doc.textLength(last);
  insertRuns(doc, last, offset, clean(tail));
  // Pasting a table on an empty line doesn't leave the line above it.
  if (
    !textFirst &&
    last !== at.block &&
    doc.getType(at.block) === "p" &&
    doc.textLength(at.block) === 0 &&
    doc.children(at.block).length === 0
  )
    doc.deleteBlock(at.block);
  return { block: last, offset };
}

/**
 * Paste into a table cell: text goes in at the caret (several blocks as
 * lines); a table fills the cells from this one on, growing the table as
 * needed; blocks without text (an image) go below the table.
 * @param {Ctx} ctx @param {Pos} at @param {Slice} slice
 * @returns {Pos}
 */
function insertIntoCell(ctx, at, slice) {
  const { doc } = ctx;
  const [first] = slice.blocks;
  if (first.type === TABLE && slice.blocks.every((b, i) => i === 0 || b.depth > first.depth))
    return fillCells(ctx, at.block, sliceCells(slice.blocks, 0));
  const texts = slice.blocks.filter((b) => hasText(b.type));
  if (texts.length === 0) {
    const table = /** @type {string} */ (tableOf(doc, at.block));
    const p = createBlock(doc, { type: "p", parent: parentOf(doc, table), after: table });
    return insertSlice(ctx, caret({ block: p, offset: 0 }), slice);
  }
  /** @type {TextRun[]} */
  const runs = [];
  for (const b of texts) {
    if (runs.length) runs.push({ text: "\n" });
    runs.push(...b.text);
  }
  return { block: at.block, offset: insertRuns(doc, at.block, at.offset, runs) };
}

/**
 * An empty text paragraph that a slice's first block lands in takes that
 * block's type (pasting a list item into an empty line makes a list item).
 * @param {Doc} doc @param {string} id @param {SliceBlock} from
 */
function adoptType(doc, id, from) {
  if (
    doc.textLength(id) !== 0 ||
    doc.getType(id) !== "p" ||
    from.type === "p" ||
    !hasText(from.type)
  )
    return;
  doc.setType(id, from.type);
  for (const [k, v] of Object.entries(from.attrs)) doc.setAttr(id, k, v);
}

/**
 * A caret in the first text block after `id`, making a paragraph if there's none.
 * @param {Ctx} ctx @param {string} id
 * @returns {Pos}
 */
export function afterBlock(ctx, id) {
  const { doc } = ctx;
  const flat = flatBlocks(ctx);
  const index = flat.indexOf(id);
  // Past a table's own rows and cells.
  const next =
    doc.getType(id) === TABLE
      ? flat.slice(index + 1).find((b) => tableOf(doc, b) !== id)
      : flat[index + 1];
  if (next !== undefined && hasText(doc.getType(next))) return { block: next, offset: 0 };
  const p = createBlock(doc, { type: "p", parent: parentOf(doc, id), after: id });
  return { block: p, offset: 0 };
}

/**
 * The slash menu's block items: an empty block becomes `type` (a divider
 * gets a paragraph below it); a block with text stays as it is and gets a
 * new block of `type` below it, as in Notion.
 * @param {Ctx} ctx @param {string} id @param {string} type
 * @returns {Pos}
 */
export function applyBlockType(ctx, id, type) {
  const { doc } = ctx;
  // In a cell, the new block goes after the table.
  const table = doc.getType(id) === CELL ? tableOf(doc, id) : null;
  if (table !== null) id = table;
  const empty = table === null && doc.textLength(id) === 0;
  if (empty && (type !== "divider" || doc.children(id).length === 0)) {
    turnInto(ctx, [id], type);
    return type === "divider" ? exitBlock(ctx, id) : { block: id, offset: 0 };
  }
  const created = createBlock(doc, { type, parent: parentOf(doc, id), after: id });
  if (type === "toggle") ctx.setOpen?.(created, true);
  return type === "divider" ? exitBlock(ctx, created) : { block: created, offset: 0 };
}

/**
 * The slash menu's embeds (a database): an empty block becomes the embed,
 * one with text gets it below; either way the caret goes to a paragraph
 * after it.
 * @param {Ctx} ctx @param {string} id @param {string} type @param {Record<string, unknown>} attrs
 * @returns {Pos}
 */
export function insertEmbed(ctx, id, type, attrs) {
  const { doc } = ctx;
  const table = doc.getType(id) === CELL ? tableOf(doc, id) : null;
  if (table !== null) id = table;
  else if (doc.textLength(id) === 0 && doc.children(id).length === 0) {
    doc.setType(id, type);
    for (const [key, value] of Object.entries(attrs)) doc.setAttr(id, key, value);
    return exitBlock(ctx, id);
  }
  const created = createBlock(doc, { type, parent: parentOf(doc, id), after: id, attrs });
  return exitBlock(ctx, created);
}

/**
 * Delete blocks (with their subtrees). Returns a caret in the text block
 * before them on screen, or after them, or in a new empty paragraph.
 * @param {Ctx} ctx @param {string[]} ids Outermost blocks, in screen order.
 * @returns {Pos}
 */
export function deleteBlocks(ctx, ids) {
  const { doc } = ctx;
  if (ids.length === 0) return ensureBlock(ctx);
  const gone = new Set(ids);
  const flat = flatBlocks(ctx);
  const inside = (/** @type {string} */ id) => {
    for (let a = /** @type {string | null} */ (id); a !== null; a = parentOf(doc, a))
      if (gone.has(a)) return true;
    return false;
  };
  const first = flat.indexOf(ids[0]);
  const before = flat
    .slice(0, Math.max(0, first))
    .reverse()
    .find((id) => !inside(id) && hasText(doc.getType(id)));
  for (const id of ids) doc.deleteBlock(id);
  if (before !== undefined) return { block: before, offset: doc.textLength(before) };
  const after = flat.slice(first + 1).find((id) => !inside(id) && hasText(doc.getType(id)));
  return after !== undefined ? { block: after, offset: 0 } : ensureBlock(ctx);
}

/**
 * Copy blocks (with their subtrees), each right after the last of them.
 * Returns a caret at the end of the last copy's text.
 * @param {Ctx} ctx @param {string[]} ids Outermost blocks, in screen order.
 * @returns {Pos | null}
 */
export function duplicateBlocks(ctx, ids) {
  const { doc } = ctx;
  if (ids.length === 0) return null;
  /** @param {string} id @param {string | null} parent @param {string | null} after @returns {string} */
  const copy = (id, parent, after) => {
    const type = doc.getType(id);
    const created = createBlock(doc, {
      type,
      parent,
      after,
      attrs: doc.getAttrs(id),
      text: hasText(type) ? doc.getTextRuns(id) : [],
    });
    if (type === "toggle") ctx.setOpen?.(created, ctx.isOpen(id));
    /** @type {string | null} */
    let prev = null;
    for (const child of doc.children(id)) prev = copy(child, created, prev);
    return created;
  };
  const last = ids[ids.length - 1];
  let after = last;
  /** @type {string} */
  let made = last;
  for (const id of ids) {
    made = copy(id, parentOf(doc, last), after);
    after = made;
  }
  return hasText(doc.getType(made))
    ? { block: made, offset: doc.textLength(made) }
    : afterBlock(ctx, made);
}

/**
 * Move blocks (with their subtrees) to `parent`, the first right after
 * `after` (null: first child) and the rest after it in order. Does nothing
 * and returns false if that would put a block inside itself, or `after` is
 * one of them.
 * @param {Ctx} ctx @param {string[]} ids Outermost blocks, in screen order.
 * @param {{ parent: string | null, after: string | null }} to
 */
export function moveBlocks(ctx, ids, to) {
  const { doc } = ctx;
  const moving = new Set(ids);
  if (to.after !== null && moving.has(to.after)) return false;
  if (
    (to.parent !== null && !holdsBlocks(doc.getType(to.parent))) ||
    ids.some((id) => isTablePart(doc.getType(id)))
  )
    return false;
  for (let a = to.parent; a !== null; a = parentOf(doc, a)) if (moving.has(a)) return false;
  let after = to.after;
  for (const id of ids) {
    doc.moveBlock(id, { parent: to.parent, after });
    after = id;
  }
  if (to.parent !== null && doc.getType(to.parent) === "toggle") ctx.setOpen?.(to.parent, true);
  return true;
}

/**
 * ⌘⇧↑ / ⌘⇧↓: move blocks one step up or down among their siblings; from
 * the first (or last) place, out of their parent to just before (or after)
 * it. Returns false when there's nowhere to go.
 * @param {Ctx} ctx @param {string[]} ids Outermost sibling blocks, in order.
 * @param {-1 | 1} dir
 */
export function moveBlocksBy(ctx, ids, dir) {
  const { doc } = ctx;
  if (ids.length === 0) return false;
  const parent = parentOf(doc, ids[0]);
  if (ids.some((id) => parentOf(doc, id) !== parent)) return false;
  const siblings = doc.children(parent);
  const first = siblings.indexOf(ids[0]);
  const last = siblings.indexOf(ids[ids.length - 1]);
  if (dir < 0 && first > 0)
    return moveBlocks(ctx, ids, { parent, after: first > 1 ? siblings[first - 2] : null });
  if (dir > 0 && last < siblings.length - 1)
    return moveBlocks(ctx, ids, { parent, after: siblings[last + 1] });
  if (parent === null) return false;
  const grandparent = parentOf(doc, parent);
  const outer = doc.children(grandparent);
  const at = outer.indexOf(parent);
  return moveBlocks(ctx, ids, {
    parent: grandparent,
    after: dir < 0 ? (at > 0 ? outer[at - 1] : null) : parent,
  });
}

/**
 * Set (or with null clear) blocks' color: a color name, or `<name>_background`.
 * @param {Ctx} ctx @param {string[]} ids @param {string | null} color
 */
export function setBlockColor(ctx, ids, color) {
  for (const id of ids) ctx.doc.setAttr(id, "color", color);
}

/**
 * Leave a block (a code block, with ⌘Enter): a caret in an empty paragraph
 * right after it, reusing one that's already there.
 * @param {Ctx} ctx @param {string} id
 * @returns {Pos}
 */
export function exitBlock(ctx, id) {
  const { doc } = ctx;
  const parent = parentOf(doc, id);
  const siblings = doc.children(parent);
  const next = siblings[siblings.indexOf(id) + 1];
  if (
    next !== undefined &&
    doc.getType(next) === "p" &&
    doc.textLength(next) === 0 &&
    doc.children(next).length === 0
  ) {
    return { block: next, offset: 0 };
  }
  return { block: createBlock(doc, { type: "p", parent, after: id }), offset: 0 };
}

/**
 * Make sure the document has a block to type in: an empty document gets
 * one empty paragraph. Returns the first text block's start.
 * @param {Ctx} ctx
 * @returns {Pos}
 */
export function ensureBlock(ctx) {
  const first = textBlocks(ctx)[0];
  if (first !== undefined) return { block: first, offset: 0 };
  const id = createBlock(ctx.doc, { type: "p", parent: null, after: undefined });
  return { block: id, offset: 0 };
}

/**
 * Clicking below the last block: put the caret in an empty paragraph at
 * the end, adding one unless the last block already is one.
 * @param {Ctx} ctx
 * @returns {Pos}
 */
export function appendParagraph(ctx) {
  const { doc } = ctx;
  const root = doc.children(null);
  const last = root[root.length - 1];
  if (
    last !== undefined &&
    doc.getType(last) === "p" &&
    doc.textLength(last) === 0 &&
    doc.children(last).length === 0
  ) {
    return { block: last, offset: 0 };
  }
  const id = createBlock(doc, { type: "p", parent: null, after: undefined });
  return { block: id, offset: 0 };
}
