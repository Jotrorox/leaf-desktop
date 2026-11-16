// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { Doc } from "../model/doc.js";
import { createTextSync, docFiles, docText } from "./text.js";

/** @param {Doc} doc @param {string | null} parent @param {string} type @param {string} text */
function add(doc, parent, type, text) {
  return doc.insertBlock({
    type,
    parent,
    after: doc.children(parent).at(-1) ?? null,
    text: text || undefined,
  });
}

test("docText is every block's text in reading order, nested ones included", () => {
  const doc = new Doc({ clientId: 1 });
  const first = add(doc, null, "h1", "Plan");
  add(doc, first, "p", "  nested  ");
  add(doc, null, "divider", "");
  add(doc, null, "todo", "Ship it");
  assert.equal(docText(doc), "Plan\nnested\nShip it");
});

test("docFiles is every visible image's uploaded file, nested ones included", () => {
  const doc = new Doc({ clientId: 1 });
  let parent = add(doc, null, "p", "top");
  // Deeper than docText looks: a file missed here would be deleted.
  for (let i = 0; i < 80; i++) parent = add(doc, parent, "p", "");
  doc.insertBlock({ type: "image", parent, attrs: { file: "deep" } });
  doc.insertBlock({ type: "image", attrs: { file: "b" } });
  doc.insertBlock({ type: "image", attrs: { file: "b" } });
  doc.insertBlock({ type: "image", attrs: { src: "https://api.example.com/v1/files/pasted?x=1" } });
  doc.insertBlock({ type: "image", attrs: { src: "https://example.com/cat.png" } });
  const gone = doc.insertBlock({ type: "image", attrs: { file: "gone" } });
  doc.deleteBlock(gone);
  assert.deepEqual(docFiles(doc), ["b", "deep", "pasted"]);
});

test("the report goes out once on open and after changes settle, never twice the same", async () => {
  const doc = new Doc({ clientId: 1 });
  add(doc, null, "p", "Hello");
  doc.insertBlock({ type: "image", attrs: { file: "f1" } });
  /** @type {import("./text.js").DocReport[]} */
  const sent = [];
  /** @type {(() => void)[]} */
  let timers = [];
  const sync = createTextSync({
    doc,
    send: async (report) => void sent.push(report),
    setTimer: (fn) => (timers.push(fn), fn),
    clearTimer: (fn) => (timers = timers.filter((t) => t !== fn)),
  });
  timers.forEach((fn) => fn());
  assert.deepEqual(
    sent.map((r) => [r.text, r.files]),
    [["Hello", ["f1"]]],
  );
  assert.deepEqual([...Buffer.from(sent[0].state, "base64")], [...doc.encodeStateVector()]);
  add(doc, null, "p", "World");
  assert.equal(sent.length, 1, "debounced");
  timers.forEach((fn) => fn());
  assert.deepEqual(
    sent.map((r) => r.text),
    ["Hello", "Hello\nWorld"],
  );
  // A change that leaves the text and the files as they were still goes
  // out: the document they were read from changed.
  doc.setAttr(doc.children(null)[0], "color", "red");
  sync.flush();
  assert.equal(sent.length, 3);
  assert.notEqual(sent[2].state, sent[1].state);
  // Nothing changed: nothing goes out.
  sync.flush();
  sync.destroy();
  assert.equal(sent.length, 3);
});
