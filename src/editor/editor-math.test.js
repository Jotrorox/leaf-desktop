// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { MATH_MARK } from "./blocks/schema.js";
import { caret } from "./commands/commands.js";
import { mathRanges } from "./commands/runs.js";
import { EditorController } from "./editor.js";
import { Doc } from "./model/doc.js";

/**
 * Two replicas of a page holding "x " and the formula `a+b+c`, and an
 * editor (not mounted: no DOM) on the first.
 */
function setup() {
  const a = new Doc({ clientId: 1 });
  let block = "";
  a.transact(() => {
    block = a.insertBlock({ type: "p" });
    a.insertText(block, 0, "x ", null);
    a.insertText(block, 2, "a+b+c", { [MATH_MARK]: "m1" });
  });
  const b = new Doc({ clientId: 2 });
  b.applyUpdate(a.encodeDiff());
  const ed = new EditorController(a);
  ed.selection = caret({ block, offset: 7 });
  return { a, b, ed, block };
}

/** @param {Doc} doc @param {string} block */
const formulas = (doc, block) =>
  mathRanges(doc.getTextRuns(block)).map((m) => doc.getText(block).slice(m.start, m.end));

test("saving a formula changes only what was edited, so a concurrent edit to another part survives", () => {
  const { a, b, ed, block } = setup();
  ed.editMath(block, 3);
  assert.equal(ed.mathRequest()?.source, "a+b+c");
  // Meanwhile someone else changes the start of the same formula.
  b.transact(() => {
    b.deleteText(block, 2, 1);
    b.insertText(block, 2, "A", { [MATH_MARK]: "m1" });
  });
  ed.applyRemote(b.encodeDiff(a.stateVector()));
  ed.finishMath("a+b+C", "none");
  assert.deepEqual(formulas(a, block), ["A+b+C"]);
  b.applyUpdate(a.encodeDiff(b.stateVector()));
  assert.deepEqual(formulas(b, block), ["A+b+C"]);
});

test("the popover follows its formula when text before it changes", () => {
  const { a, b, ed, block } = setup();
  ed.editMath(block, 2);
  b.transact(() => b.insertText(block, 0, "well, ", null));
  ed.applyRemote(b.encodeDiff(a.stateVector()));
  ed.finishMath("a-b", "none");
  assert.equal(a.getText(block), "well, x a-b");
  assert.deepEqual(formulas(a, block), ["a-b"]);
  assert.deepEqual(ed.selection, caret({ block, offset: 11 }), "the caret goes after the formula");
});

test("a new formula at the caret, emptied formulas are deleted, and cancel changes nothing", () => {
  const { a, ed, block } = setup();
  ed.toggleInlineMath();
  assert.equal(ed.mathRequest()?.id, null);
  ed.finishMath("y^2", "none");
  assert.deepEqual(formulas(a, block), ["a+b+c", "y^2"]);
  assert.equal(
    mathRanges(a.getTextRuns(block)).length,
    2,
    "it doesn't merge with the formula before it",
  );

  ed.editMath(block, 2);
  ed.finishMath(null, "none");
  assert.deepEqual(formulas(a, block), ["a+b+c", "y^2"]);

  ed.editMath(block, 2);
  ed.finishMath("  ", "none");
  assert.equal(a.getText(block), "x y^2");
});

test("each save is one undo step", () => {
  const { a, ed, block } = setup();
  ed.editMath(block, 2);
  ed.finishMath("\\frac{a}{b}", "none");
  assert.deepEqual(formulas(a, block), ["\\frac{a}{b}"]);
  ed.history(false);
  assert.deepEqual(formulas(a, block), ["a+b+c"]);
  ed.history(true);
  assert.deepEqual(formulas(a, block), ["\\frac{a}{b}"]);
});

test("⌘⇧E over text makes a formula of it, and over a formula turns it back into text", () => {
  const { a, ed, block } = setup();
  ed.selection = { anchor: { block, offset: 0 }, focus: { block, offset: 1 } };
  ed.toggleInlineMath();
  assert.deepEqual(formulas(a, block), ["x", "a+b+c"]);
  ed.selection = { anchor: { block, offset: 0 }, focus: { block, offset: 7 } };
  ed.toggleInlineMath();
  assert.deepEqual(formulas(a, block), []);
  assert.equal(a.getText(block), "x a+b+c");
});
