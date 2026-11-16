// @ts-check
import { Decoder, Encoder } from "./encoding.js";

/**
 * Relative positions on the wire (for awareness: cursors and selections).
 * Create and resolve them with `doc.createRelativePosition()` and
 * `doc.resolveRelativePosition()`.
 *
 * Layout: block id (string), anchor flag (u8: 0 none, 1 present), then the
 * anchor's client and clock (varuints) if present, then assoc as a zigzag
 * varint.
 */

/** @typedef {import("./doc.js").RelativePosition} RelativePosition */

/** @param {RelativePosition} pos */
export function encodeRelativePosition(pos) {
  const enc = new Encoder();
  enc.string(pos.block);
  if (pos.item) {
    enc.u8(1);
    enc.varuint(pos.item.client);
    enc.varuint(pos.item.clock);
  } else enc.u8(0);
  enc.varint(pos.assoc);
  return enc.finish();
}

/** @param {Uint8Array} bytes @returns {RelativePosition} */
export function decodeRelativePosition(bytes) {
  const dec = new Decoder(bytes);
  const block = dec.string();
  const flag = dec.u8();
  if (flag > 1) throw new RangeError("bad anchor flag");
  const item = flag ? { client: dec.varuint(), clock: dec.varuint() } : null;
  const assoc = dec.varint();
  if (!dec.done) throw new RangeError("trailing bytes after relative position");
  return { block, item, assoc };
}
