// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { ALL_EMOJI, EMOJI_GROUPS, searchEmoji } from "./emoji-data.js";

test("every emoji has a name, and none is listed twice", () => {
  assert.ok(ALL_EMOJI.length > 100);
  for (const item of ALL_EMOJI) {
    assert.ok(item.emoji && !item.emoji.includes(" "), `bad emoji in ${JSON.stringify(item)}`);
    assert.ok(item.name && !item.name.includes(","), `bad name in ${JSON.stringify(item)}`);
  }
  assert.equal(new Set(ALL_EMOJI.map((item) => item.emoji)).size, ALL_EMOJI.length);
  assert.ok(EMOJI_GROUPS.every((group) => group.items.length > 0));
});

test("search matches names and keywords, every word, case-insensitively", () => {
  assert.deepEqual(
    searchEmoji("rocket").map((item) => item.emoji),
    ["🚀"],
  );
  assert.ok(searchEmoji("HEART").length >= 6);
  assert.deepEqual(
    searchEmoji("red heart").map((item) => item.emoji),
    ["❤️"],
  );
  assert.ok(
    searchEmoji("idea").some((item) => item.emoji === "💡"),
    "keywords count",
  );
  assert.equal(searchEmoji("   ").length, ALL_EMOJI.length);
  assert.deepEqual(searchEmoji("zzzz"), []);
});
