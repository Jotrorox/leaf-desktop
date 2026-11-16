// @ts-check

/**
 * The v1 block types and how the editor treats each one. Block types are
 * plain strings in the document (`doc.getType(id)`); attrs hold the rest:
 * `checked` (to-do), `icon` (callout), `database` (the id of the database
 * page a database block shows), and for an image `file` (an uploaded file's
 * id, `api/files.js`) or `src` (a web address), `width` (px) and `caption`.
 * An equation's text is its TeX source.
 *
 * A table (a simple one, as in a word processor; not a database) is a
 * `table` block whose children are `table_row` blocks, whose children are
 * `table_cell` blocks holding the text. So cells are edited, formatted and
 * merged like any text. The table's attrs are `header_row` and
 * `header_column` (true, or missing). Rows can end up with different
 * numbers of cells (one person adds a row while another adds a column);
 * the view fills the gaps and table commands repair them (`table.js`).
 *
 * Pure: shared by the view, the commands and the clipboard code.
 */

/**
 * @typedef {object} BlockSpec
 * @property {string} label Shown in menus.
 * @property {boolean} text Has editable rich text (every type but the divider, the database, the image, the table and its rows).
 * @property {boolean} marks Text can carry formatting (not in code blocks or equations).
 * @property {boolean} continues Enter at the end makes another block of this type.
 * @property {boolean} list Enter or Backspace in an empty one turns it back into text first.
 * @property {string} placeholder Shown while the block is empty.
 * @property {boolean} [part] Only exists inside a table (rows and cells): never offered in menus, never turned into or out of.
 */

/** @type {Record<string, BlockSpec>} */
export const BLOCKS = {
  p: {
    label: "Text",
    text: true,
    marks: true,
    continues: false,
    list: false,
    placeholder: "Write something…",
  },
  h1: {
    label: "Heading 1",
    text: true,
    marks: true,
    continues: false,
    list: false,
    placeholder: "Heading 1",
  },
  h2: {
    label: "Heading 2",
    text: true,
    marks: true,
    continues: false,
    list: false,
    placeholder: "Heading 2",
  },
  h3: {
    label: "Heading 3",
    text: true,
    marks: true,
    continues: false,
    list: false,
    placeholder: "Heading 3",
  },
  bulleted: {
    label: "Bulleted list",
    text: true,
    marks: true,
    continues: true,
    list: true,
    placeholder: "List",
  },
  numbered: {
    label: "Numbered list",
    text: true,
    marks: true,
    continues: true,
    list: true,
    placeholder: "List",
  },
  todo: {
    label: "To-do list",
    text: true,
    marks: true,
    continues: true,
    list: true,
    placeholder: "To-do",
  },
  toggle: {
    label: "Toggle list",
    text: true,
    marks: true,
    continues: true,
    list: true,
    placeholder: "Toggle",
  },
  quote: {
    label: "Quote",
    text: true,
    marks: true,
    continues: false,
    list: false,
    placeholder: "Quote",
  },
  code: {
    label: "Code",
    text: true,
    marks: false,
    continues: false,
    list: false,
    placeholder: "Code",
  },
  callout: {
    label: "Callout",
    text: true,
    marks: true,
    continues: false,
    list: false,
    placeholder: "Callout",
  },
  equation: {
    label: "Equation",
    text: true,
    marks: false,
    continues: false,
    list: false,
    placeholder: "Add a TeX equation",
  },
  divider: {
    label: "Divider",
    text: false,
    marks: false,
    continues: false,
    list: false,
    placeholder: "",
  },
  database: {
    label: "Database",
    text: false,
    marks: false,
    continues: false,
    list: false,
    placeholder: "",
  },
  image: {
    label: "Image",
    text: false,
    marks: false,
    continues: false,
    list: false,
    placeholder: "",
  },
  table: {
    label: "Table",
    text: false,
    marks: false,
    continues: false,
    list: false,
    placeholder: "",
  },
  table_row: {
    label: "Table row",
    text: false,
    marks: false,
    continues: false,
    list: false,
    placeholder: "",
    part: true,
  },
  table_cell: {
    label: "Table cell",
    text: true,
    marks: true,
    continues: false,
    list: false,
    placeholder: "",
    part: true,
  },
};

/** Unknown types (from a newer client) render and edit as text. @param {string} type */
export function spec(type) {
  return BLOCKS[type] ?? BLOCKS.p;
}

/** @param {string} type */
export const hasText = (type) => spec(type).text;

/** Whether a type only exists inside a table (a row or a cell). @param {string} type */
export const isTablePart = (type) => spec(type).part === true;

/** The default callout icon. */
export const CALLOUT_ICON = "💡";

/**
 * Turn-into shortcuts: mod+alt+<digit>.
 * @type {Record<string, string>}
 */
export const TURN_INTO_KEYS = {
  Digit0: "p",
  Digit1: "h1",
  Digit2: "h2",
  Digit3: "h3",
  Digit4: "todo",
  Digit5: "bulleted",
  Digit6: "numbered",
  Digit7: "toggle",
  Digit8: "code",
  Digit9: "quote",
};

/** Turn into an equation: mod+alt+E (the digits are all taken). */
export const EQUATION_KEY = "KeyE";

/** Mark names the toolbar and shortcuts toggle. */
export const FLAG_MARKS = /** @type {const} */ (["bold", "italic", "underline", "strike", "code"]);

/**
 * Inline math: the mark's text is TeX source, drawn as one formula. Its
 * value is an id unique to that formula, so two formulas side by side
 * stay two (runs with equal marks would merge).
 */
export const MATH_MARK = "math";

/** Marks a formula can carry besides its own (formatting doesn't apply inside TeX). */
export const MATH_MARKS = /** @type {readonly string[]} */ (["math", "color"]);

/** A new formula's id. */
export function mathId() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

/**
 * The TeX source of a block whose text is code-like: no marks, Enter makes
 * a line break, Tab indents (code blocks and equations).
 * @param {string} type
 */
export const isPlainText = (type) => spec(type).text && !spec(type).marks;

/**
 * Links the editor will render as `<a href>`: web, mail and in-app paths.
 * Anything else (javascript:, data:) is dropped.
 * @param {unknown} href
 * @returns {string | null}
 */
export function safeHref(href) {
  if (typeof href !== "string") return null;
  const value = href.trim();
  if (value === "") return null;
  if (/^\/(?!\/)/.test(value)) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * An image address the editor will show: http(s) only (no data: or
 * javascript: URLs).
 * @param {unknown} src
 * @returns {string | null}
 */
export function safeImageSrc(src) {
  if (typeof src !== "string") return null;
  try {
    const url = new URL(src.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Image widths a resize can set (px). */
export const IMAGE_MIN_WIDTH = 80;

/**
 * What the user typed into a link field: a URL, a bare domain, or nothing usable.
 * @param {string} input
 * @returns {string | null}
 */
export function normalizeLinkInput(input) {
  const value = input.trim();
  if (value === "") return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("/")) return safeHref(value);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return safeHref(`mailto:${value}`);
  if (/^[^\s/]+\.[^\s/]+/.test(value)) return safeHref(`https://${value}`);
  return null;
}
