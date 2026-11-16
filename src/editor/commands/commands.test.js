// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { filterSlashItems, SLASH_ITEMS } from "../blocks/slash-items.js";
import { parsePlainText } from "../clipboard/parse-text.js";
import { sliceToHtml, sliceToText } from "../clipboard/serialize.js";
import { Doc } from "../model/doc.js";
import { UndoManager } from "../model/undo.js";
import {
  applyBlockType,
  caret,
  createBlock,
  deleteBlocks,
  deleteRange,
  duplicateBlocks,
  ensureBlock,
  exitBlock,
  flatBlocks,
  getSlice,
  indent,
  insertSlice,
  insertText,
  joinBackward,
  joinForward,
  moveBlocks,
  moveBlocksBy,
  outdent,
  selectedBlocks,
  splitBlock,
  toggleMark,
  turnInto,
} from "./commands.js";
import { applyInputRule } from "./markdown.js";

/**
 * Build a document from an outline: each line is `<indent><type>: <text>`,
 * two spaces per level. Returns the doc, a context, and ids by line.
 * @param {string} outline
 */
function build(outline) {
  const doc = new Doc({ clientId: 1 });
  const open = new Set();
  const ctx = {
    doc,
    isOpen: (/** @type {string} */ id) => open.has(id),
    setOpen: (/** @type {string} */ id, /** @type {boolean} */ v) =>
      v ? open.add(id) : open.delete(id),
  };
  /** @type {string[]} */
  const ids = [];
  /** @type {string[]} */
  const stack = [];
  for (const line of outline.trim().split("\n")) {
    const m = /^( *)(\w+)(\[x\])?:(?: (.*))?$/.exec(line);
    if (!m) throw new Error(`bad line ${line}`);
    const depth = m[1].length / 2;
    const parent = depth === 0 ? null : stack[depth - 1];
    const id = createBlock(doc, {
      type: m[2],
      parent,
      after: undefined,
      attrs: m[3] ? { checked: true } : {},
      text: m[4] ? [{ text: m[4] }] : [],
    });
    if (m[2] === "toggle") open.add(id);
    stack[depth] = id;
    stack.length = depth + 1;
    ids.push(id);
  }
  return { doc, ctx, ids };
}

/** The document as an outline, with marks as `**`/`_` where set. @param {import("./commands.js").Ctx} ctx */
function outline(ctx) {
  const { doc } = ctx;
  /** @type {string[]} */
  const lines = [];
  /** @param {string | null} parent @param {number} depth */
  const walk = (parent, depth) => {
    for (const id of doc.children(parent)) {
      const text = doc
        .getTextRuns(id)
        .map((r) =>
          r.marks?.bold
            ? `**${r.text}**`
            : r.marks?.italic
              ? `_${r.text}_`
              : r.marks?.code
                ? `\`${r.text}\``
                : r.text,
        )
        .join("");
      const checked = doc.getAttrs(id).checked ? "[x]" : "";
      lines.push(`${"  ".repeat(depth)}${doc.getType(id)}${checked}:${text ? ` ${text}` : ""}`);
      walk(id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join("\n");
}

const pos = (/** @type {string} */ block, /** @type {number} */ offset) => ({ block, offset });

test("typing inherits marks from the character before, but not a link's end", () => {
  const { doc, ctx, ids } = build("p: ab");
  doc.format(ids[0], 0, 2, "bold", true);
  insertText(ctx, caret(pos(ids[0], 2)), "c");
  assert.equal(outline(ctx), "p: **abc**");
  doc.format(ids[0], 0, 3, "link", "https://a.example");
  insertText(ctx, caret(pos(ids[0], 3)), "d");
  assert.deepEqual(
    doc.getTextRuns(ids[0]).map((r) => r.marks?.link ?? null),
    ["https://a.example", null],
  );
});

test("Enter splits text, continues lists, and turns an empty list item into text", () => {
  const { ctx, ids } = build("p: hello world\nbulleted: one");
  let at = splitBlock(ctx, caret(pos(ids[0], 5)));
  assert.equal(outline(ctx), "p: hello\np:  world\nbulleted: one");
  assert.equal(at.offset, 0);
  at = splitBlock(ctx, caret(pos(ids[1], 3)));
  assert.equal(outline(ctx), "p: hello\np:  world\nbulleted: one\nbulleted:");
  splitBlock(ctx, caret(at));
  assert.equal(outline(ctx), "p: hello\np:  world\nbulleted: one\np:");
});

test("Enter at the start of a block adds an empty one above and keeps the caret", () => {
  const { ctx, ids } = build("h1: Title");
  const at = splitBlock(ctx, caret(pos(ids[0], 0)));
  assert.equal(outline(ctx), "p:\nh1: Title");
  assert.deepEqual(at, pos(ids[0], 0));
});

test("Enter in an empty nested list item outdents it", () => {
  const { ctx, ids } = build("bulleted: a\n  bulleted:");
  splitBlock(ctx, caret(pos(ids[1], 0)));
  assert.equal(outline(ctx), "bulleted: a\nbulleted:");
});

test("Enter in code is a line break; in an open toggle it adds a first child", () => {
  const { ctx, ids } = build("code: ab\ntoggle: t\n  p: inside");
  splitBlock(ctx, caret(pos(ids[0], 1)));
  splitBlock(ctx, caret(pos(ids[1], 1)));
  assert.equal(outline(ctx), "code: a\nb\ntoggle: t\n  toggle:\n  p: inside");
});

test("Backspace at the start turns a typed block into text, then joins it to the block above", () => {
  const { ctx, ids } = build("p: one\nh2: two\n  p: child");
  joinBackward(ctx, ids[1]);
  assert.equal(outline(ctx), "p: one\np: two\n  p: child");
  const at = joinBackward(ctx, ids[1]);
  assert.equal(outline(ctx), "p: onetwo\np: child");
  assert.deepEqual(at, pos(ids[0], 3));
});

test("Backspace below a divider deletes the divider; Delete at the end joins the next block", () => {
  const { ctx, ids } = build("p: a\ndivider:\np: b\np: c");
  joinBackward(ctx, ids[2]);
  assert.equal(outline(ctx), "p: a\np: b\np: c");
  joinForward(ctx, ids[2]);
  assert.equal(outline(ctx), "p: a\np: bc");
});

test("deleting across blocks joins the ends and keeps blocks after the range", () => {
  const { ctx, ids } = build(
    "p: alpha\nbulleted: beta\n  bulleted: gamma\n  bulleted: delta\np: omega",
  );
  deleteRange(ctx, pos(ids[0], 2), pos(ids[2], 2));
  assert.equal(outline(ctx), "p: almma\n  bulleted: delta\np: omega");
});

test("select-all delete leaves one empty block", () => {
  const { ctx, ids } = build("h1: a\np: b\n  p: c");
  deleteRange(ctx, pos(ids[0], 0), pos(ids[2], 1));
  assert.equal(outline(ctx), "h1:");
});

test("indent and outdent keep the order on screen", () => {
  const { ctx, ids } = build("p: a\np: b\np: c\np: d");
  indent(ctx, [ids[1], ids[2]]);
  assert.equal(outline(ctx), "p: a\n  p: b\n  p: c\np: d");
  outdent(ctx, [ids[1]]);
  assert.equal(outline(ctx), "p: a\np: b\n  p: c\np: d");
  indent(ctx, [ids[0]]);
  assert.equal(outline(ctx), "p: a\np: b\n  p: c\np: d", "the first block has nothing to go under");
});

test("selectedBlocks leaves out blocks under a selected parent", () => {
  const { ctx, ids } = build("p: a\n  p: b\np: c");
  assert.deepEqual(selectedBlocks(ctx, { anchor: pos(ids[2], 0), focus: pos(ids[0], 0) }), [
    ids[0],
    ids[2],
  ]);
});

test("closed toggles hide their children from the flat order", () => {
  const { ctx, ids } = build("toggle: t\n  p: hidden\np: after");
  ctx.setOpen(ids[0], false);
  assert.deepEqual(flatBlocks(ctx), [ids[0], ids[2]]);
  // The toggle is the start block, so it (and what's hidden in it) stays.
  deleteRange(ctx, pos(ids[0], 0), pos(ids[2], 0));
  assert.equal(outline(ctx), "toggle: after\n  p: hidden");
});

test("toggleMark sets, then clears, across blocks; code blocks are skipped", () => {
  const { ctx, ids } = build("p: one\ncode: x\np: two");
  const sel = { anchor: pos(ids[0], 1), focus: pos(ids[2], 2) };
  toggleMark(ctx, sel, "bold");
  assert.equal(outline(ctx), "p: o**ne**\ncode: x\np: **tw**o");
  toggleMark(ctx, sel, "bold");
  assert.equal(outline(ctx), "p: one\ncode: x\np: two");
  assert.equal(toggleMark(ctx, caret(pos(ids[0], 1)), "bold"), false);
});

test("turning into code drops formatting", () => {
  const { doc, ctx, ids } = build("p: hey");
  doc.format(ids[0], 0, 3, "bold", true);
  turnInto(ctx, [ids[0]], "code");
  assert.equal(outline(ctx), "code: hey");
});

test("Markdown block shortcuts", () => {
  for (const [typed, want] of [
    ["# ", "h1:"],
    ["## ", "h2:"],
    ["### ", "h3:"],
    ["- ", "bulleted:"],
    ["* ", "bulleted:"],
    ["1. ", "numbered:"],
    ["[] ", "todo:"],
    ["[x] ", "todo[x]:"],
    ["> ", "quote:"],
  ]) {
    const { ctx } = build("p:");
    let at = ensureBlock(ctx);
    for (const ch of typed) {
      at = insertText(ctx, caret(at), ch);
      at = applyInputRule(ctx, at, ch) ?? at;
    }
    assert.equal(outline(ctx), want, typed);
  }
});

test("block shortcuts also work inside other text blocks, but not their own", () => {
  for (const [start, typed, want] of [
    ["bulleted: ", "1. ", "numbered:"],
    ["bulleted: ", "[] ", "todo:"],
    ["numbered: ", "# ", "h1:"],
    ["todo[x]: ", "[] ", "todo:"],
    ["bulleted: ", "- ", "bulleted: - "],
    ["h1: ", "# ", "h1: # "],
  ]) {
    const { ctx, ids } = build(start);
    let at = pos(ids[0], 0);
    for (const ch of typed) {
      at = insertText(ctx, caret(at), ch);
      at = applyInputRule(ctx, at, ch) ?? at;
    }
    assert.equal(outline(ctx), want, `${start}${typed}`);
  }
});

test("Enter on two empty lines at the end of code leaves it; exitBlock reuses an empty paragraph", () => {
  const { ctx, ids } = build("code: x\np: after");
  let at = pos(ids[0], 1);
  for (let i = 0; i < 3; i++) at = splitBlock(ctx, caret(at));
  assert.equal(outline(ctx), "code: x\np:\np: after");
  assert.equal(ctx.doc.getType(at.block), "p");
  const second = build("code: y\np:");
  assert.deepEqual(exitBlock(second.ctx, second.ids[0]), pos(second.ids[1], 0));
  assert.equal(outline(second.ctx), "code: y\np:");
});

test("``` makes a code block and --- a divider with a paragraph after", () => {
  const { ctx } = build("p:");
  let at = ensureBlock(ctx);
  for (const ch of "```") at = applyInputRule(ctx, (at = insertText(ctx, caret(at), ch)), ch) ?? at;
  assert.equal(outline(ctx), "code:");
  const second = build("p:");
  at = ensureBlock(second.ctx);
  for (const ch of "---")
    at = applyInputRule(second.ctx, (at = insertText(second.ctx, caret(at), ch)), ch) ?? at;
  assert.equal(outline(second.ctx), "divider:\np:");
  assert.equal(second.ctx.doc.getType(at.block), "p");
  // Even when a text block follows, the caret gets a new line of its own.
  const third = build("p:\nh1: next");
  at = pos(third.ids[0], 0);
  for (const ch of "---")
    at = applyInputRule(third.ctx, (at = insertText(third.ctx, caret(at), ch)), ch) ?? at;
  assert.equal(outline(third.ctx), "divider:\np:\nh1: next");
  assert.equal(at.block, third.ctx.doc.children(null)[1]);
});

test("inline Markdown: **bold**, *italic*, `code`", () => {
  const { ctx } = build("p:");
  let at = ensureBlock(ctx);
  // After a rule, the editor types without the new mark (stored marks {}).
  let plain = false;
  for (const ch of "a **b** *c* `d`") {
    at = insertText(ctx, caret(at), ch, plain ? {} : null);
    const rule = applyInputRule(ctx, at, ch);
    plain = rule !== null || (plain && ch !== " ");
    if (rule) at = rule;
  }
  assert.equal(outline(ctx), "p: a **b** _c_ `d`");
});

test("an input rule is its own undo step: undo brings back the typed text", () => {
  let now = 0;
  const { doc, ctx } = build("p:");
  const um = new UndoManager(doc, { now: () => now });
  let at = ensureBlock(ctx);
  um.clear();
  for (const ch of "# ") {
    at = doc.transact(() => insertText(ctx, caret(at), ch));
    um.stopCapturing();
    const rule = doc.transact(() => applyInputRule(ctx, at, ch));
    if (rule) at = rule;
    now += 10;
  }
  assert.equal(outline(ctx), "h1:");
  um.undo();
  assert.equal(outline(ctx), "p: # ");
});

test("copy and paste a multi-block slice", () => {
  const { ctx, ids } = build("p: one\nbulleted: two\n  bulleted: three\np: four");
  const slice = getSlice(ctx, { anchor: pos(ids[0], 1), focus: pos(ids[2], 3) });
  assert.equal(slice.inline, false);
  assert.equal(sliceToText(slice), "ne\n- two\n  - thr");
  assert.equal(sliceToHtml(slice), "<p>ne</p><ul><li>two<ul><li>thr</li></ul></li></ul>");
  const target = build("p: AB");
  insertSlice(target.ctx, caret(pos(target.ids[0], 1)), slice);
  assert.equal(outline(target.ctx), "p: Ane\nbulleted: two\n  bulleted: thrB");
});

test("pasting into an empty line takes the first block's type; inline slices stay inline", () => {
  const { ctx, ids } = build("p:");
  insertSlice(ctx, caret(pos(ids[0], 0)), parsePlainText("# Title\nbody"));
  assert.equal(outline(ctx), "h1: Title\np: body");
  const other = build("p: xy");
  insertSlice(other.ctx, caret(pos(other.ids[0], 1)), parsePlainText("**hi**"));
  assert.equal(outline(other.ctx), "p: x**hi**y");
});

test("pasting into code is plain text", () => {
  const { ctx, ids } = build("code: ab");
  insertSlice(ctx, caret(pos(ids[0], 1)), parsePlainText("- one\n- **two**"));
  assert.equal(outline(ctx), "code: aone\ntwob");
});

test("plain-text Markdown parsing", () => {
  const slice = parsePlainText(
    "# H\n- a\n  - [x] b\n1. c\n> q\n```\nx = 1\n```\n---\nplain [link](https://e.example) and `c`",
  );
  assert.deepEqual(
    slice.blocks.map((b) => [
      b.type,
      b.depth,
      b.text.map((r) => r.text).join(""),
      b.attrs.checked ?? false,
    ]),
    [
      ["h1", 0, "H", false],
      ["bulleted", 0, "a", false],
      ["todo", 1, "b", true],
      ["numbered", 0, "c", false],
      ["quote", 0, "q", false],
      ["code", 0, "x = 1", false],
      ["divider", 0, "", false],
      ["p", 0, "plain link and c", false],
    ],
  );
  const last = slice.blocks[slice.blocks.length - 1].text;
  assert.deepEqual(last[1], { text: "link", marks: { link: "https://e.example/" } });
  assert.deepEqual(last[3], { text: "c", marks: { code: true } });
});

test("a pasted URL becomes a link", () => {
  const slice = parsePlainText("https://leaf.example/x");
  assert.deepEqual(slice.blocks[0].text, [
    { text: "https://leaf.example/x", marks: { link: "https://leaf.example/x" } },
  ]);
});

test("slash items: an empty block becomes the type; one with text gets a new block below", () => {
  const { ctx, ids } = build("p:\np: text");
  assert.deepEqual(applyBlockType(ctx, ids[0], "h2"), pos(ids[0], 0));
  const at = applyBlockType(ctx, ids[1], "todo");
  assert.equal(outline(ctx), "h2:\np: text\ntodo:");
  assert.equal(ctx.doc.getType(at.block), "todo");
  const div = build("p:\np: x");
  const after = applyBlockType(div.ctx, div.ids[0], "divider");
  assert.equal(outline(div.ctx), "divider:\np:\np: x");
  assert.equal(div.ctx.doc.getType(after.block), "p");
});

test("deleteBlocks puts the caret in the text block before, or after, or a new one", () => {
  const { ctx, ids } = build("p: a\nbulleted: b\n  p: c\np: d");
  assert.deepEqual(deleteBlocks(ctx, [ids[1]]), pos(ids[0], 1));
  assert.equal(outline(ctx), "p: a\np: d");
  const first = build("p: a\np: b");
  assert.deepEqual(deleteBlocks(first.ctx, [first.ids[0]]), pos(first.ids[1], 0));
  const all = build("p: a");
  const at = deleteBlocks(all.ctx, [all.ids[0]]);
  assert.equal(outline(all.ctx), "p:");
  assert.equal(at.offset, 0);
});

test("duplicateBlocks copies subtrees, text and attrs right after the last block", () => {
  const { ctx, ids } = build("todo[x]: a\n  p: child\np: b\np: c");
  const at = duplicateBlocks(ctx, [ids[0], ids[2]]);
  assert.equal(outline(ctx), "todo[x]: a\n  p: child\np: b\ntodo[x]: a\n  p: child\np: b\np: c");
  assert.equal(ctx.doc.getText(at?.block ?? ""), "b");
});

test("moveBlocks keeps order and refuses to move a block into itself", () => {
  const { ctx, ids } = build("p: a\np: b\np: c\np: d");
  assert.equal(moveBlocks(ctx, [ids[0], ids[1]], { parent: null, after: ids[3] }), true);
  assert.equal(outline(ctx), "p: c\np: d\np: a\np: b");
  assert.equal(moveBlocks(ctx, [ids[2]], { parent: ids[2], after: null }), false);
  assert.equal(moveBlocks(ctx, [ids[2], ids[3]], { parent: null, after: ids[3] }), false);
  assert.equal(moveBlocks(ctx, [ids[0]], { parent: ids[3], after: null }), true);
  assert.equal(outline(ctx), "p: c\np: d\n  p: a\np: b");
});

test("typing after a mention doesn't extend it", () => {
  const { ctx, ids } = build("p:");
  ctx.doc.insertText(ids[0], 0, "Page", { mention: { type: "page", id: "x" } });
  const at = insertText(ctx, caret(pos(ids[0], 4)), "!");
  assert.equal(at.offset, 5);
  assert.deepEqual(ctx.doc.getTextRuns(ids[0]), [
    { text: "Page", marks: { mention: { type: "page", id: "x" } } },
    { text: "!" },
  ]);
});

test("slash menu filtering", () => {
  const ids = (/** @type {string} */ q) => filterSlashItems(q).map((i) => i.id);
  assert.equal(ids("").length, SLASH_ITEMS.length);
  assert.deepEqual(ids("h"), ["h1", "h2", "h3", "divider"]);
  assert.deepEqual(ids("head 2"), ["h2"]);
  assert.deepEqual(ids("todo"), ["todo"]);
  assert.deepEqual(ids("list").slice(0, 4), ["bulleted", "numbered", "todo", "toggle"]);
  assert.deepEqual(ids("ment"), ["mention"]);
  assert.deepEqual(ids("zzz"), []);
});

test("moveBlocksBy steps among siblings, then out of the parent", () => {
  const { ctx, ids } = build("p: a\nbulleted: b\n  p: c\n  p: d\np: e");
  assert.equal(moveBlocksBy(ctx, [ids[3]], -1), true);
  assert.equal(outline(ctx), "p: a\nbulleted: b\n  p: d\n  p: c\np: e");
  assert.equal(moveBlocksBy(ctx, [ids[3]], -1), true);
  assert.equal(outline(ctx), "p: a\np: d\nbulleted: b\n  p: c\np: e");
  assert.equal(moveBlocksBy(ctx, [ids[2]], 1), true);
  assert.equal(outline(ctx), "p: a\np: d\nbulleted: b\np: c\np: e");
  assert.equal(moveBlocksBy(ctx, [ids[0], ids[3]], -1), false);
  assert.equal(moveBlocksBy(ctx, [ids[4]], 1), false);
  assert.equal(moveBlocksBy(ctx, [ids[2], ids[4]], -1), true);
  assert.equal(outline(ctx), "p: a\np: d\np: c\np: e\nbulleted: b");
});
