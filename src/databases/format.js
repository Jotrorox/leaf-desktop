// @ts-check

import { groupItems, isGroup, takesValue } from "./query.js";
import { findOption } from "./schema.js";

/**
 * How values, filters and sorts read in the UI. Pure (Intl only).
 */

/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").Member} Member */
/** @typedef {import("../api/types.js").FilterCondition} FilterCondition */
/** @typedef {import("../api/types.js").Filter} Filter */

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 10 });
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeZone: "UTC" });

/** @param {number} n */
export function formatNumber(n) {
  return numberFormat.format(n);
}

/** "Oct 13, 2026" for "2026-10-13" (the date as written, whatever the time zone). @param {string} date */
export function formatDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  const value = new Date(0);
  value.setUTCFullYear(y, m - 1, d);
  return dateFormat.format(value);
}

/** Today in the viewer's time zone, `YYYY-MM-DD`. */
export function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Background and text color of an option's tag. @param {string} color */
export function tagColors(color) {
  if (color === "default" || !color)
    return { background: "var(--color-bg-active)", color: "var(--color-text)" };
  return { background: `var(--tag-${color}-bg)`, color: `var(--tag-${color}-fg)` };
}

/** A member's display name. @param {readonly Member[] | undefined} members @param {string} id */
export function memberName(members, id) {
  const member = members?.find((m) => m.id === id);
  return member?.name?.trim() || (member ? "Unnamed member" : "Former member");
}

/** Initials for an avatar. @param {string} name */
export function initials(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return (
    (words[0]?.[0] ?? "?") + (words.length > 1 ? (words.at(-1)?.[0] ?? "") : "")
  ).toUpperCase();
}

/** @type {Record<string, string>} */
const OPERATOR_LABELS = {
  contains: "contains",
  does_not_contain: "does not contain",
  equals: "is",
  does_not_equal: "is not",
  starts_with: "starts with",
  ends_with: "ends with",
  greater_than: ">",
  less_than: "<",
  greater_than_or_equal_to: "≥",
  less_than_or_equal_to: "≤",
  before: "is before",
  after: "is after",
  on_or_before: "is on or before",
  on_or_after: "is on or after",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

/** @param {string} operator @param {Property["type"]} [type] */
export function operatorLabel(operator, type) {
  if (type === "number" && operator === "equals") return "=";
  if (type === "number" && operator === "does_not_equal") return "≠";
  if ((type === "multi_select" || type === "person") && operator === "contains") return "has";
  if ((type === "multi_select" || type === "person") && operator === "does_not_contain")
    return "doesn't have";
  return OPERATOR_LABELS[operator] ?? operator;
}

/**
 * A condition's value as text, e.g. an option's name.
 * @param {Property} property @param {FilterCondition["value"]} value @param {readonly Member[] | undefined} members
 */
export function valueLabel(property, value, members) {
  if (value === undefined || value === "") return "";
  switch (property.type) {
    case "select":
    case "status":
    case "multi_select":
      return findOption(property, String(value))?.name ?? "(deleted option)";
    case "person":
      return memberName(members, String(value));
    case "date":
      return formatDate(String(value));
    case "number":
      return typeof value === "number" ? formatNumber(value) : String(value);
    case "checkbox":
      return value ? "checked" : "unchecked";
    default:
      return `“${value}”`;
  }
}

/**
 * A filter chip's text: "Status is Done", "Name contains “x”".
 * @param {Filter} filter @param {Property[]} schema @param {readonly Member[] | undefined} members
 */
export function describeFilter(filter, schema, members) {
  if (isGroup(filter)) {
    const n = countConditions(filter);
    return n === 1 ? "1 rule" : `${n} rules`;
  }
  const property = schema.find((p) => p.id === filter.property_id);
  if (!property) return "Deleted property";
  const op = operatorLabel(filter.operator, property.type);
  if (!takesValue(filter.operator)) return `${property.name} ${op}`;
  const value = valueLabel(property, filter.value, members);
  return value ? `${property.name} ${op} ${value}` : `${property.name}: all`;
}

/** @param {Filter} filter @returns {number} */
export function countConditions(filter) {
  return isGroup(filter) ? groupItems(filter).reduce((n, item) => n + countConditions(item), 0) : 1;
}
