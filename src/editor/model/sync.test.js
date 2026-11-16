// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrng } from "../../lib/prng.js";
import { Doc } from "./doc.js";
import { bytesEqual, syncAll } from "./test-helpers.js";
import {
  decodeStateVector,
  decodeTxns,
  encodeStateVector,
  encodeTxns,
  KIND_SNAPSHOT,
  KIND_UPDATE,
} from "./update.js";

/** A doc exercising every op type and value type. */
function sampleDoc() {
  const doc = new Doc({ clientId: 2 ** 40 + 7 });
  doc.setMeta("title", "Sample");
  doc.setMeta("cover", { url: "https://x.test/c.png", offset: -0.25 });
  const h = doc.insertBlock({
    type: "heading",
    attrs: { level: 1 },
    text: "Hello 😀",
    marks: { bold: true },
  });
  const t = doc.insertBlock({ type: "todo", parent: h, text: "buy milk" });
  doc.format(t, 4, 4, "mention", { type: "page", id: "p_1" });
  doc.setAttr(t, "checked", true);
  doc.deleteText(h, 0, 1);
  const x = doc.insertBlock({ type: "paragraph", after: null });
  doc.moveBlock(x, { parent: h, after: t });
  doc.deleteBlock(t);
  doc.setType(h, "heading2");
  return doc;
}

test("state vectors round-trip and skip zero entries", () => {
  const sv = new Map([
    [5, 10],
    [1, 3],
    [2 ** 51, 2 ** 50],
    [9, 0],
  ]);
  const back = decodeStateVector(encodeStateVector(sv));
  assert.deepEqual(
    [...back],
    [
      [1, 3],
      [5, 10],
      [2 ** 51, 2 ** 50],
    ],
  );
  assert.throws(() => decodeStateVector(new Uint8Array([1, 1, 0])), /not a state vector/);
});

test("updates decode and re-encode to identical bytes", () => {
  const doc = sampleDoc();
  const bytes = doc.encodeDiff();
  const { kind, txns } = decodeTxns(bytes);
  assert.equal(kind, KIND_UPDATE);
  assert.ok(bytesEqual(encodeTxns(txns, KIND_UPDATE), bytes));
  const snap = doc.encodeSnapshot();
  assert.equal(decodeTxns(snap).kind, KIND_SNAPSHOT);
  assert.ok(bytesEqual(encodeTxns(decodeTxns(snap).txns, KIND_SNAPSHOT), snap));
});

test("snapshot round-trip gives the same state and the same snapshot bytes", () => {
  const doc = sampleDoc();
  const snap = doc.encodeSnapshot();
  const loaded = Doc.fromSnapshot(snap, { clientId: 99 });
  assert.deepEqual(loaded.toJSON(), doc.toJSON());
  assert.deepEqual(loaded.stateVector(), doc.stateVector());
  assert.ok(bytesEqual(loaded.encodeSnapshot(), snap));
  // The loaded replica keeps editing and syncing normally.
  const h = loaded.root()[0];
  loaded.insertText(h, 0, "¡");
  doc.applyUpdate(loaded.encodeDiff(doc.stateVector()));
  assert.deepEqual(doc.toJSON(), loaded.toJSON());
});

test("an incomplete snapshot is rejected", () => {
  const a = new Doc({ clientId: 1 });
  const p = a.insertBlock({ type: "paragraph" });
  const sv = a.stateVector();
  a.insertText(p, 0, "x");
  const partial = decodeTxns(a.encodeDiff(sv)).txns;
  assert.throws(() => Doc.fromSnapshot(encodeTxns(partial, KIND_SNAPSHOT)), /incomplete/);
});

test("encodeDiff sends only what the peer is missing", () => {
  const a = new Doc({ clientId: 1 });
  const b = new Doc({ clientId: 2 });
  const p = a.insertBlock({ type: "paragraph", text: "one" });
  syncAll(a, b);
  a.insertText(p, 3, " two");
  b.insertText(p, 0, "zero ");
  const diff = a.encodeDiff(b.encodeStateVector());
  const { txns } = decodeTxns(diff);
  assert.equal(txns.length, 1);
  assert.equal(txns[0].client, 1);
  b.applyUpdate(diff);
  a.applyUpdate(b.encodeDiff(a.stateVector()));
  assert.equal(a.getText(p), "zero one two");
  assert.deepEqual(a.toJSON(), b.toJSON());
  // Nothing left to send.
  assert.equal(decodeTxns(a.encodeDiff(b.stateVector())).txns.length, 0);
});

test("applyUpdate is idempotent", () => {
  const a = sampleDoc();
  const b = new Doc({ clientId: 3 });
  const bytes = a.encodeDiff();
  b.applyUpdate(bytes);
  const once = b.toJSON();
  const snap = b.encodeSnapshot();
  b.applyUpdate(bytes);
  b.applyUpdate(bytes);
  assert.deepEqual(b.toJSON(), once);
  assert.ok(bytesEqual(b.encodeSnapshot(), snap));
});

test("out-of-order transactions wait for their predecessors and dependencies", () => {
  const a = new Doc({ clientId: 1 });
  const b = new Doc({ clientId: 2 });
  /** @type {Uint8Array[]} */
  const updates = [];
  a.observe((e) => e.update && updates.push(e.update));
  b.observe((e) => e.update && updates.push(e.update));
  const p = a.insertBlock({ type: "paragraph", text: "abc" });
  b.applyUpdate(updates[0]);
  b.insertText(p, 3, "d"); // depends on a's first transaction
  a.applyUpdate(updates[1]);
  a.format(p, 0, 4, "bold", true); // depends on b's
  a.insertText(p, 4, "e");
  const all = [...updates];
  assert.equal(all.length, 4);

  const rng = createPrng(3);
  for (let trial = 0; trial < 30; trial++) {
    const c = new Doc({ clientId: 3 });
    const shuffled = [...all, ...all].sort(() => rng.next() - 0.5);
    for (const u of shuffled) c.applyUpdate(u);
    assert.equal(c.pendingCount, 0);
    assert.deepEqual(c.toJSON(), a.toJSON());
  }

  // Only the last update: it waits, and nothing is visible.
  const d = new Doc({ clientId: 4 });
  d.applyUpdate(all[3]);
  assert.equal(d.pendingCount, 1);
  assert.deepEqual(d.toJSON(), { meta: {}, blocks: {}, root: [] });
  for (const u of all.slice(0, 3).reverse()) d.applyUpdate(u);
  assert.equal(d.pendingCount, 0);
  assert.deepEqual(d.toJSON(), a.toJSON());
});

test("a transaction applies atomically: no half-created block is ever visible", () => {
  const a = new Doc({ clientId: 1 });
  const b = new Doc({ clientId: 2 });
  const p = a.insertBlock({ type: "paragraph", text: "x" });
  syncAll(a, b);
  const sv = a.stateVector();
  // One transaction: create a block after p, with text. Its INSERT depends on p.
  a.transact(() => a.insertBlock({ type: "paragraph", after: p, text: "y" }));
  const c = new Doc({ clientId: 3 });
  c.applyUpdate(a.encodeDiff(sv)); // without p's transaction
  assert.equal(c.pendingCount, 1);
  assert.deepEqual(c.visibleBlockIds(), []);
  c.applyUpdate(a.encodeDiff(new Map()));
  assert.deepEqual(c.toJSON(), a.toJSON());
});

test("malformed bytes throw and change nothing", () => {
  const doc = sampleDoc();
  const good = doc.encodeDiff();
  const target = new Doc({ clientId: 5 });
  const bad = [
    new Uint8Array([]),
    new Uint8Array([2, 1]), // version
    new Uint8Array([1, 9]), // kind
    good.slice(0, good.length - 1), // truncated
    new Uint8Array([...good, 0]), // trailing
  ];
  for (const bytes of bad) assert.throws(() => target.applyUpdate(bytes), RangeError);
  assert.deepEqual(target.stateVector(), new Map());
  // Random corruption must only ever throw RangeError/TypeError, and never
  // leave the doc unreadable.
  const rng = createPrng(11);
  for (let i = 0; i < 300; i++) {
    const copy = good.slice();
    copy[rng.int(copy.length)] = rng.int(256);
    const d = new Doc({ clientId: 6 });
    try {
      d.applyUpdate(copy);
    } catch (err) {
      assert.ok(err instanceof RangeError || err instanceof TypeError, String(err));
    }
    d.toJSON();
  }
});

test("updates from many clients merge in any order to identical snapshots", () => {
  const rng = createPrng(21);
  const docs = [1, 2, 3].map((clientId) => new Doc({ clientId }));
  const p = docs[0].insertBlock({ type: "paragraph", text: "seed" });
  syncAll(...docs);
  /** @type {Uint8Array[]} */
  const updates = [];
  for (const d of docs) d.observe((e) => e.update && updates.push(e.update));
  for (let i = 0; i < 60; i++) {
    const d = docs[rng.int(3)];
    const len = d.textLength(p);
    if (rng.next() < 0.6 || len === 0) d.insertText(p, rng.int(len + 1), "xyz"[rng.int(3)]);
    else d.deleteText(p, rng.int(len), 1);
  }
  const replicas = [4, 5].map((clientId) => new Doc({ clientId }));
  for (const r of replicas) {
    r.applyUpdate(docs[0].encodeSnapshot());
    for (const u of [...updates].sort(() => rng.next() - 0.5)) r.applyUpdate(u);
  }
  syncAll(...docs);
  for (const r of replicas) {
    assert.equal(r.pendingCount, 0);
    assert.ok(bytesEqual(r.encodeSnapshot(), docs[0].encodeSnapshot()));
  }
});
