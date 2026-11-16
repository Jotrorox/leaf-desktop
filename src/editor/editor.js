// @ts-check
import { batch, createSignal, untrack } from "solid-js";
import {
  EQUATION_KEY,
  hasText,
  isPlainText,
  MATH_MARK,
  MATH_MARKS,
  mathId,
  normalizeLinkInput,
  safeImageSrc,
  spec,
  TURN_INTO_KEYS,
} from "./blocks/schema.js";
import { CELL_SLASH_ITEMS, filterSlashItems } from "./blocks/slash-items.js";
import { parseHtml } from "./clipboard/parse-html.js";
import { parsePlainText } from "./clipboard/parse-text.js";
import { escapeHtml, SLICE_MIME, sliceToHtml, sliceToText } from "./clipboard/serialize.js";
import {
  afterBlock,
  appendParagraph,
  applyBlockType,
  caret,
  createBlock,
  deleteBlocks,
  deleteRange,
  deleteSelection,
  duplicateBlocks,
  ensureBlock,
  exitBlock,
  flatBlocks,
  getSlice,
  hasMark,
  indent,
  insertEmbed,
  insertSlice,
  insertText,
  isCollapsed,
  isValidPos,
  joinBackward,
  joinForward,
  moveBlocks,
  moveBlocksBy,
  ordered,
  outdent,
  selectedBlocks,
  setBlockColor,
  setMark,
  splitBlock,
  textBlocks,
  textRanges,
  toggleChecked,
  toggleMark,
  turnInto,
} from "./commands/commands.js";
import { findInputRule, findTableRule } from "./commands/markdown.js";
import {
  expandToMath,
  freshMathIds,
  marksAt,
  marksOfChar,
  mathAt,
  mathRanges,
  sliceRuns,
} from "./commands/runs.js";
import {
  CELL,
  cellPlace,
  columnCount,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  insertTable,
  moveColumn,
  moveRow,
  stepCell,
  TABLE,
  tableGrid,
  tableOf,
  verticalCell,
} from "./commands/table.js";
import { isEscaped, matchTexCommands, pageCommands } from "./math/commands.js";
import { NO_NUMBERING, NUMBERED_ATTR, numberEquations, sameNumbering } from "./math/refs.js";
import { MACROS_META, parseMacros } from "./math/render.js";
import { UndoManager } from "./model/undo.js";
import {
  domText,
  domToPos,
  isMathElement,
  mathElements,
  readSelection,
  rectAt,
  scrollCaretIntoView,
  writeSelection,
} from "./view/dom.js";

/**
 * The editor controller: owns the model's reactive view state and turns
 * every input event into a command.
 *
 * The model is the only source of truth. `beforeinput` is cancelled for
 * every kind of input, and the command it maps to changes the model in one
 * transaction; observers bump per-block signals, Solid re-renders just
 * those blocks synchronously, and then the DOM selection is set from the
 * model selection. The one exception is IME composition, which the browser
 * must be allowed to draw: the DOM changes while composing, and on
 * `compositionend` the composed text is diffed against the model and
 * applied (see `flushComposition`).
 */

/** @typedef {import("./model/doc.js").Doc} Doc */
/** @typedef {import("./model/doc.js").RelativePosition} RelativePosition */
/** @typedef {import("./commands/commands.js").Ctx} Ctx */
/** @typedef {import("./commands/commands.js").Pos} Pos */
/** @typedef {import("./commands/commands.js").Sel} Sel */
/** @typedef {import("./commands/commands.js").Slice} Slice */

/**
 * A menu opened by typing a trigger character: `/` (blocks), `@` (pages)
 * or, in an equation's source, `\` (TeX commands). `offset` is where the
 * trigger character is; `query` is what's typed after it.
 * @typedef {{ kind: "slash" | "mention" | "tex", block: string, offset: number, query: string }} Suggestion
 */

/** @type {Record<Suggestion["kind"], string>} */
const TRIGGERS = { slash: "/", mention: "@", tex: "\\" };

/**
 * The inline formula being edited in its popover. `id` is the formula's
 * (null for a new one); `start` and `end` are where it was when the
 * popover opened, and `at` is that start anchored to a character, for
 * when the text around it changes meanwhile.
 * `chars` anchors the position before and after each character of the
 * formula, to place the edit when the popover closes.
 * @typedef {{ block: string, id: unknown, source: string, start: number, end: number, at: RelativePosition | null, chars: { before: RelativePosition[], after: RelativePosition[] } | null }} MathEdit
 */

/** A doc's macro definitions (TeX), or "". @param {import("./model/doc.js").Doc} doc */
const metaMacros = (doc) => {
  const value = doc.getMeta(MACROS_META);
  return typeof value === "string" ? value : "";
};

/** @param {Suggestion | null} a @param {Suggestion | null} b */
const sameSuggestion = (a, b) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.kind === b.kind &&
    a.block === b.block &&
    a.offset === b.offset &&
    a.query === b.query);

/**
 * What a table's menus can do to the row or column of a cell (or, for
 * `add-row` and `add-column`, to the table's end).
 * @typedef {"row-above" | "row-below" | "column-left" | "column-right" | "delete-row" | "delete-column" | "move-row-up" | "move-row-down" | "move-column-left" | "move-column-right" | "add-row" | "add-column"} TableAction
 */

/** Transaction origins. Only LOCAL changes are undoable. */
export const LOCAL = "local";
const SETUP = "setup";

const IS_APPLE =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** @param {KeyboardEvent} e */
const mod = (e) => (IS_APPLE ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);

/** @param {Pos | Sel} p @returns {Sel} */
const toSel = (p) => ("anchor" in p ? p : caret(p));

/** @param {Sel | null} a @param {Sel | null} b */
function sameSel(a, b) {
  if (a === null || b === null) return a === b;
  return (
    a.anchor.block === b.anchor.block &&
    a.anchor.offset === b.anchor.offset &&
    a.focus.block === b.focus.block &&
    a.focus.offset === b.focus.offset
  );
}

/** @type {Intl.Segmenter | null} */
const graphemes =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;
/** @type {Intl.Segmenter | null} */
const words =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : null;

/**
 * The offset one grapheme (or word) away from `offset`. A word step skips
 * spaces and punctuation first, then the word.
 * @param {string} text @param {number} offset @param {-1 | 1} dir @param {"grapheme" | "word"} unit
 */
function step(text, offset, dir, unit) {
  const seg = unit === "word" ? words : graphemes;
  if (!seg) return Math.max(0, Math.min(text.length, offset + dir));
  const parts = [...seg.segment(text)];
  if (dir < 0) {
    let target = offset;
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      if (p.index >= offset) continue;
      target = p.index;
      if (unit === "grapheme" || p.isWordLike) break;
    }
    return target;
  }
  for (const p of parts) {
    const end = p.index + p.segment.length;
    if (end <= offset) continue;
    if (unit === "grapheme" || p.isWordLike) return end;
  }
  return text.length;
}

export class EditorController {
  /** @type {Doc} */
  doc;
  /** @type {UndoManager} */
  undo;
  readOnly;
  /** The contenteditable element, once mounted. @type {HTMLElement | null} */
  root = null;
  /** block id → its text element. @type {Map<string, HTMLElement>} */
  textEls = new Map();
  /** @type {Sel | null} */
  selection = null;
  /**
   * Marks for the next typed text, set by ⌘B and friends at a caret or
   * after a Markdown rule. Dropped when the caret moves elsewhere.
   * @type {Record<string, unknown> | null}
   */
  storedMarks = null;
  /** @type {Pos | null} */
  #storedAt = null;

  // Reactive view state.
  /** @type {Map<string, import("solid-js").Signal<number>>} */
  #versions = new Map();
  #structure = createSignal(0);
  /** @type {Map<string, import("solid-js").Signal<boolean>>} */
  #open = new Map();
  #focused = createSignal(/** @type {string | null} */ (null));
  #link = createSignal(/** @type {{ sel: Sel, href: string } | null} */ (null));
  #suggestion = createSignal(/** @type {Suggestion | null} */ (null), { equals: sameSuggestion });
  /** Bumped whenever the selection changes (for the toolbars). */
  #selectionVersion = createSignal(0);
  /** Blocks shown as selected while the block menu is open or they're dragged. */
  #highlighted = createSignal(/** @type {ReadonlySet<string>} */ (new Set()));
  #math = createSignal(/** @type {MathEdit | null} */ (null));
  /** The page's macro definitions (TeX), from doc meta. */
  #macros = createSignal("");
  /** Whether the page macros dialog is open. */
  #macrosOpen = createSignal(false);
  /** The page's equation numbers and labels (refs.js). */
  #numbering = createSignal(/** @type {import("./math/refs.js").Numbering} */ (NO_NUMBERING), {
    equals: sameNumbering,
  });
  /** Every equation block, as of the last numbering: a change to one can renumber. @type {ReadonlySet<string>} */
  #equations = new Set();
  /** Formula elements and equation rows drawn as selected. @type {Set<HTMLElement>} */
  #selectedMath = new Set();

  /** Blocks being composed in, while an IME composition is open. @type {Set<string> | null} */
  #composing = null;
  /** compositionend happened; the DOM still has to be read. */
  #compositionPending = false;
  /** @type {Uint8Array[]} */
  #deferredRemote = [];
  /** The undo step the last local change opened or joined. @type {import("./model/undo.js").StackItem | null} */
  #lastStep = null;
  /**
   * The selection before the running command, anchored to characters
   * before the command changes anything (afterwards its offsets may no
   * longer exist). @type {{ anchor: RelativePosition, focus: RelativePosition } | null}
   */
  #relBefore = null;
  /** Selection to restore after undo/redo. @type {Sel | null} */
  #restore = null;
  #cleanups = /** @type {(() => void)[]} */ ([]);
  /** @type {() => void} */
  onExitTop = () => {};
  /** Go to an in-app path (a page mention or a link to a page was opened). @type {(path: string) => void} */
  onNavigate = () => {};
  /** Open the block menu for a block (⌘/). @type {(blockId: string) => void} */
  onBlockMenu = () => {};
  /**
   * The slash menu's "Database": creates an inline database (a subpage)
   * and returns its id, or null when it can't.
   * @type {() => string | null}
   */
  onCreateDatabase = () => null;
  /**
   * Image files pasted, dropped or picked: upload them and put image blocks
   * at block `at` (`insertImage`). Set by the editor view.
   * @type {(files: File[], at: string | null) => void}
   */
  onImages = () => {};
  /** The slash menu's "Image": ask for files for block `at`. @type {(at: string) => void} */
  onPickImage = () => {};
  /**
   * An image block's picture URL, for copying to other apps.
   * @type {import("./clipboard/serialize.js").ImageUrl}
   */
  imageUrl = (attrs) => safeImageSrc(attrs.src);
  /**
   * The open suggestion menu's key handler: ↑, ↓, Enter or Tab. Returns
   * whether it handled the key. Set by the menu while it's open.
   * @type {((key: string) => boolean) | null}
   */
  suggestionKeys = null;

  /** @type {Ctx} */
  ctx;

  /**
   * @param {Doc} doc
   * @param {{ readOnly?: boolean }} [options]
   */
  constructor(doc, { readOnly = false } = {}) {
    this.doc = doc;
    this.readOnly = readOnly;
    this.undo = new UndoManager(doc, { trackedOrigins: [LOCAL] });
    this.ctx = {
      doc,
      isOpen: (id) => untrack(() => this.isOpen(id)),
      setOpen: (id, open) => this.setOpen(id, open),
    };
    this.#macros[1](metaMacros(doc));
    this.#renumber();
    this.#cleanups.push(
      doc.observe((e) => {
        batch(() => {
          for (const id of e.changedBlockIds) this.#bump(id);
          if (e.structureChanged) this.#structure[1]((n) => n + 1);
          if (e.metaChanged) this.#macros[1](metaMacros(doc));
          if (
            e.structureChanged ||
            [...e.changedBlockIds].some(
              (id) =>
                this.#equations.has(id) || (doc.hasBlock(id) && doc.getType(id) === "equation"),
            )
          )
            this.#renumber();
        });
      }),
    );
    this.#cleanups.push(
      this.undo.observe((e) => {
        if (e.type === "added" || e.type === "updated") {
          if (e.type === "added") e.item.meta.set("before", this.#relBefore);
          this.#lastStep = e.item;
        } else {
          const rel =
            /** @type {{ anchor: RelativePosition, focus: RelativePosition } | null | undefined} */ (
              e.item.meta.get(e.type === "undo" ? "before" : "after")
            );
          this.#restore = this.#resolve(rel ?? null);
        }
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Reactive reads (for the view)

  /** @param {string} id */
  #signal(id) {
    let s = this.#versions.get(id);
    if (!s) this.#versions.set(id, (s = createSignal(0)));
    return s;
  }

  /** @param {string} id */
  #bump(id) {
    this.#versions.get(id)?.[1]((n) => n + 1);
  }

  /** Changes whenever block `id`'s type, attrs or text change. @param {string} id */
  version(id) {
    return this.#signal(id)[0]();
  }

  /** Changes whenever any block is added, removed or moved. */
  structure() {
    return this.#structure[0]();
  }

  /** Whether a toggle is open. @param {string} id */
  isOpen(id) {
    let s = this.#open.get(id);
    if (!s) this.#open.set(id, (s = createSignal(false)));
    return s[0]();
  }

  /** @param {string} id @param {boolean} open */
  setOpen(id, open) {
    let s = this.#open.get(id);
    if (!s) this.#open.set(id, (s = createSignal(open)));
    else s[1](open);
  }

  /** The block holding the caret. */
  focusedBlock() {
    return this.#focused[0]();
  }

  /** The link being edited (⌘K), or null. */
  linkRequest() {
    return this.#link[0]();
  }

  /** The page's macro definitions (TeX source; "" for none), tracked. */
  mathMacros() {
    return this.#macros[0]();
  }

  /** Whether the page macros dialog is open. */
  macrosOpen() {
    return this.#macrosOpen[0]();
  }

  /** Open or close the page macros dialog. @param {boolean} open */
  setMacrosOpen(open) {
    if (open && this.readOnly) return;
    this.#macrosOpen[1](open);
  }

  /**
   * Replace the page's macro definitions (one undo step; every formula
   * redraws with them).
   * @param {string} source
   */
  setMathMacros(source) {
    if (this.readOnly || source === untrack(() => this.#macros[0]())) return;
    // Without touching the selection: the dialog has focus.
    this.#commit(
      (ctx) => {
        ctx.doc.setMeta(MACROS_META, source.trim() === "" ? null : source);
      },
      /** @type {Sel} */ (this.selection),
    );
  }

  /** Number the page's equations again (views only hear of it when something changed). */
  #renumber() {
    const { equations, ...numbering } = numberEquations(this.doc);
    this.#equations = equations;
    this.#numbering[1](numbering);
  }

  /** The page's equation numbers and labels, tracked. */
  equationNumbering() {
    return this.#numbering[0]();
  }

  /**
   * Number equations, or stop numbering them (one undo step).
   * @param {string[]} ids @param {boolean} numbered
   */
  setEquationsNumbered(ids, numbered) {
    this.run(
      (ctx, sel) => {
        for (const id of ids)
          if (ctx.doc.getType(id) === "equation")
            ctx.doc.setAttr(id, NUMBERED_ATTR, numbered ? true : null);
        return sel ?? undefined;
      },
      { needsSelection: false },
    );
  }

  /** The inline formula being edited, or null. */
  mathRequest() {
    return this.#math[0]();
  }

  /**
   * Whether an equation block shows its source: while the caret (or one
   * end of the selection) is in it and the editor has focus.
   * @param {string} id
   */
  isEditingEquation(id) {
    if (this.readOnly || this.focusedBlock() === null) return false;
    const sel = this.trackedSelection();
    return sel !== null && (sel.focus.block === id || sel.anchor.block === id);
  }

  /** The open slash or mention menu, or null. */
  suggestion() {
    return this.#suggestion[0]();
  }

  closeSuggestion() {
    this.#suggestion[1](null);
  }

  /** The selection, tracked: re-runs when it changes. */
  trackedSelection() {
    this.#selectionVersion[0]();
    return this.selection;
  }

  /** Whether the selection is exactly one inline formula, tracked. */
  selectionIsFormula() {
    this.trackedSelection();
    return this.#selectedFormula() !== null;
  }

  /** Blocks drawn as selected (block menu, drag). */
  highlighted() {
    return this.#highlighted[0]();
  }

  /** @param {Iterable<string>} ids */
  setHighlighted(ids) {
    this.#highlighted[1](new Set(ids));
  }

  /** @param {string} id */
  isComposingIn(id) {
    return this.#composing !== null && this.#composing.has(id);
  }

  // -------------------------------------------------------------------------
  // Mounting

  /** @param {HTMLElement} root */
  mount(root) {
    this.root = root;
    /** @type {[EventTarget, string, (e: any) => void][]} */
    const listeners = [
      [root, "beforeinput", (e) => this.#onBeforeInput(e)],
      [root, "keydown", (e) => this.#onKeyDown(e)],
      [root, "compositionstart", () => this.#onCompositionStart()],
      [root, "compositionupdate", () => this.#onCompositionUpdate()],
      [root, "compositionend", () => this.#onCompositionEnd()],
      [root, "copy", (e) => this.#onCopy(e, false)],
      [root, "cut", (e) => this.#onCopy(e, true)],
      [root, "paste", (e) => this.#onPaste(e)],
      [root, "focus", () => this.#onFocus()],
      [
        root,
        "blur",
        () => {
          this.#focused[1](null);
          this.closeSuggestion();
        },
      ],
      [root, "click", (e) => this.#onClick(e)],
      [root, "mousedown", (e) => this.#onMouseDown(e)],
      [root, "dragstart", (e) => e.preventDefault()],
      [
        root,
        "dragover",
        (e) => {
          // Image files can be dropped in; nothing else.
          if (!this.readOnly && hasFiles(e.dataTransfer)) {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
          }
        },
      ],
      [root, "drop", (e) => this.#onDrop(e)],
      [document, "selectionchange", () => this.#onSelectionChange()],
    ];
    for (const [target, type, fn] of listeners) {
      // Embedded blocks (a database's table) handle their own input.
      const guarded = target === root ? (/** @type {any} */ e) => void (fromEmbed(e) || fn(e)) : fn;
      target.addEventListener(type, guarded);
      this.#cleanups.push(() => target.removeEventListener(type, guarded));
    }
  }

  destroy() {
    for (const fn of this.#cleanups.splice(0)) fn();
    this.undo.destroy();
    this.root = null;
  }

  // -------------------------------------------------------------------------
  // Selection

  /** @param {Sel | null} sel */
  #relative(sel) {
    if (!sel) return null;
    try {
      return {
        anchor: this.doc.createRelativePosition(sel.anchor.block, sel.anchor.offset),
        focus: this.doc.createRelativePosition(sel.focus.block, sel.focus.offset),
      };
    } catch {
      return null;
    }
  }

  /** @param {{ anchor: RelativePosition, focus: RelativePosition } | null} rel @returns {Sel | null} */
  #resolve(rel) {
    if (!rel) return null;
    const anchor = this.doc.resolveRelativePosition(rel.anchor);
    const focus = this.doc.resolveRelativePosition(rel.focus);
    if (!anchor || !focus) return null;
    const sel = {
      anchor: { block: anchor.blockId, offset: anchor.offset },
      focus: { block: focus.blockId, offset: focus.offset },
    };
    return isValidPos(this.ctx, sel.anchor) && isValidPos(this.ctx, sel.focus) ? sel : null;
  }

  /**
   * Set the model selection and draw it.
   * @param {Sel} sel
   * @param {{ scroll?: boolean }} [options]
   */
  setSelection(sel, { scroll = true } = {}) {
    sel = this.#outsideMath(sel);
    this.selection = sel;
    this.#focused[1](sel.focus.block);
    this.#selectionChanged();
    if (!this.root) return;
    writeSelection(this.root, (id) => this.textEls.get(id), sel);
    if (scroll) scrollCaretIntoView(this.root);
  }

  /** The selection, made valid: a fallback when the old one points at a deleted block. */
  #currentSelection() {
    const sel = this.selection;
    if (sel && isValidPos(this.ctx, sel.anchor) && isValidPos(this.ctx, sel.focus)) return sel;
    const blocks = textBlocks(this.ctx);
    const first = blocks[0];
    return first === undefined ? null : caret({ block: first, offset: 0 });
  }

  #onSelectionChange() {
    if (!this.root || this.#composing) {
      if (this.#composing && this.root) {
        const sel = readSelection(this.root);
        if (sel) this.#composing.add(sel.focus.block);
      }
      return;
    }
    if (this.root.ownerDocument.activeElement !== this.root) return;
    const sel = readSelection(this.root);
    if (!sel) return;
    if (sameSel(sel, this.selection)) {
      // Focus came back to the same selection (after a blur).
      if (untrack(() => this.#focused[0]()) === null) {
        this.#focused[1](sel.focus.block);
        this.#selectionChanged();
      }
      return;
    }
    this.selection = sel;
    this.#focused[1](sel.focus.block);
    this.#selectionChanged();
    if (
      this.#storedAt &&
      (sel.focus.block !== this.#storedAt.block ||
        sel.focus.offset !== this.#storedAt.offset ||
        !isCollapsed(sel))
    ) {
      this.storedMarks = null;
      this.#storedAt = null;
    }
  }

  /** Read the DOM selection now (events can arrive before selectionchange). */
  #syncSelection() {
    if (!this.root || this.#composing) return;
    const sel = readSelection(this.root);
    if (sel && !sameSel(sel, this.selection)) {
      this.selection = sel;
      this.#selectionChanged();
      if (
        this.#storedAt &&
        (sel.focus.block !== this.#storedAt.block || sel.focus.offset !== this.#storedAt.offset)
      ) {
        this.storedMarks = null;
        this.#storedAt = null;
      }
    }
  }

  #selectionChanged() {
    this.#selectionVersion[1]((n) => n + 1);
    this.#updateSuggestion();
    this.#drawSelectedMath();
  }

  /**
   * The selection with any end that's inside a formula moved to the
   * formula's end (a remote change can leave one there).
   * @param {Sel} sel
   */
  #outsideMath(sel) {
    /** @param {Pos} pos */
    const snap = (pos) => {
      if (
        !this.doc.hasBlock(pos.block) ||
        !hasText(this.doc.getType(pos.block)) ||
        pos.offset === 0
      )
        return pos;
      const m = mathAt(this.doc.getTextRuns(pos.block), pos.offset - 1);
      return m && m.end > pos.offset ? { block: pos.block, offset: m.end } : pos;
    };
    const anchor = snap(sel.anchor);
    const focus = snap(sel.focus);
    return anchor === sel.anchor && focus === sel.focus ? sel : { anchor, focus };
  }

  /**
   * Formulas wholly inside the selection get `data-selected`, and so do
   * closed equations it spans: they hold no text to highlight.
   */
  #drawSelectedMath() {
    for (const el of this.#selectedMath) delete el.dataset.selected;
    this.#selectedMath.clear();
    const sel = this.selection;
    if (!sel || isCollapsed(sel) || !this.root) return;
    let ranges;
    try {
      ranges = textRanges(this.ctx, sel);
    } catch {
      return;
    }
    if (sel.anchor.block !== sel.focus.block) {
      const { flat, fromIndex, toIndex } = ordered(this.ctx, sel);
      for (const id of flat.slice(fromIndex + 1, toIndex)) {
        const row =
          this.doc.getType(id) === "equation" ? this.textEls.get(id)?.closest("[data-row]") : null;
        if (!(row instanceof HTMLElement)) continue;
        row.dataset.selected = "";
        this.#selectedMath.add(row);
      }
    }
    for (const { block, start, end } of ranges) {
      const el = this.textEls.get(block);
      if (!el) continue;
      for (const m of mathElements(el)) {
        if (m.start < start || m.end > end) continue;
        m.el.dataset.selected = "";
        this.#selectedMath.add(m.el);
      }
    }
  }

  /**
   * The formula the selection is exactly, or null.
   * @returns {{ block: string, start: number, end: number } | null}
   */
  #selectedFormula() {
    const sel = this.selection;
    if (!sel || isCollapsed(sel) || sel.anchor.block !== sel.focus.block) return null;
    const start = Math.min(sel.anchor.offset, sel.focus.offset);
    const end = Math.max(sel.anchor.offset, sel.focus.offset);
    const m = mathAt(this.doc.getTextRuns(sel.focus.block), start);
    return m && m.start === start && m.end === end ? { block: sel.focus.block, start, end } : null;
  }

  // -------------------------------------------------------------------------
  // Slash and mention menus

  /**
   * Open a menu if `typed` is a trigger character typed at the start of a
   * block or after a space (so "and/or" and email addresses don't).
   * @param {Pos} at The caret right after the typed text. @param {string} typed
   */
  #maybeOpenSuggestion(at, typed) {
    if (typed === "\\" && at.offset >= 1 && this.doc.getType(at.block) === "equation") {
      if (!isEscaped(this.doc.getText(at.block), at.offset - 1))
        this.#suggestion[1]({ kind: "tex", block: at.block, offset: at.offset - 1, query: "" });
      return;
    }
    const kind = typed === "/" ? "slash" : typed === "@" ? "mention" : null;
    if (!kind || at.offset < 1) return;
    const type = this.doc.getType(at.block);
    if (!hasText(type) || isPlainText(type)) return;
    const before = this.doc.getText(at.block)[at.offset - 2];
    if (before !== undefined && !/\s/.test(before)) return;
    this.#suggestion[1]({ kind, block: at.block, offset: at.offset - 1, query: "" });
  }

  /** Follow the caret: update the query, or close the menu once the caret leaves it. */
  #updateSuggestion() {
    const s = untrack(() => this.#suggestion[0]());
    if (!s) return;
    const sel = this.selection;
    const text =
      this.doc.hasBlock(s.block) && this.doc.isVisible(s.block) ? this.doc.getText(s.block) : null;
    if (
      !sel ||
      !isCollapsed(sel) ||
      sel.focus.block !== s.block ||
      text === null ||
      text[s.offset] !== TRIGGERS[s.kind] ||
      sel.focus.offset <= s.offset
    ) {
      this.closeSuggestion();
      return;
    }
    const query = text.slice(s.offset + 1, sel.focus.offset);
    // A TeX command is letters, and closes once nothing in the list matches.
    if (s.kind === "tex") {
      const own = pageCommands(
        parseMacros(untrack(() => this.#macros[0]()))?.names ?? [],
        untrack(() => this.#numbering[0]()).refs,
      );
      if (/[^A-Za-z]/.test(query) || matchTexCommands(query, 1, own).length === 0)
        this.closeSuggestion();
      else this.#suggestion[1]({ ...s, query });
      return;
    }
    // A space right after the trigger, a line break, or (for blocks) a few
    // letters past the last match mean it wasn't meant as a command.
    if (
      /^\s|\n/.test(query) ||
      query.length > 60 ||
      (s.kind === "slash" && this.#slashGaveUp(query, s.block))
    ) {
      this.closeSuggestion();
      return;
    }
    this.#suggestion[1]({ ...s, query });
  }

  /** @param {string} query @param {string} block */
  #slashGaveUp(query, block) {
    const items = this.doc.getType(block) === CELL ? CELL_SLASH_ITEMS : undefined;
    for (let n = query.length; n >= 0; n--) {
      if (filterSlashItems(query.slice(0, n), items).length > 0) return query.length - n >= 3;
    }
    return true;
  }

  /**
   * Close the menu and return it, if its trigger and query are still in the text.
   * @param {Suggestion["kind"]} kind
   */
  #takeSuggestion(kind) {
    const s = untrack(() => this.#suggestion[0]());
    this.closeSuggestion();
    if (!s || s.kind !== kind || !this.doc.hasBlock(s.block)) return null;
    const text = this.doc.getText(s.block);
    if (text.slice(s.offset, s.offset + 1 + s.query.length) !== TRIGGERS[kind] + s.query)
      return null;
    return s;
  }

  /**
   * Apply the slash menu item picked: the typed `/query` goes away, then
   * the block changes (or a mention menu opens).
   * @param {import("./blocks/slash-items.js").SlashItem} item
   */
  applySlashItem(item) {
    if (this.readOnly) return;
    const s = this.#takeSuggestion("slash");
    if (!s) return;
    const length = 1 + s.query.length;
    if (item.action.kind === "mention") {
      const at = this.run((ctx) => {
        ctx.doc.deleteText(s.block, s.offset, length);
        return insertText(ctx, caret({ block: s.block, offset: s.offset }), "@");
      });
      if (at)
        this.#suggestion[1]({
          kind: "mention",
          block: at.focus.block,
          offset: at.focus.offset - 1,
          query: "",
        });
      return;
    }
    if (item.action.kind === "inline-math") {
      const at = this.run((ctx) => {
        ctx.doc.deleteText(s.block, s.offset, length);
        return caret({ block: s.block, offset: s.offset });
      });
      if (at) this.#openMath(at.focus.block, at.focus.offset);
      return;
    }
    if (item.action.kind === "image") {
      const at = this.run((ctx) => {
        ctx.doc.deleteText(s.block, s.offset, length);
        return caret({ block: s.block, offset: s.offset });
      });
      if (at) this.onPickImage(at.focus.block);
      return;
    }
    if (item.action.kind === "table") {
      this.run((ctx) => {
        ctx.doc.deleteText(s.block, s.offset, length);
        return insertTable(ctx, s.block);
      });
      return;
    }
    if (item.action.kind === "database") {
      const database = this.onCreateDatabase();
      this.run((ctx) => {
        ctx.doc.deleteText(s.block, s.offset, length);
        return database
          ? insertEmbed(ctx, s.block, "database", { database })
          : caret({ block: s.block, offset: s.offset });
      });
      return;
    }
    const type = item.action.type;
    this.run((ctx) => {
      ctx.doc.deleteText(s.block, s.offset, length);
      return applyBlockType(ctx, s.block, type);
    });
  }

  /**
   * Replace the typed `\query` in an equation's source with a TeX command.
   * @param {import("./math/commands.js").TexCommand} command
   */
  applyTexCommand(command) {
    if (this.readOnly) return;
    const s = this.#takeSuggestion("tex");
    if (!s) return;
    this.run((ctx) => {
      ctx.doc.deleteText(s.block, s.offset, 1 + s.query.length);
      ctx.doc.insertText(s.block, s.offset, command.insert, null);
      return { block: s.block, offset: s.offset + command.caret };
    });
  }

  /**
   * Replace the typed `@query` with a mention of a page, then a space.
   * @param {{ id: string, title: string }} page
   */
  insertMention(page) {
    if (this.readOnly) return;
    const s = this.#takeSuggestion("mention");
    if (!s) return;
    this.run((ctx) => {
      const { doc } = ctx;
      doc.deleteText(s.block, s.offset, 1 + s.query.length);
      const base = { ...(marksAt(doc, s.block, s.offset) ?? {}) };
      delete base.link;
      delete base.mention;
      delete base.code;
      doc.insertText(s.block, s.offset, page.title, {
        ...base,
        mention: { type: "page", id: page.id },
      });
      const end = s.offset + page.title.length;
      doc.insertText(s.block, end, " ", Object.keys(base).length ? base : null);
      return { block: s.block, offset: end + 1 };
    });
    this.storedMarks = null;
  }

  // -------------------------------------------------------------------------
  // Block actions (the block handle and its menu)

  /**
   * The blocks an action on `id` applies to: the selected blocks if `id` is
   * one of them (and the selection spans blocks), otherwise just `id`. A
   * table's cell or row stands for the table.
   * @param {string} id
   */
  blockTargets(id) {
    if (this.doc.hasBlock(id) && this.doc.getType(id) !== TABLE) id = tableOf(this.doc, id) ?? id;
    const sel = this.selection;
    if (
      sel &&
      sel.anchor.block !== sel.focus.block &&
      isValidPos(this.ctx, sel.anchor) &&
      isValidPos(this.ctx, sel.focus)
    ) {
      const ids = selectedBlocks(this.ctx, sel);
      if (ids.includes(id)) return ids;
      // A block under a selected one moves with it.
      for (let p = this.doc.parentOf(id); typeof p === "string"; p = this.doc.parentOf(p))
        if (ids.includes(p)) return ids;
    }
    return [id];
  }

  /** Put the caret at the end of a block's text. @param {string} id */
  focusBlock(id) {
    if (!this.doc.hasBlock(id) || !hasText(this.doc.getType(id))) return;
    this.setSelection(caret({ block: id, offset: this.doc.textLength(id) }));
  }

  /** @param {string[]} ids @param {string} type */
  turnBlocksInto(ids, type) {
    this.run(
      (ctx, sel) => {
        turnInto(ctx, ids, type);
        return sel &&
          isValidPos(ctx, sel.anchor) &&
          isValidPos(ctx, sel.focus) &&
          ids.includes(sel.focus.block)
          ? sel
          : caret({ block: ids[0], offset: ctx.doc.textLength(ids[0]) });
      },
      { needsSelection: false },
    );
  }

  /** @param {string[]} ids */
  deleteBlocks(ids) {
    this.run((ctx) => deleteBlocks(ctx, ids), { needsSelection: false });
  }

  /** @param {string[]} ids */
  duplicateBlocks(ids) {
    this.run((ctx) => duplicateBlocks(ctx, ids), { needsSelection: false });
  }

  /** @param {string[]} ids @param {string | null} color */
  setBlockColor(ids, color) {
    this.run(
      (ctx, sel) => {
        setBlockColor(ctx, ids, color);
        return sel ?? undefined;
      },
      { needsSelection: false },
    );
  }

  /**
   * Put an image block at block `at`: in its place when it's an empty
   * paragraph, else right after it (null: after the selection's block, or
   * at the end). The caret goes below it. Returns the image block's id.
   * @param {string | null} at
   * @param {Record<string, unknown>} attrs `file` or `src`, and so on.
   * @returns {string | null}
   */
  insertImage(at, attrs) {
    /** @type {string | null} */
    let created = null;
    this.run(
      (ctx, sel) => {
        const { doc } = ctx;
        const picked =
          at !== null && doc.hasBlock(at) && doc.isVisible(at)
            ? at
            : (sel?.focus.block ?? doc.root().at(-1) ?? null);
        // Into a table, it goes below it.
        const anchor = picked === null ? null : (tableOf(doc, picked) ?? picked);
        if (
          anchor !== null &&
          hasText(doc.getType(anchor)) &&
          doc.getType(anchor) !== "code" &&
          doc.textLength(anchor) === 0 &&
          doc.children(anchor).length === 0
        ) {
          doc.setType(anchor, "image");
          for (const [key, value] of Object.entries(attrs)) doc.setAttr(anchor, key, value);
          created = anchor;
        } else {
          created = createBlock(doc, {
            type: "image",
            parent: anchor === null ? null : doc.parentOf(anchor),
            after: anchor ?? undefined,
            attrs,
          });
        }
        return exitBlock(ctx, created);
      },
      { needsSelection: false },
    );
    return created;
  }

  /**
   * Change one attr of a block (an image's width or caption) as an undo
   * step, leaving the selection where it is.
   * @param {string} id @param {string} key @param {unknown} value
   */
  setBlockAttr(id, key, value) {
    if (this.readOnly || !this.doc.hasBlock(id)) return;
    const sel = this.selection;
    this.undo.stopCapturing();
    this.#relBefore = this.#relative(sel);
    this.doc.transact(() => this.doc.setAttr(id, key, value), LOCAL);
    this.undo.stopCapturing();
  }

  /**
   * Move blocks next to or into another (drag and drop).
   * @param {string[]} ids @param {{ parent: string | null, after: string | null }} to
   */
  moveBlocks(ids, to) {
    this.run(
      (ctx, sel) => {
        if (!moveBlocks(ctx, ids, to)) return sel ?? undefined;
        const last = ids[ids.length - 1];
        return sel && isValidPos(ctx, sel.anchor) && isValidPos(ctx, sel.focus)
          ? sel
          : hasText(ctx.doc.getType(last))
            ? caret({ block: last, offset: ctx.doc.textLength(last) })
            : undefined;
      },
      { needsSelection: false },
    );
  }

  /**
   * The `+` next to a block: a new paragraph below it (or the block itself
   * if it's an empty paragraph) with a `/`, so the slash menu opens there.
   * @param {string} id
   */
  insertBelow(id) {
    if (this.readOnly) return;
    const at = this.run(
      (ctx) => {
        const { doc } = ctx;
        const empty = doc.getType(id) === "p" && doc.textLength(id) === 0;
        const target = empty
          ? id
          : createBlock(doc, { type: "p", parent: doc.parentOf(id) ?? null, after: id });
        doc.insertText(target, 0, "/", null);
        return { block: target, offset: 1 };
      },
      { needsSelection: false },
    );
    if (at) this.#suggestion[1]({ kind: "slash", block: at.focus.block, offset: 0, query: "" });
  }

  /**
   * ⌘⇧↑ / ⌘⇧↓: move the selected blocks (or `ids`) up or down.
   * @param {-1 | 1} dir @param {string[]} [ids]
   */
  moveBlocksBy(dir, ids) {
    this.run(
      (ctx, s) => {
        const targets = ids ?? (s ? selectedBlocks(ctx, s) : []);
        moveBlocksBy(ctx, targets, dir);
        return s ?? undefined;
      },
      { needsSelection: !ids },
    );
  }

  /**
   * Type a trigger character at the caret and open its menu wherever the
   * caret is (the mobile toolbar's + and @ buttons).
   * @param {Suggestion["kind"]} kind
   */
  insertTrigger(kind) {
    if (this.readOnly) return;
    const sel = this.run((ctx, s) => insertText(ctx, s, TRIGGERS[kind], null));
    if (sel)
      this.#suggestion[1]({
        kind,
        block: sel.focus.block,
        offset: sel.focus.offset - 1,
        query: "",
      });
  }

  /** Focus the editor again with the selection it had (after a menu closes). */
  restoreFocus() {
    const sel = this.#currentSelection();
    if (sel) this.setSelection(sel, { scroll: false });
    else this.root?.focus({ preventScroll: true });
  }

  /** Tab / Shift+Tab on the selected blocks (also the mobile toolbar). @param {boolean} out */
  indentSelection(out) {
    this.run((ctx, s) => {
      const ids = selectedBlocks(ctx, s);
      if (out) outdent(ctx, ids);
      else indent(ctx, ids);
      return s;
    });
  }

  /** Whether every selected character has a mark (for the toolbars). @param {string} name */
  selectionHasMark(name) {
    const sel = this.trackedSelection();
    if (!sel) return false;
    if (isCollapsed(sel)) {
      const marks = this.storedMarks ?? marksAt(this.doc, sel.focus.block, sel.focus.offset) ?? {};
      return marks[name] !== undefined && marks[name] !== null;
    }
    return hasMark(this.ctx, sel, name);
  }

  /** The text color or background shared by the whole selection, or null. */
  selectionColor() {
    const sel = this.trackedSelection();
    if (!sel || isCollapsed(sel)) return null;
    const ranges = textRanges(this.ctx, sel);
    /** @type {unknown} */
    let color;
    for (const { block, start, end } of ranges) {
      const runs = this.doc.getTextRuns(block);
      for (let i = start; i < end; i++) {
        const c = marksOfChar(runs, i)?.color ?? null;
        if (color === undefined) color = c;
        else if (c !== color) return null;
      }
    }
    return typeof color === "string" ? color : null;
  }

  /** The color ⌘⇧H applies: the last one picked. */
  lastColor = "yellow_background";

  /** Set (or with null clear) the selection's text color. @param {string | null} color */
  setTextColor(color) {
    this.#syncSelection();
    const sel = this.selection;
    if (!sel || isCollapsed(sel)) return;
    if (color) this.lastColor = color;
    this.run((ctx, s) => {
      setMark(ctx, s, "color", color);
      return s;
    });
  }

  // -------------------------------------------------------------------------
  // Tables

  /**
   * Change a table's shape (its menus and + buttons) as one undo step.
   * `id` is a cell, or the table for `add-row` and `add-column`. The caret
   * goes to the cell the action made, or stays in the moved one.
   * @param {string} id @param {TableAction} action
   */
  tableAction(id, action) {
    this.run(
      (ctx, sel) => {
        const { doc } = ctx;
        const table = doc.hasBlock(id) ? tableOf(doc, id) : null;
        if (table === null) return sel ?? undefined;
        const grid = tableGrid(doc, table);
        const place = doc.getType(id) === CELL ? cellPlace(doc, id) : null;
        const row = place?.row ?? grid.length - 1;
        const col = place?.col ?? 0;
        const kept =
          sel && isValidPos(ctx, sel.anchor) && isValidPos(ctx, sel.focus) ? sel : undefined;
        /** @param {string | undefined} cell */
        const into = (cell) => (cell === undefined ? kept : caret({ block: cell, offset: 0 }));
        switch (action) {
          case "add-row":
            return into(insertRow(doc, table, grid.length)[0]);
          case "add-column":
            return into(insertColumn(doc, table, columnCount(grid))[0]);
          case "row-above":
          case "row-below":
            return into(insertRow(doc, table, action === "row-above" ? row : row + 1)[col]);
          case "column-left":
          case "column-right":
            return into(insertColumn(doc, table, action === "column-left" ? col : col + 1)[row]);
          case "delete-row":
          case "delete-column": {
            const last = action === "delete-row" ? grid.length <= 1 : columnCount(grid) <= 1;
            if (last) return deleteBlocks(ctx, [table]);
            if (action === "delete-row") deleteRow(doc, table, row);
            else deleteColumn(doc, table, col);
            const after = tableGrid(doc, table);
            const r = after[Math.min(row, after.length - 1)];
            return into(r[Math.min(col, r.length - 1)]);
          }
          case "move-row-up":
          case "move-row-down":
            moveRow(doc, table, row, action === "move-row-up" ? row - 1 : row + 1);
            return place ? caret({ block: id, offset: 0 }) : kept;
          case "move-column-left":
          case "move-column-right":
            moveColumn(doc, table, col, action === "move-column-left" ? col - 1 : col + 1);
            return place ? caret({ block: id, offset: 0 }) : kept;
        }
        return kept;
      },
      { needsSelection: false },
    );
  }

  /**
   * Turn a table option (`header_row`, `header_column`) on or off.
   * @param {string[]} ids @param {"header_row" | "header_column"} key @param {boolean} on
   */
  setTableOption(ids, key, on) {
    this.run(
      (ctx, sel) => {
        for (const id of ids)
          if (ctx.doc.hasBlock(id) && ctx.doc.getType(id) === TABLE)
            ctx.doc.setAttr(id, key, on ? true : null);
        return sel ?? undefined;
      },
      { needsSelection: false },
    );
  }

  /**
   * ↑ or ↓ on a cell's first or last line: the cell above or below, or past
   * the table's edge, the text before it (or the title) or after it (a new
   * paragraph if there's none). Returns whether it moved the caret.
   * @param {string} cell @param {-1 | 1} dir
   */
  #arrowInTable(cell, dir) {
    const target = verticalCell(this.doc, cell, dir);
    if (target !== null) {
      this.setSelection(
        caret({ block: target, offset: dir < 0 ? this.doc.textLength(target) : 0 }),
      );
      return true;
    }
    const table = /** @type {string} */ (tableOf(this.doc, cell));
    const flat = flatBlocks(this.ctx);
    const inside = (/** @type {string} */ id) => id === table || tableOf(this.doc, id) === table;
    const start = flat.indexOf(table);
    if (dir < 0) {
      const before = flat
        .slice(0, start)
        .reverse()
        .find((id) => hasText(this.doc.getType(id)));
      if (before === undefined) this.onExitTop();
      else this.setSelection(caret({ block: before, offset: this.doc.textLength(before) }));
      return true;
    }
    const after = flat.slice(start + 1).find((id) => !inside(id) && hasText(this.doc.getType(id)));
    if (after !== undefined) this.setSelection(caret({ block: after, offset: 0 }));
    else this.run((ctx) => exitBlock(ctx, table), { needsSelection: false });
    return true;
  }

  // -------------------------------------------------------------------------
  // Math

  /**
   * ⌘⇧E and the toolbar's √x: at a caret, a new inline formula (its
   * popover opens); over text, the text becomes a formula; over formulas,
   * they turn back into their TeX as text.
   */
  toggleInlineMath() {
    if (this.readOnly) return;
    this.#syncSelection();
    const sel = this.#currentSelection();
    if (!sel) return;
    if (isCollapsed(sel)) {
      if (spec(this.doc.getType(sel.focus.block)).marks)
        this.#openMath(sel.focus.block, sel.focus.offset);
      return;
    }
    const ranges = textRanges(this.ctx, sel);
    if (ranges.length === 0) return;
    const hasMath = ranges.some(({ block, start, end }) =>
      mathRanges(this.doc.getTextRuns(block)).some((m) => m.start < end && m.end > start),
    );
    this.run((ctx, s) => {
      const { doc } = ctx;
      /** @type {Pos | null} */
      let last = null;
      for (const { block, start, end } of ranges) {
        if (hasMath) {
          const whole = expandToMath(doc.getTextRuns(block), start, end);
          doc.format(block, whole.start, whole.end - whole.start, MATH_MARK, null);
          continue;
        }
        // TeX takes no formatting: only a color stays.
        let at = start;
        for (const r of sliceRuns(doc.getTextRuns(block), start, end)) {
          for (const name of Object.keys(r.marks ?? {}))
            if (!MATH_MARKS.includes(name)) doc.format(block, at, r.text.length, name, null);
          at += r.text.length;
        }
        doc.format(block, start, end - start, MATH_MARK, mathId());
        last = { block, offset: end };
      }
      return hasMath ? s : (last ?? s);
    });
  }

  /**
   * Open the popover for the formula at `offset` in `block`, selecting it.
   * @param {string} block @param {number} offset
   */
  editMath(block, offset) {
    if (this.readOnly || !this.doc.hasBlock(block)) return;
    const m = mathAt(this.doc.getTextRuns(block), offset);
    if (!m) return;
    this.closeSuggestion();
    this.setSelection(
      { anchor: { block, offset: m.start }, focus: { block, offset: m.end } },
      { scroll: false },
    );
    const source = this.doc.getText(block).slice(m.start, m.end);
    /** @type {RelativePosition[]} */
    const before = [];
    /** @type {RelativePosition[]} */
    const after = [];
    if (source.length <= 2000) {
      for (let i = 0; i < source.length; i++) {
        before.push(this.doc.createRelativePosition(block, m.start + i, 0));
        after.push(this.doc.createRelativePosition(block, m.start + i + 1, -1));
      }
    }
    this.#math[1]({
      block,
      id: m.id,
      source,
      start: m.start,
      end: m.end,
      at: this.#anchorAt(block, m.start),
      chars: { before, after },
    });
  }

  /** Open the popover for a new formula at a caret. @param {string} block @param {number} offset */
  #openMath(block, offset) {
    this.closeSuggestion();
    this.#math[1]({
      block,
      id: null,
      source: "",
      start: offset,
      end: offset,
      at: this.#anchorAt(block, offset),
      chars: null,
    });
  }

  /** @param {string} block @param {number} offset */
  #anchorAt(block, offset) {
    try {
      return this.doc.createRelativePosition(block, offset);
    } catch {
      return null;
    }
  }

  /**
   * Where the edited formula is now: found by its id (others may have
   * typed around it), or for a new one (or one deleted meanwhile), where
   * the caret was.
   * @param {MathEdit} edit
   * @returns {{ start: number, end: number } | null}
   */
  #mathNow(edit) {
    if (
      !this.doc.hasBlock(edit.block) ||
      !this.doc.isVisible(edit.block) ||
      !hasText(this.doc.getType(edit.block))
    )
      return null;
    if (edit.id !== null) {
      const key = JSON.stringify(edit.id);
      const found = mathRanges(this.doc.getTextRuns(edit.block)).find(
        (m) => JSON.stringify(m.id) === key,
      );
      if (found) return found;
    }
    const at = edit.at ? this.doc.resolveRelativePosition(edit.at) : null;
    const offset =
      at && at.blockId === edit.block
        ? at.offset
        : Math.min(edit.start, this.doc.textLength(edit.block));
    return { start: offset, end: offset };
  }

  /** Where the popover points: the formula, or the caret for a new one. @returns {DOMRect | null} */
  mathRect() {
    const edit = this.#math[0]();
    if (!edit) return null;
    this.version(edit.block);
    const el = this.textEls.get(edit.block);
    const now = this.#mathNow(edit);
    if (!el || !now) return null;
    const drawn =
      now.end > now.start ? mathElements(el).find((m) => m.start === now.start) : undefined;
    return drawn ? drawn.el.getBoundingClientRect() : rectAt(el, now.start);
  }

  /**
   * Close the popover. `tex` null cancels; "" deletes the formula. Then:
   * "after" puts the caret after the formula, "keep" keeps the caret the
   * editor has now (a click elsewhere in the text closed the popover), and
   * "none" leaves focus where it went.
   *
   * Changed TeX goes in as the smallest edit, made to the part of the
   * formula that changed (found through anchors taken when the popover
   * opened), so a concurrent change to another part of it survives.
   * @param {string | null} tex @param {"after" | "keep" | "none"} [mode]
   */
  finishMath(tex, mode = "after") {
    const edit = this.#math[0]();
    this.#math[1](null);
    if (!edit || this.readOnly) return;
    const now = this.#mathNow(edit);
    if (!now) return;
    const next = tex === null ? null : tex.replace(/\s*\n\s*/g, " ");
    const existing = now.end > now.start;
    const current = this.doc.getText(edit.block).slice(now.start, now.end);
    /** @type {Sel} */
    const restore = caret({ block: edit.block, offset: now.end });
    const unchanged =
      next === null || (!existing && next.trim() === "") || (existing && next === current);
    // Where the editor's caret is now, anchored before anything changes.
    const kept = mode === "keep" && this.root ? this.#relative(readSelection(this.root)) : null;
    let after = restore;
    if (!unchanged && next !== null) {
      const sel = this.#commit((ctx) => {
        const { doc } = ctx;
        const block = edit.block;
        if (existing && next.trim() === "") {
          doc.deleteText(block, now.start, now.end - now.start);
          return { block, offset: now.start };
        }
        if (!existing) {
          // A new formula, or one someone else deleted meanwhile: it goes in where it was.
          const base = { ...(marksAt(doc, block, now.start) ?? {}) };
          for (const name of Object.keys(base)) if (!MATH_MARKS.includes(name)) delete base[name];
          doc.insertText(block, now.start, next, { ...base, [MATH_MARK]: edit.id ?? mathId() });
          return { block, offset: now.start + next.length };
        }
        const marks = marksOfChar(doc.getTextRuns(block), now.start) ?? { [MATH_MARK]: edit.id };
        const region = this.#changedRegion(edit, next, now) ?? diffRegion(current, next, now.start);
        if (region.end > region.start)
          doc.deleteText(block, region.start, region.end - region.start);
        if (region.text) doc.insertText(block, region.start, region.text, marks);
        const end = mathRanges(doc.getTextRuns(block)).find(
          (m) => m.start <= region.start && m.end >= region.start + region.text.length,
        );
        return { block, offset: end ? end.end : region.start + region.text.length };
      }, restore);
      if (sel) after = sel;
    }
    if (mode === "after") this.setSelection(after);
    else if (mode === "keep") {
      const sel = this.#resolve(kept);
      if (sel) this.setSelection(sel, { scroll: false });
    } else {
      this.selection = after;
      this.#selectionChanged();
    }
  }

  /**
   * The edit from the TeX the popover opened with to `next`, placed in the
   * formula as it is now: what changed sits between the last unchanged
   * character at the start and the first at the end. Null when those
   * anchors are gone (then the caller diffs against the current text).
   * @param {MathEdit} edit @param {string} next @param {{ start: number, end: number }} now
   * @returns {{ start: number, end: number, text: string } | null}
   */
  #changedRegion(edit, next, now) {
    const chars = edit.chars;
    const source = edit.source;
    if (!chars || chars.before.length !== source.length || source.length === 0) return null;
    let pre = 0;
    while (pre < source.length && pre < next.length && source[pre] === next[pre]) pre++;
    let suf = 0;
    while (
      suf < source.length - pre &&
      suf < next.length - pre &&
      source[source.length - 1 - suf] === next[next.length - 1 - suf]
    )
      suf++;
    /** @param {RelativePosition} rel */
    const at = (rel) => {
      const r = this.doc.resolveRelativePosition(rel);
      return r && r.blockId === edit.block ? r.offset : null;
    };
    const start = pre > 0 ? at(chars.after[pre - 1]) : at(chars.before[0]);
    const end =
      suf > 0 ? at(chars.before[source.length - suf]) : at(chars.after[source.length - 1]);
    if (start === null || end === null || start > end || start < now.start || end > now.end)
      return null;
    return { start, end, text: next.slice(pre, next.length - suf) };
  }

  /**
   * One undo step that doesn't read or move the DOM selection (the
   * popover has focus). Returns where the command says the caret goes.
   * @param {(ctx: Ctx) => Pos | Sel | null | undefined | void} command @param {Sel} before
   * @returns {Sel | null}
   */
  #commit(command, before) {
    this.undo.stopCapturing();
    this.#relBefore = this.#relative(before);
    this.#lastStep = null;
    /** @type {Pos | Sel | null | undefined | void} */
    let next;
    this.doc.transact(() => {
      next = command(this.ctx);
    }, LOCAL);
    this.undo.stopCapturing();
    const sel = next ? toSel(next) : null;
    const step = /** @type {import("./model/undo.js").StackItem | null} */ (this.#lastStep);
    if (sel && step) step.meta.set("after", this.#relative(sel));
    return sel;
  }

  /**
   * Stop editing an equation (Escape, Done): the caret goes to the next
   * text block, or the one before, or a new paragraph below.
   * @param {string} id
   */
  leaveEquation(id) {
    if (this.readOnly || !this.doc.hasBlock(id)) return;
    const blocks = textBlocks(this.ctx);
    const i = blocks.indexOf(id);
    const next = blocks[i + 1];
    const prev = i > 0 ? blocks[i - 1] : undefined;
    if (next !== undefined) this.setSelection(caret({ block: next, offset: 0 }));
    else if (prev !== undefined)
      this.setSelection(caret({ block: prev, offset: this.doc.textLength(prev) }));
    else this.run((ctx) => afterBlock(ctx, id), { needsSelection: false });
  }

  // -------------------------------------------------------------------------
  // Running commands

  /**
   * Run a command as one transaction and put the caret where it says.
   *
   * @param {(ctx: Ctx, sel: Sel) => Pos | Sel | null | undefined | void} command
   * @param {{ typing?: boolean, origin?: string, needsSelection?: boolean }} [options]
   *   `typing`: joins the current undo step (plain typing); everything else is a step of its own.
   * @returns {Sel | null} the new selection
   */
  run(command, { typing = false, origin = LOCAL, needsSelection = true } = {}) {
    if (this.readOnly) return null;
    this.flushComposition();
    this.#syncSelection();
    const sel = this.#currentSelection();
    if (!sel && needsSelection) return null;
    if (!typing) this.undo.stopCapturing();
    this.#relBefore = this.#relative(sel);
    this.#lastStep = null;
    /** @type {Pos | Sel | null | undefined | void} */
    let next;
    this.doc.transact(() => {
      next = command(this.ctx, /** @type {Sel} */ (sel));
    }, origin);
    if (!typing) this.undo.stopCapturing();
    const nextSel = next ? toSel(next) : sel;
    if (nextSel) {
      const step = /** @type {import("./model/undo.js").StackItem | null} */ (this.#lastStep);
      if (step) step.meta.set("after", this.#relative(nextSel));
      this.setSelection(nextSel);
    }
    return nextSel;
  }

  /**
   * Type text over the selection (or `range`), then apply Markdown rules.
   * @param {string} text
   * @param {Sel} [range]
   */
  typeText(text, range) {
    if (this.readOnly) return;
    if (range) this.selection = range;
    const marks = this.storedMarks;
    this.storedMarks = null;
    this.#storedAt = null;
    const sel = this.run((ctx, s) => insertText(ctx, s, text, marks), { typing: true });
    // Rules look at the last character (autocorrect and some keyboards insert several at once).
    if (sel && text.length > 0) {
      this.#inputRule(sel.focus, text[text.length - 1]);
      if (text.length === 1) this.#maybeOpenSuggestion(sel.focus, text);
    }
  }

  /**
   * Apply a Markdown rule for the character just typed, as its own undo step.
   * @param {Pos} at The caret after the character. @param {string} typed
   */
  #inputRule(at, typed) {
    const rule = findInputRule(this.ctx, at, typed);
    if (!rule) return;
    const ruled = this.run(() => rule());
    // Text typed after a rule shouldn't carry the new mark on.
    if (ruled && ruled.focus.block === at.block) {
      this.storedMarks = {};
      this.#storedAt = ruled.focus;
    }
  }

  // -------------------------------------------------------------------------
  // Public actions (keyboard, toolbar, page)

  /** Focus the start of the document (from the title). */
  focusStart() {
    if (this.readOnly) return;
    const sel = this.run((ctx) => ensureBlock(ctx), { origin: SETUP, needsSelection: false });
    if (sel) this.setSelection(caret(sel.focus));
  }

  /** Clicking below the last block. */
  focusEnd() {
    if (this.readOnly) return;
    this.run((ctx) => appendParagraph(ctx), { needsSelection: false });
  }

  /** @param {boolean} redo */
  history(redo) {
    if (this.readOnly) return;
    this.flushComposition();
    this.#restore = null;
    const done = redo ? this.undo.redo() : this.undo.undo();
    if (!done) return;
    const sel = this.#restore ?? this.#currentSelection();
    if (sel) this.setSelection(sel);
  }

  /** @param {string} name */
  toggleMark(name) {
    this.#syncSelection();
    const sel = this.selection;
    if (!sel) return;
    if (isCollapsed(sel)) {
      // At a caret, the mark applies to what's typed next.
      const current =
        this.storedMarks ?? marksAt(this.doc, sel.focus.block, sel.focus.offset) ?? {};
      const next = { ...current };
      if (next[name]) delete next[name];
      else next[name] = true;
      this.storedMarks = next;
      this.#storedAt = sel.focus;
      return;
    }
    this.run((ctx, s) => {
      toggleMark(ctx, s, name);
      return s;
    });
  }

  /** ⌘K: ask for a link for the selected text. */
  requestLink() {
    this.#syncSelection();
    const sel = this.selection;
    if (!sel || isCollapsed(sel) || this.readOnly) return false;
    const { from } = ordered(this.ctx, sel);
    const runs = this.doc.getTextRuns(from.block);
    let pos = 0;
    let href = "";
    for (const r of runs) {
      if (from.offset < pos + r.text.length && typeof r.marks?.link === "string") {
        href = r.marks.link;
        break;
      }
      pos += r.text.length;
    }
    this.#link[1]({ sel, href });
    return true;
  }

  /**
   * Finish ⌘K: link (or with "" unlink) the saved selection.
   * @param {string | null} input null cancels.
   */
  finishLink(input) {
    const request = this.#link[0]();
    this.#link[1](null);
    if (!request) return;
    this.selection = request.sel;
    if (input === null) {
      this.setSelection(request.sel);
      return;
    }
    const href = input.trim() === "" ? null : normalizeLinkInput(input);
    if (input.trim() !== "" && href === null) {
      this.setSelection(request.sel);
      return;
    }
    this.run((ctx, s) => {
      setMark(ctx, s, "link", href);
      return s;
    });
  }

  /** @param {string} type */
  turnInto(type) {
    this.run((ctx, sel) => {
      turnInto(ctx, selectedBlocks(ctx, sel), type);
      return sel;
    });
  }

  /** @param {string} id */
  toggleChecked(id) {
    if (this.readOnly) return;
    const sel = this.selection;
    this.undo.stopCapturing();
    this.#relBefore = this.#relative(sel);
    this.doc.transact(() => toggleChecked(this.ctx, id), LOCAL);
    this.undo.stopCapturing();
    if (sel && this.root?.ownerDocument.activeElement === this.root)
      this.setSelection(sel, { scroll: false });
  }

  /** @param {string} id */
  toggleOpen(id) {
    this.setOpen(id, !untrack(() => this.isOpen(id)));
    // A caret inside what just closed moves to the toggle's end.
    const sel = this.selection;
    if (!sel || !this.root || this.root.ownerDocument.activeElement !== this.root) return;
    const visible = new Set(textBlocks(this.ctx));
    if (visible.has(sel.anchor.block) && visible.has(sel.focus.block))
      this.setSelection(sel, { scroll: false });
    else
      this.setSelection(caret({ block: id, offset: this.doc.textLength(id) }), { scroll: false });
  }

  #selectAll() {
    this.#syncSelection();
    const sel = this.selection;
    const blocks = textBlocks(this.ctx);
    if (!sel || blocks.length === 0) return;
    const { from, to } = ordered(this.ctx, sel);
    const length = this.doc.textLength(from.block);
    if (from.block === to.block && !(from.offset === 0 && to.offset === length) && length > 0) {
      this.setSelection(
        { anchor: { block: from.block, offset: 0 }, focus: { block: from.block, offset: length } },
        { scroll: false },
      );
      return;
    }
    const last = blocks[blocks.length - 1];
    this.setSelection(
      {
        anchor: { block: blocks[0], offset: 0 },
        focus: { block: last, offset: this.doc.textLength(last) },
      },
      { scroll: false },
    );
  }

  // -------------------------------------------------------------------------
  // Remote changes

  /**
   * Merge changes from elsewhere (the server's copy), keeping the selection
   * where it was in the text. Waits while an IME composition is open.
   * @param {Uint8Array} bytes
   */
  applyRemote(bytes) {
    if (this.#composing || this.#compositionPending) {
      this.#deferredRemote.push(bytes);
      return;
    }
    const rel = this.#relative(this.selection);
    this.doc.applyUpdate(bytes, "server");
    const sel = this.#resolve(rel) ?? this.#currentSelection();
    if (sel && this.root?.ownerDocument.activeElement === this.root)
      this.setSelection(sel, { scroll: false });
    else if (sel) this.selection = sel;
  }

  // -------------------------------------------------------------------------
  // Input events

  /** @param {InputEvent} e */
  #onBeforeInput(e) {
    const type = e.inputType;
    if (
      type === "insertCompositionText" ||
      type === "deleteCompositionText" ||
      type === "insertFromComposition"
    ) {
      if (this.readOnly) e.preventDefault();
      return;
    }
    e.preventDefault();
    if (this.readOnly) return;
    this.flushComposition();
    this.#syncSelection();
    const target = this.#targetRange(e);
    switch (type) {
      case "insertText":
      case "insertReplacementText":
      case "insertFromYank": {
        const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
        if (text === "") return;
        this.typeText(text.replace(/\r\n?/g, "\n"), target ?? undefined);
        return;
      }
      case "insertParagraph":
        if (untrack(() => this.#suggestion[0]()) && this.suggestionKeys?.("Enter")) return;
        this.#enter();
        return;
      case "insertLineBreak":
        this.typeText("\n");
        return;
      case "insertTranspose":
        return;
      case "formatBold":
        this.toggleMark("bold");
        return;
      case "formatItalic":
        this.toggleMark("italic");
        return;
      case "formatUnderline":
        this.toggleMark("underline");
        return;
      case "formatStrikeThrough":
        this.toggleMark("strike");
        return;
      case "historyUndo":
        this.history(false);
        return;
      case "historyRedo":
        this.history(true);
        return;
      default:
        if (type.startsWith("delete")) this.#delete(type, target);
    }
  }

  /**
   * The range the browser says an input applies to, in model terms.
   * @param {InputEvent} e
   * @returns {Sel | null}
   */
  #targetRange(e) {
    if (!this.root || typeof e.getTargetRanges !== "function") return null;
    const ranges = e.getTargetRanges();
    if (ranges.length === 0) return null;
    const r = ranges[0];
    const anchor = domToPos(this.root, r.startContainer, r.startOffset);
    const focus = domToPos(this.root, r.endContainer, r.endOffset);
    return anchor && focus ? { anchor, focus } : null;
  }

  /**
   * @param {string} type
   * @param {Sel | null} target
   */
  #delete(type, target) {
    const sel = this.#currentSelection();
    if (!sel) return;
    if (!isCollapsed(sel)) {
      this.run((ctx, s) => deleteSelection(ctx, s));
      return;
    }
    const pos = sel.focus;
    const backward = type.includes("Backward");
    const length = this.doc.textLength(pos.block);
    if (backward && pos.offset === 0) {
      this.run((ctx, s) => joinBackward(ctx, s.focus.block));
      return;
    }
    if (!backward && pos.offset === length) {
      this.run((ctx, s) => joinForward(ctx, s.focus.block));
      return;
    }
    // A formula next to the caret is selected first, and goes on the next press.
    const runs = this.doc.getTextRuns(pos.block);
    if (!type.includes("Word") && !type.includes("Line")) {
      const m = mathAt(runs, backward ? pos.offset - 1 : pos.offset);
      if (m) {
        const from = { block: pos.block, offset: backward ? m.end : m.start };
        const to = { block: pos.block, offset: backward ? m.start : m.end };
        this.setSelection({ anchor: from, focus: to });
        return;
      }
    }
    // Inside the text: the browser's range when it stays in this block,
    // otherwise our own grapheme/word/line boundaries.
    let start;
    let end;
    if (
      target &&
      target.anchor.block === pos.block &&
      target.focus.block === pos.block &&
      target.anchor.offset !== target.focus.offset
    ) {
      start = Math.min(target.anchor.offset, target.focus.offset);
      end = Math.max(target.anchor.offset, target.focus.offset);
    } else {
      const text = this.doc.getText(pos.block);
      const unit = type.includes("Word") ? "word" : "grapheme";
      if (type.includes("Line")) {
        start = backward ? text.lastIndexOf("\n", pos.offset - 1) + 1 : pos.offset;
        const nl = text.indexOf("\n", pos.offset);
        end = backward ? pos.offset : nl === -1 ? length : Math.max(nl, pos.offset + 1);
        if (backward && start === pos.offset) start = pos.offset - 1;
      } else if (backward) {
        start = step(text, pos.offset, -1, unit);
        end = pos.offset;
      } else {
        start = pos.offset;
        end = step(text, pos.offset, 1, unit);
      }
    }
    // A word or line deleted up to a formula takes all of it, never half.
    ({ start, end } = expandToMath(runs, start, end));
    this.run(
      (ctx) =>
        deleteRange(ctx, { block: pos.block, offset: start }, { block: pos.block, offset: end }),
      { typing: true },
    );
  }

  /** @param {KeyboardEvent} e */
  #onKeyDown(e) {
    if (e.isComposing || e.keyCode === 229) return;
    this.flushComposition();
    const key = e.key;
    const m = mod(e);

    if (untrack(() => this.#suggestion[0]()) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (key === "Escape") {
        e.preventDefault();
        this.closeSuggestion();
        return;
      }
      if (key === "ArrowUp" || key === "ArrowDown" || key === "Enter" || key === "Tab") {
        if (this.suggestionKeys?.(key === "Tab" ? "Enter" : key)) {
          e.preventDefault();
          return;
        }
        if (key === "Enter" || key === "Tab") this.closeSuggestion();
      }
    }
    if (m && !e.altKey && !e.shiftKey && (key === "/" || e.code === "Slash")) {
      e.preventDefault();
      this.#syncSelection();
      const sel = this.#currentSelection();
      if (sel) this.onBlockMenu(sel.focus.block);
      return;
    }

    if (m && !e.altKey && key.toLowerCase() === "a") {
      e.preventDefault();
      this.#selectAll();
      return;
    }
    if (this.readOnly) return;

    // Escape leaves an equation's source.
    if (key === "Escape" && !m && !e.shiftKey && !e.altKey) {
      this.#syncSelection();
      const block = this.selection?.focus.block;
      if (block && this.doc.hasBlock(block) && this.doc.getType(block) === "equation") {
        e.preventDefault();
        this.leaveEquation(block);
      }
      return;
    }

    if (m && !e.altKey && key.toLowerCase() === "z") {
      e.preventDefault();
      this.history(e.shiftKey);
      return;
    }
    if (m && !e.altKey && !e.shiftKey && key.toLowerCase() === "y" && !IS_APPLE) {
      e.preventDefault();
      this.history(true);
      return;
    }
    if (m && !e.altKey) {
      const lower = key.toLowerCase();
      if (e.shiftKey && lower === "e") {
        e.preventDefault();
        this.toggleInlineMath();
        return;
      }
      /** @type {string | null} */
      const mark =
        !e.shiftKey && lower === "b"
          ? "bold"
          : !e.shiftKey && lower === "i"
            ? "italic"
            : !e.shiftKey && lower === "u"
              ? "underline"
              : e.shiftKey && lower === "s"
                ? "strike"
                : !e.shiftKey && lower === "e"
                  ? "code"
                  : null;
      if (mark) {
        e.preventDefault();
        this.toggleMark(mark);
        return;
      }
      // ⌘K links selected text; at a caret it's quick find's (the app's).
      if (!e.shiftKey && lower === "k") {
        if (this.requestLink()) e.preventDefault();
        return;
      }
    }
    if (m && !e.shiftKey && !e.altKey && key.toLowerCase() === "d") {
      e.preventDefault();
      this.#syncSelection();
      const sel = this.#currentSelection();
      if (sel) this.duplicateBlocks(selectedBlocks(this.ctx, sel));
      return;
    }
    if (m && e.shiftKey && !e.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
      e.preventDefault();
      this.moveBlocksBy(key === "ArrowUp" ? -1 : 1);
      return;
    }
    if (m && e.shiftKey && !e.altKey && key.toLowerCase() === "h") {
      e.preventDefault();
      const color = this.selectionColor() === this.lastColor ? null : this.lastColor;
      this.setTextColor(color);
      return;
    }
    if (m && e.altKey && TURN_INTO_KEYS[e.code] && !e.getModifierState?.("AltGraph")) {
      e.preventDefault();
      this.turnInto(TURN_INTO_KEYS[e.code]);
      return;
    }
    if (
      m &&
      e.altKey &&
      !e.shiftKey &&
      e.code === EQUATION_KEY &&
      !e.getModifierState?.("AltGraph")
    ) {
      e.preventDefault();
      this.turnInto("equation");
      return;
    }

    if (key === "Tab" && !m && !e.altKey) {
      e.preventDefault();
      this.#syncSelection();
      const sel = this.selection;
      if (!sel) return;
      if (isCollapsed(sel) && isPlainText(this.doc.getType(sel.focus.block)) && !e.shiftKey) {
        this.typeText("  ");
        return;
      }
      // In a table, Tab goes from cell to cell.
      if (
        this.doc.hasBlock(sel.focus.block) &&
        this.doc.getType(sel.focus.block) === CELL &&
        tableOf(this.doc, sel.focus.block) !== null
      ) {
        this.run((ctx, s) => stepCell(ctx, s.focus.block, e.shiftKey ? -1 : 1) ?? s);
        return;
      }
      this.run((ctx, s) => {
        const ids = selectedBlocks(ctx, s);
        if (e.shiftKey) outdent(ctx, ids);
        else indent(ctx, ids);
        return s;
      });
      return;
    }

    if (key === "Enter") {
      e.preventDefault();
      this.#syncSelection();
      if (m) {
        const sel = this.selection;
        if (!sel) return;
        if (isCollapsed(sel) && isPlainText(this.doc.getType(sel.focus.block))) {
          this.run((ctx, s) => exitBlock(ctx, s.focus.block));
          return;
        }
        // In a table, ⌘Enter leaves it for a paragraph below.
        const table =
          this.doc.getType(sel.focus.block) === CELL ? tableOf(this.doc, sel.focus.block) : null;
        if (table !== null) {
          this.run((ctx) => exitBlock(ctx, table));
          return;
        }
        for (const id of selectedBlocks(this.ctx, sel)) {
          const type = this.doc.getType(id);
          if (type === "todo") this.toggleChecked(id);
          else if (type === "toggle") this.toggleOpen(id);
        }
        return;
      }
      // Enter on a selected formula edits it.
      const formula = !e.shiftKey ? this.#selectedFormula() : null;
      if (formula) {
        this.editMath(formula.block, formula.start);
        return;
      }
      if (e.shiftKey) this.typeText("\n");
      else this.#enter();
      return;
    }

    if ((key === "Backspace" || key === "Delete") && !e.altKey) {
      this.#syncSelection();
      const sel = this.selection;
      if (!sel || !isCollapsed(sel)) return;
      const pos = sel.focus;
      if (key === "Backspace" && pos.offset === 0) {
        e.preventDefault();
        this.run((ctx, s) => joinBackward(ctx, s.focus.block));
      } else if (key === "Delete" && pos.offset === this.doc.textLength(pos.block)) {
        e.preventDefault();
        this.run((ctx, s) => joinForward(ctx, s.focus.block));
      }
      return;
    }

    if (
      (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") &&
      !m &&
      !e.altKey
    ) {
      this.#syncSelection();
      if (this.selection && this.#arrow(key, e.shiftKey, this.selection)) {
        e.preventDefault();
        return;
      }
    }

    if ((key === "ArrowUp" || key === "ArrowLeft") && !e.shiftKey && !m && !e.altKey) {
      this.#syncSelection();
      const sel = this.selection;
      if (!sel || !isCollapsed(sel)) return;
      const first = textBlocks(this.ctx)[0];
      if (sel.focus.block !== first) return;
      if (sel.focus.offset === 0 || (key === "ArrowUp" && this.#onFirstLine(sel.focus))) {
        e.preventDefault();
        this.onExitTop();
      }
    }
  }

  /** Enter: a Markdown table line becomes a table; otherwise the block splits. */
  #enter() {
    this.flushComposition();
    this.#syncSelection();
    const sel = this.selection;
    const rule =
      sel && isCollapsed(sel) && isValidPos(this.ctx, sel.focus)
        ? findTableRule(this.ctx, sel.focus)
        : null;
    if (rule) this.run(() => rule());
    else this.run((ctx, s) => splitBlock(ctx, s));
  }

  /**
   * Arrow keys the browser would get wrong: a formula is stepped over (or
   * with Shift, selected) as one character, and a closed equation, whose
   * source is hidden, is entered instead of skipped. Returns whether it
   * moved the caret.
   * @param {string} key @param {boolean} shift @param {Sel} sel
   */
  #arrow(key, shift, sel) {
    const pos = sel.focus;
    if (!this.doc.hasBlock(pos.block) || !hasText(this.doc.getType(pos.block))) return false;
    if (key === "ArrowLeft" || key === "ArrowRight") {
      const runs = this.doc.getTextRuns(pos.block);
      const m =
        key === "ArrowLeft"
          ? pos.offset > 0
            ? mathAt(runs, pos.offset - 1)
            : null
          : mathAt(runs, pos.offset);
      if (m && (shift || isCollapsed(sel))) {
        const to = { block: pos.block, offset: key === "ArrowLeft" ? m.start : m.end };
        this.setSelection(shift ? { anchor: sel.anchor, focus: to } : caret(to));
        return true;
      }
    }
    if (shift || !isCollapsed(sel)) return false;
    if (
      (key === "ArrowUp" || key === "ArrowDown") &&
      this.doc.getType(pos.block) === CELL &&
      tableOf(this.doc, pos.block) !== null
    ) {
      const up = key === "ArrowUp";
      if (up ? !this.#onFirstLine(pos) : !this.#onLastLine(pos)) return false;
      return this.#arrowInTable(pos.block, up ? -1 : 1);
    }
    const blocks = textBlocks(this.ctx);
    const i = blocks.indexOf(pos.block);
    const forward = key === "ArrowRight" || key === "ArrowDown";
    const target = blocks[forward ? i + 1 : i - 1];
    if (i === -1 || target === undefined || this.doc.getType(target) !== "equation") return false;
    const atEdge =
      key === "ArrowRight"
        ? pos.offset === this.doc.textLength(pos.block)
        : key === "ArrowLeft"
          ? pos.offset === 0
          : key === "ArrowDown"
            ? this.#onLastLine(pos)
            : this.#onFirstLine(pos);
    if (!atEdge) return false;
    this.setSelection(caret({ block: target, offset: forward ? 0 : this.doc.textLength(target) }));
    return true;
  }

  /** Whether the caret is on the last visual line of its block. @param {Pos} pos */
  #onLastLine(pos) {
    const el = this.textEls.get(pos.block);
    const sel = this.root?.ownerDocument.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return false;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.height === 0) return true;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
    return el.getBoundingClientRect().bottom - rect.bottom < lineHeight * 0.75;
  }

  /** Whether the caret is on the first visual line of its block. @param {Pos} pos */
  #onFirstLine(pos) {
    const el = this.textEls.get(pos.block);
    const sel = this.root?.ownerDocument.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return false;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.height === 0) return true;
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 24;
    return rect.top - el.getBoundingClientRect().top < lineHeight * 0.75;
  }

  #onFocus() {
    if (this.readOnly) return;
    if (this.doc.root().length === 0) this.focusStart();
  }

  /**
   * The formula an event is on, with its block and offset, or null.
   * @param {Event} e
   */
  #formulaAt(e) {
    const el = e.target instanceof Element ? e.target.closest("[data-math]") : null;
    const textEl = el?.closest("[data-text]");
    if (
      !isMathElement(el) ||
      !(textEl instanceof HTMLElement) ||
      !this.root?.contains(textEl) ||
      !textEl.dataset.text
    )
      return null;
    const drawn = mathElements(textEl).find((m) => m.el === el);
    return drawn ? { block: textEl.dataset.text, start: drawn.start } : null;
  }

  /**
   * Pressing on a formula doesn't put the caret in it; the click that
   * follows opens it (opened on the press, its popover would take the
   * release for a click outside and close).
   * @param {MouseEvent} e
   */
  #onMouseDown(e) {
    if (e.button !== 0 || this.readOnly) return;
    if (this.#formulaAt(e)) e.preventDefault();
  }

  /** @param {MouseEvent} e */
  #onClick(e) {
    const formula = this.readOnly || e.button !== 0 ? null : this.#formulaAt(e);
    if (formula) {
      this.editMath(formula.block, formula.start);
      return;
    }
    const link = /** @type {HTMLElement | null} */ (
      e.target instanceof Element ? e.target.closest("a[href]") : null
    );
    if (!link || !this.root?.contains(link)) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    // A page mention opens the page on a plain click.
    if (link.dataset.mention) {
      this.onNavigate(href);
      return;
    }
    // Links to pages in the app open in place.
    if (href.startsWith("/") && (this.readOnly || e.metaKey || e.ctrlKey)) {
      this.onNavigate(href);
      return;
    }
    if (this.readOnly || e.metaKey || e.ctrlKey) {
      window.open(link.getAttribute("href") ?? "", "_blank", "noopener,noreferrer");
    }
  }

  // -------------------------------------------------------------------------
  // IME composition

  #onCompositionStart() {
    if (this.readOnly) return;
    this.flushComposition();
    this.#syncSelection();
    const sel = this.#currentSelection();
    if (sel && !isCollapsed(sel) && sel.anchor.block !== sel.focus.block) {
      // The browser can't compose over several blocks without breaking our DOM.
      this.run((ctx, s) => deleteSelection(ctx, s));
    }
    const at = this.selection;
    this.#composing = new Set(at ? [at.focus.block, at.anchor.block] : []);
  }

  #onCompositionUpdate() {
    if (!this.root || !this.#composing) return;
    const sel = readSelection(this.root);
    if (sel) this.#composing.add(sel.focus.block);
  }

  #onCompositionEnd() {
    if (!this.#composing) return;
    this.#compositionPending = true;
    // Safari sends the final input events after compositionend; read the DOM
    // once they're through (or before the next input, whichever is first).
    setTimeout(() => this.flushComposition(), 0);
  }

  /**
   * Read what the IME left in the DOM and apply it to the model: the text
   * of each block composed in is diffed with the model's, and the
   * difference becomes one transaction.
   */
  flushComposition() {
    if (!this.#compositionPending || !this.#composing || !this.root) return;
    const blocks = this.#composing;
    this.#composing = null;
    this.#compositionPending = false;
    const caretPos = readSelection(this.root);
    /** @type {{ block: string, at: number, inserted: string } | null} */
    let last = null;
    const marks = this.storedMarks;
    this.storedMarks = null;
    this.undo.stopCapturing();
    this.#relBefore = null;
    this.doc.transact(() => {
      for (const id of blocks) {
        const el = this.textEls.get(id);
        if (!el || !this.doc.hasBlock(id) || !hasText(this.doc.getType(id))) continue;
        const dom = domText(el);
        const model = this.doc.getText(id);
        if (dom === model) continue;
        let start = 0;
        const min = Math.min(dom.length, model.length);
        while (start < min && dom[start] === model[start]) start++;
        let endModel = model.length;
        let endDom = dom.length;
        while (endModel > start && endDom > start && model[endModel - 1] === dom[endDom - 1]) {
          endModel--;
          endDom--;
        }
        const inserted = dom.slice(start, endDom);
        const m = marks ?? marksAt(this.doc, id, start);
        if (endModel > start) this.doc.deleteText(id, start, endModel - start);
        if (inserted)
          this.doc.insertText(id, start, inserted, spec(this.doc.getType(id)).marks ? m : null);
        last = { block: id, at: start, inserted };
      }
    }, LOCAL);
    this.undo.stopCapturing();
    // The DOM may hold stray nodes from the composition even where the text
    // matches: redraw every block involved.
    for (const id of blocks) {
      const el = this.textEls.get(id);
      if (el && this.doc.hasBlock(id) && hasText(this.doc.getType(id))) this.#bump(id);
    }
    const sel =
      caretPos && isValidPos(this.ctx, caretPos.anchor) && isValidPos(this.ctx, caretPos.focus)
        ? caretPos
        : this.#currentSelection();
    if (sel) this.setSelection(sel);
    // Markdown rules for text typed through an IME (Android keyboards compose everything).
    const done = /** @type {{ block: string, at: number, inserted: string } | null} */ (last);
    if (
      done &&
      done.inserted.length > 0 &&
      sel &&
      isCollapsed(sel) &&
      sel.focus.block === done.block
    ) {
      const typed = done.inserted[done.inserted.length - 1];
      if (sel.focus.offset === done.at + done.inserted.length) {
        this.#inputRule(sel.focus, typed);
        this.#maybeOpenSuggestion(sel.focus, typed);
      }
    }
    for (const bytes of this.#deferredRemote.splice(0)) this.applyRemote(bytes);
  }

  // -------------------------------------------------------------------------
  // Clipboard

  /** @param {ClipboardEvent} e @param {boolean} cut */
  #onCopy(e, cut) {
    this.flushComposition();
    this.#syncSelection();
    const sel = this.selection;
    if (!sel || isCollapsed(sel) || !e.clipboardData) return;
    e.preventDefault();
    const slice = getSlice(this.ctx, sel);
    const json = JSON.stringify(slice);
    e.clipboardData.setData(SLICE_MIME, json);
    e.clipboardData.setData(
      "text/html",
      `<meta data-leaf-slice="${escapeHtml(json)}">${sliceToHtml(slice, { imageUrl: this.imageUrl, macros: untrack(() => this.#macros[0]()), refs: untrack(() => this.#numbering[0]()).refs })}`,
    );
    e.clipboardData.setData("text/plain", sliceToText(slice, { imageUrl: this.imageUrl }));
    if (cut && !this.readOnly) this.run((ctx, s) => deleteSelection(ctx, s));
  }

  /** @param {ClipboardEvent} e */
  #onPaste(e) {
    e.preventDefault();
    if (this.readOnly || !e.clipboardData) return;
    this.flushComposition();
    this.#syncSelection();
    const data = e.clipboardData;
    // Pasted image files (a screenshot, a copied image) are uploaded.
    const images = imageFiles(data);
    if (images.length > 0) {
      const sel = this.selection;
      if (sel && !isCollapsed(sel)) this.run((ctx, s) => deleteSelection(ctx, s));
      this.onImages(images, this.selection?.focus.block ?? null);
      return;
    }
    const plain = data.getData("text/plain");
    const sel = this.selection;
    // A URL pasted over selected text links it.
    if (sel && !isCollapsed(sel) && /^\s*(https?:\/\/|mailto:)\S+\s*$/i.test(plain)) {
      const href = normalizeLinkInput(plain);
      if (href) {
        this.run((ctx, s) => {
          setMark(ctx, s, "link", href);
          return s;
        });
        return;
      }
    }
    // Into code or an equation, text from elsewhere goes in exactly as it is (TeX and code aren't Markdown).
    const target =
      sel && this.doc.hasBlock(sel.focus.block) ? this.doc.getType(sel.focus.block) : null;
    if (
      target &&
      isPlainText(target) &&
      plain &&
      !data.getData(SLICE_MIME) &&
      !/data-leaf-slice=/.test(data.getData("text/html"))
    ) {
      this.run((ctx, s) => insertText(ctx, s, plain.replace(/\r\n?/g, "\n"), null));
      return;
    }
    const read = this.#readSlice(data);
    if (!read) return;
    // Pasted formulas get ids of their own (one pasted next to its original would merge with it).
    const slice = {
      ...read,
      blocks: read.blocks.map((b) => ({ ...b, text: freshMathIds(b.text) })),
    };
    this.run((ctx, s) => insertSlice(ctx, s, slice));
  }

  /** Image files dropped on the editor: uploaded, at the block they're dropped on. @param {DragEvent} e */
  #onDrop(e) {
    e.preventDefault();
    if (this.readOnly || !e.dataTransfer) return;
    const images = imageFiles(e.dataTransfer);
    if (images.length === 0) return;
    /** @type {string | null} */
    let at = null;
    const doc = this.root?.ownerDocument;
    const point = /** @type {any} */ (doc)?.caretPositionFromPoint?.(e.clientX, e.clientY) ?? null;
    const range = point ? null : (doc?.caretRangeFromPoint?.(e.clientX, e.clientY) ?? null);
    const node = point ? point.offsetNode : range?.startContainer;
    const offset = point ? point.offset : (range?.startOffset ?? 0);
    if (node && this.root?.contains(node)) {
      const pos = domToPos(this.root, node, offset);
      if (pos) at = pos.block;
    }
    if (at === null) {
      const el = e.target instanceof Element ? e.target.closest("[data-block-id]") : null;
      at = el instanceof HTMLElement ? (el.dataset.blockId ?? null) : null;
    }
    this.onImages(images, at);
  }

  /** @param {DataTransfer} data @returns {Slice | null} */
  #readSlice(data) {
    /** @param {string} json */
    const fromJson = (json) => {
      try {
        const slice = JSON.parse(json);
        if (slice && Array.isArray(slice.blocks)) return /** @type {Slice} */ (slice);
      } catch {
        // Not ours after all.
      }
      return null;
    };
    const own = data.getData(SLICE_MIME);
    if (own) {
      const slice = fromJson(own);
      if (slice) return slice;
    }
    const html = data.getData("text/html");
    if (html) {
      const embedded = /data-leaf-slice="([^"]*)"/.exec(html);
      if (embedded) {
        const decoded = new DOMParser()
          .parseFromString(`<i title="${embedded[1]}"></i>`, "text/html")
          .querySelector("i")?.title;
        const slice = decoded ? fromJson(decoded) : null;
        if (slice) return slice;
      }
      const parsed = parseHtml(html);
      if (parsed) return parsed;
    }
    const text = data.getData("text/plain");
    return text ? parsePlainText(text) : null;
  }

  /** Whether the selection is linked (for the toolbar later). */
  selectionHasLink() {
    const sel = this.selection;
    return sel !== null && !isCollapsed(sel) && hasMark(this.ctx, sel, "link");
  }
}

/**
 * The smallest edit turning `from` into `to` (their common start and end
 * kept), at `offset` in the text.
 * @param {string} from @param {string} to @param {number} offset
 */
function diffRegion(from, to, offset) {
  let pre = 0;
  while (pre < from.length && pre < to.length && from[pre] === to[pre]) pre++;
  let suf = 0;
  while (
    suf < from.length - pre &&
    suf < to.length - pre &&
    from[from.length - 1 - suf] === to[to.length - 1 - suf]
  )
    suf++;
  return {
    start: offset + pre,
    end: offset + from.length - suf,
    text: to.slice(pre, to.length - suf),
  };
}

/**
 * Whether an event comes from inside an embedded block's own UI (marked
 * `data-embed`), which the editor leaves alone.
 * @param {Event} e
 */
function fromEmbed(e) {
  return e.target instanceof Element && e.target.closest("[data-embed]") !== null;
}

/** Whether a drag carries files. @param {DataTransfer | null} data */
function hasFiles(data) {
  return data !== null && [...data.types].includes("Files");
}

/** The image files in a paste or drop. @param {DataTransfer} data @returns {File[]} */
function imageFiles(data) {
  return [...(data.files ?? [])].filter((file) => file.type.startsWith("image/"));
}
