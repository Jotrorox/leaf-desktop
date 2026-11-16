// @ts-check
import { MATH_MARK, mathId, safeHref, safeImageSrc } from "../blocks/schema.js";

/**
 * Pasted HTML to a slice. The HTML is parsed with `DOMParser` (so nothing
 * runs and nothing loads) and walked against a whitelist: block elements
 * become blocks, a few inline elements and styles become marks, and
 * everything else is reduced to its text. A table becomes a table (unless
 * it holds another table: then it's page layout, and only its content
 * counts). MathML with a TeX annotation
 * (KaTeX, MathJax, Wikipedia, leaf itself) becomes math: an equation block
 * for display math, inline math otherwise; MathML without one is its text.
 *
 * Browser only (needs `DOMParser`).
 */

/** @typedef {import("../commands/commands.js").Slice} Slice */
/** @typedef {import("../commands/commands.js").SliceBlock} SliceBlock */
/** @typedef {import("../model/doc.js").TextRun} TextRun */

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "BLOCKQUOTE",
  "PRE",
  "HR",
  "UL",
  "OL",
  "TABLE",
  "TR",
  "SECTION",
  "ARTICLE",
  "HEADER",
  "FOOTER",
  "MAIN",
  "ASIDE",
  "FIGURE",
  "FIGCAPTION",
  "DL",
  "DT",
  "DD",
]);
const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "IFRAME",
  "OBJECT",
  "HEAD",
  "TITLE",
  "META",
  "LINK",
  "SVG",
  "IMG",
  "VIDEO",
  "AUDIO",
  "BUTTON",
  "SELECT",
  "TEXTAREA",
]);

/**
 * @param {string} html
 * @returns {Slice | null} null when there's nothing usable.
 */
export function parseHtml(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  /** @type {SliceBlock[]} */
  const blocks = [];
  /** @type {SliceBlock | null} */
  let current = null;
  let sawBlock = false;

  /** @param {string} type @param {number} depth @param {Record<string, unknown>} [attrs] */
  const open = (type, depth, attrs = {}) => {
    current = { type, attrs, text: [], depth };
    blocks.push(current);
    return current;
  };
  /** Text outside any block element goes into a paragraph. @param {number} depth */
  const target = (depth) => current ?? open("p", depth);
  /**
   * A formula: display math as an equation block, other math as inline
   * math (in code, its TeX is left to the caller). Returns whether it went in.
   * @param {string} tex @param {boolean} display @param {Record<string, unknown>} marks @param {{ depth: number }} ctx
   */
  const walkTex = (tex, display, marks, ctx) => {
    if (display) {
      sawBlock = true;
      blocks.push({ type: "equation", attrs: {}, text: [{ text: tex }], depth: ctx.depth });
      current = null;
      return true;
    }
    const block = target(ctx.depth);
    if (block.type === "code") return false;
    block.text.push({
      text: tex,
      marks: {
        ...(typeof marks.color === "string" ? { color: marks.color } : {}),
        [MATH_MARK]: mathId(),
      },
    });
    return true;
  };

  /**
   * @param {Node} node
   * @param {Record<string, unknown>} marks
   * @param {{ depth: number, list: string | null, pre: boolean }} ctx
   */
  const walk = (node, marks, ctx) => {
    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.textContent ?? "";
      if (!ctx.pre) {
        text = text.replace(/[\t\n\r ]+/g, " ");
        const block = current;
        const prev = block ? block.text.map((r) => r.text).join("") : "";
        if (prev === "" || prev.endsWith(" ") || prev.endsWith("\n")) text = text.replace(/^ /, "");
        if (text === "") return;
      }
      if (text === "") return;
      const block = target(ctx.depth);
      const m = block.type === "code" ? {} : marks;
      const last = block.text[block.text.length - 1];
      if (last && JSON.stringify(last.marks ?? {}) === JSON.stringify(m)) last.text += text;
      else block.text.push(Object.keys(m).length ? { text, marks: m } : { text });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = /** @type {HTMLElement} */ (node);
    const tag = el.tagName.toUpperCase();
    if (tag === "MATH") {
      const tex = texOf(el);
      if (tex && walkTex(tex, el.getAttribute("display") === "block", marks, ctx)) return;
      for (const child of el.childNodes)
        if (!(child instanceof Element && child.tagName.toUpperCase() === "ANNOTATION"))
          walk(child, marks, ctx);
      return;
    }
    if (tag === "ANNOTATION" || tag === "ANNOTATION-XML") return;
    // Wikipedia hides its MathML (and shows a picture of the formula instead).
    if (el.style?.display === "none" && !hasMathChild(el)) return;
    if (tag === "IMG" && /\bmath\b|mwe-math/.test(el.className)) {
      // Its picture alone (the MathML didn't come along): the TeX is its alt text.
      const tex = el.closest(".mwe-math-element")?.getElementsByTagName("math").length
        ? null
        : unwrapTex(el.getAttribute("alt") ?? "");
      if (tex && !walkTex(tex, /mwe-math-fallback-image-display/.test(el.className), marks, ctx))
        target(ctx.depth).text.push({ text: tex });
      return;
    }
    // A picture with a web address becomes an image block (others are dropped).
    if (tag === "IMG") {
      const src = safeImageSrc(el.getAttribute("src"));
      if (src) {
        sawBlock = true;
        const alt = (el.getAttribute("alt") ?? "").trim();
        blocks.push({
          type: "image",
          attrs: alt ? { src, caption: alt } : { src },
          text: [],
          depth: ctx.depth,
        });
        current = null;
      }
      return;
    }
    if (SKIP_TAGS.has(tag)) return;
    if (el.getAttribute("aria-hidden") === "true") return;

    if (tag === "BR") {
      if (current) {
        const last = current.text[current.text.length - 1];
        if (last && !last.marks) last.text += "\n";
        else current.text.push({ text: "\n" });
      }
      return;
    }
    if (tag === "INPUT") {
      const input = /** @type {HTMLInputElement} */ (el);
      if (input.type === "checkbox" && current && current.type !== "code") {
        current.type = "todo";
        current.attrs = input.checked || input.hasAttribute("checked") ? { checked: true } : {};
      }
      return;
    }

    if (BLOCK_TAGS.has(tag)) {
      sawBlock = true;
      if (tag === "TABLE" && el.getElementsByTagName("table").length === 0) {
        const rows = [...el.querySelectorAll("tr")].filter((tr) => tr.closest("table") === el);
        const cells = rows.map((tr) =>
          [...tr.children].filter((c) => c.tagName === "TD" || c.tagName === "TH"),
        );
        if (cells.some((row) => row.length > 0)) {
          const header =
            rows[0]?.parentElement?.tagName === "THEAD" ||
            (cells[0]?.length > 0 && cells[0].every((c) => c.tagName === "TH"));
          blocks.push({
            type: "table",
            attrs: header ? { header_row: true } : {},
            text: [],
            depth: ctx.depth,
          });
          for (const row of cells) {
            if (row.length === 0) continue;
            blocks.push({ type: "table_row", attrs: {}, text: [], depth: ctx.depth + 1 });
            for (const cell of row)
              blocks.push({
                type: "table_cell",
                attrs: {},
                text: cellText(cell),
                depth: ctx.depth + 2,
              });
          }
          current = null;
          return;
        }
      }
      if (tag === "HR") {
        blocks.push({ type: "divider", attrs: {}, text: [], depth: ctx.depth });
        current = null;
        return;
      }
      if (tag === "UL" || tag === "OL") {
        current = null;
        const inList = ctx.list !== null;
        for (const child of el.childNodes)
          walk(child, marks, { ...ctx, list: tag, depth: inList ? ctx.depth + 1 : ctx.depth });
        current = null;
        return;
      }
      if (tag === "PRE") {
        open("code", ctx.depth);
        for (const child of el.childNodes) walk(child, {}, { ...ctx, pre: true });
        const block = /** @type {SliceBlock} */ (/** @type {unknown} */ (current));
        if (block) {
          const text = block.text
            .map((r) => r.text)
            .join("")
            .replace(/\n$/, "");
          block.text = text ? [{ text }] : [];
        }
        current = null;
        return;
      }
      /** @type {string} */
      let type = "p";
      if (/^H[1-6]$/.test(tag)) type = `h${Math.min(3, Number(tag[1]))}`;
      else if (tag === "BLOCKQUOTE") type = "quote";
      else if (tag === "LI") type = ctx.list === "OL" ? "numbered" : "bulleted";
      const container =
        tag === "DIV" ||
        tag === "SECTION" ||
        tag === "ARTICLE" ||
        tag === "MAIN" ||
        tag === "TABLE" ||
        tag === "TR";
      if (container && hasBlockChild(el)) {
        current = null;
        for (const child of el.childNodes) walk(child, marks, ctx);
        current = null;
        return;
      }
      const block = open(type, ctx.depth);
      for (const child of el.childNodes) {
        if (
          child.nodeType === Node.ELEMENT_NODE &&
          BLOCK_TAGS.has(/** @type {Element} */ (child).tagName.toUpperCase())
        ) {
          const nested = /** @type {Element} */ (child).tagName.toUpperCase();
          // An item whose text is wrapped in a paragraph (Google Docs: <li><p>…</p></li>): the paragraph is the item's own text.
          if (
            (nested === "P" || nested === "DIV") &&
            block.text.length === 0 &&
            blocks[blocks.length - 1] === block &&
            !hasBlockChild(/** @type {Element} */ (child))
          ) {
            current = block;
            for (const c of child.childNodes) walk(c, marks, ctx);
            current = null;
            continue;
          }
          // A nested list (or block) inside an item: its children are one level deeper.
          if (nested === "UL" || nested === "OL") {
            current = null;
            for (const c of child.childNodes)
              walk(c, marks, { ...ctx, list: nested, depth: ctx.depth + 1 });
          } else {
            current = null;
            walk(child, marks, { ...ctx, depth: tag === "LI" ? ctx.depth + 1 : ctx.depth });
          }
          current = null;
          continue;
        }
        if (current === null) current = block.text.length === 0 ? block : open("p", ctx.depth);
        walk(child, marks, ctx);
      }
      current = null;
      return;
    }

    // Inline: collect marks from the tag and its style.
    const next = { ...marks };
    const style = el.style;
    const weight = style.fontWeight;
    if (tag === "B" || tag === "STRONG" || weight === "bold" || Number(weight) >= 600)
      next.bold = true;
    if (weight === "normal" || (Number(weight) > 0 && Number(weight) < 600)) delete next.bold;
    if (tag === "I" || tag === "EM" || style.fontStyle === "italic") next.italic = true;
    if (
      tag === "U" ||
      style.textDecoration.includes("underline") ||
      style.textDecorationLine.includes("underline")
    )
      next.underline = true;
    if (
      tag === "S" ||
      tag === "STRIKE" ||
      tag === "DEL" ||
      style.textDecoration.includes("line-through") ||
      style.textDecorationLine.includes("line-through")
    )
      next.strike = true;
    if ((tag === "CODE" || tag === "KBD" || tag === "SAMP") && !ctx.pre) next.code = true;
    if (tag === "A") {
      const href = safeHref(el.getAttribute("href"));
      if (href) next.link = href;
    }
    for (const child of el.childNodes) walk(child, next, ctx);
  };

  walk(doc.body, {}, { depth: 0, list: null, pre: false });

  // Trim and drop empty paragraphs that only came from markup whitespace.
  for (const b of blocks) {
    if (b.type === "code") continue;
    const first = b.text[0];
    if (first) first.text = first.text.replace(/^\s+/, "");
    const last = b.text[b.text.length - 1];
    if (last) last.text = last.text.replace(/[ \t]+$/, "");
    b.text = b.text.filter((r) => r.text !== "");
  }
  const kept = blocks.filter((b) => b.type !== "p" || b.text.length > 0);
  if (kept.length === 0) return null;
  const min = Math.min(...kept.map((b) => b.depth));
  for (const b of kept) b.depth -= min;
  if (!sawBlock && kept.length === 1 && kept[0].type === "p") return { inline: true, blocks: kept };
  return { inline: false, blocks: kept };
}

/**
 * A table cell's content as one text: its blocks' text, a line each.
 * @param {Element} cell
 * @returns {TextRun[]}
 */
function cellText(cell) {
  const slice = parseHtml(cell.innerHTML);
  /** @type {TextRun[]} */
  const runs = [];
  for (const b of slice?.blocks ?? []) {
    if (b.text.length === 0) continue;
    if (runs.length) runs.push({ text: "\n" });
    runs.push(...b.text);
  }
  return runs;
}

/**
 * The TeX source a MathML element carries, if any: its TeX annotation
 * (KaTeX, MathJax, leaf), or else its `alttext` when that is TeX
 * (Wikipedia's MathML has no annotation).
 * @param {Element} el
 */
function texOf(el) {
  for (const annotation of el.getElementsByTagName("annotation")) {
    if (!/^application\/(x-)?tex$/i.test(annotation.getAttribute("encoding") ?? "")) continue;
    const tex = unwrapTex(annotation.textContent ?? "");
    if (tex) return tex;
  }
  const alt = el.getAttribute("alttext") ?? "";
  // Alt text can also be words ("x squared"); only TeX-looking text counts.
  return /[\\^_{}]/.test(alt) ? unwrapTex(alt) : null;
}

/**
 * TeX without Wikipedia's `{\displaystyle …}` wrapper, or null if empty.
 * @param {string} tex
 */
function unwrapTex(tex) {
  tex = tex.trim();
  const wrapped = /^\{\\(?:displaystyle|textstyle)\s*([\s\S]*)\}$/.exec(tex);
  if (wrapped) tex = wrapped[1].trim();
  return tex || null;
}

/** @param {Element} el */
function hasMathChild(el) {
  return el.getElementsByTagName("math").length > 0;
}

/** @param {Element} el */
function hasBlockChild(el) {
  for (const child of el.children) if (BLOCK_TAGS.has(child.tagName.toUpperCase())) return true;
  return false;
}
