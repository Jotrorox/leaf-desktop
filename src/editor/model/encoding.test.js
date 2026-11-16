// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrng } from "../../lib/prng.js";
import { Decoder, Encoder, valuesEqual } from "./encoding.js";

test("varuint round-trips edge values with canonical lengths", () => {
  const cases = [
    [0, 1],
    [1, 1],
    [127, 1],
    [128, 2],
    [16383, 2],
    [16384, 3],
    [2 ** 32 - 1, 5],
    [2 ** 32, 5],
    [2 ** 52 - 1, 8],
    [Number.MAX_SAFE_INTEGER, 8],
  ];
  for (const [n, len] of cases) {
    const enc = new Encoder();
    enc.varuint(n);
    const bytes = enc.finish();
    assert.equal(bytes.length, len, `length of ${n}`);
    const dec = new Decoder(bytes);
    assert.equal(dec.varuint(), n);
    assert.ok(dec.done);
  }
  assert.deepEqual(
    [
      ...(() => {
        const e = new Encoder();
        e.varuint(300);
        return e.finish();
      })(),
    ],
    [0xac, 0x02],
  );
});

test("varuint rejects bad input", () => {
  const enc = new Encoder();
  assert.throws(() => enc.varuint(-1), RangeError);
  assert.throws(() => enc.varuint(1.5), RangeError);
  assert.throws(() => enc.varuint(2 ** 53), RangeError);
  assert.throws(() => new Decoder(new Uint8Array([0x80])).varuint(), RangeError, "truncated");
  assert.throws(
    () => new Decoder(new Uint8Array([0x80, 0x00])).varuint(),
    RangeError,
    "non-canonical",
  );
  assert.throws(() => new Decoder(new Uint8Array(9).fill(0xff)).varuint(), RangeError, "too long");
  assert.throws(
    () => new Decoder(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x7f])).varuint(),
    RangeError,
    "> 2^53",
  );
});

test("varint zigzags", () => {
  for (const n of [0, -1, 1, -64, 64, -(2 ** 40), 2 ** 51, -(2 ** 52 - 1)]) {
    const enc = new Encoder();
    enc.varint(n);
    assert.equal(new Decoder(enc.finish()).varint(), n);
  }
  const enc = new Encoder();
  enc.varint(-1);
  assert.deepEqual([...enc.finish()], [1]);
});

test("strings round-trip, including astral characters and long strings", () => {
  for (const s of ["", "a", "héllo", "日本語", "😀👍🏽", "x".repeat(50), "y".repeat(100_000)]) {
    const enc = new Encoder();
    enc.string(s);
    enc.u8(42);
    const dec = new Decoder(enc.finish());
    assert.equal(dec.string(), s);
    assert.equal(dec.u8(), 42);
  }
});

test("invalid UTF-8 is rejected", () => {
  assert.throws(() => new Decoder(new Uint8Array([2, 0xc3, 0x28])).string());
});

test("any() round-trips JSON-like values", () => {
  const values = [
    null,
    true,
    false,
    0,
    -0,
    42,
    -42,
    2 ** 52,
    1.5,
    -1e300,
    "",
    "text",
    [],
    [1, "a", null, [true]],
    {},
    { a: 1, b: { c: [1, 2, { d: "e" }] } },
    { href: "https://example.com", title: null },
  ];
  for (const v of values) {
    const enc = new Encoder();
    enc.any(v);
    const out = new Decoder(enc.finish()).any();
    assert.ok(Object.is(out, v) || valuesEqual(out, v), `round-trip ${JSON.stringify(v)}`);
  }
  const enc = new Encoder();
  enc.any(-0);
  assert.ok(Object.is(new Decoder(enc.finish()).any(), -0));
  enc.any(undefined);
  assert.throws(() => new Encoder().any(new Date()), TypeError);
  assert.throws(() => new Encoder().any(10n), TypeError);
});

test("a __proto__ key decodes as an own property", () => {
  const enc = new Encoder();
  enc.any(JSON.parse('{"__proto__": {"x": 1}}'));
  const out = /** @type {Record<string, unknown>} */ (new Decoder(enc.finish()).any());
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.ok(Object.hasOwn(out, "__proto__"));
});

test("random values round-trip (seeded)", () => {
  const rng = createPrng(7);
  /** @param {number} depth @returns {unknown} */
  const gen = (depth) => {
    switch (rng.int(depth > 3 ? 5 : 7)) {
      case 0:
        return null;
      case 1:
        return rng.next() < 0.5;
      case 2:
        return rng.int(2 ** 31) - 2 ** 30;
      case 3:
        return rng.next() * 1e6;
      case 4:
        return String.fromCharCode(...Array.from({ length: rng.int(8) }, () => 32 + rng.int(500)));
      case 5:
        return Array.from({ length: rng.int(4) }, () => gen(depth + 1));
      default:
        return Object.fromEntries(
          Array.from({ length: rng.int(4) }, (_, i) => [`k${i}`, gen(depth + 1)]),
        );
    }
  };
  for (let i = 0; i < 500; i++) {
    const v = gen(0);
    const enc = new Encoder();
    enc.any(v);
    assert.ok(valuesEqual(new Decoder(enc.finish()).any(), v));
  }
});

test("valuesEqual ignores key order and treats undefined as null", () => {
  assert.ok(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert.ok(valuesEqual(undefined, null));
  assert.ok(!valuesEqual({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!valuesEqual([1], { 0: 1 }));
  assert.ok(!valuesEqual(1, "1"));
});
