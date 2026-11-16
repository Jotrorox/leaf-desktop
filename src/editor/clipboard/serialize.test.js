// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { sliceToHtml, sliceToText } from "./serialize.js";

test("image blocks copy out as pictures other apps understand", () => {
  /** @type {import("../commands/commands.js").Slice} */
  const slice = {
    inline: false,
    blocks: [
      { type: "image", attrs: { file: "f1", caption: 'A "dot"' }, text: [], depth: 0 },
      { type: "image", attrs: { src: "https://example.com/a.png" }, text: [], depth: 0 },
      { type: "image", attrs: { src: "javascript:alert(1)" }, text: [], depth: 0 },
    ],
  };
  const imageUrl = (/** @type {Record<string, unknown>} */ attrs) =>
    attrs.file
      ? `https://api.test/v1/files/${attrs.file}`
      : typeof attrs.src === "string" && attrs.src.startsWith("https:")
        ? attrs.src
        : null;
  assert.equal(
    sliceToHtml(slice, { imageUrl }),
    '<figure><img src="https://api.test/v1/files/f1" alt="A &#34;dot&#34;"><figcaption>A &#34;dot&#34;</figcaption></figure><figure><img src="https://example.com/a.png" alt=""></figure>',
  );
  assert.equal(
    sliceToText(slice, { imageUrl }),
    '![A "dot"](https://api.test/v1/files/f1)\n![](https://example.com/a.png)',
  );
  // Without a resolver, only web addresses (never uploaded files' ids, nor scripts).
  assert.equal(sliceToText(slice), "![](https://example.com/a.png)");
});
