// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { Doc } from "./doc.js";
import { checkInvariants, syncAll } from "./test-helpers.js";

/** @param {number} [clientId] */
const newDoc = (clientId = 1) => new Doc({ clientId });

test("text insert and delete by UTF-16 offset", () => {
  const doc = newDoc();
  const p = doc.insertBlock({ type: "paragraph" });
  doc.insertText(p, 0, "hello");
  doc.insertText(p, 5, " world");
  doc.insertText(p, 0, ">");
  assert.equal(doc.getText(p), ">hello world");
  doc.deleteText(p, 1, 6);
  assert.equal(doc.getText(p), ">world");
  assert.equal(doc.textLength(p), 6);
  assert.throws(() => doc.insertText(p, 7, "x"), RangeError);
  assert.throws(() => doc.deleteText(p, 3, 4), RangeError);
  assert.throws(() => doc.insertText("nope", 0, "x"), /no block/);
});

test("surrogate pairs are never split", () => {
  const doc = newDoc();
  const p = doc.insertBlock({ type: "paragraph", text: "a😀b" });
  assert.equal(doc.textLength(p), 4);
  doc.insertText(p, 2, "x"); // inside the pair: moves to before it
  assert.equal(doc.getText(p), "ax😀b");
  doc.deleteText(p, 2, 1); // half the pair: widened to all of it
  assert.equal(doc.getText(p), "axb");
  doc.insertText(p, 0, "\uD800"); // lone surrogate
  assert.equal(doc.getText(p), "�axb");
});

test("marks: runs, LWW per character and mark, null removes", () => {
  const doc = newDoc();
  const p = doc.insertBlock({ type: "paragraph", text: "hello world" });
  doc.format(p, 0, 5, "bold", true);
  doc.format(p, 3, 5, "italic", true);
  doc.format(p, 6, 5, "link", "https://leaf.test");
  assert.deepEqual(doc.getTextRuns(p), [
    { text: "hel", marks: { bold: true } },
    { text: "lo", marks: { bold: true, italic: true } },
    { text: " ", marks: { italic: true } },
    { text: "wo", marks: { italic: true, link: "https://leaf.test" } },
    { text: "rld", marks: { link: "https://leaf.test" } },
  ]);
  doc.format(p, 0, 11, "italic", null);
  doc.format(p, 0, 11, "bold", null);
  assert.deepEqual(doc.getTextRuns(p), [
    { text: "hello " },
    { text: "world", marks: { link: "https://leaf.test" } },
  ]);
  doc.insertText(p, 0, "Hi ", { bold: true, italic: null });
  assert.deepEqual(doc.getTextRuns(p)[0], { text: "Hi ", marks: { bold: true } });
});

test("concurrent marks on the same character: the newer op wins on both replicas", () => {
  const a = newDoc(1);
  const b = newDoc(2);
  const p = a.insertBlock({ type: "paragraph", text: "abc" });
  syncAll(a, b);
  a.format(p, 0, 3, "color", "red");
  b.format(p, 1, 2, "color", "blue");
  // Same Lamport clock: client 2 is newer.
  syncAll(a, b);
  assert.deepEqual(a.getTextRuns(p), [
    { text: "a", marks: { color: "red" } },
    { text: "bc", marks: { color: "blue" } },
  ]);
  assert.deepEqual(b.toJSON(), a.toJSON());
  // A later local write wins over both.
  a.format(p, 0, 3, "color", null);
  syncAll(a, b);
  assert.deepEqual(b.getTextRuns(p), [{ text: "abc" }]);
});

test("attrs, type and meta are LWW registers", () => {
  const a = newDoc(1);
  const b = newDoc(2);
  const p = a.insertBlock({ type: "todo", attrs: { checked: false } });
  a.setMeta("icon", "🌿");
  syncAll(a, b);
  a.setAttr(p, "checked", true);
  b.setAttr(p, "checked", false);
  b.setAttr(p, "color", "red");
  a.setType(p, "heading");
  syncAll(a, b);
  assert.deepEqual(a.getAttrs(p), { checked: false, color: "red" });
  assert.equal(b.getType(p), "heading");
  assert.equal(b.getMeta("icon"), "🌿");
  b.setAttr(p, "color", null);
  syncAll(a, b);
  assert.deepEqual(a.getAttrs(p), { checked: false });
  assert.deepEqual(a.toJSON(), b.toJSON());
});

test("block insert, order, nesting and delete", () => {
  const doc = newDoc();
  const a = doc.insertBlock({ type: "paragraph", text: "A" });
  const c = doc.insertBlock({ type: "paragraph", text: "C" });
  const b = doc.insertBlock({ type: "paragraph", after: a, text: "B" });
  const first = doc.insertBlock({ type: "heading", after: null });
  assert.deepEqual(doc.root(), [first, a, b, c]);
  const child = doc.insertBlock({ type: "paragraph", parent: b });
  const grandchild = doc.insertBlock({ type: "paragraph", parent: child });
  assert.deepEqual(doc.children(b), [child]);
  assert.equal(doc.parentOf(grandchild), child);
  doc.deleteBlock(b);
  assert.deepEqual(doc.root(), [first, a, c]);
  assert.equal(doc.isVisible(child), false, "deleted parents hide their children");
  assert.equal(doc.isVisible(grandchild), false);
  assert.deepEqual(Object.keys(doc.toJSON().blocks).sort(), [first, a, c].sort());
  assert.throws(() => doc.insertBlock({ type: "paragraph", after: child }), /not a child/);
  checkInvariants(doc);
});

test("moveBlock moves the subtree; moving into itself throws", () => {
  const doc = newDoc();
  const a = doc.insertBlock({ type: "paragraph" });
  const b = doc.insertBlock({ type: "paragraph" });
  const c = doc.insertBlock({ type: "paragraph", parent: b });
  doc.moveBlock(b, { parent: a });
  assert.deepEqual(doc.root(), [a]);
  assert.deepEqual(doc.children(a), [b]);
  assert.deepEqual(doc.children(b), [c]);
  assert.throws(() => doc.moveBlock(a, { parent: c }), /into itself/);
  assert.throws(() => doc.moveBlock(a, { parent: a }), /into itself/);
  doc.moveBlock(c, { parent: null, after: null });
  assert.deepEqual(doc.root(), [c, a]);
  checkInvariants(doc);
});

test("concurrent moves of the same block: the newest wins, it appears once", () => {
  const r = [newDoc(1), newDoc(2), newDoc(3)];
  const [a] = r;
  const x = a.insertBlock({ type: "paragraph", text: "x" });
  const p = a.insertBlock({ type: "paragraph", text: "p" });
  const q = a.insertBlock({ type: "paragraph", text: "q" });
  syncAll(...r);
  r[0].moveBlock(x, { parent: p });
  r[1].moveBlock(x, { parent: q });
  r[2].moveBlock(x, { parent: null }); // to the end of the root
  syncAll(...r);
  for (const d of r) {
    checkInvariants(d);
    assert.deepEqual(d.toJSON(), r[0].toJSON());
  }
  // Same Lamport clock everywhere; client 3 is newest.
  assert.deepEqual(r[0].root(), [p, q, x]);
});

test("concurrent moves that would form a cycle: the older move stands", () => {
  const a = newDoc(1);
  const b = newDoc(2);
  const x = a.insertBlock({ type: "paragraph", text: "x" });
  const y = a.insertBlock({ type: "paragraph", text: "y" });
  syncAll(a, b);
  a.moveBlock(x, { parent: y }); // older (client 1)
  b.moveBlock(y, { parent: x }); // newer, but would put y under its own child
  syncAll(a, b);
  for (const d of [a, b]) {
    checkInvariants(d);
    assert.deepEqual(d.root(), [y]);
    assert.deepEqual(d.children(y), [x]);
  }
  assert.deepEqual(a.toJSON(), b.toJSON());
});

test("a three-way cycle resolves deterministically", () => {
  const r = [newDoc(1), newDoc(2), newDoc(3)];
  const [x, y, z] = ["x", "y", "z"].map((t) => r[0].insertBlock({ type: "paragraph", text: t }));
  syncAll(...r);
  r[0].moveBlock(x, { parent: y });
  r[1].moveBlock(y, { parent: z });
  r[2].moveBlock(z, { parent: x });
  syncAll(...r);
  for (const d of r) {
    checkInvariants(d);
    assert.deepEqual(d.toJSON(), r[0].toJSON());
    assert.equal(d.visibleBlockIds().length, 3);
  }
});

test("delete and concurrent move: the block stays deleted", () => {
  const a = newDoc(1);
  const b = newDoc(2);
  const x = a.insertBlock({ type: "paragraph" });
  const p = a.insertBlock({ type: "paragraph" });
  syncAll(a, b);
  a.deleteBlock(x);
  b.moveBlock(x, { parent: p });
  syncAll(a, b);
  assert.equal(a.isVisible(x), false);
  assert.deepEqual(a.toJSON(), b.toJSON());
});

test("insert into a block another replica deleted: hidden, but converges", () => {
  const a = newDoc(1);
  const b = newDoc(2);
  const p = a.insertBlock({ type: "toggle" });
  syncAll(a, b);
  a.deleteBlock(p);
  const child = b.insertBlock({ type: "paragraph", parent: p, text: "hi" });
  b.insertText(p, 0, "title");
  syncAll(a, b);
  assert.equal(a.isVisible(child), false);
  assert.equal(a.getText(child), "hi");
  assert.deepEqual(a.toJSON(), { meta: {}, blocks: {}, root: [] });
  assert.deepEqual(a.toJSON(), b.toJSON());
});

test("transact groups ops into one event with changed block ids", () => {
  const doc = newDoc();
  const p = doc.insertBlock({ type: "paragraph", text: "abc" });
  const q = doc.insertBlock({ type: "paragraph" });
  /** @type {import("./doc.js").DocEvent[]} */
  const events = [];
  doc.observe((e) => events.push(e));
  doc.transact(() => {
    doc.insertText(p, 3, "d");
    doc.format(p, 0, 1, "bold", true);
    doc.setAttr(q, "level", 2);
  }, "typing");
  assert.equal(events.length, 1);
  assert.equal(events[0].origin, "typing");
  assert.equal(events[0].local, true);
  assert.deepEqual([...events[0].changedBlockIds].sort(), [p, q].sort());
  assert.equal(events[0].structureChanged, false);
  assert.ok(events[0].update instanceof Uint8Array);

  doc.transact(() => {
    const r = doc.insertBlock({ type: "paragraph" });
    doc.insertBlock({ type: "paragraph", after: r }); // sees the block from the same transaction
  });
  assert.equal(events.length, 2);
  assert.equal(events[1].structureChanged, true);

  // Remote: one event per applyUpdate, with the given origin.
  const other = newDoc(2);
  /** @type {import("./doc.js").DocEvent[]} */
  const remote = [];
  other.observe((e) => remote.push(e));
  other.applyUpdate(doc.encodeDiff(), "ws");
  assert.equal(remote.length, 1);
  assert.equal(remote[0].origin, "ws");
  assert.equal(remote[0].local, false);
  assert.equal(remote[0].structureChanged, true);
  // A duplicate changes nothing, so it's silent.
  other.applyUpdate(doc.encodeDiff(), "ws");
  assert.equal(remote.length, 1);
});

test("an exception inside transact keeps the ops made so far", () => {
  const doc = newDoc();
  const p = doc.insertBlock({ type: "paragraph" });
  assert.throws(
    () =>
      doc.transact(() => {
        doc.insertText(p, 0, "kept");
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.equal(doc.getText(p), "kept");
  const other = newDoc(2);
  other.applyUpdate(doc.encodeDiff());
  assert.equal(other.getText(p), "kept");
});

test("toJSON has the documented shape", () => {
  const doc = newDoc(1);
  doc.setMeta("title", "Leaf");
  const h = doc.insertBlock({
    type: "heading",
    attrs: { level: 1 },
    text: "Title",
    marks: { bold: true },
  });
  const li = doc.insertBlock({ type: "bulleted", parent: h, text: "item" });
  assert.deepEqual(doc.toJSON(), {
    meta: { title: "Leaf" },
    root: [h],
    blocks: {
      [h]: {
        id: h,
        type: "heading",
        attrs: { level: 1 },
        text: [{ text: "Title", marks: { bold: true } }],
        children: [li],
      },
      [li]: { id: li, type: "bulleted", attrs: {}, text: [{ text: "item" }], children: [] },
    },
  });
});

test("the Lamport clock moves past everything seen", () => {
  const a = newDoc(1);
  const b = newDoc(2);
  for (let i = 0; i < 10; i++) a.insertBlock({ type: "paragraph" });
  b.applyUpdate(a.encodeDiff());
  assert.equal(b.clock, a.clock);
  const before = b.clock;
  b.insertBlock({ type: "paragraph" });
  assert.ok(b.clock > before);
});
