// @ts-check
import { ApiError } from "../api/client.js";

/**
 * Database properties: the types, their values, and what a type change does
 * to values. The rules are docs/databases.md's (Section 2), the same as the
 * backend's `dbschema.go`; the mock backend runs these, and the UI uses the
 * same helpers to edit and show values.
 *
 * Pure: runs under `node --test`.
 */

/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").PropertyType} PropertyType */
/** @typedef {import("../api/types.js").SelectOption} SelectOption */
/** @typedef {import("../api/types.js").PropertyValue} PropertyValue */

/** The title property's id; every database has it. */
export const TITLE_ID = "title";

export const MAX_TEXT_VALUE = 2000;
export const MAX_PROPERTY_NAME = 200;
export const MAX_OPTION_NAME = 200;
export const MAX_PROPERTIES = 100;
export const MAX_OPTIONS = 200;

/**
 * The types, in the order the "add property" menu lists them.
 * @type {readonly { type: PropertyType, label: string }[]}
 */
export const PROPERTY_TYPES = [
  { type: "text", label: "Text" },
  { type: "number", label: "Number" },
  { type: "select", label: "Select" },
  { type: "multi_select", label: "Multi-select" },
  { type: "status", label: "Status" },
  { type: "date", label: "Date" },
  { type: "person", label: "Person" },
  { type: "checkbox", label: "Checkbox" },
  { type: "url", label: "URL" },
];

/** @param {PropertyType} type */
export function typeLabel(type) {
  return type === "title" ? "Title" : (PROPERTY_TYPES.find((t) => t.type === type)?.label ?? type);
}

/** Option colors; after "default", the order new options are colored in. */
export const OPTION_COLORS = /** @type {const} */ ([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
]);

export const STATUS_GROUPS = /** @type {const} */ ([
  { id: "to_do", label: "To-do" },
  { id: "in_progress", label: "In progress" },
  { id: "complete", label: "Complete" },
]);

/** @param {string} type */
export function isOptionType(type) {
  return type === "select" || type === "multi_select" || type === "status";
}

/** The color the nth new option gets. @param {number} n */
export function nthColor(n) {
  return OPTION_COLORS[1 + (n % (OPTION_COLORS.length - 1))];
}

/** @param {() => string} newId @returns {SelectOption[]} */
export function defaultStatusOptions(newId) {
  return [
    { id: newId(), name: "Not started", color: "default", group: "to_do" },
    { id: newId(), name: "In progress", color: "blue", group: "in_progress" },
    { id: newId(), name: "Done", color: "green", group: "complete" },
  ];
}

/** A new database's schema. @returns {Property[]} */
export function defaultSchema() {
  return [
    { id: TITLE_ID, name: "Name", type: "title" },
    { id: "tags", name: "Tags", type: "multi_select", options: [] },
  ];
}

/** A short random id for properties, options and views. */
export function newShortId() {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** @param {unknown} id */
export function isValidId(id) {
  return typeof id === "string" && ID_PATTERN.test(id);
}

/** @param {string} message */
const invalidValue = (message) => new ApiError(400, "invalid_value", message);
/** @param {string} message */
export const invalidProperty = (message) => new ApiError(400, "invalid_property", message);

/**
 * Whether `s` is a real date, `YYYY-MM-DD`.
 * @param {unknown} s
 */
export function isDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(y, m - 1, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** @param {Property} property @param {string} id */
export function findOption(property, id) {
  return property.options?.find((option) => option.id === id);
}

/**
 * Checks an option list for a property of `type`: distinct valid ids,
 * names, known colors; status options get a group (to_do by default), the
 * others lose theirs.
 * @param {string} type
 * @param {unknown} options
 * @returns {SelectOption[]}
 */
export function validateOptions(type, options) {
  if (!Array.isArray(options))
    throw invalidProperty("options must be a list of {id, name, color, group?}");
  if (options.length > MAX_OPTIONS)
    throw invalidProperty(`A property has at most ${MAX_OPTIONS} options`);
  /** @type {Set<string>} */
  const seen = new Set();
  return options.map((/** @type {any} */ o) => {
    if (!o || typeof o !== "object" || !isValidId(o.id) || seen.has(o.id)) {
      throw invalidProperty("Option ids must be distinct: 1–64 letters, digits, '-' or '_'");
    }
    seen.add(o.id);
    if (typeof o.name !== "string" || o.name === "" || o.name.length > MAX_OPTION_NAME) {
      throw invalidProperty(`Option names are 1–${MAX_OPTION_NAME} characters`);
    }
    const color = o.color ?? "";
    if (!OPTION_COLORS.includes(color))
      throw invalidProperty(`Unknown option color ${JSON.stringify(color)}`);
    /** @type {SelectOption} */
    const option = { id: o.id, name: o.name, color };
    if (type === "status") {
      const group = o.group || "to_do";
      if (!STATUS_GROUPS.some((g) => g.id === group))
        throw invalidProperty(`Unknown status group ${JSON.stringify(group)}`);
      option.group = group;
    }
    return option;
  });
}

/** @param {unknown} name */
export function validatePropertyName(name) {
  if (typeof name !== "string" || name === "" || name.length > MAX_PROPERTY_NAME) {
    throw invalidProperty(`Property names are 1–${MAX_PROPERTY_NAME} characters`);
  }
}

/**
 * A value written to `property`, checked and in its stored form: null means
 * "no value" (the key is removed). Empty text, empty lists and `false` are
 * stored as no value.
 * @param {Property} property
 * @param {unknown} value
 * @param {(userId: string) => boolean} [isMember] For person values.
 * @returns {PropertyValue | null}
 */
export function normalizeValue(property, value, isMember = () => true) {
  if (value === undefined || value === null) return null;
  const name = JSON.stringify(property.name);
  switch (property.type) {
    case "text":
    case "url":
      if (typeof value !== "string" || value.length > MAX_TEXT_VALUE) {
        throw invalidValue(`${name} takes text of at most ${MAX_TEXT_VALUE} characters`);
      }
      return value === "" ? null : value;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value))
        throw invalidValue(`${name} takes a number`);
      return value;
    case "select":
    case "status":
      if (typeof value !== "string" || !findOption(property, value))
        throw invalidValue(`${name} takes one of its options' ids`);
      return value;
    case "multi_select":
    case "person": {
      if (!Array.isArray(value) || value.some((id) => typeof id !== "string"))
        throw invalidValue(`${name} takes a list of ids`);
      /** @type {string[]} */
      const out = [];
      for (const id of value) {
        if (out.includes(id)) throw invalidValue(`${name} takes distinct ids`);
        if (property.type === "multi_select" && !findOption(property, id))
          throw invalidValue(`${name} takes its options' ids`);
        if (property.type === "person" && !isMember(id))
          throw invalidValue(`${name} takes members of the workspace`);
        out.push(id);
      }
      return out.length ? out : null;
    }
    case "date":
      if (!isDate(value)) throw invalidValue(`${name} takes a date, YYYY-MM-DD`);
      return /** @type {string} */ (value);
    case "checkbox":
      if (typeof value !== "boolean") throw invalidValue(`${name} takes true or false`);
      return value ? true : null;
  }
  throw invalidValue(`${name} can't be set this way`);
}

/**
 * A value as text: what a type change to text makes of it.
 * @param {Property} property
 * @param {PropertyValue | null | undefined} value
 * @returns {string}
 */
export function textOf(property, value) {
  if (typeof value === "string") {
    if (property.type === "select" || property.type === "status")
      return findOption(property, value)?.name ?? "";
    if (["text", "url", "date", "title"].includes(property.type)) return value;
    return "";
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "";
  if (Array.isArray(value) && property.type === "multi_select") {
    return value
      .map((id) => findOption(property, id)?.name)
      .filter((name) => name !== undefined)
      .join(", ");
  }
  return "";
}

const TRUTHY = ["true", "yes", "1", "x", "✓"];

/**
 * Gives `old` the type `type`: the property as it becomes, and each row's
 * new value (null: cleared), in the order given (position order, so new
 * options come out in that order).
 * @param {Property} old
 * @param {PropertyType} type
 * @param {{ id: string, value: PropertyValue | null }[]} values
 * @param {() => string} newId
 * @returns {{ property: Property, values: { id: string, value: PropertyValue | null }[] }}
 */
export function changeType(old, type, values, newId) {
  /** @type {Property} */
  const next = { id: old.id, name: old.name, type };
  /** @type {SelectOption[]} */
  const options = [];
  /** @type {{ id: string, value: PropertyValue | null }[]} */
  let out;
  if (isOptionType(old.type) && isOptionType(type)) {
    for (const o of old.options ?? []) {
      /** @type {SelectOption} */
      const option = { id: o.id, name: o.name, color: o.color };
      if (type === "status") option.group = o.group || "to_do";
      options.push(option);
    }
    out = values.map(({ id, value }) => {
      if (typeof value === "string")
        return { id, value: type === "multi_select" ? [value] : value };
      if (Array.isArray(value))
        return { id, value: type === "multi_select" ? value : (value[0] ?? null) };
      return { id, value: null };
    });
  } else if (isOptionType(type)) {
    /** @type {Map<string, string>} */
    const byName = new Map();
    out = values.map(({ id, value }) => {
      const text = textOf(old, value).trim();
      const parts = type === "multi_select" ? text.split(",") : [text];
      /** @type {string[]} */
      const ids = [];
      for (const part of parts) {
        let name = part.trim();
        if (name === "") continue;
        if (name.length > MAX_OPTION_NAME) name = truncate(name, MAX_OPTION_NAME);
        let optionId = byName.get(name);
        if (optionId === undefined) {
          optionId = newId();
          byName.set(name, optionId);
          /** @type {SelectOption} */
          const option = { id: optionId, name, color: nthColor(options.length) };
          if (type === "status") option.group = "to_do";
          options.push(option);
        }
        if (!ids.includes(optionId)) ids.push(optionId);
      }
      if (!ids.length) return { id, value: null };
      return { id, value: type === "multi_select" ? ids : ids[0] };
    });
  } else {
    out = values.map(({ id, value }) => ({ id, value: convertScalar(old, type, value) }));
  }
  if (type === "status" && options.length === 0) options.push(...defaultStatusOptions(newId));
  if (isOptionType(type)) next.options = options;
  return { property: next, values: out };
}

/**
 * @param {Property} old
 * @param {PropertyType} type
 * @param {PropertyValue | null} value
 * @returns {PropertyValue | null}
 */
function convertScalar(old, type, value) {
  if (value === null || value === undefined) return null;
  if (old.type === type) return value;
  const text = textOf(old, value);
  const trimmed = text.trim();
  switch (type) {
    case "text":
    case "url":
      if (text === "") return null;
      return text.length > MAX_TEXT_VALUE ? truncate(text, MAX_TEXT_VALUE) : text;
    case "number":
      if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) return n;
      }
      return null;
    case "checkbox":
      return TRUTHY.includes(trimmed.toLowerCase()) ? true : null;
    case "date":
      return isDate(trimmed) ? trimmed : null;
  }
  return null;
}

/**
 * Cuts `s` to at most `n` UTF-16 code units, between characters.
 * @param {string} s @param {number} n
 */
function truncate(s, n) {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
}

/**
 * A value without the option ids `property` no longer has.
 * @param {Property} property
 * @param {PropertyValue | null} value
 * @returns {PropertyValue | null}
 */
export function keepOptions(property, value) {
  if (typeof value === "string") return findOption(property, value) ? value : null;
  if (Array.isArray(value)) {
    const kept = value.filter((id) => findOption(property, id));
    return kept.length ? kept : null;
  }
  return value;
}

/**
 * Whether a cell is empty (`false` counts as empty for checkboxes).
 * @param {PropertyValue | null | undefined} value
 */
export function isEmptyValue(value) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    value === false ||
    (Array.isArray(value) && value.length === 0)
  );
}
