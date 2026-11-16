// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrng } from "../../lib/prng.js";
import { Doc } from "./doc.js";
import { checkInvariants, randomLocalEdit, syncAll } from "./test-helpers.js";
import { UndoManager } from "./undo.js";

function setup(clientId = 1) {
  const clock = { now: 0 };
  const doc = new Doc({ clientId });
  const um = new UndoManager(doc, { now: () => clock.now });
  return { doc, um, clock };
}

test("changes within the capture timeout form one step", () => {
  const { doc, um, clock } = setup();
  const p = doc.insertBlock({ type: "paragraph" });
  clock.now = 1000;
  for (const ch of "hello") {
    doc.insertText(p, doc.textLength(p), ch);
    clock.now += 100;
  }
  clock.now += 1000;
  doc.insertText(p, 5, "!");
  assert.equal(um.undo(), true);
  assert.equal(doc.getText(p), "hello");
  assert.equal(um.undo(), true);
  assert.equal(doc.getText(p), "");
  assert.equal(um.undo(), true);
  assert.deepEqual(doc.root(), []);
  assert.equal(um.undo(), false);
  um.redo();
  um.redo();
  assert.equal(doc.getText(p), "hello");
  um.redo();
  assert.equal(doc.getText(p), "hello!");
  assert.equal(um.redo(), false);
});

test("stopCapturing and a custom timeout split steps", () => {
  const clock = { now: 0 };
  const doc = new Doc({ clientId: 1 });
  const um = new UndoManager(doc, { captureTimeout: 50, now: () => clock.now });
  const p = doc.insertBlock({ type: "paragraph" });
  um.stopCapturing();
  doc.insertText(p, 0, "a");
  clock.now = 49;
  doc.insertText(p, 1, "b");
  clock.now = 100;
  doc.insertText(p, 2, "c");
  um.undo();
  assert.equal(doc.getText(p), "ab");
  um.undo();
  assert.equal(doc.getText(p), "");
});

test("a new change clears the redo stack", () => {
  const { doc, um, clock } = setup();
  const p = doc.insertBlock({ type: "paragraph", text: "a" });
  clock.now = 1000;
  doc.insertText(p, 1, "b");
  um.undo();
  assert.ok(um.canRedo());
  clock.now = 2000;
  doc.insertText(p, 1, "c");
  assert.ok(!um.canRedo());
});

test("only tracked origins are recorded; remote changes never are", () => {
  const clock = { now: 0 };
  const a = new Doc({ clientId: 1 });
  const b = new Doc({ clientId: 2 });
  const um = new UndoManager(a, { trackedOrigins: ["user"], now: () => clock.now });
  /** @type {string} */
  let p = "";
  a.transact(() => (p = a.insertBlock({ type: "paragraph", text: "x" })), "user");
  clock.now = 1000;
  a.transact(() => a.insertText(p, 1, "-programmatic"), "system");
  syncAll(a, b);
  b.insertText(p, 0, "remote ");
  syncAll(a, b);
  assert.equal(um.undo(), true);
  assert.equal(a.isVisible(p), false);
  assert.equal(um.undo(), false);
  um.redo();
  assert.equal(a.getText(p), "remote x-programmatic");
});

test("undo never reverts other people's edits", () => {
  const { doc: a, um, clock } = setup(1);
  const b = new Doc({ clientId: 2 });
  const p = a.insertBlock({ type: "paragraph", text: "abc" });
  syncAll(a, b);
  clock.now = 1000;
  a.insertText(p, 3, "def");
  a.format(p, 0, 3, "bold", true);
  a.setAttr(p, "color", "red");
  syncAll(a, b);
  // Remote edits on top of ours: overwrite color, unbold "b", type inside our text.
  b.setAttr(p, "color", "blue");
  b.format(p, 1, 1, "bold", null);
  b.insertText(p, 4, "X");
  syncAll(a, b);
  um.undo();
  syncAll(a, b);
  assert.equal(a.getText(p), "abcX");
  assert.deepEqual(a.getAttrs(p), { color: "blue" });
  assert.deepEqual(a.getTextRuns(p), [{ text: "abcX" }]);
  um.redo();
  syncAll(a, b);
  assert.equal(b.getText(p), "abcdXef");
  assert.deepEqual(b.getTextRuns(p)[0], { text: "a", marks: { bold: true } });
  assert.deepEqual(b.getAttrs(p), { color: "blue" });
});

test("a register overwritten remotely between two local steps stays remote", () => {
  const { doc: a, um, clock } = setup(1);
  const b = new Doc({ clientId: 2 });
  a.setMeta("x", 1);
  syncAll(a, b);
  b.setMeta("x", 2);
  syncAll(a, b);
  clock.now = 1000;
  a.setMeta("x", 3);
  um.undo();
  assert.equal(a.getMeta("x"), 2);
  assert.equal(um.undo(), false, "step 1 was superseded by the remote write");
  assert.equal(a.getMeta("x"), 2);
});

test("undo restores deleted text with its marks, in place", () => {
  const { doc, um, clock } = setup();
  const p = doc.insertBlock({ type: "paragraph", text: "hello brave new world" });
  doc.format(p, 6, 5, "bold", true);
  doc.format(p, 0, 5, "link", "https://leaf.test");
  const before = doc.toJSON();
  clock.now = 1000;
  doc.deleteText(p, 3, 12);
  doc.deleteText(p, 0, 2);
  um.undo();
  assert.deepEqual(doc.toJSON(), before);
  um.redo();
  assert.equal(doc.getText(p), "l world");
  um.undo();
  assert.deepEqual(doc.toJSON(), before);
});

test("typing then deleting part of it in one step undoes cleanly", () => {
  const { doc, um, clock } = setup();
  const p = doc.insertBlock({ type: "paragraph", text: "_" });
  clock.now = 1000;
  doc.insertText(p, 1, "ac");
  doc.insertText(p, 2, "b"); // between a and c
  doc.deleteText(p, 1, 1); // the a
  assert.equal(doc.getText(p), "_bc");
  um.undo();
  assert.equal(doc.getText(p), "_");
  um.redo();
  assert.equal(doc.getText(p), "_bc");
  um.undo();
  um.redo();
  assert.equal(doc.getText(p), "_bc");
});

test("moves undo to the exact previous position, and not after a remote move", () => {
  const { doc: a, um, clock } = setup(1);
  const ids = ["1", "2", "3", "4"].map((t) => a.insertBlock({ type: "paragraph", text: t }));
  const b = new Doc({ clientId: 2 });
  syncAll(a, b);
  clock.now = 1000;
  a.moveBlock(ids[1], { parent: ids[3] });
  clock.now = 2000;
  a.moveBlock(ids[1], { parent: null, after: null });
  assert.deepEqual(a.root(), [ids[1], ids[0], ids[2], ids[3]]);
  um.undo();
  assert.deepEqual(a.children(ids[3]), [ids[1]]);
  um.undo();
  assert.deepEqual(a.root(), ids);
  um.redo();
  um.redo();
  assert.deepEqual(a.root(), [ids[1], ids[0], ids[2], ids[3]]);

  // A remote move after ours: our undo leaves it alone.
  clock.now = 3000;
  a.moveBlock(ids[2], { parent: ids[0] });
  syncAll(a, b);
  b.moveBlock(ids[2], { parent: null });
  syncAll(a, b);
  um.undo();
  syncAll(a, b);
  assert.equal(a.parentOf(ids[2]), null);
  assert.equal(a.root().at(-1), ids[2]);
});

test("block delete and create undo with their whole subtree", () => {
  const { doc, um, clock } = setup();
  const p = doc.insertBlock({ type: "toggle", text: "parent" });
  doc.insertBlock({ type: "paragraph", parent: p, text: "child" });
  const before = doc.toJSON();
  clock.now = 1000;
  doc.deleteBlock(p);
  assert.deepEqual(doc.toJSON().root, []);
  um.undo();
  assert.deepEqual(doc.toJSON(), before);
  um.undo();
  assert.deepEqual(doc.toJSON(), { meta: {}, blocks: {}, root: [] });
  um.redo();
  assert.deepEqual(doc.toJSON(), before);
});

test("stack items carry meta, and observers hear about steps", () => {
  const { doc, um } = setup();
  /** @type {string[]} */
  const seen = [];
  um.observe((e) => {
    seen.push(e.type);
    if (e.type === "added") e.item.meta.set("selection", 0);
  });
  doc.insertBlock({ type: "paragraph" });
  doc.setMeta("a", 1);
  um.undo();
  assert.deepEqual(seen, ["added", "updated", "undo"]);
});

/**
 * Random local edits grouped into steps; undo all of them checking each
 * previous state exactly, then redo all checking each again, twice over.
 */
test("undo and redo restore exact states (seeded random steps)", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const rng = createPrng(seed);
    const { doc, um, clock } = setup(1);
    let added = 0;
    um.observe((e) => e.type === "added" && added++);
    // states[i] is the state after undo step i (some steps change nothing
    // visible, e.g. a move to where the block already is).
    const states = [JSON.stringify(doc.toJSON())];
    for (let step = 0; step < 150; step++) {
      clock.now += 1000;
      const before = added;
      const n = 1 + rng.int(3);
      for (let i = 0; i < n; i++) {
        randomLocalEdit(doc, rng);
        clock.now += 10;
      }
      assert.ok(added - before <= 1);
      if (added > before) states.push(JSON.stringify(doc.toJSON()));
    }
    for (let round = 0; round < 2; round++) {
      for (let i = states.length - 1; i > 0; i--) {
        assert.equal(um.undo(), true, `seed ${seed}: undo to state ${i - 1}`);
        assert.equal(
          JSON.stringify(doc.toJSON()),
          states[i - 1],
          `seed ${seed}: undo to state ${i - 1}`,
        );
        checkInvariants(doc);
      }
      assert.equal(um.undo(), false);
      for (let i = 1; i < states.length; i++) {
        assert.equal(um.redo(), true, `seed ${seed}: redo ${i}`);
        assert.equal(JSON.stringify(doc.toJSON()), states[i], `seed ${seed}: redo to state ${i}`);
      }
      assert.equal(um.redo(), false);
    }
  }
});

test("undo restores exact states of one's own blocks while a peer edits others", () => {
  for (const seed of [11, 12, 13]) {
    const rng = createPrng(seed);
    const { doc: a, um, clock } = setup(1);
    const b = new Doc({ clientId: 2 });
    const mine = a.insertBlock({ type: "paragraph", text: "mine" });
    const theirs = a.insertBlock({ type: "paragraph", text: "theirs" });
    syncAll(a, b);
    um.clear();
    const states = [JSON.stringify(a.getBlock(mine))];
    for (let step = 0; step < 60; step++) {
      clock.now += 1000;
      const len = a.textLength(mine);
      if (len > 0 && rng.next() < 0.4) a.deleteText(mine, rng.int(len), 1);
      else if (len > 0 && rng.next() < 0.3)
        a.format(mine, rng.int(len), 1, "bold", rng.pick([true, null]));
      else a.insertText(mine, rng.int(len + 1), rng.pick(["x", "yz", "😀"]));
      b.insertText(theirs, rng.int(b.textLength(theirs) + 1), "r");
      if (rng.next() < 0.5) syncAll(a, b);
      const s = JSON.stringify(a.getBlock(mine));
      if (s === states[states.length - 1]) um.stopCapturing();
      else states.push(s);
    }
    syncAll(a, b);
    const theirText = a.getText(theirs);
    for (let i = states.length - 1; i > 0; i--) {
      um.undo();
      assert.equal(JSON.stringify(a.getBlock(mine)), states[i - 1], `seed ${seed}: step ${i}`);
    }
    syncAll(a, b);
    assert.equal(b.getText(theirs), theirText, "the peer's text is untouched");
    assert.deepEqual(b.toJSON(), a.toJSON());
  }
});
