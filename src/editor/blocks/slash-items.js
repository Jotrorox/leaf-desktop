// @ts-check
import { BLOCKS } from "./schema.js";

/**
 * What the slash menu offers, and how typing after the `/` filters it.
 *
 * Pure: the menu renders these and the editor applies the one picked.
 */

/**
 * @typedef {object} SlashItem
 * @property {string} id
 * @property {string} label
 * @property {string} description
 * @property {string} group
 * @property {string[]} keywords Other words that find it.
 * @property {string} [hint] The Markdown shortcut, shown on the right.
 * @property {{ kind: "block", type: string } | { kind: "mention" } | { kind: "database" } | { kind: "table" } | { kind: "image" } | { kind: "inline-math" }} action
 */

/** @param {string} type @param {string} description @param {string[]} keywords @param {string} [hint] @returns {SlashItem} */
const block = (type, description, keywords, hint) => ({
  id: type,
  label: BLOCKS[type].label,
  description,
  group: "Basic blocks",
  keywords,
  hint,
  action: { kind: "block", type },
});

/** @type {SlashItem[]} */
export const SLASH_ITEMS = [
  block("p", "Just start writing with plain text.", ["text", "paragraph", "plain"]),
  block("h1", "Big section heading.", ["heading", "title", "h1"], "#"),
  block("h2", "Medium section heading.", ["heading", "subtitle", "h2"], "##"),
  block("h3", "Small section heading.", ["heading", "subheading", "h3"], "###"),
  block("bulleted", "Create a simple bulleted list.", ["bullet", "unordered", "ul", "list"], "-"),
  block("numbered", "Create a list with numbering.", ["number", "ordered", "ol", "list"], "1."),
  block("todo", "Track tasks with a to-do list.", ["todo", "task", "checkbox", "check"], "[]"),
  block("toggle", "Toggles can hide and show content inside.", [
    "toggle",
    "collapse",
    "expand",
    "details",
  ]),
  block("quote", "Capture a quote.", ["quote", "blockquote", "citation"], ">"),
  block("code", "Capture a code snippet.", ["code", "snippet", "pre", "monospace"], "```"),
  block("callout", "Make writing stand out.", ["callout", "note", "info", "tip", "warning"]),
  block(
    "divider",
    "Visually divide blocks.",
    ["divider", "separator", "line", "hr", "rule"],
    "---",
  ),
  {
    id: "table",
    label: "Table",
    description: "Add a simple table of text, like in a document.",
    group: "Basic blocks",
    keywords: ["table", "grid", "rows", "columns", "cells", "matrix"],
    action: { kind: "table" },
  },
  {
    id: "image",
    label: "Image",
    description: "Upload an image, or paste or drop one.",
    group: "Media",
    keywords: ["image", "picture", "photo", "upload", "screenshot", "img"],
    action: { kind: "image" },
  },
  {
    id: "database",
    label: "Database",
    description: "Add an inline database of pages, with properties and views.",
    group: "Advanced blocks",
    keywords: [
      "database",
      "inline",
      "records",
      "properties",
      "views",
      "board",
      "kanban",
      "spreadsheet",
    ],
    action: { kind: "database" },
  },
  {
    id: "equation",
    label: "Equation",
    description: "Display a standalone math formula.",
    group: "Advanced blocks",
    keywords: ["equation", "math", "latex", "tex", "katex", "formula", "block"],
    hint: "$$",
    action: { kind: "block", type: "equation" },
  },
  {
    id: "mention",
    label: "Mention a page",
    description: "Link to another page.",
    group: "Inline",
    keywords: ["mention", "link", "page", "reference", "@"],
    hint: "@",
    action: { kind: "mention" },
  },
  {
    id: "inline-equation",
    label: "Inline equation",
    description: "Insert math inside a line of text.",
    group: "Inline",
    keywords: ["equation", "math", "latex", "tex", "katex", "formula", "inline"],
    hint: "$$…$$",
    action: { kind: "inline-math" },
  },
];

/** What the slash menu offers in a table cell: only what goes inside text. */
export const CELL_SLASH_ITEMS = SLASH_ITEMS.filter((item) => item.group === "Inline");

/**
 * The items matching what was typed after the `/`, best first. Every word
 * of the query must start a word of the label or keywords; a label that
 * starts with the whole query ranks first. An empty query lists everything.
 * @param {string} query
 * @param {SlashItem[]} [items]
 * @returns {SlashItem[]}
 */
export function filterSlashItems(query, items = SLASH_ITEMS) {
  const q = query.trim().toLowerCase();
  if (q === "") return items;
  const tokens = q.split(/\s+/);
  /** @type {{ item: SlashItem, score: number, index: number }[]} */
  const scored = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const words = [...label.split(/\s+/), ...item.keywords.map((k) => k.toLowerCase())];
    if (!tokens.every((t) => words.some((w) => w.startsWith(t)))) return;
    const score = label.startsWith(q)
      ? 0
      : label.split(/\s+/).some((w) => w.startsWith(tokens[0]))
        ? 1
        : 2;
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((s) => s.item);
}
