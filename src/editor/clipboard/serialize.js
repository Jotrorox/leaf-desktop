// @ts-check
import { MATH_MARK, safeHref, safeImageSrc } from "../blocks/schema.js";
import { sliceCells } from "../commands/commands.js";
import { tableCellSource } from "../commands/table.js";
import { NO_REFS } from "../math/refs.js";
import { mathToMathml } from "../math/render.js";

/**
 * Turning a slice (see commands.js) into what goes on the clipboard: the
 * slice itself as JSON (for pasting back into leaf), HTML for other rich
 * text editors, and Markdown-ish plain text.
 *
 * Math goes out as MathML with its TeX as an annotation (other apps draw
 * it, and math-aware editors get the source back), or as `$$…$$` where
 * KaTeX isn't loaded and in plain text.
 *
 * Tables go out as HTML tables, and in plain text as Markdown tables.
 *
 * Pure: strings only, no DOM.
 */

/** @typedef {import("../commands/commands.js").Slice} Slice */
/** @typedef {import("../commands/commands.js").SliceBlock} SliceBlock */
/** @typedef {import("../model/doc.js").TextRun} TextRun */

/**
 * Where an image block's picture is, for other apps: its `src`, or for an
 * uploaded file, its URL (the editor knows where files are served).
 * @typedef {(attrs: Record<string, unknown>) => string | null} ImageUrl
 */

/** @type {ImageUrl} */
const srcOnly = (attrs) => safeImageSrc(attrs.src);

/** The clipboard type for slices. Browsers keep custom types within themselves. */
export const SLICE_MIME = "application/x-leaf-slice+json";

/** @param {string} s */
export function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** @param {TextRun} run */
const isMath = (run) => run.marks?.[MATH_MARK] !== undefined && run.marks?.[MATH_MARK] !== null;

/** @param {TextRun[]} runs */
function runsToText(runs) {
  return runs.map((r) => (isMath(r) ? `$$${r.text}$$` : r.text)).join("");
}

/**
 * What formulas need from their page: its macros (TeX) and its equation labels.
 * @typedef {{ macros: string, refs: import("../math/refs.js").Refs }} MathContext
 */

/** @param {TextRun[]} runs @param {MathContext} math */
function runsToHtml(runs, math) {
  return runs
    .map((r) => {
      if (isMath(r))
        return mathToMathml(r.text, false, math.macros, math.refs) ?? escapeHtml(`$$${r.text}$$`);
      let html = escapeHtml(r.text).replace(/\n/g, "<br>");
      const m = r.marks ?? {};
      if (m.code) html = `<code>${html}</code>`;
      if (m.bold) html = `<strong>${html}</strong>`;
      if (m.italic) html = `<em>${html}</em>`;
      if (m.underline) html = `<u>${html}</u>`;
      if (m.strike) html = `<s>${html}</s>`;
      const href = safeHref(m.link);
      if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
      return html;
    })
    .join("");
}

/**
 * @param {SliceBlock[]} blocks
 * @param {number} depth
 * @param {number} start
 * @param {ImageUrl} imageUrl
 * @param {MathContext} math
 * @returns {{ html: string, next: number }}
 */
function blocksToHtml(blocks, depth, start, imageUrl, math) {
  let html = "";
  let i = start;
  while (i < blocks.length && blocks[i].depth >= depth) {
    const b = blocks[i];
    if (b.depth > depth) {
      // Deeper than expected: render it at this level.
      blocks[i] = { ...b, depth };
      continue;
    }
    if (b.type === "table") {
      const rows = sliceCells(blocks, i);
      while (i + 1 < blocks.length && blocks[i + 1].depth > depth) i++;
      i++;
      const header = b.attrs.header_row === true;
      const column = b.attrs.header_column === true;
      const tr = rows.map(
        (row, r) =>
          `<tr>${row
            .map((cell, c) => {
              const tag = (header && r === 0) || (column && c === 0) ? "th" : "td";
              return `<${tag}>${runsToHtml(cell, math)}</${tag}>`;
            })
            .join("")}</tr>`,
      );
      const head = header ? `<thead>${tr.shift() ?? ""}</thead>` : "";
      html += `<table>${head}<tbody>${tr.join("")}</tbody></table>`;
      continue;
    }
    i++;
    // The children: the following deeper blocks.
    const inner = blocksToHtml(blocks, depth + 1, i, imageUrl, math);
    i = inner.next;
    const text = runsToHtml(b.text, math);
    const list =
      b.type === "bulleted" || b.type === "todo" || b.type === "toggle"
        ? "ul"
        : b.type === "numbered"
          ? "ol"
          : null;
    if (list) {
      const box =
        b.type === "todo"
          ? `<input type="checkbox" disabled${b.attrs.checked ? " checked" : ""}> `
          : "";
      const item = `<li>${box}${text}${inner.html}</li>`;
      // Join consecutive items of the same list.
      const close = `</${list}>`;
      if (html.endsWith(close)) html = html.slice(0, -close.length) + item + close;
      else html += `<${list}>${item}${close}`;
      continue;
    }
    switch (b.type) {
      case "h1":
      case "h2":
      case "h3":
        html += `<${b.type}>${text}</${b.type}>`;
        break;
      case "quote":
        html += `<blockquote>${text}</blockquote>`;
        break;
      case "code":
        html += `<pre><code>${escapeHtml(b.text.map((r) => r.text).join(""))}</code></pre>`;
        break;
      case "equation": {
        const tex = b.text.map((r) => r.text).join("");
        if (tex.trim())
          html += `<div>${mathToMathml(tex, true, math.macros, math.refs) ?? escapeHtml(`$$${tex}$$`)}</div>`;
        break;
      }
      case "divider":
        html += "<hr>";
        break;
      case "database": {
        const id = typeof b.attrs.database === "string" ? b.attrs.database : "";
        html += `<p><a href="/p/${escapeHtml(encodeURIComponent(id))}">Database</a></p>`;
        break;
      }
      case "image": {
        const src = imageUrl(b.attrs);
        const caption = typeof b.attrs.caption === "string" ? b.attrs.caption : "";
        if (src)
          html += `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(caption)}">${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
        break;
      }
      case "callout":
        html += `<p>${escapeHtml(String(b.attrs.icon ?? ""))} ${text}</p>`;
        break;
      default:
        html += `<p>${text}</p>`;
    }
    if (inner.html) html += `<div style="margin-left:1.5em">${inner.html}</div>`;
  }
  return { html, next: i };
}

/**
 * @param {Slice} slice
 * @param {{ imageUrl?: ImageUrl, macros?: string, refs?: import("../math/refs.js").Refs }} [options] `macros`: the page's math macros (TeX), expanded in the MathML;
 *   `refs`: its equation labels, so references go out as numbers.
 */
export function sliceToHtml(slice, { imageUrl = srcOnly, macros = "", refs = NO_REFS } = {}) {
  const math = { macros, refs };
  if (slice.inline) return runsToHtml(slice.blocks[0]?.text ?? [], math);
  return blocksToHtml(
    slice.blocks.map((b) => ({ ...b })),
    0,
    0,
    imageUrl,
    math,
  ).html;
}

/** @param {Slice} slice @param {{ imageUrl?: ImageUrl }} [options] */
export function sliceToText(slice, { imageUrl = srcOnly } = {}) {
  if (slice.inline) {
    const only = slice.blocks[0];
    // Part of an equation's TeX is just TeX.
    return only?.type === "equation"
      ? only.text.map((r) => r.text).join("")
      : runsToText(only?.text ?? []);
  }
  /** @type {string[]} */
  const lines = [];
  /** @type {number[]} */
  const numbers = [];
  for (let i = 0; i < slice.blocks.length; i++) {
    const b = slice.blocks[i];
    const indent = "  ".repeat(b.depth);
    if (b.type === "table") {
      const rows = sliceCells(slice.blocks, i);
      while (i + 1 < slice.blocks.length && slice.blocks[i + 1].depth > b.depth) i++;
      lines.push(
        ...tableToMarkdown(rows.map((row) => row.map((cell) => runsToText(cell)))).map(
          (line) => indent + line,
        ),
      );
      continue;
    }
    const text =
      b.type === "code" || b.type === "equation"
        ? b.text.map((r) => r.text).join("")
        : runsToText(b.text);
    numbers.length = b.depth + 1;
    if (b.type === "numbered") numbers[b.depth] = (numbers[b.depth] ?? 0) + 1;
    else numbers[b.depth] = 0;
    switch (b.type) {
      case "h1":
        lines.push(`# ${text}`);
        break;
      case "h2":
        lines.push(`## ${text}`);
        break;
      case "h3":
        lines.push(`### ${text}`);
        break;
      case "bulleted":
      case "toggle":
        lines.push(`${indent}- ${text}`);
        break;
      case "numbered":
        lines.push(`${indent}${numbers[b.depth]}. ${text}`);
        break;
      case "todo":
        lines.push(`${indent}- [${b.attrs.checked ? "x" : " "}] ${text}`);
        break;
      case "quote":
        lines.push(
          text
            .split("\n")
            .map((l) => `> ${l}`)
            .join("\n"),
        );
        break;
      case "code":
        lines.push("```", text, "```");
        break;
      case "equation":
        if (text.trim()) lines.push("$$", text, "$$");
        break;
      case "divider":
        lines.push("---");
        break;
      case "database":
        lines.push(`${indent}[Database]`);
        break;
      case "image": {
        const src = imageUrl(b.attrs);
        if (src)
          lines.push(
            `${indent}![${typeof b.attrs.caption === "string" ? b.attrs.caption : ""}](${src})`,
          );
        break;
      }
      default:
        lines.push(`${indent}${text}`);
    }
  }
  return lines.join("\n");
}

/**
 * A table as Markdown lines: the first row is the header (Markdown tables
 * always have one), then the delimiter line and the other rows, every row
 * as wide as the widest.
 * @param {string[][]} rows Cell texts.
 * @returns {string[]}
 */
export function tableToMarkdown(rows) {
  if (rows.length === 0) return [];
  const width = Math.max(1, ...rows.map((r) => r.length));
  /** @param {string[]} row */
  const line = (row) =>
    `| ${Array.from({ length: width }, (_, c) => tableCellSource(row[c] ?? "")).join(" | ")} |`;
  return [line(rows[0]), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)];
}
