// @ts-check
import assert from "node:assert/strict";
import { createPrng } from "../../lib/prng.js";
import { Doc } from "./doc.js";
import { bytesEqual, checkInvariants, randomLocalEdit, syncAll } from "./test-helpers.js";
import { UndoManager } from "./undo.js";

/**
 * The convergence fuzzer behind fuzz.test.js (see there). Not imported by app code.
 *
 * Each run: 3–5 replicas make random edits (text, marks, attrs, type, meta,
 * block insert/delete/move, undo and redo). Every local transaction is
 * broadcast to every peer with a random delay; messages arrive in random
 * order, sometimes twice, sometimes not at all (full state-vector syncs
 * happen now and then, as a reconnect would). A quarter of the edits hit one
 * shared block, and "contention rounds" make every replica write the same
 * registers, marks and offsets with equal Lamport clocks. At the end the
 * network is flushed and every replica must hold identical state.
 */

/**
 * @param {number} seed
 * @param {number} ops
 */
export function runFuzz(seed, ops) {
  const rng = createPrng(seed);
  const n = 3 + rng.int(3);
  const time = { now: 0 };
  /** @type {Set<number>} */
  const ids = new Set();
  while (ids.size < n) ids.add(1 + rng.int(2 ** 40));
  const replicas = [...ids].map((clientId) => {
    const doc = new Doc({ clientId });
    const um = new UndoManager(doc, { now: () => time.now });
    return { doc, um };
  });

  /** @type {{ to: number, bytes: Uint8Array, at: number }[]} */
  let inbox = [];
  const stats = {
    delivered: 0,
    duplicated: 0,
    dropped: 0,
    fullSyncs: 0,
    undos: 0,
    redos: 0,
    maxPending: 0,
    edits: 0,
    contentions: 0,
  };
  /** @type {Record<string, number>} */
  const kinds = {};

  replicas.forEach(({ doc }, from) => {
    doc.observe((e) => {
      const update = e.update;
      if (!e.local || !update) return;
      for (let to = 0; to < replicas.length; to++) {
        if (to === from) continue;
        const r = rng.next();
        if (r < 0.03) {
          stats.dropped++;
          continue;
        }
        inbox.push({ to, bytes: update, at: step + rng.int(40) });
        if (r > 0.9) {
          stats.duplicated++;
          inbox.push({ to, bytes: update, at: step + rng.int(80) });
        }
      }
    });
  });

  let step = 0;
  for (; step < ops; step++) {
    time.now += rng.pick([5, 50, 200, 600, 2000]);
    const i = rng.int(replicas.length);
    const { doc, um } = replicas[i];
    const r = rng.next();
    if (r < 0.06) {
      // Undo a few steps, then often redo some of them.
      for (let k = rng.int(3); k >= 0; k--) if (um.undo()) stats.undos++;
      if (rng.next() < 0.5) for (let k = rng.int(3); k >= 0; k--) if (um.redo()) stats.redos++;
    } else if (r < 0.07) {
      if (um.redo()) stats.redos++;
    } else if (r < 0.08) {
      // A reconnect: full exchange between two replicas.
      const j = rng.int(replicas.length);
      if (j !== i) {
        replicas[j].doc.applyUpdate(doc.encodeDiff(replicas[j].doc.stateVector()));
        doc.applyUpdate(replicas[j].doc.encodeDiff(doc.stateVector()));
        stats.fullSyncs++;
      }
    } else if (r < 0.09) {
      // Contention: bring everyone level, then all write the same things at
      // once. Their ops get equal Lamport clocks, so only the client id
      // breaks the ties.
      const hot = doc.root()[0];
      if (hot) {
        syncAll(...replicas.map((x) => x.doc));
        stats.contentions++;
        replicas.forEach(({ doc: d }, k) => {
          if (!d.isVisible(hot)) return;
          const which = rng.int(4);
          if (which === 0) d.setAttr(hot, "contended", k);
          else if (which === 1) d.setMeta("contended", k);
          else if (which === 2 && d.textLength(hot) > 0)
            d.format(hot, 0, Math.min(3, d.textLength(hot)), "color", `c${k}`);
          else d.insertText(hot, 0, `[${k}]`);
        });
      }
    } else if (r < 0.35) {
      // Everyone edits the first block, so same-spot conflicts are common.
      const hot = doc.root()[0];
      const kind = hot ? hotEdit(doc, hot, rng) : randomLocalEdit(doc, rng);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      stats.edits++;
    } else {
      const kind = randomLocalEdit(doc, rng);
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      stats.edits++;
    }

    // Deliver what's due, in random order.
    const due = inbox.filter((m) => m.at <= step);
    if (due.length) {
      inbox = inbox.filter((m) => m.at > step);
      for (let k = due.length - 1; k > 0; k--) {
        const j = rng.int(k + 1);
        [due[k], due[j]] = [due[j], due[k]];
      }
      for (const m of due) {
        replicas[m.to].doc.applyUpdate(m.bytes);
        stats.delivered++;
      }
    }
    for (const { doc: d } of replicas)
      stats.maxPending = Math.max(stats.maxPending, d.pendingCount);

    if (step % 500 === 0) for (const { doc: d } of replicas) checkInvariants(d);
  }

  // Flush the network (random order), then reconcile what was dropped.
  for (const m of inbox.sort(() => rng.next() - 0.5)) replicas[m.to].doc.applyUpdate(m.bytes);
  const docs = replicas.map((r) => r.doc);
  syncAll(...docs);

  const first = docs[0];
  const json = JSON.stringify(first.toJSON());
  const snap = first.encodeSnapshot();
  for (const d of docs) {
    assert.equal(d.pendingCount, 0, "nothing left waiting");
    checkInvariants(d);
    assert.deepEqual(d.stateVector(), first.stateVector(), "state vectors match");
    const dj = JSON.stringify(d.toJSON());
    if (dj !== json)
      assert.fail(
        `replica ${d.clientId} differs from ${first.clientId}: ${describeDifference(first.toJSON(), d.toJSON())}`,
      );
    assert.ok(bytesEqual(d.encodeSnapshot(), snap), "snapshots are byte-identical");
  }
  // A fresh replica loading the snapshot agrees too.
  const loaded = Doc.fromSnapshot(snap);
  assert.equal(JSON.stringify(loaded.toJSON()), json, "a loaded snapshot matches");

  const final = first.toJSON();
  return {
    replicas: n,
    ...stats,
    kinds,
    blocks: Object.keys(final.blocks).length,
    chars: Object.values(final.blocks).reduce(
      (s, b) => s + b.text.reduce((t, r) => t + r.text.length, 0),
      0,
    ),
    snapshotBytes: snap.length,
  };
}

/**
 * The first difference between two materialized docs, for failure messages.
 *
 * @param {import("./doc.js").DocJSON} a @param {import("./doc.js").DocJSON} b
 */
function describeDifference(a, b) {
  if (JSON.stringify(a.meta) !== JSON.stringify(b.meta))
    return `meta ${JSON.stringify(a.meta)} vs ${JSON.stringify(b.meta)}`;
  if (JSON.stringify(a.root) !== JSON.stringify(b.root))
    return `root ${JSON.stringify(a.root)} vs ${JSON.stringify(b.root)}`;
  for (const id of new Set([...Object.keys(a.blocks), ...Object.keys(b.blocks)])) {
    const x = JSON.stringify(a.blocks[id]);
    const y = JSON.stringify(b.blocks[id]);
    if (x !== y) return `block ${id}: ${x} vs ${y}`;
  }
  return "key order only";
}

/**
 * Typing, deleting and formatting in one block, with a bias towards its
 * start and end where concurrent typing piles up.
 *
 * @param {Doc} doc @param {string} block @param {ReturnType<typeof createPrng>} rng
 */
function hotEdit(doc, block, rng) {
  const len = doc.textLength(block);
  const at = () => rng.pick([0, len, rng.int(len + 1)]);
  const r = rng.next();
  if (r < 0.6 || len === 0) {
    doc.insertText(
      block,
      at(),
      rng.pick(["a", "bb", "ccc", "😀", "Wort "]),
      rng.next() < 0.2 ? { italic: true } : null,
    );
    return "hotInsert";
  }
  const off = rng.int(len);
  if (r < 0.85) {
    doc.deleteText(block, off, 1 + rng.int(Math.min(4, len - off)));
    return "hotDelete";
  }
  doc.format(
    block,
    off,
    1 + rng.int(len - off),
    rng.pick(["bold", "code", "color"]),
    rng.pick([true, "red", null]),
  );
  return "hotFormat";
}
