// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  insertByPosition,
  isNoopMove,
  keyboardMove,
  patchNode,
  placeNode,
  positionAfter,
  removeNode,
  resolveDrop,
  wouldCreateCycle,
} from "./tree-ops.js";

/** @param {string} id @param {string} [position] */
const node = (id, position = "a0") => ({ id, position, title: id.toUpperCase() });
const list = [node("a", "a0"), node("b", "a1"), node("c", "a2")];
/** @param {{ id: string }[] | undefined} items */
const ids = (items) => items?.map((item) => item.id);

test("removeNode removes by id and keeps the list when it's absent", () => {
  assert.deepEqual(ids(removeNode(list, "b")), ["a", "c"]);
  assert.equal(removeNode(list, "x"), list);
  assert.equal(removeNode(undefined, "x"), undefined);
});

test("patchNode merges fields and keeps the list when nothing changes", () => {
  const patched = patchNode(list, "b", { title: "Bee" });
  assert.equal(patched?.[1].title, "Bee");
  assert.equal(patched?.[0], list[0], "other items keep their identity");
  assert.equal(patchNode(list, "b", { title: "B" }), list);
  assert.equal(patchNode(list, "x", { title: "X" }), list);
  assert.equal(
    patchNode(/** @type {typeof list | undefined} */ (undefined), "b", { title: "X" }),
    undefined,
  );
});

test("placeNode inserts after an id, first for null, last for undefined", () => {
  const d = node("d");
  assert.deepEqual(ids(placeNode(list, d, "a")), ["a", "d", "b", "c"]);
  assert.deepEqual(ids(placeNode(list, d, null)), ["d", "a", "b", "c"]);
  assert.deepEqual(ids(placeNode(list, d, undefined)), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(placeNode(list, d, "missing")), ["a", "b", "c", "d"]);
});

test("placeNode moves an existing node and is a no-op when it's already there", () => {
  assert.deepEqual(ids(placeNode(list, list[2], null)), ["c", "a", "b"]);
  assert.deepEqual(ids(placeNode(list, list[0], "c")), ["b", "c", "a"]);
  assert.equal(placeNode(list, list[1], "a"), list);
  assert.equal(placeNode(list, list[0], null), list);
  assert.notEqual(
    placeNode(list, { ...list[1] }, "a"),
    list,
    "a new object for the same id replaces it",
  );
});

test("insertByPosition keeps position order and replaces an earlier copy", () => {
  assert.deepEqual(ids(insertByPosition(list, node("d", "a0V"))), ["a", "d", "b", "c"]);
  assert.deepEqual(ids(insertByPosition(list, node("d", "Zz"))), ["d", "a", "b", "c"]);
  assert.deepEqual(ids(insertByPosition(list, node("d", "a3"))), ["a", "b", "c", "d"]);
  assert.deepEqual(ids(insertByPosition(list, node("a", "a5"))), ["b", "c", "a"]);
});

test("positionAfter computes a key between the neighbours, ignoring the moved page", () => {
  assert.equal(positionAfter(list, "a", "x", "?"), "a0V");
  assert.equal(positionAfter(list, null, "x", "?"), "Zz");
  assert.equal(positionAfter(list, undefined, "x", "?"), "a3");
  assert.equal(
    positionAfter(list, "a", "b", "?"),
    "a1",
    "b is the one moving, so it's between a and c",
  );
  assert.equal(positionAfter([node("a", "not a key")], undefined, "x", "fallback"), "fallback");
});

test("wouldCreateCycle walks up through known parents", () => {
  /** @type {Record<string, string | null>} */
  const parents = { a: null, b: "a", c: "b", d: null };
  /** @param {string} id */
  const parentOf = (id) => (id in parents ? parents[id] : undefined);
  assert.equal(wouldCreateCycle("a", "a", parentOf), true);
  assert.equal(wouldCreateCycle("a", "c", parentOf), true);
  assert.equal(wouldCreateCycle("b", "c", parentOf), true);
  assert.equal(wouldCreateCycle("c", "a", parentOf), false);
  assert.equal(wouldCreateCycle("a", "d", parentOf), false);
  assert.equal(wouldCreateCycle("a", null, parentOf), false);
  assert.equal(wouldCreateCycle("a", "unknown", parentOf), false);
  const loop = /** @type {Record<string, string>} */ ({ x: "y", y: "x" });
  assert.equal(
    wouldCreateCycle("z", "x", (id) => loop[id]),
    false,
    "a broken cache can't hang it",
  );
});

test("resolveDrop: before goes after the previous sibling, ignoring the dragged page", () => {
  const siblings = ["a", "b", "c"];
  const target = { id: "b", parentId: "p", expanded: false };
  assert.deepEqual(resolveDrop("before", target, siblings, "x"), { parentId: "p", afterId: "a" });
  assert.deepEqual(resolveDrop("before", target, siblings, "a"), { parentId: "p", afterId: null });
  assert.deepEqual(resolveDrop("before", { ...target, id: "a" }, siblings, "x"), {
    parentId: "p",
    afterId: null,
  });
});

test("resolveDrop: after, after an expanded page, and inside", () => {
  const target = { id: "b", parentId: "p", expanded: false };
  assert.deepEqual(resolveDrop("after", target, ["a", "b"], "x"), { parentId: "p", afterId: "b" });
  assert.deepEqual(resolveDrop("after", { ...target, expanded: true }, ["a", "b"], "x"), {
    parentId: "b",
    afterId: null,
  });
  assert.deepEqual(resolveDrop("inside", target, ["a", "b"], "x"), {
    parentId: "b",
    afterId: undefined,
  });
});

test("isNoopMove spots placements that change nothing", () => {
  const siblings = ["a", "b", "c"];
  const b = { id: "b", parentId: "p" };
  assert.equal(isNoopMove(b, siblings, { parentId: "p", afterId: "a" }), true);
  assert.equal(isNoopMove(b, siblings, { parentId: "p", afterId: "c" }), false);
  assert.equal(isNoopMove(b, siblings, { parentId: "q", afterId: "a" }), false);
  assert.equal(
    isNoopMove({ id: "a", parentId: "p" }, siblings, { parentId: "p", afterId: null }),
    true,
  );
  assert.equal(
    isNoopMove({ id: "c", parentId: "p" }, siblings, { parentId: "p", afterId: undefined }),
    true,
  );
  assert.equal(isNoopMove(b, siblings, { parentId: "p", afterId: undefined }), false);
});

test("keyboardMove: up and down among siblings", () => {
  const siblings = ["a", "b", "c"];
  assert.deepEqual(keyboardMove("up", "c", siblings, "p", null), { parentId: "p", afterId: "a" });
  assert.deepEqual(keyboardMove("up", "b", siblings, "p", null), { parentId: "p", afterId: null });
  assert.equal(keyboardMove("up", "a", siblings, "p", null), null);
  assert.deepEqual(keyboardMove("down", "a", siblings, "p", null), { parentId: "p", afterId: "b" });
  assert.equal(keyboardMove("down", "c", siblings, "p", null), null);
});

test("keyboardMove: in becomes the last child of the page above; out goes after the parent", () => {
  const siblings = ["a", "b"];
  assert.deepEqual(keyboardMove("in", "b", siblings, "p", null), {
    parentId: "a",
    afterId: undefined,
  });
  assert.equal(keyboardMove("in", "a", siblings, "p", null), null);
  assert.deepEqual(keyboardMove("out", "b", siblings, "p", "g"), { parentId: "g", afterId: "p" });
  assert.deepEqual(keyboardMove("out", "b", siblings, "p", null), { parentId: null, afterId: "p" });
  assert.equal(keyboardMove("out", "b", siblings, null, null), null, "already at the top level");
  assert.equal(keyboardMove("out", "b", siblings, "p", undefined), null, "grandparent unknown");
  assert.equal(keyboardMove("up", "x", siblings, "p", null), null);
});
