// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { EditorController } from "../editor.js";
import { Doc } from "../model/doc.js";
import { refCommands } from "./commands.js";
import { equationLabel, NO_REFS, numberEquations, resolveRefs } from "./refs.js";
import { installKatex, mathmlSource, renderMath } from "./render.js";

installKatex(katex);

test("an equation's label is its first \\label, and an escaped one isn't", () => {
  assert.equal(equationLabel("E = mc^2 \\label{ energy }"), "energy");
  assert.equal(equationLabel("a \\label{} b \\label{second}"), "second");
  assert.equal(equationLabel("a \\\\label{x}"), null, "\\\\ is a line break");
  assert.equal(equationLabel("a \\labels{x}"), null);
  assert.equal(equationLabel("x^2"), null);
});

test("references become numbers, labels go, and unknown labels show ??", () => {
  const refs = new Map([["euler", 2]]);
  assert.equal(resolveRefs("e^{i\\pi}+1=0 \\label{euler}", refs), "e^{i\\pi}+1=0 ");
  assert.equal(resolveRefs("by \\eqref{euler}", refs), "by \\text{(2)}");
  assert.equal(resolveRefs("\\ref { euler }", refs), "\\text{2}");
  assert.equal(resolveRefs("\\eqref{nope}", refs), "\\text{(\\textbf{??})}");
  assert.equal(
    resolveRefs("a\\\\eqref{euler}", refs),
    "a\\\\eqref{euler}",
    "after \\\\ it's text, not a command",
  );
  assert.equal(resolveRefs("\\eqrefs{euler}", refs), "\\eqrefs{euler}");
  const plain = "x^2";
  assert.equal(resolveRefs(plain, refs), plain);
});

test("formulas with labels and references draw, and MathML has the numbers", () => {
  const refs = new Map([["a", 1]]);
  assert.ok(renderMath("x \\label{a}", { display: true })?.html, "a label alone is fine");
  const ref = renderMath("\\eqref{a}", { refs });
  assert.ok(ref?.html?.includes("(1)"));
  assert.ok(renderMath("\\eqref{b}", { refs })?.html?.includes("??"));
  assert.ok(mathmlSource("\\eqref{a}", false, "", refs)?.includes("(1)"));
  assert.ok(
    renderMath("\\eqref{a}", { refs: NO_REFS })?.html?.includes("??"),
    "cached by what's drawn, not the source",
  );
});

/** A page: a paragraph, a numbered equation, a toggle holding one, an unnumbered one and another numbered one. */
function page() {
  const doc = new Doc({ clientId: 1 });
  /** @type {Record<string, string>} */
  const ids = {};
  doc.transact(() => {
    ids.p = doc.insertBlock({ type: "p", text: "see $$\\eqref{b}$$" });
    ids.a = doc.insertBlock({
      type: "equation",
      after: ids.p,
      attrs: { numbered: true },
      text: "a \\label{a}",
    });
    ids.toggle = doc.insertBlock({ type: "toggle", after: ids.a, text: "more" });
    ids.b = doc.insertBlock({
      type: "equation",
      parent: ids.toggle,
      attrs: { numbered: true },
      text: "b \\label{b}",
    });
    ids.plain = doc.insertBlock({ type: "equation", after: ids.toggle, text: "c \\label{c}" });
    ids.dup = doc.insertBlock({
      type: "equation",
      after: ids.plain,
      attrs: { numbered: true },
      text: "d \\label{a}",
    });
  });
  return { doc, ids };
}

test("numbered equations count up in page order, nested ones included", () => {
  const { doc, ids } = page();
  const n = numberEquations(doc);
  assert.deepEqual(
    [...n.numbers],
    [
      [ids.a, 1],
      [ids.b, 2],
      [ids.dup, 3],
    ],
  );
  assert.deepEqual(
    [...n.refs],
    [
      ["a", 1],
      ["b", 2],
    ],
    "an unnumbered equation's label isn't a reference, and the first of two keeps it",
  );
  assert.deepEqual([...n.duplicates], [ids.dup]);
  assert.equal(n.equations.size, 4);
});

test("the editor renumbers when equations change, move or go, as one undo step each", () => {
  const { doc, ids } = page();
  const ed = new EditorController(doc);
  const numbers = () => [...ed.equationNumbering().numbers.values()];
  const refs = () => Object.fromEntries(ed.equationNumbering().refs);
  assert.deepEqual(numbers(), [1, 2, 3]);

  ed.setEquationsNumbered([ids.plain, ids.p], true);
  assert.equal(ed.equationNumbering().numbers.get(ids.plain), 3, "only equations get numbered");
  assert.equal(ed.equationNumbering().numbers.get(ids.dup), 4);
  assert.deepEqual(refs(), { a: 1, b: 2, c: 3 });
  assert.equal(doc.getAttrs(ids.p).numbered, undefined);

  ed.undo.undo();
  assert.deepEqual(refs(), { a: 1, b: 2 });

  // Editing a label renames it; moving an equation renumbers.
  doc.transact(() => doc.insertText(ids.b, doc.getText(ids.b).length - 1, "2", null));
  assert.deepEqual(refs(), { a: 1, b2: 2 });
  ed.moveBlocks([ids.dup], { parent: null, after: null });
  assert.deepEqual(refs(), { a: 1, b2: 3 }, "the moved equation is first now, so its label wins");
  assert.equal(ed.equationNumbering().numbers.get(ids.dup), 1);

  // Turning an equation into text drops it from the numbering.
  ed.turnBlocksInto([ids.dup], "p");
  assert.deepEqual(refs(), { a: 1, b2: 2 });
  ed.destroy();
});

test("the page's labels complete as references, shown as their numbers", () => {
  const [c] = refCommands(new Map([["euler", 4]]));
  assert.deepEqual(c, {
    label: "eqref{euler}",
    insert: "\\eqref{euler}",
    caret: 13,
    preview: "\\text{(4)}",
  });
});
