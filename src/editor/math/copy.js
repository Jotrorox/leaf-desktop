// @ts-check
import { toast } from "../../ui/Toast.jsx";
import { loadMath, mathmlSource, mathReady } from "./render.js";

/**
 * "Copy as TeX" and "Copy as MathML": formulas as source text, for apps
 * with an equation editor of their own (Pages' and Keynote's Insert ▸
 * Equation, Word's equation editor, LaTeX documents). Several formulas go
 * on the clipboard one after another, separated by blank lines.
 */

/**
 * Put formulas on the clipboard as TeX or MathML, and say so.
 * @param {string[]} sources @param {"tex" | "mathml"} format @param {boolean} display
 * @param {string} [macros] The page's definitions (TeX): MathML has them expanded; TeX keeps the commands.
 * @param {import("./refs.js").Refs} [refs] The page's equation labels: MathML has references as numbers; TeX keeps `\eqref`.
 */
export async function copyMath(sources, format, display, macros = "", refs = undefined) {
  const texs = sources.map((s) => s.trim()).filter((s) => s !== "");
  if (texs.length === 0) {
    toast({ title: "Nothing to copy", description: "The equation is empty." });
    return;
  }
  /** @type {string[]} */
  let out = texs;
  if (format === "mathml") {
    // Safari only lets a click write to the clipboard right away, so wait only when KaTeX isn't there yet.
    if (!mathReady()) await loadMath();
    const mathml = texs.map((tex) => mathmlSource(tex, display, macros, refs));
    if (mathml.some((m) => m === null)) {
      toast({
        title: "Couldn't copy MathML",
        description: "Fix the TeX error first.",
        tone: "danger",
      });
      return;
    }
    out = /** @type {string[]} */ (mathml);
  }
  try {
    await navigator.clipboard.writeText(out.join("\n\n"));
    const what = format === "tex" ? "TeX" : "MathML";
    toast({
      title: texs.length > 1 ? `Copied ${texs.length} equations as ${what}` : `Copied as ${what}`,
    });
  } catch {
    toast({
      title: "Couldn't copy",
      description: "Your browser blocked clipboard access.",
      tone: "danger",
    });
  }
}
