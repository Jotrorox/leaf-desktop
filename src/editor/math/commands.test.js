// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import katex from "katex";
import {
  isEscaped,
  macroCommands,
  matchTexCommands,
  TEX_COMMANDS,
  texQueryAt,
} from "./commands.js";
import { NO_REFS, resolveRefs } from "./refs.js";

test("what follows a backslash is the query, unless the backslash is escaped", () => {
  assert.deepEqual(texQueryAt("x + \\alp", 8), { start: 4, query: "alp" });
  assert.deepEqual(texQueryAt("\\", 1), { start: 0, query: "" });
  assert.deepEqual(
    texQueryAt("a \\\\\\fr", 7),
    { start: 4, query: "fr" },
    "a command after a line break",
  );
  assert.equal(texQueryAt("a \\\\", 4), null, "a line break");
  assert.equal(texQueryAt("\\alpha x", 8), null, "the caret has moved past the name");
  assert.equal(texQueryAt("\\frac{", 6), null);
  assert.deepEqual(texQueryAt("\\alpha+\\be", 7), null);
  assert.equal(isEscaped("\\\\", 1), true);
  assert.equal(isEscaped("\\\\\\", 2), false);
});

test("typed letters find commands, prefixes first", () => {
  assert.equal(matchTexCommands("alp")[0].label, "alpha");
  assert.equal(matchTexCommands("fr")[0].label, "frac{}{}");
  assert.equal(matchTexCommands("D")[0].label, "Delta", "the exact case wins");
  assert.equal(
    matchTexCommands("d")[0].label,
    "delta",
    "the most used of the names starting with it",
  );
  assert.equal(matchTexCommands("in")[0].label, "in", "the exact name first");
  assert.equal(matchTexCommands("left")[0].label, "left( \\right)");
  assert.ok(matchTexCommands("pmat").some((c) => c.label === "begin{pmatrix}"));
  assert.deepEqual(matchTexCommands("zzzz"), []);
  assert.equal(matchTexCommands("").length, 8);
  assert.equal(matchTexCommands("")[0].label, "frac{}{}");
});

test("completions put the caret in the first argument, or after a space", () => {
  const byLabel = (/** @type {string} */ l) =>
    /** @type {import("./commands.js").TexCommand} */ (TEX_COMMANDS.find((c) => c.label === l));
  const at = (/** @type {import("./commands.js").TexCommand} */ c) =>
    c.insert.slice(0, c.caret) + "|" + c.insert.slice(c.caret);
  assert.equal(at(byLabel("frac{}{}")), "\\frac{|}{}");
  assert.equal(at(byLabel("sqrt[]{}")), "\\sqrt[|]{}");
  assert.equal(at(byLabel("alpha")), "\\alpha |");
  assert.equal(at(byLabel("begin{cases}")), "\\begin{cases} | \\end{cases}");
  assert.equal(at(byLabel("left( \\right)")), "\\left( | \\right)");
});

test("every command is real TeX that KaTeX draws (\\label and \\eqref as leaf resolves them), and listed once", () => {
  const labels = new Set();
  for (const c of TEX_COMMANDS) {
    assert.ok(!labels.has(c.label), `${c.label} listed twice`);
    labels.add(c.label);
    assert.doesNotThrow(() => katex.renderToString(c.preview, { throwOnError: true }), c.label);
    const filled = c.insert.replace(/\{\}/g, "{x}").replace(/\[\]/g, "[3]");
    assert.doesNotThrow(
      () => katex.renderToString(resolveRefs(filled, NO_REFS), { throwOnError: true }),
      filled,
    );
  }
});

test("a page's macros complete too, before the built-in commands", () => {
  const extra = macroCommands([
    { name: "RR", args: 0 },
    { name: "norm", args: 1 },
    { name: "not a name", args: 0 },
  ]);
  assert.deepEqual(
    extra.map((c) => c.label),
    ["RR", "norm{}"],
  );
  assert.equal(matchTexCommands("R", 8, extra)[0].label, "RR");
  assert.equal(matchTexCommands("no", 8, extra)[0].label, "norm{}");
  assert.equal(matchTexCommands("", 8, extra)[0].label, "RR");
  const norm = extra[1];
  assert.equal(norm.insert.slice(0, norm.caret) + "|" + norm.insert.slice(norm.caret), "\\norm{|}");
  assert.equal(norm.preview, "\\norm{x}");
});
