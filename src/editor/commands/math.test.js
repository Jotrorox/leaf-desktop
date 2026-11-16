// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { MATH_MARK } from "../blocks/schema.js";
import { parsePlainText } from "../clipboard/parse-text.js";
import { sliceToHtml, sliceToText } from "../clipboard/serialize.js";
import { Doc } from "../model/doc.js";
import {
  caret,
  createBlock,
  getSlice,
  insertSlice,
  insertText,
  joinBackward,
  joinForward,
  splitBlock,
  toggleMark,
  turnInto,
} from "./commands.js";
import { applyInputRule } from "./markdown.js";
import { expandToMath, formatText, freshMathIds, marksAt, mathAt, mathRanges } from "./runs.js";

/** @param {...{ type: string, text?: import("../model/doc.js").TextRun[] }} blocks */
function setup(...blocks) {
  const doc = new Doc({ clientId: 1 });
  const ctx = { doc, isOpen: () => true };
  const ids = blocks.map((b) =>
    createBlock(doc, { type: b.type, parent: null, after: undefined, text: b.text ?? [] }),
  );
  return { doc, ctx, ids };
}

/**
 * Type `text` one character at a time at the end of block `id`, applying
 * Markdown rules the way the editor does.
 * @param {ReturnType<typeof setup>["ctx"]} ctx @param {string} id @param {string} text
 */
function type(ctx, id, text) {
  for (const ch of text) {
    const at = insertText(ctx, caret({ block: id, offset: ctx.doc.textLength(id) }), ch);
    applyInputRule(ctx, at, ch);
  }
}

/** Runs as a compact string: formulas in [brackets], bold in *stars*. @param {Doc} doc @param {string} id */
function show(doc, id) {
  return doc
    .getTextRuns(id)
    .map((r) => (r.marks?.[MATH_MARK] ? `[${r.text}]` : r.marks?.bold ? `*${r.text}*` : r.text))
    .join("");
}

test("$$…$$ becomes inline math on the closing marker; single dollars never do", () => {
  const { doc, ctx, ids } = setup({ type: "p" });
  type(ctx, ids[0], "Costs $5 and $10, so $$a^2+b^2$$ ok");
  assert.equal(show(doc, ids[0]), "Costs $5 and $10, so [a^2+b^2] ok");
  // Text typed right after a formula is plain.
  assert.equal(marksAt(doc, ids[0], 31), null);
});

test("an unconverted $$ earlier in the line doesn't pair up with a new one", () => {
  const { doc, ctx, ids } = setup({ type: "p", text: [{ text: "Energy $$E and more " }] });
  type(ctx, ids[0], "$$x$$");
  assert.equal(show(doc, ids[0]), "Energy $$E and more [x]");
});

test("two formulas side by side stay two", () => {
  const { doc, ctx, ids } = setup({ type: "p" });
  type(ctx, ids[0], "$$a$$");
  type(ctx, ids[0], "$$b$$");
  assert.equal(mathRanges(doc.getTextRuns(ids[0])).length, 2);
});

test("a formula takes no formatting from the text it was typed in, and Markdown inside it is literal", () => {
  const { doc, ctx, ids } = setup({
    type: "p",
    text: [{ text: "$$a*b", marks: { bold: true, color: "red" } }],
  });
  type(ctx, ids[0], "$$");
  const [run] = doc.getTextRuns(ids[0]);
  assert.deepEqual(Object.keys(run.marks ?? {}).sort(), ["color", MATH_MARK]);
  type(ctx, ids[0], " c*");
  assert.equal(show(doc, ids[0]), "[a*b] c*");
});

test("$$ and a space on an empty line makes an equation; not in a line with text", () => {
  const { doc, ctx, ids } = setup({ type: "p" }, { type: "p", text: [{ text: "x" }] });
  type(ctx, ids[0], "$$ ");
  assert.equal(doc.getType(ids[0]), "equation");
  assert.equal(doc.getText(ids[0]), "");
  const at = insertText(ctx, caret({ block: ids[1], offset: 0 }), "$$ ");
  assert.equal(applyInputRule(ctx, at, " "), null);
  assert.equal(doc.getType(ids[1]), "p");
});

test("Markdown rules don't run inside an equation's TeX", () => {
  const { doc, ctx, ids } = setup({ type: "equation" });
  type(ctx, ids[0], "# **x** $$y$$");
  assert.equal(doc.getType(ids[0]), "equation");
  assert.equal(doc.getText(ids[0]), "# **x** $$y$$");
  assert.deepEqual(doc.getTextRuns(ids[0]), [{ text: "# **x** $$y$$" }]);
});

test("formatting a selection skips formulas; color applies to them", () => {
  const { doc, ctx, ids } = setup({
    type: "p",
    text: [{ text: "a " }, { text: "x^2", marks: { [MATH_MARK]: "m1" } }, { text: " b" }],
  });
  const all = { anchor: { block: ids[0], offset: 0 }, focus: { block: ids[0], offset: 7 } };
  toggleMark(ctx, all, "bold");
  assert.equal(show(doc, ids[0]), "*a *[x^2]* b*");
  // Every formattable character is bold now, so it toggles off.
  toggleMark(ctx, all, "bold");
  assert.equal(show(doc, ids[0]), "a [x^2] b");
  formatText(doc, ids[0], 0, 7, "color", "red");
  assert.equal(doc.getTextRuns(ids[0])[1].marks?.color, "red");
});

test("formula lookups: extent, growing a range to whole formulas, fresh ids", () => {
  const runs = [
    { text: "ab" },
    { text: "xy", marks: { [MATH_MARK]: "m1" } },
    { text: "z", marks: { [MATH_MARK]: "m1", color: "red" } },
    { text: "w", marks: { [MATH_MARK]: "m2" } },
  ];
  assert.deepEqual(mathRanges(runs), [
    { start: 2, end: 5, id: "m1" },
    { start: 5, end: 6, id: "m2" },
  ]);
  assert.deepEqual(mathAt(runs, 3), { start: 2, end: 5, id: "m1" });
  assert.equal(mathAt(runs, 1), null);
  assert.deepEqual(expandToMath(runs, 1, 3), { start: 1, end: 5 });
  const fresh = freshMathIds(runs);
  assert.notEqual(fresh[1].marks?.[MATH_MARK], "m1");
  assert.equal(
    fresh[1].marks?.[MATH_MARK],
    fresh[2].marks?.[MATH_MARK],
    "one formula keeps one id",
  );
  assert.notEqual(fresh[2].marks?.[MATH_MARK], fresh[3].marks?.[MATH_MARK]);
});

test("equations: turning into one drops formatting; Enter is a line break", () => {
  const { doc, ctx, ids } = setup({
    type: "p",
    text: [
      { text: "x", marks: { bold: true } },
      { text: "^2", marks: { [MATH_MARK]: "m1" } },
    ],
  });
  turnInto(ctx, [ids[0]], "equation");
  assert.deepEqual(doc.getTextRuns(ids[0]), [{ text: "x^2" }]);
  const at = splitBlock(ctx, caret({ block: ids[0], offset: 3 }));
  assert.equal(doc.getText(ids[0]), "x^2\n");
  assert.deepEqual(at, { block: ids[0], offset: 4 });
});

test("Backspace below an equation moves into it instead of pouring text into the TeX", () => {
  const { doc, ctx, ids } = setup(
    { type: "equation", text: [{ text: "x^2" }] },
    { type: "p", text: [{ text: "after" }] },
    { type: "p" },
  );
  assert.deepEqual(joinBackward(ctx, ids[1]), { block: ids[0], offset: 3 });
  assert.equal(doc.getText(ids[0]), "x^2");
  assert.equal(doc.getText(ids[1]), "after");
  // An empty line right below goes away.
  const {
    doc: d2,
    ctx: c2,
    ids: i2,
  } = setup({ type: "equation", text: [{ text: "y" }] }, { type: "p" });
  assert.deepEqual(joinBackward(c2, i2[1]), { block: i2[0], offset: 1 });
  assert.equal(d2.hasBlock(i2[1]) && d2.isVisible(i2[1]), false);
});

test("Delete never joins an equation with its neighbours", () => {
  const { doc, ctx, ids } = setup(
    { type: "p", text: [{ text: "before" }] },
    { type: "equation", text: [{ text: "x" }] },
    { type: "p", text: [{ text: "after" }] },
  );
  assert.deepEqual(joinForward(ctx, ids[0]), { block: ids[1], offset: 0 });
  assert.deepEqual(joinForward(ctx, ids[1]), { block: ids[1], offset: 1 });
  assert.deepEqual(
    [doc.getText(ids[0]), doc.getText(ids[1]), doc.getText(ids[2])],
    ["before", "x", "after"],
  );
});

test("pasting a leaf slice into an equation keeps just the text", () => {
  const { doc, ctx, ids } = setup({ type: "equation", text: [{ text: "a" }] });
  insertSlice(ctx, caret({ block: ids[0], offset: 1 }), {
    inline: false,
    blocks: [
      {
        type: "p",
        attrs: {},
        text: [
          { text: "b", marks: { bold: true } },
          { text: "+c", marks: { [MATH_MARK]: "m1" } },
        ],
        depth: 0,
      },
      { type: "h1", attrs: {}, text: [{ text: "d" }], depth: 0 },
    ],
  });
  assert.deepEqual(doc.getTextRuns(ids[0]), [{ text: "ab+c\nd" }]);
});

test("copying math: $$ in plain text, and a slice that pastes back as math", () => {
  const { ctx, ids } = setup(
    { type: "p", text: [{ text: "so " }, { text: "x^2", marks: { [MATH_MARK]: "m1" } }] },
    { type: "equation", text: [{ text: "\\sum_i i" }] },
    { type: "equation" },
  );
  const all = { anchor: { block: ids[0], offset: 0 }, focus: { block: ids[2], offset: 0 } };
  const slice = getSlice(ctx, all);
  // Without KaTeX loaded, HTML falls back to the same $$ text.
  assert.equal(sliceToText(slice), "so $$x^2$$\n$$\n\\sum_i i\n$$");
  assert.equal(sliceToHtml(slice), "<p>so $$x^2$$</p><div>$$\\sum_i i$$</div>");
  const inline = getSlice(ctx, {
    anchor: { block: ids[1], offset: 0 },
    focus: { block: ids[1], offset: 4 },
  });
  assert.equal(sliceToText(inline), "\\sum", "part of an equation is just TeX");

  const back = parsePlainText(sliceToText(slice));
  assert.deepEqual(
    back.blocks.map((b) => [
      b.type,
      b.text.map((r) => (r.marks?.[MATH_MARK] ? `[${r.text}]` : r.text)).join(""),
    ]),
    [
      ["p", "so [x^2]"],
      ["equation", "\\sum_i i"],
    ],
  );
});

test("Markdown paste: $$ fences and $$…$$ lines are equations, $$…$$ in a line is inline math", () => {
  const slice = parsePlainText("Intro $$a+b$$ end\n$$\n\\int f\n$$\n$$E=mc^2$$\nCosts $5 and $10");
  assert.deepEqual(
    slice.blocks.map((b) => [
      b.type,
      b.text.map((r) => (r.marks?.[MATH_MARK] ? `[${r.text}]` : r.text)).join(""),
    ]),
    [
      ["p", "Intro [a+b] end"],
      ["equation", "\\int f"],
      ["equation", "E=mc^2"],
      ["p", "Costs $5 and $10"],
    ],
  );
  const one = parsePlainText("$$x$$");
  assert.equal(one.inline, true);
  assert.ok(one.blocks[0].text[0].marks?.[MATH_MARK]);
});
