// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { katexWoff2Only, woff2Only } from "./woff2-only.js";

const require = createRequire(import.meta.url);
const css = readFileSync(require.resolve("katex/dist/katex-swap.min.css"), "utf8");

/** @param {string} s */
const faces = (s) => s.match(/@font-face\{[^}]*\}/g) ?? [];

test("every KaTeX font keeps its woff2 and loses woff and ttf", () => {
  const before = faces(css);
  const after = faces(woff2Only(css));
  assert.ok(before.length >= 20, "the stylesheet still declares KaTeX's fonts");
  assert.equal(after.length, before.length);
  for (const face of after) {
    assert.match(face, /src:url\([^)]*\.woff2\) format\("woff2"\)\}/, face);
    assert.doesNotMatch(face, /\.woff\)|\.ttf\)/, face);
  }
  const rest = (/** @type {string} */ s) => s.replace(/@font-face\{[^}]*\}/g, "");
  assert.equal(rest(woff2Only(css)), rest(css), "nothing but the font sources changes");
});

test("the plugin only touches KaTeX's stylesheet", () => {
  const plugin = katexWoff2Only();
  const transform = /** @type {(code: string, id: string) => { code: string } | null} */ (
    plugin.transform
  );
  assert.equal(transform(css, "/app/src/styles/tokens.css"), null);
  assert.ok(
    !transform(css, "/app/node_modules/katex/dist/katex-swap.min.css?direct")?.code.includes(
      ".ttf",
    ),
  );
});
