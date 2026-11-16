// @ts-check
import { MATH_MARK, MATH_MARKS, mathId } from "../blocks/schema.js";

/**
 * Helpers for rich text as runs: `[{ text, marks? }]`, the shape
 * `doc.getTextRuns()` returns. Offsets are UTF-16 code units, like the
 * document's and the DOM's.
 */

/** @typedef {import("../model/doc.js").Doc} Doc */
/** @typedef {import("../model/doc.js").TextRun} TextRun */
/** @typedef {Record<string, unknown>} Marks */

/** @param {TextRun[]} runs */
export function runsLength(runs) {
  let n = 0;
  for (const r of runs) n += r.text.length;
  return n;
}

/** @param {TextRun[]} runs */
export function runsText(runs) {
  return runs.map((r) => r.text).join("");
}

/**
 * The runs covering [start, end).
 * @param {TextRun[]} runs @param {number} start @param {number} [end]
 * @returns {TextRun[]}
 */
export function sliceRuns(runs, start, end = Infinity) {
  /** @type {TextRun[]} */
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + r.text.length);
    if (b > a)
      out.push(
        r.marks
          ? { text: r.text.slice(a - pos, b - pos), marks: r.marks }
          : { text: r.text.slice(a - pos, b - pos) },
      );
    pos += r.text.length;
    if (pos >= end) break;
  }
  return out;
}

/**
 * Same runs with `drop` marks removed (e.g. formatting pasted into a code block).
 * @param {TextRun[]} runs @param {(name: string) => boolean} drop
 */
export function filterMarks(runs, drop) {
  return runs.map((r) => {
    if (!r.marks) return r;
    const marks = Object.fromEntries(Object.entries(r.marks).filter(([k]) => !drop(k)));
    return Object.keys(marks).length ? { text: r.text, marks } : { text: r.text };
  });
}

/**
 * Insert runs at an offset, each with its own marks. Returns the offset
 * after the inserted text.
 * @param {Doc} doc @param {string} block @param {number} offset @param {TextRun[]} runs
 */
export function insertRuns(doc, block, offset, runs) {
  for (const r of runs) {
    if (!r.text) continue;
    doc.insertText(block, offset, r.text, r.marks ?? null);
    offset += r.text.length;
  }
  return offset;
}

/**
 * The marks of the character at `index` (null if out of range).
 * @param {TextRun[]} runs @param {number} index
 * @returns {Marks | null}
 */
export function marksOfChar(runs, index) {
  let pos = 0;
  for (const r of runs) {
    if (index < pos + r.text.length) return index >= pos ? (r.marks ?? {}) : null;
    pos += r.text.length;
  }
  return null;
}

/**
 * The marks new text typed at `offset` gets: those of the character before
 * it. A link, mention or formula only carries on inside itself (the next
 * character has it too), so typing after its end writes plain text.
 * @param {Doc} doc @param {string} block @param {number} offset
 * @returns {Marks | null}
 */
export function marksAt(doc, block, offset) {
  if (offset === 0) return null;
  const runs = doc.getTextRuns(block);
  const before = marksOfChar(runs, offset - 1);
  if (!before) return null;
  const out = { ...before };
  for (const name of ["link", "mention", MATH_MARK]) {
    if (out[name] === undefined) continue;
    const after = marksOfChar(runs, offset);
    if (!after || JSON.stringify(after[name]) !== JSON.stringify(out[name])) delete out[name];
  }
  return Object.keys(out).length ? out : null;
}

/** @param {Marks | null | undefined} a @param {Marks | null | undefined} b */
export function sameMarks(a, b) {
  const ka = Object.keys(a ?? {});
  const kb = Object.keys(b ?? {});
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) return false;
  return true;
}

/**
 * The formulas (inline math) in a block's runs: each one's extent and id.
 * Neighbouring runs of the same formula (split by a color) count as one.
 * @param {TextRun[]} runs
 * @returns {{ start: number, end: number, id: unknown }[]}
 */
export function mathRanges(runs) {
  /** @type {{ start: number, end: number, id: unknown }[]} */
  const out = [];
  let pos = 0;
  for (const r of runs) {
    const id = r.marks?.[MATH_MARK];
    const end = pos + r.text.length;
    if (id !== undefined && id !== null) {
      const last = out[out.length - 1];
      if (last && last.end === pos && JSON.stringify(last.id) === JSON.stringify(id))
        last.end = end;
      else out.push({ start: pos, end, id });
    }
    pos = end;
  }
  return out;
}

/**
 * The formula covering the character at `index`, or null.
 * @param {TextRun[]} runs @param {number} index
 */
export function mathAt(runs, index) {
  return mathRanges(runs).find((m) => index >= m.start && index < m.end) ?? null;
}

/**
 * `[start, end)` grown so it doesn't cut a formula in two.
 * @param {TextRun[]} runs @param {number} start @param {number} end
 */
export function expandToMath(runs, start, end) {
  for (const m of mathRanges(runs)) {
    if (m.start < start && m.end > start) start = m.start;
    if (m.start < end && m.end > end) end = m.end;
  }
  return { start, end };
}

/**
 * Set (or with null clear) a mark on `[start, start + length)`, skipping
 * formulas for marks that don't apply inside TeX (only color does).
 * @param {Doc} doc @param {string} block @param {number} start @param {number} length @param {string} name @param {unknown} value
 */
export function formatText(doc, block, start, length, name, value) {
  if (length <= 0) return;
  if (MATH_MARKS.includes(name)) {
    doc.format(block, start, length, name, value);
    return;
  }
  const end = start + length;
  let at = start;
  for (const m of mathRanges(doc.getTextRuns(block))) {
    if (m.end <= at || m.start >= end) continue;
    if (m.start > at) doc.format(block, at, m.start - at, name, value);
    at = Math.max(at, m.end);
  }
  if (end > at) doc.format(block, at, end - at, name, value);
}

/**
 * The same runs with new ids for their formulas, for pasting (a formula
 * pasted next to its original would otherwise merge with it).
 * @param {TextRun[]} runs
 * @returns {TextRun[]}
 */
export function freshMathIds(runs) {
  /** @type {Map<string, string>} */
  const ids = new Map();
  return runs.map((r) => {
    const id = r.marks?.[MATH_MARK];
    if (id === undefined || id === null) return r;
    const key = JSON.stringify(id);
    let next = ids.get(key);
    if (!next) ids.set(key, (next = mathId()));
    return { text: r.text, marks: { ...r.marks, [MATH_MARK]: next } };
  });
}
