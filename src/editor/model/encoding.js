// @ts-check

/**
 * Binary primitives for the sync protocol: unsigned LEB128 varints (up to
 * 2^53 - 1, so every JS safe integer fits), zigzag signed varints, float64,
 * length-prefixed UTF-8 strings and a small tagged encoding for JSON-like
 * values. The byte layout is specified in docs/sync-protocol.md.
 */

const textEncoder = new TextEncoder();
// ignoreBOM: a string that starts with U+FEFF must keep it (the encoder writes it).
const textDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Value tags for `any()`. */
export const ANY_NULL = 0;
export const ANY_FALSE = 1;
export const ANY_TRUE = 2;
export const ANY_INT = 3;
export const ANY_FLOAT = 4;
export const ANY_STRING = 5;
export const ANY_ARRAY = 6;
export const ANY_OBJECT = 7;

/** Integers with |n| below this use ANY_INT (their zigzag form stays a safe integer). */
const MAX_ZIGZAG = 2 ** 52;
/** Nesting limit for decoded values, so hostile input can't overflow the stack. */
const MAX_DEPTH = 64;

export class Encoder {
  constructor() {
    this.buf = new Uint8Array(256);
    this.view = new DataView(this.buf.buffer);
    this.pos = 0;
  }

  /** @param {number} n */
  #ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  /** @param {number} v */
  u8(v) {
    this.#ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  /** Unsigned LEB128. @param {number} n A safe non-negative integer. */
  varuint(n) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`varuint out of range: ${n}`);
    this.#ensure(8);
    while (n >= 0x80) {
      this.buf[this.pos++] = (n % 0x80) | 0x80;
      n = Math.floor(n / 0x80);
    }
    this.buf[this.pos++] = n;
  }

  /** Zigzag-encoded signed varint. @param {number} n |n| < 2^52 */
  varint(n) {
    if (!Number.isSafeInteger(n) || Math.abs(n) >= MAX_ZIGZAG)
      throw new RangeError(`varint out of range: ${n}`);
    this.varuint(n >= 0 ? n * 2 : -n * 2 - 1);
  }

  /** Little-endian IEEE 754 double. @param {number} n */
  f64(n) {
    this.#ensure(8);
    this.view.setFloat64(this.pos, n, true);
    this.pos += 8;
  }

  /** Length-prefixed UTF-8. @param {string} s */
  string(s) {
    // UTF-8 needs at most 3 bytes per UTF-16 code unit.
    const max = s.length * 3;
    if (max < 0x80) {
      // The length prefix is one byte: write the bytes after it, then the prefix.
      this.#ensure(1 + max);
      const { written } = textEncoder.encodeInto(s, this.buf.subarray(this.pos + 1));
      this.buf[this.pos] = written;
      this.pos += 1 + written;
      return;
    }
    const bytes = textEncoder.encode(s);
    this.varuint(bytes.length);
    this.#ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  /**
   * A JSON-like value: null, booleans, numbers, strings, arrays and plain
   * objects. `undefined` encodes as null.
   *
   * @param {unknown} v
   * @param {number} [depth]
   */
  any(v, depth = 0) {
    if (depth > MAX_DEPTH) throw new RangeError("value nested too deeply");
    if (v === null || v === undefined) this.u8(ANY_NULL);
    else if (v === false) this.u8(ANY_FALSE);
    else if (v === true) this.u8(ANY_TRUE);
    else if (typeof v === "number") {
      if (Number.isInteger(v) && Math.abs(v) < MAX_ZIGZAG && !Object.is(v, -0)) {
        this.u8(ANY_INT);
        this.varint(v);
      } else {
        this.u8(ANY_FLOAT);
        this.f64(v);
      }
    } else if (typeof v === "string") {
      this.u8(ANY_STRING);
      this.string(v);
    } else if (Array.isArray(v)) {
      this.u8(ANY_ARRAY);
      this.varuint(v.length);
      for (const x of v) this.any(x, depth + 1);
    } else if (typeof v === "object" && isPlainObject(v)) {
      const keys = Object.keys(v);
      this.u8(ANY_OBJECT);
      this.varuint(keys.length);
      for (const k of keys) {
        this.string(k);
        this.any(/** @type {Record<string, unknown>} */ (v)[k], depth + 1);
      }
    } else {
      throw new TypeError(`can't encode value of type ${typeof v}`);
    }
  }

  /** The bytes written so far, as a copy. */
  finish() {
    return this.buf.slice(0, this.pos);
  }
}

export class Decoder {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("expected a Uint8Array");
    this.buf = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  get done() {
    return this.pos >= this.buf.length;
  }

  /** @param {number} n */
  #need(n) {
    if (this.pos + n > this.buf.length) throw new RangeError("unexpected end of data");
  }

  u8() {
    this.#need(1);
    return this.buf[this.pos++];
  }

  varuint() {
    let n = 0;
    let scale = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      n += (b & 0x7f) * scale;
      if (b < 0x80) {
        if (!Number.isSafeInteger(n)) throw new RangeError("varuint exceeds 2^53 - 1");
        if (i > 0 && b === 0) throw new RangeError("non-canonical varuint");
        return n;
      }
      scale *= 0x80;
    }
    throw new RangeError("varuint longer than 8 bytes");
  }

  varint() {
    const z = this.varuint();
    if (z >= MAX_ZIGZAG * 2) throw new RangeError("varint out of range");
    return z % 2 === 0 ? z / 2 : -(z + 1) / 2;
  }

  f64() {
    this.#need(8);
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  string() {
    const len = this.varuint();
    this.#need(len);
    const s = textDecoder.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  /** @param {number} [depth] @returns {unknown} */
  any(depth = 0) {
    if (depth > MAX_DEPTH) throw new RangeError("value nested too deeply");
    const tag = this.u8();
    switch (tag) {
      case ANY_NULL:
        return null;
      case ANY_FALSE:
        return false;
      case ANY_TRUE:
        return true;
      case ANY_INT:
        return this.varint();
      case ANY_FLOAT:
        return this.f64();
      case ANY_STRING:
        return this.string();
      case ANY_ARRAY: {
        const n = this.varuint();
        /** @type {unknown[]} */
        const out = [];
        for (let i = 0; i < n; i++) out.push(this.any(depth + 1));
        return out;
      }
      case ANY_OBJECT: {
        const n = this.varuint();
        /** @type {Record<string, unknown>} */
        const out = {};
        for (let i = 0; i < n; i++) {
          const k = this.string();
          const v = this.any(depth + 1);
          // defineProperty so a "__proto__" key stays an ordinary own property.
          Object.defineProperty(out, k, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return out;
      }
      default:
        throw new RangeError(`unknown value tag ${tag}`);
    }
  }
}

/** @param {object} v */
function isPlainObject(v) {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality for JSON-like values (object key order ignored).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function valuesEqual(a, b) {
  if (a === b) return true;
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return (
      a === b ||
      (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b))
    );
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!valuesEqual(a[i], b[i])) return false;
    return true;
  }
  const ra = /** @type {Record<string, unknown>} */ (a);
  const rb = /** @type {Record<string, unknown>} */ (b);
  const ka = Object.keys(ra);
  if (ka.length !== Object.keys(rb).length) return false;
  for (const k of ka) if (!Object.hasOwn(rb, k) || !valuesEqual(ra[k], rb[k])) return false;
  return true;
}
