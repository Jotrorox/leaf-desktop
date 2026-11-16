// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import { MATH_MARK } from "../blocks/schema.js";
import { sliceToHtml } from "../clipboard/serialize.js";
import {
  installKatex,
  mathmlSource,
  mathReady,
  mathToMathml,
  onMathReady,
  parseMacros,
  renderMath,
} from "./render.js";

// Before KaTeX is installed: nothing to draw yet, and listeners wait.
test("renderMath is null until KaTeX loads, then tells its listeners", () => {
  // In node the lazy chunk (with its stylesheet) can't load; tests install the package.
  assert.equal(mathReady(), false);
  let told = 0;
  const stop = onMathReady(() => told++);
  installKatex(katex);
  stop();
  assert.equal(told, 1);
  assert.equal(mathReady(), true);
});

test("formulas render, and the same source comes from the cache", () => {
  const a = renderMath("x^2");
  assert.ok(a?.html?.includes("katex"));
  assert.equal(renderMath("x^2"), a, "same result object");
  const display = renderMath("x^2", { display: true });
  assert.ok(display?.html?.includes("katex-display"));
});

test("a broken formula returns its error instead of throwing", () => {
  const result = renderMath("\\frac{1}{");
  assert.equal(result?.html, null);
  assert.match(String(result?.error), /Expected '}'|end of input/);
  assert.ok(!String(result?.error).startsWith("KaTeX parse error"), "without KaTeX's prefix");
});

test("untrusted commands don't make links, and runaway macros stop", () => {
  const link = renderMath("\\href{javascript:alert(1)}{x} \\url{https://a.test}");
  assert.ok(!link?.html?.includes("<a "), "no links");
  assert.ok(!link?.html?.includes("href="), "the address is only shown, as text");
  const bomb = renderMath("\\def\\a{\\a\\a}\\a");
  assert.equal(bomb?.html, null);
  const huge = renderMath("\\rule{1000em}{1000em}");
  const styles = String(huge?.html).match(/style="[^"]*"/g) ?? [];
  assert.ok(
    styles.length > 0 && styles.every((s) => !s.includes("1000em")),
    "drawn sizes are capped",
  );
});

test("the clipboard gets MathML with the TeX as an annotation", () => {
  const ml = mathToMathml("a<b", false);
  assert.ok(ml?.includes("<math"));
  assert.ok(ml?.includes('<annotation encoding="application/x-tex">a&lt;b</annotation>'));
  assert.ok(!ml?.includes("katex-html"), "no HTML rendering to duplicate the MathML");
  assert.ok(mathToMathml("x", true)?.includes('display="block"'));
  assert.equal(mathToMathml("\\frac{", false), null);
  const html = sliceToHtml({
    inline: true,
    blocks: [
      {
        type: "p",
        attrs: {},
        text: [{ text: "so " }, { text: "x", marks: { [MATH_MARK]: "m1" } }],
        depth: 0,
      },
    ],
  });
  assert.match(html, /^so <span class="katex"><math/);
});

test("Copy as MathML gets the bare <math> element", () => {
  const ml = mathmlSource("x^2", true);
  assert.match(
    String(ml),
    /^<math xmlns="http:\/\/www.w3.org\/1998\/Math\/MathML" display="block">/,
  );
  assert.match(
    String(ml),
    /<annotation encoding="application\/x-tex">x\^2<\/annotation><\/semantics><\/math>$/,
  );
  assert.equal(mathmlSource("\\frac{", false), null);
});

const MACROS =
  "\\newcommand{\\RR}{\\mathbb{R}}\n\\newcommand{\\norm}[1]{\\left\\lVert #1 \\right\\rVert}\n\\def\\eps{\\varepsilon}";

test("a page's macros parse once, with their names and argument counts", () => {
  const parsed = parseMacros(MACROS);
  assert.equal(parsed?.error, null);
  assert.deepEqual(parsed?.names, [
    { name: "RR", args: 0 },
    { name: "norm", args: 1 },
    { name: "eps", args: 0 },
  ]);
  assert.equal(parseMacros(MACROS), parsed, "cached");
  assert.equal(parseMacros("  ")?.names.length, 0);
});

test("formulas use the page's macros, and the cache tells pages apart", () => {
  const plain = renderMath("\\norm{x} \\in \\RR");
  assert.equal(plain?.html, null, "undefined without the macros");
  const withMacros = renderMath("\\norm{x} \\in \\RR", { macros: MACROS });
  assert.ok(
    withMacros?.html?.includes("mathbb") || withMacros?.html?.includes("amsrm"),
    "\\RR draws as a blackboard R",
  );
  assert.notEqual(renderMath("x", { macros: MACROS }), renderMath("x"), "separate cache entries");
  assert.ok(mathToMathml("\\eps", false, MACROS)?.includes("ε"));
  assert.ok(mathmlSource("\\RR", true, MACROS)?.startsWith("<math"));
});

test("one formula's definitions don't reach the next", () => {
  assert.ok(renderMath("\\gdef\\leak{y}\\leak", { macros: MACROS })?.html);
  assert.equal(renderMath("\\leak", { macros: MACROS })?.html, null);
  assert.ok(!parseMacros(MACROS)?.names.some((n) => n.name === "leak"));
});

test("a broken definition is reported, and the ones before it still apply", () => {
  const parsed = parseMacros("\\newcommand{\\Aa}{a}\n\\newcommand{\\Bb}{\\frac{}");
  assert.match(String(parsed?.error), /end of input/);
  assert.deepEqual(
    parsed?.names.map((n) => n.name),
    ["Aa"],
  );
  assert.match(
    String(parseMacros("\\newcommand{\\R}{x}")?.error),
    /redefine/,
    "KaTeX's own commands need \\renewcommand",
  );
  assert.match(
    String(parseMacros("\\newcommand{\\bomb}{\\bomb\\bomb}\\bomb")?.error),
    /Too many expansions/,
  );
  const recursive = parseMacros("\\newcommand{\\loop}{\\loop}");
  assert.equal(recursive?.error, null, "defining is fine");
  assert.match(
    String(renderMath("\\loop", { macros: "\\newcommand{\\loop}{\\loop}" })?.error),
    /Too many expansions/,
    "using it stops",
  );
});
