// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy.js";

const titles = [
  "Getting started",
  "Meeting notes",
  "Roadmap 2027",
  "Reading list",
  "Research ideas",
  "Café plans",
  "Tasks",
];
/** @param {string} q */
const ranked = (q) => fuzzyFilter(q, titles, (t) => t).map((r) => r.item);

test("characters must appear in order", () => {
  assert.ok(fuzzyMatch("rdmp", "Roadmap"));
  assert.equal(fuzzyMatch("pmdr", "Roadmap"), null);
  assert.equal(fuzzyMatch("roadmaps", "Roadmap"), null);
});

test("prefixes and word starts rank first", () => {
  assert.equal(ranked("r")[0], "Roadmap 2027");
  assert.deepEqual(ranked("re").slice(0, 2), ["Reading list", "Research ideas"]);
  assert.equal(ranked("mn")[0], "Meeting notes");
  assert.equal(ranked("rl")[0], "Reading list");
  assert.equal(ranked("ta")[0], "Tasks");
});

test("case, accents and spaces don't matter", () => {
  assert.deepEqual(ranked("CAFE"), ["Café plans"]);
  assert.equal(ranked("meet not")[0], "Meeting notes");
});

test("positions point at the matched characters", () => {
  assert.deepEqual(fuzzyMatch("mn", "Meeting notes")?.positions, [0, 8]);
  assert.deepEqual(fuzzyMatch("", "x"), { score: 0, positions: [] });
});

test("every page title in a small workspace is reachable in two characters", () => {
  // The milestone's "found in under three keystrokes": the two-letter
  // initials of each title put it first.
  for (const title of titles) {
    const words = title.split(/\s+/);
    const query = words.length > 1 ? words[0][0] + words[1][0] : title.slice(0, 2);
    assert.equal(ranked(query)[0], title, `${query} → ${ranked(query)[0]}`);
  }
});
