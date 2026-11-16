// @ts-check
import { MATH_MARK, mathId, normalizeLinkInput, safeHref } from "../blocks/schema.js";
import { isDelimiterRow, splitTableLine } from "../commands/table.js";

/**
 * Plain text from the clipboard to a slice. One line is inline text. More
 * lines are parsed as Markdown-ish blocks: headings, lists, to-dos, quotes,
 * fenced code, `$$` math (fenced, or a line of its own), `---` and
 * Markdown tables (a header line, a `|---|` line, then rows), with
 * indentation (2 spaces or a tab per level) for nesting, and `**bold**`,
 * `*italic*`, `~~strike~~`, `` `code` ``, `$$math$$` and `[text](url)`
 * inside lines.
 *
 * Pure.
 */

/** @typedef {import("../commands/commands.js").Slice} Slice */
/** @typedef {import("../commands/commands.js").SliceBlock} SliceBlock */
/** @typedef {import("../model/doc.js").TextRun} TextRun */

/** @param {string} text @returns {Slice} */
export function parsePlainText(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length <= 1) {
    const line = lines[0] ?? "";
    const url =
      /^\S+$/.test(line) && /^(https?:\/\/|mailto:)/i.test(line) ? normalizeLinkInput(line) : null;
    return {
      inline: true,
      blocks: [
        {
          type: "p",
          attrs: {},
          text: url ? [{ text: line, marks: { link: url } }] : parseInline(line),
          depth: 0,
        },
      ],
    };
  }

  /** @type {SliceBlock[]} */
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fence = /^\s*```/.exec(raw);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      blocks.push({
        type: "code",
        attrs: {},
        text: body.length ? [{ text: body.join("\n") }] : [],
        depth: 0,
      });
      continue;
    }
    // Display math: $$ on its own line up to the next one, or $$…$$ as the whole line.
    if (/^\s*\$\$\s*$/.test(raw)) {
      const body = [];
      i++;
      while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) body.push(lines[i++]);
      const tex = body.join("\n").trim();
      blocks.push({ type: "equation", attrs: {}, text: tex ? [{ text: tex }] : [], depth: 0 });
      continue;
    }
    // A table: a header line, the delimiter line, and the rows that follow.
    const header = splitTableLine(raw, { pipes: false });
    const delimiter =
      header && i + 1 < lines.length ? splitTableLine(lines[i + 1], { pipes: false }) : null;
    if (header && delimiter && isDelimiterRow(delimiter) && delimiter.length === header.length) {
      const depth = Math.floor((/^[ \t]*/.exec(raw)?.[0] ?? "").replace(/\t/g, "  ").length / 2);
      /** @type {string[][]} */
      const rows = [header];
      i += 2;
      for (; i < lines.length; i++) {
        const row = lines[i].trim() === "" ? null : splitTableLine(lines[i], { pipes: false });
        if (!row) break;
        rows.push(row);
      }
      i--;
      blocks.push({ type: "table", attrs: { header_row: true }, text: [], depth });
      for (const row of rows) {
        blocks.push({ type: "table_row", attrs: {}, text: [], depth: depth + 1 });
        for (let c = 0; c < header.length; c++)
          blocks.push({
            type: "table_cell",
            attrs: {},
            text: parseInline((row[c] ?? "").replace(/<br\s*\/?>/gi, "\n")),
            depth: depth + 2,
          });
      }
      continue;
    }
    const display = /^\s*\$\$([^$]+)\$\$\s*$/.exec(raw);
    if (display && display[1].trim()) {
      blocks.push({ type: "equation", attrs: {}, text: [{ text: display[1].trim() }], depth: 0 });
      continue;
    }
    const indentMatch = /^[ \t]*/.exec(raw);
    const indentText = indentMatch ? indentMatch[0] : "";
    const depth = Math.floor(indentText.replace(/\t/g, "  ").length / 2);
    const line = raw.slice(indentText.length);
    /** @type {[RegExp, string, Record<string, unknown>?][]} */
    const rules = [
      [/^###\s+/, "h3"],
      [/^##\s+/, "h2"],
      [/^#\s+/, "h1"],
      [/^[-*+]\s+\[[xX]\]\s+/, "todo", { checked: true }],
      [/^[-*+]\s+\[ ?\]\s+/, "todo"],
      [/^\[[xX]\]\s+/, "todo", { checked: true }],
      [/^\[ ?\]\s+/, "todo"],
      [/^[-*+•]\s+/, "bulleted"],
      [/^\d{1,9}[.)]\s+/, "numbered"],
      [/^>\s?/, "quote"],
    ];
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      blocks.push({ type: "divider", attrs: {}, text: [], depth });
      continue;
    }
    let type = "p";
    /** @type {Record<string, unknown>} */
    let attrs = {};
    let body = line;
    for (const [re, t, a] of rules) {
      const m = re.exec(line);
      if (!m) continue;
      type = t;
      attrs = { ...a };
      body = line.slice(m[0].length);
      break;
    }
    // Headings don't nest; blank lines are empty paragraphs at the top level.
    blocks.push({
      type,
      attrs,
      text: parseInline(body),
      depth: type.startsWith("h") || body === "" ? 0 : depth,
    });
  }
  return { inline: false, blocks };
}

/** @type {[RegExp, string][]} */
const INLINE = [
  [/`([^`]+)`/, "code"],
  [/\$\$([^$\s](?:[^$]*[^$\s])?)\$\$/, MATH_MARK],
  [/\*\*([^*]+)\*\*/, "bold"],
  [/__([^_]+)__/, "bold"],
  [/~~([^~]+)~~/, "strike"],
  [/(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w])/, "italic"],
  [/(?<![_\w])_([^_\s][^_]*?)_(?![_\w])/, "italic"],
];

/**
 * Inline Markdown to runs.
 * @param {string} text
 * @param {Record<string, unknown>} [marks]
 * @returns {TextRun[]}
 */
export function parseInline(text, marks = {}) {
  if (text === "") return [];
  // The earliest match of any rule (links first among equals).
  /** @type {{ index: number, length: number, inner: string, mark: string, value: unknown } | null} */
  let best = null;
  const link = /\[([^\]]+)\]\(([^)\s]+)\)/.exec(text);
  if (link) {
    const href = safeHref(link[2]) ?? normalizeLinkInput(link[2]);
    if (href)
      best = {
        index: link.index,
        length: link[0].length,
        inner: link[1],
        mark: "link",
        value: href,
      };
  }
  if (!marks.code) {
    for (const [re, mark] of INLINE) {
      const m = re.exec(text);
      if (m && (best === null || m.index < best.index))
        best = {
          index: m.index,
          length: m[0].length,
          inner: m[1],
          mark,
          value: mark === MATH_MARK ? mathId() : true,
        };
    }
  }
  /** @param {string} s */
  const plain = (s) => (s ? [Object.keys(marks).length ? { text: s, marks } : { text: s }] : []);
  if (best === null) return plain(text);
  // Code and TeX are literal: no Markdown inside, and TeX takes no formatting.
  const inner =
    best.mark === "code"
      ? [{ text: best.inner, marks: { ...marks, code: true } }]
      : best.mark === MATH_MARK
        ? [
            {
              text: best.inner,
              marks: {
                ...(typeof marks.color === "string" ? { color: marks.color } : {}),
                [MATH_MARK]: best.value,
              },
            },
          ]
        : parseInline(best.inner, { ...marks, [best.mark]: best.value });
  return [
    ...plain(text.slice(0, best.index)),
    ...inner,
    ...parseInline(text.slice(best.index + best.length), marks),
  ];
}
