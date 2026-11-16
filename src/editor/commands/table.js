// @ts-check
import { insertRuns } from "./runs.js";

/**
 * Simple tables, as in a word processor: a `table` block, its `table_row`
 * children, and their `table_cell` children, which hold the text (see
 * schema.js). Nothing here knows about the DOM.
 *
 * Rows may have different numbers of cells: two people can add a row and
 * a column at the same time, and the row one of them added lacks the
 * other's column. The view draws the missing cells as gaps, and every
 * command that changes the table's shape fills them in first (`padTable`).
 */

/** @typedef {import("../model/doc.js").Doc} Doc */
/** @typedef {import("../model/doc.js").TextRun} TextRun */
/** @typedef {import("./commands.js").Ctx} Ctx */
/** @typedef {import("./commands.js").Pos} Pos */
/** @typedef {import("./commands.js").Sel} Sel */

export const TABLE = "table";
export const ROW = "table_row";
export const CELL = "table_cell";

/** Rows and columns a new table gets. */
export const NEW_TABLE = { rows: 3, cols: 3 };

/** A table's rows (other children, from an older client, are ignored). @param {Doc} doc @param {string} table */
export function tableRows(doc, table) {
  return doc.children(table).filter((id) => doc.getType(id) === ROW);
}

/** A row's cells. @param {Doc} doc @param {string} row */
export function rowCells(doc, row) {
  return doc.children(row).filter((id) => doc.getType(id) === CELL);
}

/** Cell ids by row. @param {Doc} doc @param {string} table */
export function tableGrid(doc, table) {
  return tableRows(doc, table).map((row) => rowCells(doc, row));
}

/** The widest row's length. @param {string[][]} grid */
export function columnCount(grid) {
  let n = 0;
  for (const row of grid) n = Math.max(n, row.length);
  return n;
}

/**
 * The table a block belongs to: itself for a table, its table for a row or
 * a cell in place; null otherwise (a cell an older client moved out).
 * @param {Doc} doc @param {string} id
 * @returns {string | null}
 */
export function tableOf(doc, id) {
  if (!doc.hasBlock(id)) return null;
  const type = doc.getType(id);
  if (type === TABLE) return id;
  if (type === ROW) {
    const parent = doc.parentOf(id);
    return typeof parent === "string" && doc.getType(parent) === TABLE ? parent : null;
  }
  if (type === CELL) {
    const row = doc.parentOf(id);
    return typeof row === "string" && doc.getType(row) === ROW ? tableOf(doc, row) : null;
  }
  return null;
}

/** Whether a block is a cell in a table. @param {Doc} doc @param {string} id */
export const isCell = (doc, id) =>
  doc.hasBlock(id) && doc.getType(id) === CELL && tableOf(doc, id) !== null;

/**
 * Where a cell is: its table, row and column, and the table's grid.
 * @param {Doc} doc @param {string} cell
 * @returns {{ table: string, row: number, col: number, grid: string[][] } | null}
 */
export function cellPlace(doc, cell) {
  const table = doc.getType(cell) === CELL ? tableOf(doc, cell) : null;
  if (table === null) return null;
  const grid = tableGrid(doc, table);
  for (let row = 0; row < grid.length; row++) {
    const col = grid[row].indexOf(cell);
    if (col !== -1) return { table, row, col, grid };
  }
  return null;
}

/**
 * Create a table with rows of cells, each cell's text given as runs.
 * @param {Doc} doc
 * @param {{ parent: string | null, after: string | null | undefined, cells: TextRun[][][], attrs?: Record<string, unknown> }} spec
 * @returns {string} the table's id
 */
export function createTable(doc, { parent, after, cells, attrs = {} }) {
  const table = doc.insertBlock({ type: TABLE, parent, after, attrs });
  /** @type {string | null} */
  let prevRow = null;
  for (const row of cells) {
    const rowId = doc.insertBlock({ type: ROW, parent: table, after: prevRow });
    /** @type {string | null} */
    let prevCell = null;
    for (const text of row) {
      const cell = doc.insertBlock({ type: CELL, parent: rowId, after: prevCell });
      insertRuns(doc, cell, 0, text);
      prevCell = cell;
    }
    prevRow = rowId;
  }
  return table;
}

/** Empty cells for a new table. @param {number} rows @param {number} cols @returns {TextRun[][][]} */
export function emptyCells(rows, cols) {
  return Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => /** @type {TextRun[]} */ ([])),
  );
}

/**
 * Give every row as many cells as the widest one. Returns the grid.
 * @param {Doc} doc @param {string} table
 */
export function padTable(doc, table) {
  const rows = tableRows(doc, table);
  const grid = rows.map((row) => rowCells(doc, row));
  const cols = columnCount(grid);
  rows.forEach((row, i) => {
    while (grid[i].length < cols)
      grid[i].push(doc.insertBlock({ type: CELL, parent: row, after: grid[i].at(-1) ?? null }));
  });
  return grid;
}

/**
 * Add a row so it becomes row `index` (at most the row count). Returns
 * its cells.
 * @param {Doc} doc @param {string} table @param {number} index
 */
export function insertRow(doc, table, index) {
  const grid = padTable(doc, table);
  const rows = tableRows(doc, table);
  const at = Math.max(0, Math.min(index, rows.length));
  const row = doc.insertBlock({ type: ROW, parent: table, after: at > 0 ? rows[at - 1] : null });
  /** @type {string[]} */
  const cells = [];
  for (let i = 0; i < Math.max(1, columnCount(grid)); i++)
    cells.push(doc.insertBlock({ type: CELL, parent: row, after: cells.at(-1) ?? null }));
  return cells;
}

/**
 * Add a column so it becomes column `index` (at most the column count).
 * Returns its cells, top to bottom.
 * @param {Doc} doc @param {string} table @param {number} index
 */
export function insertColumn(doc, table, index) {
  const grid = padTable(doc, table);
  const rows = tableRows(doc, table);
  const at = Math.max(0, Math.min(index, columnCount(grid)));
  return rows.map((row, i) =>
    doc.insertBlock({ type: CELL, parent: row, after: at > 0 ? grid[i][at - 1] : null }),
  );
}

/**
 * Delete row `index`; the table goes with its last row. Returns whether
 * the table is still there.
 * @param {Doc} doc @param {string} table @param {number} index
 */
export function deleteRow(doc, table, index) {
  const rows = tableRows(doc, table);
  if (rows.length <= 1) {
    doc.deleteBlock(table);
    return false;
  }
  if (rows[index] !== undefined) doc.deleteBlock(rows[index]);
  return true;
}

/**
 * Delete column `index`; the table goes with its last column. Returns
 * whether the table is still there.
 * @param {Doc} doc @param {string} table @param {number} index
 */
export function deleteColumn(doc, table, index) {
  const grid = tableGrid(doc, table);
  if (columnCount(grid) <= 1) {
    doc.deleteBlock(table);
    return false;
  }
  for (const row of grid) if (row[index] !== undefined) doc.deleteBlock(row[index]);
  return true;
}

/**
 * Move row `from` so it becomes row `to`.
 * @param {Doc} doc @param {string} table @param {number} from @param {number} to
 */
export function moveRow(doc, table, from, to) {
  const rows = tableRows(doc, table);
  const row = rows[from];
  if (row === undefined || from === to || to < 0 || to >= rows.length) return;
  const rest = rows.filter((r) => r !== row);
  doc.moveBlock(row, { parent: table, after: to > 0 ? rest[to - 1] : null });
}

/**
 * Move column `from` so it becomes column `to`.
 * @param {Doc} doc @param {string} table @param {number} from @param {number} to
 */
export function moveColumn(doc, table, from, to) {
  const grid = padTable(doc, table);
  const rows = tableRows(doc, table);
  if (from === to || to < 0 || to >= columnCount(grid)) return;
  rows.forEach((row, i) => {
    const cell = grid[i][from];
    if (cell === undefined) return;
    const rest = grid[i].filter((c) => c !== cell);
    doc.moveBlock(cell, { parent: row, after: to > 0 ? rest[to - 1] : null });
  });
}

// ---------------------------------------------------------------------------
// Commands (they return where the caret goes)

/** The whole text of a cell, selected (or a caret, when it's empty). @param {Doc} doc @param {string} cell @returns {Sel} */
function selectCell(doc, cell) {
  return {
    anchor: { block: cell, offset: 0 },
    focus: { block: cell, offset: doc.textLength(cell) },
  };
}

/**
 * Put a new table at block `id` (the slash menu): in place of an empty
 * paragraph, otherwise after the block (after the table, for a cell).
 * The caret goes into the first cell.
 * @param {Ctx} ctx @param {string} id @param {{ rows?: number, cols?: number }} [size]
 * @returns {Pos}
 */
export function insertTable(ctx, id, { rows = NEW_TABLE.rows, cols = NEW_TABLE.cols } = {}) {
  const { doc } = ctx;
  const anchor = tableOf(doc, id) ?? id;
  const parent = doc.parentOf(anchor) ?? null;
  const table = createTable(doc, {
    parent,
    after: anchor,
    cells: emptyCells(rows, cols),
    attrs: { header_row: true },
  });
  if (
    anchor === id &&
    doc.getType(id) === "p" &&
    doc.textLength(id) === 0 &&
    doc.children(id).length === 0
  )
    doc.deleteBlock(id);
  return { block: tableGrid(doc, table)[0][0], offset: 0 };
}

/**
 * Tab and Shift+Tab in a cell: the next (or previous) cell, its text
 * selected. Tab in the last cell adds a row; Shift+Tab in the first stays.
 * @param {Ctx} ctx @param {string} cell @param {-1 | 1} dir
 * @returns {Sel | null}
 */
export function stepCell(ctx, cell, dir) {
  const { doc } = ctx;
  const place = cellPlace(doc, cell);
  if (!place) return null;
  const flat = place.grid.flat();
  const next = flat[flat.indexOf(cell) + dir];
  if (next !== undefined) return selectCell(doc, next);
  if (dir < 0) return selectCell(doc, cell);
  const added = insertRow(doc, place.table, place.grid.length);
  return selectCell(doc, added[0]);
}

/**
 * The cell above or below, in the same column (or the nearest one, in a
 * shorter row); null at the table's edge.
 * @param {Doc} doc @param {string} cell @param {-1 | 1} dir
 * @returns {string | null}
 */
export function verticalCell(doc, cell, dir) {
  const place = cellPlace(doc, cell);
  if (!place) return null;
  const row = place.grid[place.row + dir];
  if (row === undefined || row.length === 0) return null;
  return row[Math.min(place.col, row.length - 1)];
}

/**
 * Write a grid of text into a table from a cell on (pasting cells), adding
 * rows and columns as needed. Returns the caret at the end of the last cell written.
 * @param {Ctx} ctx @param {string} cell @param {TextRun[][][]} cells
 * @returns {Pos}
 */
export function fillCells(ctx, cell, cells) {
  const { doc } = ctx;
  const place = cellPlace(doc, cell);
  if (!place || cells.length === 0) return { block: cell, offset: doc.textLength(cell) };
  const { table, row, col } = place;
  const width = columnCount(/** @type {any} */ (cells));
  let grid = padTable(doc, table);
  while (grid.length < row + cells.length) {
    insertRow(doc, table, grid.length);
    grid = tableGrid(doc, table);
  }
  while (columnCount(grid) < col + width) {
    insertColumn(doc, table, columnCount(grid));
    grid = tableGrid(doc, table);
  }
  /** @type {Pos} */
  let last = { block: cell, offset: doc.textLength(cell) };
  cells.forEach((line, r) => {
    line.forEach((text, c) => {
      const target = grid[row + r][col + c];
      const length = doc.textLength(target);
      if (length > 0) doc.deleteText(target, 0, length);
      last = { block: target, offset: insertRuns(doc, target, 0, text) };
    });
  });
  return last;
}

/**
 * A line of a Markdown table (`| a | b |`) split into its cells' source, or
 * null when it isn't one. `\|` is a pipe inside a cell.
 * @param {string} line
 * @param {{ pipes?: boolean }} [options] `pipes`: require the leading and trailing pipe.
 * @returns {string[] | null}
 */
export function splitTableLine(line, { pipes = true } = {}) {
  let text = line.trim();
  if (!text.includes("|")) return null;
  const leading = text.startsWith("|");
  const trailing = text.endsWith("|") && !text.endsWith("\\|");
  if (pipes && (!leading || !trailing || text.length < 2)) return null;
  if (leading) text = text.slice(1);
  if (trailing) text = text.slice(0, -1);
  /** @type {string[]} */
  const cells = [];
  let current = "";
  let code = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === "|") {
      current += "|";
      i++;
    } else if (c === "`") {
      code = !code;
      current += c;
    } else if (c === "|" && !code) {
      cells.push(current.trim());
      current = "";
    } else current += c;
  }
  cells.push(current.trim());
  return cells;
}

/** Whether a table line is the delimiter row under the header (`|---|:--:|`). @param {string[]} cells */
export function isDelimiterRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

/** A cell's text for a Markdown table line: pipes escaped, line breaks as `<br>`. @param {string} text */
export function tableCellSource(text) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}
