// @ts-check

/** Helpers shared by the model's tests. Not imported by app code. */

/** @typedef {import("./doc.js").Doc} Doc */

/**
 * Exchange everything both ways until neither has anything new.
 *
 * @param {Doc[]} docs
 */
export function syncAll(...docs) {
  for (let round = 0; round < 3; round++) {
    for (const a of docs)
      for (const b of docs) if (a !== b) b.applyUpdate(a.encodeDiff(b.stateVector()));
  }
}

/** @param {Uint8Array} a @param {Uint8Array} b */
export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Structural invariants of a materialized doc: each visible block is reached
 * exactly once from the root, children point at existing visible blocks,
 * runs join to the text. Throws on violation.
 *
 * @param {Doc} doc
 */
export function checkInvariants(doc) {
  const json = doc.toJSON();
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string[]} ids @param {string | null} parent */
  const walk = (ids, parent) => {
    for (const id of ids) {
      if (seen.has(id)) throw new Error(`block ${id} appears twice`);
      seen.add(id);
      const b = json.blocks[id];
      if (!b) throw new Error(`child ${id} has no entry in blocks`);
      if (doc.parentOf(id) !== parent)
        throw new Error(`parentOf(${id}) is ${doc.parentOf(id)}, expected ${parent}`);
      if (!doc.isVisible(id)) throw new Error(`${id} listed but not visible`);
      const text = b.text.map((r) => r.text).join("");
      if (text !== doc.getText(id)) throw new Error(`runs of ${id} don't join to its text`);
      if (text.length !== doc.textLength(id)) throw new Error(`textLength(${id}) is wrong`);
      for (let i = 1; i < b.text.length; i++) {
        if (JSON.stringify(b.text[i - 1].marks) === JSON.stringify(b.text[i].marks))
          throw new Error(`adjacent runs in ${id} have equal marks`);
      }
      walk(b.children, id);
    }
  };
  walk(json.root, null);
  if (seen.size !== Object.keys(json.blocks).length)
    throw new Error("blocks has entries not reachable from the root");
}

/**
 * One random local edit of any kind, valid for the doc's current state.
 * Returns a short name of what it did.
 *
 * @param {Doc} doc
 * @param {ReturnType<typeof import("../../lib/prng.js").createPrng>} rng
 */
export function randomLocalEdit(doc, rng) {
  const blocks = doc.visibleBlockIds();
  const r = rng.next();
  const block = blocks.length ? rng.pick(blocks) : null;
  if (block === null || r < 0.12) {
    const parent = blocks.length && rng.next() < 0.3 ? rng.pick(blocks) : null;
    const kids = doc.children(parent);
    const after = kids.length && rng.next() < 0.7 ? rng.pick(kids) : null;
    doc.insertBlock({
      type: rng.pick(["paragraph", "heading", "todo"]),
      parent,
      after,
      text: rng.next() < 0.5 ? "new" : undefined,
    });
    return "insertBlock";
  }
  const len = doc.textLength(block);
  if (r < 0.45) {
    const s = rng.pick(["a", "bc", "def", "😀", " ", "xyz!"]);
    doc.insertText(block, rng.int(len + 1), s, rng.next() < 0.3 ? { bold: true } : null);
    return "insertText";
  }
  if (r < 0.6 && len > 0) {
    const off = rng.int(len);
    doc.deleteText(block, off, 1 + rng.int(Math.min(5, len - off)));
    return "deleteText";
  }
  if (r < 0.72 && len > 0) {
    const off = rng.int(len);
    const name = rng.pick([
      "bold",
      "italic",
      "underline",
      "strike",
      "code",
      "link",
      "color",
      "mention",
      "math",
    ]);
    const value =
      name === "link"
        ? rng.pick(["https://a.test", "https://b.test", null])
        : name === "color"
          ? rng.pick(["red", "blue", null])
          : name === "mention"
            ? rng.pick([{ type: "page", id: "p1" }, { type: "user", id: "u2" }, null])
            : name === "math"
              ? rng.pick(["m1", "m2", null])
              : rng.pick([true, null]);
    doc.format(block, off, 1 + rng.int(Math.min(6, len - off)), name, value);
    return "format";
  }
  if (r < 0.8) {
    doc.setAttr(
      block,
      rng.pick(["checked", "level", "color"]),
      rng.pick([true, false, 1, 2, "red", null]),
    );
    return "setAttr";
  }
  if (r < 0.84) {
    doc.setType(block, rng.pick(["paragraph", "heading", "quote"]));
    return "setType";
  }
  if (r < 0.87) {
    doc.setMeta(rng.pick(["icon", "cover"]), rng.pick(["🌿", "🍂", null]));
    return "setMeta";
  }
  if (r < 0.92) {
    doc.deleteBlock(block);
    return "deleteBlock";
  }
  const parent = rng.pick([null, ...blocks]);
  const kids = doc.children(parent);
  const after = kids.length && rng.next() < 0.7 ? rng.pick(kids) : null;
  try {
    doc.moveBlock(block, { parent, after });
  } catch {
    // Into its own subtree: refused before any op is made.
  }
  return "moveBlock";
}
