// @ts-check
import assert from "node:assert/strict";
import { test } from "node:test";
import { Doc } from "../model/doc.js";
import { CURSOR_COLORS, initials, localState, readPeer, userColor } from "./presence.js";

test("a user's color is stable and from the palette", () => {
  assert.equal(userColor("user_abc"), userColor("user_abc"));
  assert.ok(CURSOR_COLORS.includes(userColor("user_abc")));
  const seen = new Set(Array.from({ length: 50 }, (_, i) => userColor(`user_${i}`)));
  assert.ok(seen.size >= CURSOR_COLORS.length - 1, "ids spread over the palette");
});

test("initials", () => {
  assert.equal(initials("Ada Lovelace"), "AL");
  assert.equal(initials("grace"), "G");
  assert.equal(initials("  Jean  Luc  Picard "), "JP");
  assert.equal(initials("Émile Zola"), "ÉZ");
  assert.equal(initials(""), "?");
});

test("our state round-trips through a peer, cursor included", () => {
  const doc = new Doc();
  let id = "";
  doc.transact(() => {
    id = doc.insertBlock({ type: "p", text: "hello" });
  });
  const pos = doc.createRelativePosition(id, 2);
  const state = JSON.parse(
    JSON.stringify(
      localState(
        { id: "u1", name: "Ada", image: "https://img.example/a.png" },
        { anchor: pos, focus: pos },
      ),
    ),
  );
  const peer = readPeer({ session: 9, user: "u1", state, clock: 1, seen: 0 });
  assert.equal(peer.name, "Ada");
  assert.equal(peer.image, "https://img.example/a.png");
  assert.equal(peer.color, userColor("u1"));
  assert.deepEqual(
    doc.resolveRelativePosition(/** @type {NonNullable<typeof peer.cursor>} */ (peer.cursor).focus),
    { blockId: id, offset: 2 },
  );
});

test("malformed states are read safely", () => {
  const read = (/** @type {unknown} */ state) =>
    readPeer({ session: 1, user: "u", state, clock: 1, seen: 0 });
  assert.deepEqual(read(null), {
    session: 1,
    userId: "u",
    name: "Someone",
    image: null,
    color: userColor("u"),
    cursor: null,
  });
  assert.equal(read({ name: "   " }).name, "Someone");
  assert.equal(read({ name: "x".repeat(200) }).name.length, 80);
  assert.equal(read({ image: "javascript:alert(1)" }).image, null);
  assert.equal(read({ image: "http://insecure.example/a.png" }).image, null);
  assert.equal(read({ cursor: { anchor: "!!!", focus: "AAAA" } }).cursor, null);
  assert.equal(read({ cursor: "nope" }).cursor, null);
});
