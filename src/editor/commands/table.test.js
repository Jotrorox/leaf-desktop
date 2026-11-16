// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePlainText } from "../clipboard/parse-text.js";
import { sliceToHtml, sliceToText } from "../clipboard/serialize.js";
import { Doc } from "../model/doc.js";
import {
  applyBlockType,
  caret,
  createBlock,
  deleteRange,
  flatBlocks,
  getSlice,
  indent,
  insertSlice,
  joinBackward,
  joinForward,
  moveBlocks,
  selectedBlocks,
  splitBlock,
  turnInto,
  wholeTables,
} from "./commands.js";
import { applyInputRule, findTableRule } from "./markdown.js";
import {
  cellPlace,
  createTable,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  insertTable,
  moveColumn,
  moveRow,
  padTable,
  splitTableLine,
  stepCell,
  tableGrid,
  tableOf,
  verticalCell,
} from "./table.js";

/** @param {Doc} [doc] */
function setup(doc = new Doc({ clientId: 1 })) {
  const open = new Set();
  const ctx = {
    doc,
    isOpen: (/** @type {string} */ id) => open.has(id),
    setOpen: (/** @type {string} */ id, /** @type {boolean} */ v) =>
      v ? open.add(id) : open.delete(id),
  };
  return { doc, ctx };
}

/** A table with cells holding `texts`, between paragraphs "before" and "after". @param {string[][]} texts */
function withTable(texts) {
  const { doc, ctx } = setup();
  const before = createBlock(doc, {
    type: "p",
    parent: null,
    after: undefined,
    text: [{ text: "before" }],
  });
  const table = createTable(doc, {
    parent: null,
    after: before,
    cells: texts.map((row) => row.map((t) => (t ? [{ text: t }] : []))),
    attrs: { header_row: true },
  });
  const after = createBlock(doc, {
    type: "p",
    parent: null,
    after: table,
    text: [{ text: "after" }],
  });
  return { doc, ctx, before, table, after, grid: tableGrid(doc, table) };
}

/** @param {Doc} doc @param {string} table */
const texts = (doc, table) => tableGrid(doc, table).map((row) => row.map((id) => doc.getText(id)));

test("a table is a table block of rows of cells, in screen order", () => {
  const { doc, ctx, before, table, after, grid } = withTable([
    ["a", "b"],
    ["c", "d"],
  ]);
  const rows = doc.children(table);
  assert.deepEqual(flatBlocks(ctx), [
    before,
    table,
    rows[0],
    ...grid[0],
    rows[1],
    ...grid[1],
    after,
  ]);
  assert.equal(tableOf(doc, grid[1][0]), table);
  assert.deepEqual(cellPlace(doc, grid[1][0]), { table, row: 1, col: 0, grid });
  assert.equal(tableOf(doc, before), null);
});

test("the slash menu's table replaces an empty paragraph and puts the caret in the first cell", () => {
  const { doc, ctx } = setup();
  const p = createBlock(doc, { type: "p", parent: null, after: undefined });
  const at = insertTable(ctx, p);
  const [table] = doc.root();
  assert.equal(doc.getType(table), "table");
  assert.equal(doc.getAttrs(table).header_row, true);
  assert.deepEqual(texts(doc, table), [
    ["", "", ""],
    ["", "", ""],
    ["", "", ""],
  ]);
  assert.equal(at.block, tableGrid(doc, table)[0][0]);
  // From a cell, block items go after the table instead.
  const h = applyBlockType(ctx, at.block, "h1");
  assert.deepEqual(doc.root(), [table, h.block]);
  assert.equal(doc.getType(h.block), "h1");
});

test("Enter in a cell is a line break; Backspace and Delete at its edges do nothing", () => {
  const { doc, ctx, table, grid } = withTable([["ab", "cd"]]);
  const at = splitBlock(ctx, caret({ block: grid[0][0], offset: 1 }));
  assert.deepEqual(texts(doc, table), [["a\nb", "cd"]]);
  assert.deepEqual(at, { block: grid[0][0], offset: 2 });
  assert.deepEqual(joinBackward(ctx, grid[0][1]), { block: grid[0][1], offset: 0 });
  joinForward(ctx, grid[0][0]);
  assert.deepEqual(texts(doc, table), [["a\nb", "cd"]]);
});

test("Backspace below a table and Delete above it move into it instead of joining", () => {
  const { doc, ctx, before, table, after, grid } = withTable([["x", "y"]]);
  assert.deepEqual(joinBackward(ctx, after), { block: grid[0][1], offset: 1 });
  assert.equal(doc.getText(after), "after");
  assert.deepEqual(joinForward(ctx, before), { block: grid[0][0], offset: 0 });
  assert.deepEqual(doc.root(), [before, table, after]);
  // An empty line goes away as the caret moves.
  doc.deleteText(after, 0, 5);
  joinBackward(ctx, after);
  assert.deepEqual(doc.root(), [before, table]);
});

test("deleting across cells empties them; the table keeps its shape", () => {
  const { doc, ctx, table, grid } = withTable([
    ["one", "two"],
    ["three", "four"],
  ]);
  const at = deleteRange(ctx, { block: grid[0][1], offset: 1 }, { block: grid[1][1], offset: 2 });
  assert.deepEqual(texts(doc, table), [
    ["one", "t"],
    ["", "ur"],
  ]);
  assert.deepEqual(at, { block: grid[0][1], offset: 1 });
});

test("deleting from a table into the text after it clears cells and keeps the rest", () => {
  const { doc, ctx, table, after, grid } = withTable([["one", "two"]]);
  const mid = createBlock(doc, {
    type: "p",
    parent: null,
    after: table,
    text: [{ text: "middle" }],
  });
  deleteRange(ctx, { block: grid[0][0], offset: 1 }, { block: after, offset: 2 });
  assert.deepEqual(texts(doc, table), [["o", ""]]);
  assert.equal(doc.hasBlock(mid) && doc.isVisible(mid), false);
  assert.equal(doc.getText(after), "ter");
  // From before a table into it: the start keeps its text up to the caret.
  const { doc: d2, ctx: c2, before, table: t2, grid: g2 } = withTable([["ab", "cd"]]);
  deleteRange(c2, { block: before, offset: 3 }, { block: g2[0][1], offset: 1 });
  assert.equal(d2.getText(before), "bef");
  assert.deepEqual(texts(d2, t2), [["", "d"]]);
  // A whole table inside the range goes.
  const { doc: d3, ctx: c3, before: b3, table: t3, after: a3 } = withTable([["x"]]);
  deleteRange(c3, { block: b3, offset: 2 }, { block: a3, offset: 2 });
  assert.equal(d3.isVisible(t3), false);
});

test("Tab moves to the next cell, adding a row after the last; Shift+Tab goes back", () => {
  const { doc, ctx, table, grid } = withTable([["a", "bc"]]);
  assert.deepEqual(stepCell(ctx, grid[0][0], 1), {
    anchor: { block: grid[0][1], offset: 0 },
    focus: { block: grid[0][1], offset: 2 },
  });
  const added = stepCell(ctx, grid[0][1], 1);
  const rows = tableGrid(doc, table);
  assert.equal(rows.length, 2);
  assert.equal(added?.focus.block, rows[1][0]);
  assert.equal(stepCell(ctx, grid[0][0], -1)?.focus.block, grid[0][0]);
  assert.equal(verticalCell(doc, rows[1][0], -1), grid[0][0]);
  assert.equal(verticalCell(doc, grid[0][0], -1), null);
});

test("rows and columns are added, moved and deleted; the last one takes the table along", () => {
  const { doc, table } = withTable([
    ["a", "b"],
    ["c", "d"],
  ]);
  insertRow(doc, table, 1);
  insertColumn(doc, table, 0);
  assert.deepEqual(texts(doc, table), [
    ["", "a", "b"],
    ["", "", ""],
    ["", "c", "d"],
  ]);
  moveRow(doc, table, 2, 0);
  moveColumn(doc, table, 0, 2);
  assert.deepEqual(texts(doc, table), [
    ["c", "d", ""],
    ["a", "b", ""],
    ["", "", ""],
  ]);
  deleteRow(doc, table, 2);
  deleteColumn(doc, table, 2);
  assert.deepEqual(texts(doc, table), [
    ["c", "d"],
    ["a", "b"],
  ]);
  deleteColumn(doc, table, 0);
  assert.equal(deleteColumn(doc, table, 0), false);
  assert.equal(doc.isVisible(table), false);
});

test("a row and a column added at the same time leave a gap, which table commands fill", () => {
  const a = new Doc({ clientId: 1 });
  const table = createTable(a, { parent: null, after: undefined, cells: [[[{ text: "x" }]]] });
  const b = new Doc({ clientId: 2 });
  b.applyUpdate(a.encodeDiff(b.stateVector()));
  insertRow(a, table, 1);
  insertColumn(b, table, 1);
  a.applyUpdate(b.encodeDiff(a.stateVector()));
  b.applyUpdate(a.encodeDiff(b.stateVector()));
  assert.deepEqual(
    tableGrid(a, table).map((r) => r.length),
    [2, 1],
  );
  assert.deepEqual(a.toJSON(), b.toJSON());
  padTable(a, table);
  assert.deepEqual(
    tableGrid(a, table).map((r) => r.length),
    [2, 2],
  );
});

test("block commands treat a table as one block", () => {
  const { doc, ctx, before, table, after, grid } = withTable([["a", "b"]]);
  assert.deepEqual(
    selectedBlocks(ctx, {
      anchor: { block: grid[0][0], offset: 0 },
      focus: { block: after, offset: 1 },
    }),
    [table, after],
  );
  turnInto(ctx, [grid[0][0]], "h1");
  assert.equal(doc.getType(grid[0][0]), "table_cell");
  indent(ctx, [after]);
  assert.equal(doc.parentOf(after), null);
  assert.equal(moveBlocks(ctx, [before], { parent: table, after: null }), false);
  assert.equal(moveBlocks(ctx, [grid[0][0]], { parent: null, after: null }), false);
  // Block shortcuts don't apply in a cell; inline ones do.
  doc.insertText(grid[0][0], 0, "# ", null);
  assert.equal(applyInputRule(ctx, { block: grid[0][0], offset: 2 }, " "), null);
  doc.insertText(grid[0][1], 1, " **x**", null);
  assert.ok(applyInputRule(ctx, { block: grid[0][1], offset: 7 }, "*"));
  assert.equal(doc.getText(grid[0][1]), "b x");
});

test("Enter on a Markdown table line makes a table with that header", () => {
  const { doc, ctx } = setup();
  const p = createBlock(doc, {
    type: "p",
    parent: null,
    after: undefined,
    text: [{ text: "| Name | **Due** |" }],
  });
  assert.equal(findTableRule(ctx, { block: p, offset: 3 }), null);
  const rule = findTableRule(ctx, { block: p, offset: doc.textLength(p) });
  assert.ok(rule);
  const at = rule();
  const [table] = doc.root();
  assert.deepEqual(texts(doc, table), [
    ["Name", "Due"],
    ["", ""],
  ]);
  assert.deepEqual(doc.getTextRuns(tableGrid(doc, table)[0][1]), [
    { text: "Due", marks: { bold: true } },
  ]);
  assert.equal(at.block, tableGrid(doc, table)[1][0]);
  // Not for a delimiter line, or text that only has pipes inside.
  const q = createBlock(doc, {
    type: "p",
    parent: null,
    after: undefined,
    text: [{ text: "|---|---|" }],
  });
  assert.equal(findTableRule(ctx, { block: q, offset: 9 }), null);
  const r = createBlock(doc, {
    type: "p",
    parent: null,
    after: undefined,
    text: [{ text: "a | b" }],
  });
  assert.equal(findTableRule(ctx, { block: r, offset: 5 }), null);
});

test("Markdown table lines split on unescaped pipes outside code", () => {
  assert.deepEqual(splitTableLine("| a | b \\| c | `x|y` |"), ["a", "b | c", "`x|y`"]);
  assert.equal(splitTableLine("a | b"), null);
  assert.deepEqual(splitTableLine("a | b", { pipes: false }), ["a", "b"]);
});

test("copying part of a table copies whole rows; pasting it below rebuilds the table", () => {
  const { doc, ctx, table, after, grid } = withTable([
    ["h1", "h2"],
    ["a", "b"],
    ["c", "d"],
  ]);
  const slice = getSlice(ctx, {
    anchor: { block: grid[1][1], offset: 0 },
    focus: { block: grid[2][0], offset: 1 },
  });
  assert.deepEqual(
    slice.blocks.map((b) => [b.type, b.depth, b.text.map((r) => r.text).join("")]),
    [
      ["table", 0, ""],
      ["table_row", 1, ""],
      ["table_cell", 2, ""],
      ["table_cell", 2, "b"],
      ["table_row", 1, ""],
      ["table_cell", 2, "c"],
      ["table_cell", 2, ""],
    ],
  );
  // Not the header row, so no header.
  assert.equal(slice.blocks[0].attrs.header_row, undefined);
  assert.equal(sliceToText(slice), "|  | b |\n| --- | --- |\n| c |  |");
  assert.equal(
    sliceToHtml(slice),
    "<table><tbody><tr><td></td><td>b</td></tr><tr><td>c</td><td></td></tr></tbody></table>",
  );

  const end = insertSlice(ctx, caret({ block: after, offset: 5 }), slice);
  const copy = doc.root()[3];
  assert.equal(doc.getType(copy), "table");
  assert.deepEqual(texts(doc, copy), [
    ["", "b"],
    ["c", ""],
  ]);
  assert.equal(doc.getType(end.block), "p");
  assert.deepEqual(texts(doc, table), [
    ["h1", "h2"],
    ["a", "b"],
    ["c", "d"],
  ]);
});

test("pasting a table on an empty line puts the table there, with the caret after it", () => {
  const { doc, ctx } = setup();
  const p = createBlock(doc, { type: "p", parent: null, after: undefined });
  const slice = parsePlainText("| A | B |\n|---|---|\n| 1 | 2 |\n");
  const end = insertSlice(ctx, caret({ block: p, offset: 0 }), slice);
  const [table, tail] = doc.root();
  assert.equal(doc.getType(table), "table");
  assert.deepEqual(texts(doc, table), [
    ["A", "B"],
    ["1", "2"],
  ]);
  assert.deepEqual(end, { block: tail, offset: 0 });
  assert.equal(doc.root().length, 2);
});

test("pasting into a cell: a table fills cells (growing the table), other blocks go in as lines", () => {
  const { doc, ctx, table, grid } = withTable([["a", "b"]]);
  const cells = parsePlainText("| x | y | z |\n|---|---|---|\n| 1 | 2 | 3 |");
  insertSlice(ctx, caret({ block: grid[0][1], offset: 0 }), cells);
  assert.deepEqual(texts(doc, table), [
    ["a", "x", "y", "z"],
    ["", "1", "2", "3"],
  ]);
  const lines = parsePlainText("# Title\n- item");
  insertSlice(ctx, caret({ block: grid[0][0], offset: 1 }), lines);
  assert.equal(doc.getText(grid[0][0]), "aTitle\nitem");
  assert.equal(tableGrid(doc, table).length, 2);
});

test("stray rows and cells in a slice become paragraphs; empty tables drop", () => {
  const out = wholeTables([
    { type: "table_cell", attrs: {}, text: [{ text: "lost cell" }], depth: 2 },
    { type: "table", attrs: {}, text: [], depth: 0 },
    { type: "p", attrs: {}, text: [{ text: "inside" }], depth: 1 },
    { type: "table", attrs: {}, text: [], depth: 0 },
    { type: "table_row", attrs: {}, text: [], depth: 1 },
    { type: "table_cell", attrs: {}, text: [{ text: "ok" }], depth: 2 },
  ]);
  assert.deepEqual(
    out.map((b) => [b.type, b.depth]),
    [
      ["p", 0],
      ["table", 0],
      ["table_row", 1],
      ["table_cell", 2],
    ],
  );
});

test("plain-text Markdown tables paste as tables, with formatting, escapes and line breaks", () => {
  const slice = parsePlainText(
    "Intro\n| City | Pop |\n| :-- | --: |\n| **Berlin** | 3.6M |\n| Paris \\| FR | 2.1M<br>(city) |\nAfter",
  );
  assert.deepEqual(
    slice.blocks.map((b) => [b.type, b.depth, b.text.map((r) => r.text).join("")]),
    [
      ["p", 0, "Intro"],
      ["table", 0, ""],
      ["table_row", 1, ""],
      ["table_cell", 2, "City"],
      ["table_cell", 2, "Pop"],
      ["table_row", 1, ""],
      ["table_cell", 2, "Berlin"],
      ["table_cell", 2, "3.6M"],
      ["table_row", 1, ""],
      ["table_cell", 2, "Paris | FR"],
      ["table_cell", 2, "2.1M\n(city)"],
      ["p", 0, "After"],
    ],
  );
  assert.deepEqual(slice.blocks[6].text, [{ text: "Berlin", marks: { bold: true } }]);
  assert.equal(slice.blocks[1].attrs.header_row, true);
});
