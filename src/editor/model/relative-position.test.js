// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { Doc } from "./doc.js";
import { decodeRelativePosition, encodeRelativePosition } from "./relative-position.js";
import { syncAll } from "./test-helpers.js";

function twoReplicas() {
  const a = new Doc({ clientId: 1 });
  const b = new Doc({ clientId: 2 });
  const p = a.insertBlock({ type: "paragraph", text: "hello world" });
  syncAll(a, b);
  return { a, b, p };
}

test("a position survives concurrent inserts and deletes before and after it", () => {
  const { a, b, p } = twoReplicas();
  const pos = a.createRelativePosition(p, 6); // before "w"
  b.insertText(p, 0, ">> ");
  b.deleteText(p, 4, 2); // removes "el"
  b.insertText(p, b.textLength(p), "!");
  syncAll(a, b);
  assert.equal(a.getText(p), ">> hlo world!");
  assert.deepEqual(a.resolveRelativePosition(pos), { blockId: p, offset: 7 });
  assert.equal(a.getText(p).slice(7), "world!");
});

test("assoc decides which side text typed at the position goes", () => {
  const { a, b, p } = twoReplicas();
  const right = a.createRelativePosition(p, 5); // sticks to " "
  const left = a.createRelativePosition(p, 5, -1); // sticks to "o"
  b.insertText(p, 5, "XYZ");
  syncAll(a, b);
  assert.equal(a.getText(p), "helloXYZ world");
  assert.equal(a.resolveRelativePosition(right)?.offset, 8, "after the inserted text");
  assert.equal(a.resolveRelativePosition(left)?.offset, 5, "before the inserted text");
});

test("ends of the text, and a deleted anchor", () => {
  const { a, b, p } = twoReplicas();
  const end = a.createRelativePosition(p, 11);
  const start = a.createRelativePosition(p, 0, -1);
  const mid = a.createRelativePosition(p, 3);
  assert.equal(end.item, null);
  assert.equal(start.item, null);
  b.insertText(p, 11, "!!");
  b.insertText(p, 0, "_");
  b.deleteText(p, 2, 5); // removes "ello " with the anchor "l"
  syncAll(a, b);
  assert.equal(a.getText(p), "_hworld!!");
  assert.equal(a.resolveRelativePosition(end)?.offset, 9);
  assert.equal(a.resolveRelativePosition(start)?.offset, 0);
  assert.equal(a.resolveRelativePosition(mid)?.offset, 2, "falls back to where the anchor was");
});

test("unknown blocks or anchors resolve to null; encoding round-trips", () => {
  const { a, p } = twoReplicas();
  const pos = a.createRelativePosition(p, 4);
  const other = new Doc({ clientId: 3 });
  assert.equal(other.resolveRelativePosition(pos), null);
  const back = decodeRelativePosition(encodeRelativePosition(pos));
  assert.deepEqual(back, pos);
  assert.deepEqual(a.resolveRelativePosition(back), { blockId: p, offset: 4 });
  const endPos = a.createRelativePosition(p, 11, -1);
  assert.deepEqual(decodeRelativePosition(encodeRelativePosition(endPos)), endPos);
  assert.throws(() => a.createRelativePosition(p, 12), RangeError);
});
