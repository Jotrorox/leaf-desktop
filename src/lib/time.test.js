// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { timeAgo } from "./time.js";

const now = Date.parse("2026-10-12T12:00:00Z");
/** @param {number} secondsAgo */
const ago = (secondsAgo) =>
  timeAgo(new Date(now - secondsAgo * 1000).toISOString(), { now, locale: "en" });

test("timeAgo picks a sensible unit", () => {
  assert.equal(ago(10), "just now");
  assert.equal(ago(120), "2 minutes ago");
  assert.equal(ago(3 * 3600), "3 hours ago");
  assert.equal(ago(86_400), "yesterday");
  assert.equal(ago(2 * 86_400), "2 days ago");
  assert.equal(ago(15 * 86_400), "2 weeks ago");
  assert.equal(ago(400 * 86_400), "last year");
});

test("timeAgo handles the future and bad input", () => {
  assert.equal(ago(-7200), "in 2 hours");
  assert.equal(timeAgo("not a date", { now }), "");
});
