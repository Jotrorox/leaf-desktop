// @ts-check
import { fuzzyFilter } from "../../lib/fuzzy.js";

/**
 * Completion for TeX commands: typing `\alp` in an equation's source or in
 * the inline formula field offers `\alpha`. A small curated list (what
 * people reach for most, roughly most used first, which is also the order
 * shown before anything is typed after the `\`), matched with quick find's
 * fuzzy matcher.
 *
 * Pure: the editor and the popover find the `\query` before the caret and
 * put the completion in; the menus draw `preview` with KaTeX.
 */

/**
 * @typedef {object} TexCommand
 * @property {string} label What's matched and shown, without the backslash (`frac`, `begin{cases}`).
 * @property {string} insert What replaces the typed `\query`.
 * @property {number} caret Where the caret goes in `insert`.
 * @property {string} preview TeX that shows what it makes.
 */

/**
 * `name` and what follows it: `{}` and `[]` are arguments (the caret goes in
 * the first one). A command without arguments gets a space after it, so a
 * letter typed next doesn't run into its name.
 * @param {string} spec e.g. "frac{}{}" @param {string} [preview]
 * @returns {TexCommand}
 */
function command(spec, preview) {
  const name = /** @type {RegExpExecArray} */ (/^[A-Za-z]+/.exec(spec))[0];
  const args = spec.slice(name.length);
  const insert = `\\${spec}${args === "" ? " " : ""}`;
  const slot = args.search(/\{\}|\[\]/);
  return {
    label: spec,
    insert,
    caret: slot === -1 ? insert.length : name.length + 1 + slot + 1,
    preview: preview ?? `\\${name}`,
  };
}

/** @param {string} env @param {string} preview @returns {TexCommand} */
function environment(env, preview) {
  const open = `\\begin{${env}} `;
  return { label: `begin{${env}}`, insert: `${open} \\end{${env}}`, caret: open.length, preview };
}

/**
 * `\left` and `\right` go together (one alone doesn't parse).
 * @param {string} open @param {string} close @returns {TexCommand}
 */
function pair(open, close) {
  const before = `\\left${open} `;
  const insert = `${before} \\right${close}`;
  return {
    label: `left${open} \\right${close}`,
    insert,
    caret: before.length,
    preview: `\\left${open} x \\right${close}`,
  };
}

/** @type {TexCommand[]} */
export const TEX_COMMANDS = [
  command("frac{}{}", "\\frac{a}{b}"),
  command("sqrt{}", "\\sqrt{x}"),
  command("sum"),
  command("int"),
  command("alpha"),
  command("beta"),
  command("gamma"),
  command("delta"),
  command("pi"),
  command("theta"),
  command("lambda"),
  command("mu"),
  command("sigma"),
  command("omega"),
  command("infty"),
  command("cdot"),
  command("times"),
  command("leq"),
  command("geq"),
  command("neq"),
  command("approx"),
  command("pm"),
  command("to"),
  command("lim"),
  command("prod"),
  command("partial"),
  command("nabla"),
  command("text{}", "\\text{abc}"),
  command("mathbb{}", "\\mathbb{R}"),
  pair("(", ")"),
  pair("[", "]"),
  pair("\\{", "\\}"),
  pair("|", "|"),
  command("vec{}", "\\vec{v}"),
  command("hat{}", "\\hat{x}"),
  command("bar{}", "\\bar{x}"),
  command("dot{}", "\\dot{x}"),
  command("ddot{}", "\\ddot{x}"),
  command("tilde{}", "\\tilde{x}"),
  command("overline{}", "\\overline{AB}"),
  command("underline{}", "\\underline{x}"),
  command("widehat{}", "\\widehat{xy}"),
  command("overbrace{}", "\\overbrace{a+b}"),
  command("underbrace{}", "\\underbrace{a+b}"),
  command("sqrt[]{}", "\\sqrt[n]{x}"),
  command("dfrac{}{}", "\\dfrac{a}{b}"),
  command("binom{}{}", "\\binom{n}{k}"),
  command("iint"),
  command("oint"),
  command("mathbf{}", "\\mathbf{x}"),
  command("mathrm{}", "\\mathrm{d}"),
  command("mathit{}", "\\mathit{x}"),
  command("mathcal{}", "\\mathcal{L}"),
  command("mathfrak{}", "\\mathfrak{g}"),
  command("operatorname{}", "\\operatorname{rank}"),
  command("epsilon"),
  command("varepsilon"),
  command("zeta"),
  command("eta"),
  command("vartheta"),
  command("iota"),
  command("kappa"),
  command("nu"),
  command("xi"),
  command("rho"),
  command("tau"),
  command("upsilon"),
  command("phi"),
  command("varphi"),
  command("chi"),
  command("psi"),
  command("Gamma"),
  command("Delta"),
  command("Theta"),
  command("Lambda"),
  command("Xi"),
  command("Pi"),
  command("Sigma"),
  command("Upsilon"),
  command("Phi"),
  command("Psi"),
  command("Omega"),
  command("div"),
  command("mp"),
  command("ast"),
  command("circ"),
  command("bullet"),
  command("oplus"),
  command("otimes"),
  command("cup"),
  command("cap"),
  command("setminus"),
  command("wedge"),
  command("vee"),
  command("neg"),
  command("forall"),
  command("exists"),
  command("emptyset"),
  command("ldots"),
  command("cdots"),
  command("vdots"),
  command("ddots"),
  command("prime"),
  command("angle"),
  command("hbar"),
  command("ell"),
  command("Re"),
  command("Im"),
  command("aleph"),
  command("equiv"),
  command("sim"),
  command("simeq"),
  command("cong"),
  command("propto"),
  command("ll"),
  command("gg"),
  command("in"),
  command("notin"),
  command("ni"),
  command("subset"),
  command("subseteq"),
  command("supset"),
  command("supseteq"),
  command("mid"),
  command("parallel"),
  command("perp"),
  command("rightarrow"),
  command("leftarrow"),
  command("leftrightarrow"),
  command("Rightarrow"),
  command("Leftarrow"),
  command("Leftrightarrow"),
  command("longrightarrow"),
  command("mapsto"),
  command("implies"),
  command("iff"),
  command("uparrow"),
  command("downarrow"),
  command("sin"),
  command("cos"),
  command("tan"),
  command("cot"),
  command("sec"),
  command("csc"),
  command("arcsin"),
  command("arccos"),
  command("arctan"),
  command("sinh"),
  command("cosh"),
  command("tanh"),
  command("log"),
  command("ln"),
  command("exp"),
  command("det"),
  command("dim"),
  command("ker"),
  command("max"),
  command("min"),
  command("sup"),
  command("inf"),
  command("gcd"),
  command("deg"),
  command("arg"),
  command("quad", "a\\quad b"),
  command("qquad", "a\\qquad b"),
  command("eqref{}", "\\text{(1)}"),
  command("label{}", "\\text{name}"),
  environment("cases", "\\begin{cases}a\\\\b\\end{cases}"),
  environment("pmatrix", "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}"),
  environment("bmatrix", "\\begin{bmatrix}a&b\\\\c&d\\end{bmatrix}"),
  environment("matrix", "\\begin{matrix}a&b\\\\c&d\\end{matrix}"),
  environment("aligned", "\\begin{aligned}a&=b\\\\&=c\\end{aligned}"),
];

/**
 * A page's own macros as completions (`\RR`, `\norm{}`), drawn with
 * placeholder arguments.
 * @param {readonly { name: string, args: number }[]} names
 * @returns {TexCommand[]}
 */
export function macroCommands(names) {
  return names
    .filter((m) => /^[A-Za-z]+$/.test(m.name))
    .map((m) => command(m.name + "{}".repeat(m.args), `\\${m.name}` + "{x}".repeat(m.args)));
}

/**
 * References to a page's labelled equations as completions
 * (`\eqref{euler}`), drawn as the number they show.
 * @param {ReadonlyMap<string, number>} refs Labels and their numbers.
 * @returns {TexCommand[]}
 */
export function refCommands(refs) {
  return [...refs].map(([name, n]) => {
    const insert = `\\eqref{${name}}`;
    return { label: `eqref{${name}}`, insert, caret: insert.length, preview: `\\text{(${n})}` };
  });
}

/**
 * The commands the page itself adds: its macros, then references to its
 * labelled equations.
 * @param {readonly { name: string, args: number }[]} macros @param {ReadonlyMap<string, number>} refs
 */
export function pageCommands(macros, refs) {
  return [...macroCommands(macros), ...refCommands(refs)];
}

/**
 * The commands matching what's typed after the `\`, best first: the one
 * named exactly that, then names starting with it as typed (`\D` →
 * `\Delta`), then starting with it in any case, each in the list's order;
 * then the rest by fuzzy score. Nothing typed lists the first few. The
 * page's own macros (`extra`) come before the built-in ones.
 * @param {string} query @param {number} [limit] @param {readonly TexCommand[]} [extra]
 * @returns {TexCommand[]}
 */
export function matchTexCommands(query, limit = 8, extra = []) {
  const all = extra.length ? [...extra, ...TEX_COMMANDS] : TEX_COMMANDS;
  if (query === "") return all.slice(0, limit);
  const lower = query.toLowerCase();
  /** @param {TexCommand} c */
  const tier = (c) => {
    const name = c.label.replace(/[^A-Za-z].*$/, "");
    return name === query
      ? 0
      : c.label.startsWith(query)
        ? 1
        : c.label.toLowerCase().startsWith(lower)
          ? 2
          : 3;
  };
  const index = new Map(all.map((c, i) => [c, i]));
  return fuzzyFilter(query, all, (c) => c.label)
    .map(({ item, match }) => ({
      item,
      tier: tier(item),
      score: match.score,
      index: /** @type {number} */ (index.get(item)),
    }))
    .sort((a, b) => a.tier - b.tier || (a.tier === 3 ? b.score - a.score : 0) || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

/**
 * The command being typed right before `offset`: where its backslash is
 * and the letters after it. Null when there's none, or when the backslash
 * is itself escaped (`\\` is a line break in TeX).
 * @param {string} text @param {number} offset
 * @returns {{ start: number, query: string } | null}
 */
export function texQueryAt(text, offset) {
  const m = /\\([A-Za-z]*)$/.exec(text.slice(0, offset));
  if (!m) return null;
  const start = offset - m[0].length;
  return isEscaped(text, start) ? null : { start, query: m[1] };
}

/**
 * Whether the backslash at `index` follows an odd number of backslashes
 * (and so ends a `\\`, rather than starting a command).
 * @param {string} text @param {number} index
 */
export function isEscaped(text, index) {
  let n = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) n++;
  return n % 2 === 1;
}
