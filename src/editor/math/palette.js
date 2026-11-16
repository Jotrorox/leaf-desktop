// @ts-check
import { TEX_COMMANDS } from "./commands.js";

/**
 * The symbol palette in the formula popover, for people who don't know the
 * TeX names: a few groups of commands from the completion list (so a symbol
 * goes in exactly as its completion would), plus super- and subscripts.
 *
 * Pure.
 */

/** @typedef {import("./commands.js").TexCommand} TexCommand */
/** @typedef {{ id: string, label: string, items: TexCommand[] }} PaletteGroup */

/** @type {Map<string, TexCommand>} */
const BY_LABEL = new Map(TEX_COMMANDS.map((c) => [c.label, c]));

/** @param {string} labels Space-separated completion labels. @returns {TexCommand[]} */
function pick(labels) {
  return labels.split(" ").map((label) => {
    const command = BY_LABEL.get(label);
    if (!command) throw new Error(`No TeX command ${label}`);
    return command;
  });
}

/** @type {TexCommand} */
const SUPERSCRIPT = { label: "^{}", insert: "^{}", caret: 2, preview: "x^{n}" };
/** @type {TexCommand} */
const SUBSCRIPT = { label: "_{}", insert: "_{}", caret: 2, preview: "x_{n}" };

/** @type {PaletteGroup[]} */
export const PALETTE = [
  {
    id: "structures",
    label: "Structures",
    items: [
      SUPERSCRIPT,
      SUBSCRIPT,
      ...pick(
        "frac{}{} sqrt{} sqrt[]{} sum prod int iint oint lim binom{}{} vec{} hat{} bar{} overline{} dot{} text{} mathbb{}",
      ),
      ...TEX_COMMANDS.filter((c) => c.label.startsWith("left") && c.label.includes("\\right")),
      ...pick("begin{pmatrix} begin{cases} begin{aligned}"),
    ],
  },
  {
    id: "greek",
    label: "Greek",
    items: pick(
      "alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi rho sigma tau upsilon phi varphi chi psi omega " +
        "Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega",
    ),
  },
  {
    id: "operators",
    label: "Operators",
    items: pick(
      "pm mp times div cdot circ ast bullet oplus otimes cup cap setminus wedge vee neg partial nabla infty forall exists emptyset prime ldots cdots",
    ),
  },
  {
    id: "relations",
    label: "Relations",
    items: pick(
      "leq geq neq approx equiv sim simeq cong propto ll gg in notin ni subset subseteq supset supseteq mid parallel perp",
    ),
  },
  {
    id: "arrows",
    label: "Arrows",
    items: pick(
      "to leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow longrightarrow mapsto implies iff uparrow downarrow",
    ),
  },
];

/**
 * A palette item's name for assistive tech and its tooltip: the command
 * without its braces (`\frac`), or for scripts, what it is.
 * @param {TexCommand} item
 */
export function paletteName(item) {
  if (item === SUPERSCRIPT) return "Superscript";
  if (item === SUBSCRIPT) return "Subscript";
  return `\\${item.label.replace(/\{\}/g, "").replace("[]", "[n]")}`;
}
