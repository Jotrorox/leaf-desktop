// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../api/client.js";
import {
  DEFAULT_PAGE_SIZE,
  newView,
  PAGE_SIZES,
  pageSizeChoices,
  pageSizeOf,
  pageSlice,
  parsePageSize,
  withDefaults,
} from "./views.js";

test("parsePageSize takes null or 1–1000, like the server", () => {
  assert.equal(parsePageSize(undefined), null);
  assert.equal(parsePageSize(null), null);
  assert.equal(parsePageSize(1), 1);
  assert.equal(parsePageSize(1000), 1000);
  for (const bad of [0, -1, 1001, 2.5, "50", true]) {
    assert.throws(
      () => parsePageSize(bad),
      (e) => e instanceof ApiError && e.code === "invalid_view",
    );
  }
});

test("a view without a page size shows the default", () => {
  assert.equal(newView("v", "Table", "table", "a0").page_size, null);
  assert.equal(pageSizeOf(newView("v", "Table", "table", "a0")), DEFAULT_PAGE_SIZE);
  assert.equal(pageSizeOf(undefined), DEFAULT_PAGE_SIZE);
  assert.equal(pageSizeOf({ page_size: 25 }), 25);
  const old = {
    id: "v",
    name: "Old",
    type: /** @type {const} */ ("table"),
    position: "a0",
    filter: null,
    sorts: [],
    columns: [],
  };
  assert.equal(withDefaults(old).page_size, null);
});

test("pageSlice splits rows into pages and keeps the page in range", () => {
  assert.deepEqual(pageSlice(0, 50, 0), { page: 0, pages: 1, start: 0, count: 0 });
  assert.deepEqual(pageSlice(120, 50, 0), { page: 0, pages: 3, start: 0, count: 50 });
  assert.deepEqual(pageSlice(120, 50, 2), { page: 2, pages: 3, start: 100, count: 20 });
  assert.deepEqual(pageSlice(120, 50, 9), { page: 2, pages: 3, start: 100, count: 20 });
  assert.deepEqual(pageSlice(100, 50, 2), { page: 1, pages: 2, start: 50, count: 50 });
  assert.deepEqual(pageSlice(10, 50, -1), { page: 0, pages: 1, start: 0, count: 10 });
});

test("pageSizeChoices includes a view's own size", () => {
  assert.deepEqual(pageSizeChoices(50), PAGE_SIZES);
  assert.deepEqual(pageSizeChoices(30), [10, 25, 30, 50, 100, 250, 500]);
});
