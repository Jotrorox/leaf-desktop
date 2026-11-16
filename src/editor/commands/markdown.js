// @ts-check
import { isPlainText, MATH_MARK, MATH_MARKS, mathId, spec } from "../blocks/schema.js";
import { parseInline } from "../clipboard/parse-text.js";
import { createBlock, turnInto } from "./commands.js";
import { marksOfChar, mathRanges, sliceRuns } from "./runs.js";
import { CELL, createTable, isDelimiterRow, splitTableLine, tableGrid } from "./table.js";

/**
 * Markdown shortcuts, applied right after a character is typed.
 *
 * - At the start of any text block but code and equations, `# `, `## `, `### `, `- ` (or
 *   `* `, `+ `), `1. `, `[] ` (or `[ ] `, `[x] `), `> ` and `" ` turn it into
 *   a heading, list, to-do or quote (a bullet can become a to-do, as in
 *   Notion). Typing a block's own shortcut in it changes nothing.
 * - A text paragraph that reads exactly ```` ``` ```` becomes code, and `---`
 *   becomes a divider with an empty paragraph below it for the caret.
 * - `$$ ` on an empty line makes an equation block.
 * - Closing `**bold**`, `*italic*`, `~~strike~~` or `` `code` `` formats
 *   what's between the markers and removes them; closing `$$x^2$$` makes
 *   what's between them inline math. (Single dollars never do, so prices
 *   like "$5 and $10" stay text.)
 * - Enter at the end of a paragraph that reads like a Markdown table's
 *   header (`| Name | Date |`) makes a table with those headings
 *   (`findTableRule`).
 *
 * In a table cell only the inline rules apply: a cell stays a cell.
 *
 * Each returns the new caret, or null when nothing matched. The editor runs
 * a rule as its own transaction and undo step, so undo brings back the
 * typed characters.
 */

/** @typedef {import("./commands.js").Ctx} Ctx */
/** @typedef {import("./commands.js").Pos} Pos */

/** @type {[RegExp, string, Record<string, unknown>?][]} */
const BLOCK_RULES = [
  [/^#$/, "h1"],
  [/^##$/, "h2"],
  [/^###$/, "h3"],
  [/^[-*+]$/, "bulleted"],
  [/^\d{1,9}[.)]$/, "numbered"],
  [/^\[ ?\]$/, "todo"],
  [/^\[[xX]\]$/, "todo", { checked: true }],
  [/^>$/, "quote"],
  [/^"$/, "quote"],
];

/** @type {[RegExp, string][]} */
const INLINE_RULES = [
  [/(?:^|[^$])\$\$([^$\s](?:[^$\n]*[^$\s])?)\$\$$/, MATH_MARK],
  [/(?:^|[^*])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, "bold"],
  [/(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, "italic"],
  [/(?:^|[^~])~~([^~\s](?:[^~]*[^~\s])?)~~$/, "strike"],
  [/(?:^|[^`])`([^`]+)`$/, "code"],
];

/**
 * Apply the rule that matches, if any.
 * @param {Ctx} ctx
 * @param {Pos} pos The caret right after the typed character.
 * @param {string} typed
 * @returns {Pos | null}
 */
export function applyInputRule(ctx, pos, typed) {
  return findInputRule(ctx, pos, typed)?.() ?? null;
}

/**
 * The rule that matches, as a function that applies it, or null. Finding
 * one changes nothing, so the editor can start a new undo step first.
 * @param {Ctx} ctx
 * @param {Pos} pos The caret right after the typed character.
 * @param {string} typed
 * @returns {(() => Pos) | null}
 */
export function findInputRule(ctx, pos, typed) {
  const { doc } = ctx;
  const type = doc.getType(pos.block);
  if (isPlainText(type)) return null;
  const before = doc.getText(pos.block).slice(0, pos.offset);
  const whole = doc.getText(pos.block);

  const inCell = type === CELL;

  if (typed === " " && whole === "$$ " && pos.offset === 3 && !inCell) {
    return () => {
      doc.deleteText(pos.block, 0, 3);
      turnInto(ctx, [pos.block], "equation");
      return { block: pos.block, offset: 0 };
    };
  }

  if (typed === " " && !inCell) {
    const prefix = before.slice(0, -1);
    for (const [re, to, attrs] of BLOCK_RULES) {
      if (!re.test(prefix)) continue;
      if (
        to === type &&
        (to !== "todo" || (doc.getAttrs(pos.block).checked === true) === (attrs?.checked === true))
      )
        return null;
      return () => {
        doc.deleteText(pos.block, 0, before.length);
        turnInto(ctx, [pos.block], to);
        if (to === "todo") doc.setAttr(pos.block, "checked", attrs?.checked === true ? true : null);
        return { block: pos.block, offset: 0 };
      };
    }
  }

  if (type === "p" && before === whole) {
    if (typed === "`" && whole === "```") {
      return () => {
        doc.deleteText(pos.block, 0, 3);
        turnInto(ctx, [pos.block], "code");
        return { block: pos.block, offset: 0 };
      };
    }
    if (typed === "-" && whole === "---" && doc.children(pos.block).length === 0) {
      return () => {
        doc.deleteText(pos.block, 0, 3);
        doc.setType(pos.block, "divider");
        const p = createBlock(doc, {
          type: "p",
          parent: doc.parentOf(pos.block) ?? null,
          after: pos.block,
        });
        return { block: p, offset: 0 };
      };
    }
  }

  if (!spec(type).marks || (typed !== "*" && typed !== "~" && typed !== "`" && typed !== "$"))
    return null;
  const runs = doc.getTextRuns(pos.block);
  for (const [re, mark] of INLINE_RULES) {
    const m = re.exec(before);
    if (!m) continue;
    const inner = m[1];
    const len = markerLength(mark);
    const open = before.length - inner.length - 2 * len;
    // Inside code, other markers are literal; a formula's TeX is never Markdown.
    if (mark !== "code" && marksOfChar(runs, open)?.code) continue;
    if (mathRanges(runs).some((r) => r.start < before.length && r.end > open)) continue;
    return () => {
      doc.deleteText(pos.block, before.length - len, len);
      doc.deleteText(pos.block, open, len);
      if (mark === MATH_MARK) {
        // TeX takes no formatting: only a color carries over.
        let at = open;
        for (const r of sliceRuns(doc.getTextRuns(pos.block), open, open + inner.length)) {
          for (const name of Object.keys(r.marks ?? {}))
            if (!MATH_MARKS.includes(name)) doc.format(pos.block, at, r.text.length, name, null);
          at += r.text.length;
        }
        doc.format(pos.block, open, inner.length, MATH_MARK, mathId());
      } else {
        doc.format(pos.block, open, inner.length, mark, true);
      }
      return { block: pos.block, offset: open + inner.length };
    };
  }
  return null;
}

/**
 * Enter at the end of a paragraph that is one Markdown table line
 * (`| a | b |`): it becomes a table with those cells as the
 * header row and an empty row below, where the caret goes. A delimiter
 * line (`|---|---|`) alone doesn't count. Null when it doesn't apply.
 * @param {Ctx} ctx @param {Pos} pos The caret (collapsed).
 * @returns {(() => Pos) | null}
 */
export function findTableRule(ctx, pos) {
  const { doc } = ctx;
  if (doc.getType(pos.block) !== "p" || doc.children(pos.block).length > 0) return null;
  const text = doc.getText(pos.block);
  if (pos.offset !== text.length || text.includes("\n")) return null;
  const cells = splitTableLine(text);
  if (!cells || isDelimiterRow(cells)) return null;
  return () => {
    const parent = doc.parentOf(pos.block) ?? null;
    const header = cells.map((c) => parseInline(c.replace(/<br\s*\/?>/gi, "\n")));
    const table = createTable(doc, {
      parent,
      after: pos.block,
      cells: [header, cells.map(() => [])],
      attrs: { header_row: true },
    });
    doc.deleteBlock(pos.block);
    return { block: tableGrid(doc, table)[1][0], offset: 0 };
  };
}

/** @param {string} mark */
function markerLength(mark) {
  return mark === "bold" || mark === "strike" || mark === MATH_MARK ? 2 : 1;
}
