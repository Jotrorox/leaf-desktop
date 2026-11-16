// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeMessage,
  encodeAck,
  encodeAwareness,
  encodeHello,
  encodeNotice,
  encodeSync,
  encodeUpdate,
  NOTICE_GAP,
  NOTICE_READ_ONLY,
} from "./protocol.js";

const sv = new Uint8Array([1, 3, 1, 0xac, 0x02, 4]); // {300: 4}
const update = new Uint8Array([1, 1, 0, 0]); // an empty update

test("messages have the layout of docs/sync-protocol.md 13.2", () => {
  assert.deepEqual([...encodeHello(sv)], [1, ...sv]);
  assert.deepEqual([...encodeSync(sv, update)], [2, 6, ...sv, ...update]);
  assert.deepEqual([...encodeUpdate(300, update)], [3, 0xac, 0x02, ...update]);
  assert.deepEqual([...encodeAck(1, sv)], [4, 1, ...sv]);
  assert.deepEqual([...encodeNotice(NOTICE_READ_ONLY)], [5, 1]);
  assert.deepEqual([...encodeNotice(NOTICE_GAP, sv)], [5, 2, ...sv]);
});

test("decoding round-trips and rejects junk", () => {
  assert.deepEqual(decodeMessage(encodeSync(sv, update)), { type: "sync", sv, update });
  assert.deepEqual(decodeMessage(encodeUpdate(7, update)), { type: "update", seq: 7, update });
  assert.deepEqual(decodeMessage(encodeAck(9, sv)), { type: "ack", seq: 9, sv });
  assert.deepEqual(decodeMessage(encodeNotice(NOTICE_READ_ONLY)), {
    type: "notice",
    code: 1,
    sv: null,
  });
  assert.deepEqual(decodeMessage(encodeNotice(NOTICE_GAP, sv)), { type: "notice", code: 2, sv });
  assert.throws(() => decodeMessage(new Uint8Array([9])), RangeError);
  assert.throws(() => decodeMessage(new Uint8Array([2, 50, 1])), RangeError);
  assert.throws(() => decodeMessage(new Uint8Array([])), RangeError);
});

test("AWARENESS has the layout of Section 14 and round-trips", () => {
  const entries = [
    { session: 300, clock: 2, user: "", state: '{"a":1}' },
    { session: 5, clock: 1, user: "user_é", state: "" },
  ];
  const bytes = encodeAwareness(entries);
  assert.deepEqual(
    [...bytes],
    [
      6,
      2,
      0xac,
      0x02,
      2,
      0,
      7,
      ...new TextEncoder().encode('{"a":1}'),
      5,
      1,
      7,
      ...new TextEncoder().encode("user_é"),
      0,
    ],
  );
  assert.deepEqual(decodeMessage(bytes), { type: "awareness", entries });
  assert.throws(() => decodeMessage(new Uint8Array([...bytes, 0])), RangeError);
  assert.throws(() => decodeMessage(bytes.subarray(0, bytes.length - 3)), RangeError);
});
