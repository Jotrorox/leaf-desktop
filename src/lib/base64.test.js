// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { base64ToBytes, bytesToBase64 } from "./base64.js";

test("round-trips bytes, including large arrays", () => {
  const small = new Uint8Array([0, 1, 2, 253, 254, 255]);
  assert.equal(bytesToBase64(small), "AAEC/f7/");
  assert.deepEqual(base64ToBytes("AAEC/f7/"), small);
  const big = new Uint8Array(200_000).map((_, i) => (i * 7) & 0xff);
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
});
