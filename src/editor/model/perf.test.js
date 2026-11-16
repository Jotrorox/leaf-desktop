// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrng } from "../../lib/prng.js";
import { Doc } from "./doc.js";

/**
 * Size and speed with 100k characters. Bounds are loose (they guard against
 * accidental quadratic behaviour, not small regressions); the numbers are
 * printed.
 */

/** @template T @param {() => T} fn @returns {[T, number]} */
function timed(fn) {
  const t0 = performance.now();
  const out = fn();
  return [out, Math.round((performance.now() - t0) * 10) / 10];
}

/**
 * Load `snapshot` on a fresh replica, let a peer make `edits` random edits,
 * and apply their diff to the loaded replica.
 *
 * @param {Uint8Array} snapshot @param {number} edits @param {number} seed
 */
function loadAndApplyDiff(snapshot, edits, seed) {
  const [doc, loadMs] = timed(() => Doc.fromSnapshot(snapshot, { clientId: 50 }));
  const peer = Doc.fromSnapshot(snapshot, { clientId: 51 });
  const sv = peer.stateVector();
  const rng = createPrng(seed);
  const blocks = peer.visibleBlockIds();
  const [, editMs] = timed(() => {
    for (let i = 0; i < edits; i++) {
      const b = rng.pick(blocks);
      const len = peer.textLength(b);
      const r = rng.next();
      if (r < 0.6) peer.insertText(b, rng.int(len + 1), "edit ");
      else if (r < 0.8 && len > 10) peer.deleteText(b, rng.int(len - 10), 3);
      else if (len > 10) peer.format(b, rng.int(len - 10), 5, "bold", true);
    }
  });
  const [diff, diffMs] = timed(() => peer.encodeDiff(sv));
  const [, applyMs] = timed(() => doc.applyUpdate(diff));
  assert.deepEqual(doc.toJSON(), peer.toJSON());
  return { loadMs, editMs, diffBytes: diff.length, diffMs, applyMs };
}

test("perf: one block of 100k characters", () => {
  const doc = new Doc({ clientId: 1 });
  const p = doc.insertBlock({ type: "paragraph" });
  // Typed at the end in 5-character transactions: 20k transactions.
  const [, typeMs] = timed(() => {
    for (let i = 0; i < 20_000; i++) doc.insertText(p, doc.textLength(p), "abcd ");
  });
  assert.equal(doc.textLength(p), 100_000);
  // 2000 single-character inserts at random offsets (no position cache help).
  const rng = createPrng(5);
  const [, randomMs] = timed(() => {
    for (let i = 0; i < 2000; i++) doc.insertText(p, rng.int(doc.textLength(p) + 1), "x");
  });
  doc.format(p, 0, 50_000, "bold", true);
  const [, textMs] = timed(() => doc.getText(p));
  const [, runsMs] = timed(() => doc.getTextRuns(p));
  const [snapshot, snapshotMs] = timed(() => doc.encodeSnapshot());
  const result = loadAndApplyDiff(snapshot, 1000, 9);
  console.log(
    `perf one block: type 100k chars (20k txns) ${typeMs} ms, 2000 random inserts ${randomMs} ms, ` +
      `getText ${textMs} ms, getTextRuns ${runsMs} ms, snapshot ${snapshot.length} bytes in ${snapshotMs} ms, ` +
      `load ${result.loadMs} ms, peer's 1000 edits ${result.editMs} ms, diff ${result.diffBytes} bytes in ${result.diffMs} ms, ` +
      `apply diff ${result.applyMs} ms`,
  );
  assert.ok(result.loadMs < 5000, `load took ${result.loadMs} ms`);
  assert.ok(result.applyMs < 2000, `apply took ${result.applyMs} ms`);
  assert.ok(typeMs < 5000, `typing took ${typeMs} ms`);
});

test("perf: 1000 blocks of 100 characters", () => {
  const doc = new Doc({ clientId: 1 });
  const [, buildMs] = timed(() => {
    let after = null;
    for (let i = 0; i < 1000; i++) {
      const id = doc.insertBlock({ type: "paragraph", after });
      for (let j = 0; j < 10; j++) doc.insertText(id, doc.textLength(id), "word word ");
      after = id;
    }
  });
  const [json, jsonMs] = timed(() => doc.toJSON());
  assert.equal(Object.keys(json.blocks).length, 1000);
  const [snapshot, snapshotMs] = timed(() => doc.encodeSnapshot());
  const result = loadAndApplyDiff(snapshot, 1000, 10);
  console.log(
    `perf 1000 blocks: build ${buildMs} ms (11k txns), toJSON ${jsonMs} ms, snapshot ${snapshot.length} bytes in ${snapshotMs} ms, ` +
      `load ${result.loadMs} ms, peer's 1000 edits ${result.editMs} ms, diff ${result.diffBytes} bytes in ${result.diffMs} ms, ` +
      `apply diff ${result.applyMs} ms`,
  );
  assert.ok(result.loadMs < 5000, `load took ${result.loadMs} ms`);
  assert.ok(result.applyMs < 2000, `apply took ${result.applyMs} ms`);
});
