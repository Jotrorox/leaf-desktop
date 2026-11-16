// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { compilePath, matchPath, matchRoutes } from "./match.js";

test("root matches only the root", () => {
  assert.deepEqual(matchPath("/", "/"), {});
  assert.equal(matchPath("/", "/trash"), null);
});

test("static paths match exactly, ignoring a trailing slash", () => {
  assert.deepEqual(matchPath("/trash", "/trash"), {});
  assert.deepEqual(matchPath("/trash", "/trash/"), {});
  assert.deepEqual(matchPath("/trash/", "/trash"), {});
  assert.equal(matchPath("/trash", "/trash/x"), null);
  assert.equal(matchPath("/trash", "/settings"), null);
});

test("static segments are case-sensitive", () => {
  assert.equal(matchPath("/trash", "/Trash"), null);
});

test("params capture one segment", () => {
  assert.deepEqual(matchPath("/p/:pageId", "/p/abc123"), { pageId: "abc123" });
  assert.deepEqual(matchPath("/p/:pageId", "/p/abc123/"), { pageId: "abc123" });
  assert.equal(matchPath("/p/:pageId", "/p"), null);
  assert.equal(matchPath("/p/:pageId", "/p/a/b"), null);
});

test("params never match an empty segment", () => {
  assert.equal(matchPath("/p/:pageId", "/p//"), null);
  assert.equal(matchPath("/p/:pageId/edit", "/p//edit"), null);
});

test("multiple params", () => {
  assert.deepEqual(matchPath("/w/:workspace/p/:pageId", "/w/acme/p/42"), {
    workspace: "acme",
    pageId: "42",
  });
});

test("param values are URI-decoded; malformed encodings don't match", () => {
  assert.deepEqual(matchPath("/p/:pageId", "/p/caf%C3%A9%20au%20lait"), { pageId: "café au lait" });
  assert.equal(matchPath("/p/:pageId", "/p/%E0%A4%A"), null);
});

test("malformed patterns throw", () => {
  assert.throws(() => compilePath("p/:id"), /must start with/);
  assert.throws(() => compilePath("/p/:"), /Invalid param name/);
  assert.throws(() => compilePath("/p/:1st"), /Invalid param name/);
  assert.throws(() => compilePath("/a/:id/b/:id"), /Duplicate param/);
});

test("matchRoutes returns the first match in order", () => {
  const patterns = ["/", "/p/new", "/p/:pageId", "/trash"];
  assert.deepEqual(matchRoutes(patterns, "/"), { index: 0, params: {} });
  assert.deepEqual(matchRoutes(patterns, "/p/new"), { index: 1, params: {} });
  assert.deepEqual(matchRoutes(patterns, "/p/xyz"), { index: 2, params: { pageId: "xyz" } });
  assert.equal(matchRoutes(patterns, "/nope"), null);
});
