// @ts-check
import { NO_REFS, resolveRefs } from "./refs.js";

/**
 * TeX to HTML with KaTeX, loaded the first time a page shows math (pages
 * without math never download it). Until it's there, `renderMath` returns
 * null and callers show the source; `onMathReady` tells them when to draw
 * again.
 *
 * Pages are shared publicly, so the options are strict: no `\href`,
 * `\url` or `\includegraphics` (`trust: false`), bounded macro expansion
 * and sizes, and errors come back as a message instead of a thrown
 * exception or half-drawn output.
 *
 * Results are cached by source, since the same formula is drawn again on
 * every keystroke elsewhere in its block and on every remote change.
 *
 * A page can define its own commands (`\newcommand{\RR}{\mathbb{R}}`, kept
 * as TeX in the doc meta key `mathMacros`). Callers pass that source as
 * `macros`; it's parsed once by KaTeX itself (`parseMacros`), each formula
 * gets a copy of the definitions (so a `\gdef` in one formula doesn't
 * reach the next), and cached results are keyed by the macros too.
 *
 * Callers also pass the page's equation labels (`refs`, refs.js): a
 * formula's `\label` is dropped and its `\eqref`s become numbers before
 * KaTeX sees it, so the cache is keyed by what's actually drawn.
 */

/** The doc meta key holding a page's macro definitions (TeX source). */
export const MACROS_META = "mathMacros";

/** @typedef {{ html: string, error: null } | { html: null, error: string }} MathResult */

/** @typedef {{ renderToString: (tex: string, options?: Record<string, unknown>) => string }} Katex */

/** @type {Katex | null} */
let katex = null;
/** @type {Promise<void> | null} */
let loading = null;
/** @type {Set<() => void>} */
const listeners = new Set();

/** @type {Map<string, MathResult>} */
const cache = new Map();
const CACHE_SIZE = 500;

/**
 * A page's parsed macros: the definitions (KaTeX's own form), their names
 * and argument counts, and the error that stopped parsing, if any (the
 * definitions before it still apply).
 * @typedef {{ id: number, definitions: Record<string, unknown>, names: { name: string, args: number }[], error: string | null }} Macros
 */

/** @type {Macros} */
const NO_MACROS = Object.freeze({ id: 0, definitions: Object.freeze({}), names: [], error: null });
/** @type {Map<string, Macros>} */
const macroCache = new Map();
const MACRO_CACHE_SIZE = 20;
let nextMacrosId = 1;

const OPTIONS = {
  throwOnError: true,
  trust: false,
  strict: "ignore",
  // In em: the largest `\rule` or `\kern` a formula may ask for.
  maxSize: 20,
  maxExpand: 500,
};

/** Start loading KaTeX (once). */
export function loadMath() {
  if (!loading) {
    loading = import("./katex.js").then(
      (module) => installKatex(module.default),
      () => {
        // Offline or a failed chunk: try again next time something asks.
        loading = null;
      },
    );
  }
  return loading;
}

/**
 * Use this KaTeX (the loader's, or the package itself in tests).
 * @param {Katex} instance
 */
export function installKatex(instance) {
  katex = instance;
  cache.clear();
  macroCache.clear();
  for (const fn of [...listeners]) fn();
}

/** Whether KaTeX is loaded. */
export function mathReady() {
  return katex !== null;
}

/**
 * Call `fn` once KaTeX has loaded. Returns a function that stops it.
 * @param {() => void} fn
 */
export function onMathReady(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * A page's macro definitions, parsed by KaTeX (with the same limits as a
 * formula, so a definition that expands forever stops with an error).
 * Null while KaTeX is still loading (this starts the load).
 * @param {string} source
 * @returns {Macros | null}
 */
export function parseMacros(source) {
  if (!katex) {
    void loadMath();
    return null;
  }
  if (source.trim() === "") return NO_MACROS;
  const hit = macroCache.get(source);
  if (hit) return hit;
  /** @type {Record<string, unknown>} */
  const definitions = {};
  /** @type {string | null} */
  let error = null;
  try {
    // In the global group, \newcommand and \def write into `definitions`.
    katex.renderToString(source, { ...OPTIONS, macros: definitions, globalGroup: true });
  } catch (e) {
    error = errorMessage(e);
  }
  const names = Object.entries(definitions).map(([name, def]) => ({
    name: name.slice(1),
    args: argCount(def),
  }));
  /** @type {Macros} */
  const parsed = { id: nextMacrosId++, definitions: Object.freeze(definitions), names, error };
  macroCache.set(source, parsed);
  if (macroCache.size > MACRO_CACHE_SIZE)
    macroCache.delete(/** @type {string} */ (macroCache.keys().next().value));
  return parsed;
}

/** How many arguments a KaTeX macro definition takes. @param {unknown} def */
function argCount(def) {
  if (def && typeof def === "object" && "numArgs" in def && typeof def.numArgs === "number")
    return def.numArgs;
  if (typeof def === "string")
    return Math.max(0, ...[...def.matchAll(/#([1-9])/g)].map((m) => Number(m[1])));
  return 0;
}

/**
 * Options for one formula with a page's macros: a fresh copy of the
 * definitions, so the formula can't change them for the next one.
 * @param {string} macros @param {boolean} display
 */
function optionsFor(macros, display) {
  const parsed = macros ? parseMacros(macros) : NO_MACROS;
  return {
    parsed: parsed ?? NO_MACROS,
    options: { ...OPTIONS, displayMode: display, macros: { ...(parsed ?? NO_MACROS).definitions } },
  };
}

/**
 * A formula as HTML (with MathML for screen readers), or the parse error.
 * Null while KaTeX is still loading (this starts the load).
 * @param {string} source
 * @param {{ display?: boolean, macros?: string, refs?: import("./refs.js").Refs }} [options] `macros`: the page's definitions (TeX); `refs`: its equation labels.
 * @returns {MathResult | null}
 */
export function renderMath(source, { display = false, macros = "", refs = NO_REFS } = {}) {
  if (!katex) {
    void loadMath();
    return null;
  }
  const tex = resolveRefs(source, refs);
  const { parsed, options } = optionsFor(macros, display);
  const key = (display ? "D" : "I") + parsed.id + ":" + tex;
  const hit = cache.get(key);
  if (hit) {
    // Most recently used goes last.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  /** @type {MathResult} */
  let result;
  try {
    result = { html: katex.renderToString(tex, options), error: null };
  } catch (error) {
    result = { html: null, error: errorMessage(error) };
  }
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) cache.delete(/** @type {string} */ (cache.keys().next().value));
  return result;
}

/**
 * A formula as MathML only, for the clipboard: other apps (Word, Pages,
 * browsers) draw it natively, and its TeX annotation lets editors that
 * know math get the source back. Null when KaTeX isn't loaded or the
 * formula doesn't parse.
 * @param {string} tex @param {boolean} display @param {string} [macros] The page's definitions (TeX).
 * @param {import("./refs.js").Refs} [refs] The page's equation labels.
 */
export function mathToMathml(tex, display, macros = "", refs = NO_REFS) {
  if (!katex) return null;
  try {
    return katex.renderToString(resolveRefs(tex, refs), {
      ...optionsFor(macros, display).options,
      output: "mathml",
    });
  } catch {
    return null;
  }
}

/**
 * A formula as bare MathML markup, for "Copy as MathML": the `<math>`
 * element (its TeX as an annotation) without KaTeX's wrapper. Null when
 * KaTeX isn't loaded or the formula doesn't parse.
 * @param {string} tex @param {boolean} display @param {string} [macros] The page's definitions (TeX).
 * @param {import("./refs.js").Refs} [refs] The page's equation labels.
 */
export function mathmlSource(tex, display, macros = "", refs = NO_REFS) {
  const html = mathToMathml(tex, display, macros, refs);
  const math = html === null ? null : /<math[\s\S]*<\/math>/.exec(html);
  return math ? math[0] : null;
}

/** KaTeX's message without its prefix. @param {unknown} error */
function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^KaTeX parse error:\s*/, "") || "Invalid equation";
}
