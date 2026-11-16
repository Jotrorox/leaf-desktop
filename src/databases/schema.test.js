// @ts-check

import assert from "node:assert/strict";
import { test } from "node:test";
import { changeType, isDate, normalizeValue } from "./schema.js";

// The same cases as the backend's dbschema_test.go.

function counterIds() {
  let n = 0;
  return () => `o${++n}`;
}

/** @param {any} type @param {any} [extra] */
const prop = (type, extra = {}) => ({ id: "p", name: "P", type, ...extra });

test("normalizeValue checks values and stores them canonically", () => {
  const sel = prop("select", { options: [{ id: "a", name: "A", color: "red" }] });
  const multi = prop("multi_select", {
    options: [
      { id: "a", name: "A", color: "red" },
      { id: "b", name: "B", color: "red" },
    ],
  });
  const person = prop("person");
  const member = (/** @type {string} */ id) => id === "u1";
  /** @type {[any, unknown, unknown][]} */
  const ok = [
    [prop("text"), "hi", "hi"],
    [prop("text"), "", null],
    [prop("number"), 3.5, 3.5],
    [sel, "a", "a"],
    [multi, ["b", "a"], ["b", "a"]],
    [multi, [], null],
    [person, ["u1"], ["u1"]],
    [prop("date"), "2026-02-28", "2026-02-28"],
    [prop("checkbox"), true, true],
    [prop("checkbox"), false, null],
    [prop("url"), null, null],
  ];
  for (const [p, value, want] of ok)
    assert.deepEqual(normalizeValue(p, value, member), want, `${p.type} ${JSON.stringify(value)}`);
  /** @type {[any, unknown][]} */
  const bad = [
    [prop("text"), 3],
    [prop("number"), "3"],
    [sel, "zzz"],
    [multi, ["a", "a"]],
    [multi, ["zzz"]],
    [person, ["u2"]],
    [prop("date"), "2026-02-30"],
    [prop("date"), "26-02-01"],
    [prop("checkbox"), "yes"],
  ];
  for (const [p, value] of bad) {
    assert.throws(
      () => normalizeValue(p, value, member),
      { code: "invalid_value" },
      `${p.type} ${JSON.stringify(value)}`,
    );
  }
});

test("isDate accepts real dates only", () => {
  assert.equal(isDate("2024-02-29"), true);
  assert.equal(isDate("2023-02-29"), false);
  assert.equal(isDate("0001-01-01"), true);
  assert.equal(isDate("2026-13-01"), false);
});

test("changeType converts values", () => {
  const text = prop("text");
  const values = [
    { id: "r1", value: "Red, Blue" },
    { id: "r2", value: "blue" },
    { id: "r3", value: null },
    { id: "r4", value: "Red" },
  ];

  const sel = changeType(text, "select", values, counterIds());
  assert.deepEqual(sel.property.options, [
    { id: "o1", name: "Red, Blue", color: "gray" },
    { id: "o2", name: "blue", color: "brown" },
    { id: "o3", name: "Red", color: "orange" },
  ]);
  assert.deepEqual(
    sel.values.map((v) => v.value),
    ["o1", "o2", null, "o3"],
  );

  const multi = changeType(text, "multi_select", values, counterIds());
  assert.deepEqual(
    multi.property.options?.map((o) => o.name),
    ["Red", "Blue", "blue"],
  );
  assert.deepEqual(multi.values[0].value, ["o1", "o2"]);
  assert.deepEqual(multi.values[3].value, ["o1"]);

  const status = changeType(multi.property, "status", multi.values, counterIds());
  assert.equal(status.property.options?.[0].group, "to_do");
  assert.equal(status.values[0].value, "o1");
  assert.equal(status.values[2].value, null);

  const back = changeType(status.property, "multi_select", status.values, counterIds());
  assert.equal(back.property.options?.[0].group, undefined);
  assert.deepEqual(back.values[0].value, ["o1"]);

  const asText = changeType(
    back.property,
    "text",
    [{ id: "r1", value: ["o2", "o1"] }],
    counterIds(),
  );
  assert.equal(asText.property.options, undefined);
  assert.equal(asText.values[0].value, "Blue, Red");

  const empty = changeType(prop("checkbox"), "status", [], counterIds());
  assert.equal(empty.property.options?.length, 3);
  assert.equal(empty.property.options?.[2].group, "complete");

  /** @type {[any, any, unknown, unknown][]} */
  const scalars = [
    [text, "number", " 42.5 ", 42.5],
    [text, "number", "4e3", null],
    [text, "checkbox", " YES ", true],
    [text, "checkbox", "nope", null],
    [text, "date", "2026-10-13", "2026-10-13"],
    [text, "date", "13.10.2026", null],
    [prop("number"), "text", 0.5, "0.5"],
    [prop("checkbox"), "text", true, "Yes"],
    [prop("person"), "text", ["u1"], null],
    [text, "person", "u1", null],
    [prop("date"), "url", "2026-01-01", "2026-01-01"],
  ];
  for (const [from, to, value, want] of scalars) {
    const { values: out } = changeType(
      from,
      to,
      [{ id: "r", value: /** @type {any} */ (value) }],
      counterIds(),
    );
    assert.deepEqual(out[0].value, want, `${from.type} ${JSON.stringify(value)} → ${to}`);
  }
});
