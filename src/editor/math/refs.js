// @ts-check
import { isEscaped } from "./commands.js";

/**
 * Numbered equations and references between them, as in LaTeX: an
 * equation block with the `numbered` attr gets the next number in page
 * order, a `\label{name}` in its TeX names it, and `\eqref{name}` (or
 * `\ref{name}`) in any formula on the page, inline or block, draws as its
 * number.
 *
 * KaTeX knows none of the three, so formulas are rewritten before they're
 * drawn (`resolveRefs`): labels go, references become their numbers, and
 * a reference to a label no numbered equation has shows `??`, as LaTeX
 * does. The document keeps the TeX as written.
 *
 * Pure: the editor numbers the page when its equations change, and
 * render.js resolves each formula with the result.
 */

/** The block attr that numbers an equation (true, or absent). */
export const NUMBERED_ATTR = "numbered";

/** Labels and their numbers. @typedef {ReadonlyMap<string, number>} Refs */

/** @type {Refs} */
export const NO_REFS = new Map();

/**
 * A page's numbering: each numbered equation's number, each label's
 * number (the first numbered equation with a label keeps it), and the
 * numbered equations whose label an earlier one already has.
 * @typedef {{ numbers: ReadonlyMap<string, number>, refs: Refs, duplicates: ReadonlySet<string> }} Numbering
 */

/** @type {Numbering} */
export const NO_NUMBERING = { numbers: new Map(), refs: NO_REFS, duplicates: new Set() };

const COMMAND = /\\(label|eqref|ref)(?![A-Za-z])/;
const WITH_ARG = /\\(label|eqref|ref)\s*\{([^{}]*)\}/g;

/**
 * The name an equation's `\label{name}` gives it, or null.
 * @param {string} tex
 */
export function equationLabel(tex) {
  if (!tex.includes("\\label")) return null;
  for (const m of tex.matchAll(WITH_ARG)) {
    if (m[1] !== "label" || isEscaped(tex, m.index)) continue;
    const name = m[2].trim();
    if (name !== "") return name;
  }
  return null;
}

/**
 * A formula as KaTeX should see it: without its `\label`, with each
 * `\eqref{name}` as `(1)` and each `\ref{name}` as `1`.
 * @param {string} tex @param {Refs} refs
 */
export function resolveRefs(tex, refs) {
  if (!COMMAND.test(tex)) return tex;
  return tex.replace(
    WITH_ARG,
    (
      all,
      /** @type {string} */ command,
      /** @type {string} */ name,
      /** @type {number} */ index,
    ) => {
      if (isEscaped(tex, index)) return all;
      if (command === "label") return "";
      const n = refs.get(name.trim());
      const number = n === undefined ? "\\textbf{??}" : String(n);
      return command === "eqref" ? `\\text{(${number})}` : `\\text{${number}}`;
    },
  );
}

/**
 * Number a page's equations in page order (depth first, collapsed toggles
 * included). Also returns every equation block's id, so the caller knows
 * which changes can renumber.
 * @param {{ children: (parent: string | null) => readonly string[], getType: (id: string) => string, getAttrs: (id: string) => Record<string, unknown>, getText: (id: string) => string }} doc
 * @returns {Numbering & { equations: Set<string> }}
 */
export function numberEquations(doc) {
  /** @type {Map<string, number>} */
  const numbers = new Map();
  /** @type {Map<string, number>} */
  const refs = new Map();
  /** @type {Set<string>} */
  const duplicates = new Set();
  /** @type {Set<string>} */
  const equations = new Set();
  /** @param {string | null} parent */
  const walk = (parent) => {
    for (const id of doc.children(parent)) {
      if (doc.getType(id) === "equation") {
        equations.add(id);
        if (doc.getAttrs(id)[NUMBERED_ATTR] === true) {
          const n = numbers.size + 1;
          numbers.set(id, n);
          const label = equationLabel(doc.getText(id));
          if (label !== null) {
            if (refs.has(label)) duplicates.add(id);
            else refs.set(label, n);
          }
        }
      }
      walk(id);
    }
  };
  walk(null);
  return { numbers, refs, duplicates, equations };
}

/** Whether two numberings draw the same. @param {Numbering} a @param {Numbering} b */
export function sameNumbering(a, b) {
  return (
    a === b ||
    (sameMap(a.numbers, b.numbers) &&
      sameMap(a.refs, b.refs) &&
      a.duplicates.size === b.duplicates.size &&
      [...a.duplicates].every((id) => b.duplicates.has(id)))
  );
}

/** @param {ReadonlyMap<string, number>} a @param {ReadonlyMap<string, number>} b */
function sameMap(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
