// @ts-check
import { ApiError } from "../api/client.js";
import { findOption, isDate } from "./schema.js";

/**
 * Filters and sorts: their shape, the operators each property type has,
 * and how rows match and order. The rules are docs/databases.md's (Section
 * 3), the same as the backend's `dbquery.go` (which turns them into SQL);
 * the mock backend runs these on its rows.
 *
 * Pure: runs under `node --test`.
 */

/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").PropertyType} PropertyType */
/** @typedef {import("../api/types.js").Filter} Filter */
/** @typedef {import("../api/types.js").FilterGroup} FilterGroup */
/** @typedef {import("../api/types.js").FilterCondition} FilterCondition */
/** @typedef {import("../api/types.js").Sort} Sort */
/** @typedef {import("../api/types.js").Row} Row */
/** @typedef {import("../api/types.js").PropertyValue} PropertyValue */
/** @typedef {import("../api/types.js").RowGroup} RowGroup */

export const MAX_FILTER_DEPTH = 3;
export const MAX_CONDITIONS = 50;
export const MAX_SORTS = 10;

const TEXT_OPERATORS = [
  "contains",
  "does_not_contain",
  "equals",
  "does_not_equal",
  "starts_with",
  "ends_with",
];

/**
 * Each type's operators besides `is_empty` and `is_not_empty` (which every
 * type but checkbox has).
 * @type {Record<PropertyType, string[]>}
 */
const OPERATORS = {
  title: TEXT_OPERATORS,
  text: TEXT_OPERATORS,
  url: TEXT_OPERATORS,
  number: [
    "equals",
    "does_not_equal",
    "greater_than",
    "less_than",
    "greater_than_or_equal_to",
    "less_than_or_equal_to",
  ],
  select: ["equals", "does_not_equal"],
  status: ["equals", "does_not_equal"],
  multi_select: ["contains", "does_not_contain"],
  person: ["contains", "does_not_contain"],
  date: ["equals", "before", "after", "on_or_before", "on_or_after"],
  checkbox: ["equals"],
};

/** Every operator a type has, in the order the filter builder offers them. @param {PropertyType} type */
export function operatorsFor(type) {
  return type === "checkbox"
    ? OPERATORS.checkbox
    : [...(OPERATORS[type] ?? []), "is_empty", "is_not_empty"];
}

/** @param {PropertyType} type @param {string} operator */
export function validOperator(type, operator) {
  return operatorsFor(type).includes(operator);
}

/** Operators that take no value. @param {string} operator */
export function takesValue(operator) {
  return operator !== "is_empty" && operator !== "is_not_empty";
}

/** @param {string} message */
const invalidFilter = (message) => new ApiError(400, "invalid_filter", message);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** @param {Filter} f @returns {f is FilterGroup} */
export function isGroup(f) {
  return "and" in f || "or" in f;
}

/** @param {FilterGroup} g @returns {"and" | "or"} */
export function groupOp(g) {
  return "and" in g ? "and" : "or";
}

/** @param {FilterGroup} g @returns {Filter[]} */
export function groupItems(g) {
  return "and" in g ? g.and : g.or;
}

/** @param {"and" | "or"} op @param {Filter[]} items @returns {FilterGroup} */
export function makeGroup(op, items) {
  return op === "and" ? { and: items } : { or: items };
}

/**
 * Reads a filter's structure, like the server: null, or a group of
 * conditions and groups, at most 3 deep. Returns it in canonical form.
 * @param {unknown} raw
 * @returns {FilterGroup | null}
 */
export function parseFilter(raw) {
  if (raw === undefined || raw === null) return null;
  let conditions = 0;
  /** @param {unknown} node @param {number} depth @returns {Filter} */
  const parse = (node, depth) => {
    if (!isObject(node)) throw invalidFilter("A filter is an object");
    for (const op of /** @type {const} */ (["and", "or"])) {
      if (!(op in node)) continue;
      if (Object.keys(node).length !== 1)
        throw invalidFilter("A filter group has only an and or an or");
      if (depth >= MAX_FILTER_DEPTH)
        throw invalidFilter(`Filter groups nest at most ${MAX_FILTER_DEPTH} deep`);
      const items = node[op];
      if (!Array.isArray(items)) throw invalidFilter("A filter group holds a list");
      return makeGroup(
        op,
        items.map((item) => parse(item, depth + 1)),
      );
    }
    if (depth === 0) throw invalidFilter('A filter is a group: {"and": […]} or {"or": […]}');
    if (++conditions > MAX_CONDITIONS)
      throw invalidFilter(`A filter has at most ${MAX_CONDITIONS} conditions`);
    if (typeof node.property_id !== "string" || node.property_id === "")
      throw invalidFilter("A filter condition needs a property_id");
    if (typeof node.operator !== "string" || node.operator === "")
      throw invalidFilter("A filter condition needs an operator");
    for (const key of Object.keys(node)) {
      if (key !== "property_id" && key !== "operator" && key !== "value")
        throw invalidFilter(`Unknown filter field ${JSON.stringify(key)}`);
    }
    /** @type {FilterCondition} */
    const condition = { property_id: node.property_id, operator: node.operator };
    if (node.value !== undefined && node.value !== null)
      condition.value = /** @type {any} */ (node.value);
    return condition;
  };
  return /** @type {FilterGroup} */ (parse(raw, 0));
}

/**
 * A condition's value checked against its property: null when there's
 * none (the condition then matches every row).
 * @param {Property} property
 * @param {FilterCondition} c
 * @returns {string | number | boolean | null}
 */
export function conditionValue(property, c) {
  const value = c.value;
  if (!takesValue(c.operator) || value === undefined || value === null) return null;
  const bad = () => invalidFilter(`Wrong value for ${property.type} ${c.operator}`);
  switch (property.type) {
    case "number":
      if (typeof value === "number") return value;
      if (value === "") return null;
      throw bad();
    case "checkbox":
      if (typeof value !== "boolean") throw bad();
      return value;
    default:
      if (typeof value !== "string") throw bad();
      if (value === "") return null;
      if (property.type === "date" && !isDate(value)) throw bad();
      return value;
  }
}

/**
 * Validates a (parsed) filter against a schema and drops conditions on
 * properties it doesn't have: the filter as a view stores it.
 * @param {FilterGroup | null} filter
 * @param {Property[]} schema
 * @returns {FilterGroup | null}
 */
export function checkFilter(filter, schema) {
  if (!filter) return null;
  /** @param {Filter} f @returns {Filter | null} */
  const check = (f) => {
    if (isGroup(f)) {
      return makeGroup(
        groupOp(f),
        groupItems(f)
          .map(check)
          .filter((item) => item !== null),
      );
    }
    const property = schema.find((p) => p.id === f.property_id);
    if (!property) return null;
    if (!validOperator(property.type, f.operator))
      throw invalidFilter(`${property.type} properties have no ${f.operator} filter`);
    conditionValue(property, f);
    return f;
  };
  return /** @type {FilterGroup} */ (check(filter));
}

/**
 * The filter without its conditions on a property (and without groups left
 * empty below the top).
 * @param {FilterGroup | null} filter
 * @param {string} propertyId
 * @returns {FilterGroup | null}
 */
export function pruneFilter(filter, propertyId) {
  if (!filter) return null;
  /** @param {Filter} f @returns {Filter | null} */
  const prune = (f) => {
    if (!isGroup(f)) return f.property_id === propertyId ? null : f;
    const items = /** @type {Filter[]} */ (
      groupItems(f)
        .map(prune)
        .filter((item) => item !== null && (!isGroup(item) || groupItems(item).length > 0))
    );
    return makeGroup(groupOp(f), items);
  };
  return /** @type {FilterGroup} */ (prune(filter));
}

/**
 * A row's value for a property, null when the cell is empty (a checkbox is
 * never empty: unchecked is false).
 * @param {Pick<Row, "title" | "properties">} row
 * @param {Property} property
 * @returns {string | number | boolean | string[] | null}
 */
export function cellValue(row, property) {
  if (property.type === "title") return row.title === "" ? null : row.title;
  const value = row.properties[property.id];
  switch (property.type) {
    case "number":
      return typeof value === "number" ? value : null;
    case "multi_select":
    case "person":
      return Array.isArray(value) && value.length > 0 ? value : null;
    case "checkbox":
      return value === true;
    default:
      return typeof value === "string" && value !== "" ? value : null;
  }
}

/**
 * Whether a row matches a filter.
 * @param {Pick<Row, "title" | "properties">} row
 * @param {FilterGroup | null} filter
 * @param {Property[]} schema
 */
export function matchesFilter(row, filter, schema) {
  if (!filter) return true;
  /** @param {Filter} f @returns {boolean} */
  const test = (f) => {
    if (isGroup(f)) {
      const items = groupItems(f);
      if (items.length === 0) return true;
      return groupOp(f) === "and" ? items.every(test) : items.some(test);
    }
    const property = schema.find((p) => p.id === f.property_id);
    // Deleted since: matches every row.
    if (!property) return true;
    if (!validOperator(property.type, f.operator))
      throw invalidFilter(`${property.type} properties have no ${f.operator} filter`);
    const value = conditionValue(property, f);
    const cell = cellValue(row, property);
    if (f.operator === "is_empty") return cell === null;
    if (f.operator === "is_not_empty") return cell !== null;
    if (value === null) return true;
    if (cell === null) return f.operator === "does_not_equal" || f.operator === "does_not_contain";
    return matchCell(property.type, f.operator, cell, value);
  };
  return test(filter);
}

/**
 * @param {PropertyType} type
 * @param {string} operator
 * @param {string | number | boolean | string[]} cell Not empty.
 * @param {string | number | boolean} value
 */
function matchCell(type, operator, cell, value) {
  switch (type) {
    case "title":
    case "text":
    case "url": {
      const s = String(cell).toLowerCase();
      const v = String(value).toLowerCase();
      switch (operator) {
        case "contains":
          return s.includes(v);
        case "does_not_contain":
          return !s.includes(v);
        case "equals":
          return s === v;
        case "does_not_equal":
          return s !== v;
        case "starts_with":
          return s.startsWith(v);
        case "ends_with":
          return s.endsWith(v);
      }
      return false;
    }
    case "number": {
      const n = /** @type {number} */ (cell);
      const v = /** @type {number} */ (value);
      switch (operator) {
        case "equals":
          return n === v;
        case "does_not_equal":
          return n !== v;
        case "greater_than":
          return n > v;
        case "less_than":
          return n < v;
        case "greater_than_or_equal_to":
          return n >= v;
        case "less_than_or_equal_to":
          return n <= v;
      }
      return false;
    }
    case "select":
    case "status":
      return operator === "equals" ? cell === value : cell !== value;
    case "multi_select":
    case "person": {
      const has = /** @type {string[]} */ (cell).includes(/** @type {string} */ (value));
      return operator === "contains" ? has : !has;
    }
    case "date": {
      const d = /** @type {string} */ (cell);
      const v = /** @type {string} */ (value);
      switch (operator) {
        case "equals":
          return d === v;
        case "before":
          return d < v;
        case "after":
          return d > v;
        case "on_or_before":
          return d <= v;
        case "on_or_after":
          return d >= v;
      }
      return false;
    }
    case "checkbox":
      return cell === value;
  }
  return false;
}

/**
 * Compares strings by code point (as UTF-8 bytes compare, and Postgres's
 * "C" collation), not by UTF-16 code unit.
 * @param {string} a @param {string} b
 */
export function compareCodePoints(a, b) {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = /** @type {number} */ (a.codePointAt(i));
    const y = /** @type {number} */ (b.codePointAt(j));
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  return (a.length - i > 0 ? 1 : 0) - (b.length - j > 0 ? 1 : 0);
}

/**
 * A row's sort key for a property: null when empty (sorted last).
 * @param {Pick<Row, "title" | "properties">} row
 * @param {Property} property
 * @returns {string | number | boolean | null}
 */
function sortKey(row, property) {
  const cell = cellValue(row, property);
  switch (property.type) {
    case "title":
    case "text":
    case "url":
      return cell === null ? null : String(cell).toLowerCase();
    case "select":
    case "status":
    case "multi_select": {
      const first = Array.isArray(cell) ? cell[0] : cell;
      const index =
        typeof first === "string" ? (property.options ?? []).findIndex((o) => o.id === first) : -1;
      return index < 0 ? null : index;
    }
    case "person":
      return Array.isArray(cell) ? cell[0] : null;
    default:
      return /** @type {string | number | boolean | null} */ (cell);
  }
}

/** @param {string | number | boolean} a @param {string | number | boolean} b */
function compareKeys(a, b) {
  if (typeof a === "string" && typeof b === "string") return compareCodePoints(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A comparator for rows: each sort in turn (empty values last either way),
 * then position, then id. Sorts on unknown properties are skipped.
 * @param {readonly Sort[]} sorts
 * @param {Property[]} schema
 * @returns {(a: Row, b: Row) => number}
 */
export function rowComparator(sorts, schema) {
  const keyed = sorts.flatMap((sort) => {
    const property = schema.find((p) => p.id === sort.property_id);
    return property ? [{ property, sign: sort.direction === "descending" ? -1 : 1 }] : [];
  });
  return (a, b) => {
    for (const { property, sign } of keyed) {
      const x = sortKey(a, property);
      const y = sortKey(b, property);
      if (x === null && y === null) continue;
      if (x === null) return 1;
      if (y === null) return -1;
      const c = compareKeys(x, y);
      if (c !== 0) return c * sign;
    }
    return compareCodePoints(a.position, b.position) || compareCodePoints(a.id, b.id);
  };
}

/**
 * A query's `group`, checked: a select or status property, and an option
 * id or null (docs/databases.md, Section 3.1).
 * @param {unknown} raw
 * @param {Property[]} schema
 * @returns {RowGroup | null}
 */
export function parseGroup(raw, schema) {
  if (raw === undefined || raw === null) return null;
  const invalid = new ApiError(
    400,
    "invalid_query",
    "group is {property_id, value}: an option id, or null for rows without a value",
  );
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid;
  const { property_id: id, value } = /** @type {Record<string, unknown>} */ (raw);
  if (
    typeof id !== "string" ||
    (value !== undefined && value !== null && (typeof value !== "string" || value === ""))
  )
    throw invalid;
  const property = schema.find((p) => p.id === id);
  if (property?.type !== "select" && property?.type !== "status") {
    throw new ApiError(400, "invalid_query", "group's property_id is a select or status property");
  }
  return { property_id: id, value: typeof value === "string" ? value : null };
}

/**
 * Whether a row is in a board column: its value of the group's property
 * is the option, or it has none when the group's value is null.
 * @param {Pick<Row, "properties">} row
 * @param {RowGroup} group
 */
export function matchesGroup(row, group) {
  const value = row.properties[group.property_id];
  if (group.value === null) return value === undefined || value === null || value === "";
  return value === group.value;
}

/**
 * The server's query over a list of rows: those matching the filter (and
 * the group, if any), in the sorts' order, one page of them, and how many
 * match in all.
 * @param {Row[]} rows Live rows of one database.
 * @param {Property[]} schema
 * @param {{ filter?: FilterGroup | null, sorts?: readonly Sort[], group?: RowGroup | null, offset?: number, limit?: number }} query
 * @returns {{ rows: Row[], total: number }}
 */
export function runQuery(
  rows,
  schema,
  { filter = null, sorts = [], group = null, offset = 0, limit = 100 },
) {
  const matching = rows
    .filter((row) => (!group || matchesGroup(row, group)) && matchesFilter(row, filter, schema))
    .sort(rowComparator(sorts, schema));
  return { rows: matching.slice(offset, offset + limit), total: matching.length };
}

/**
 * Whether a cell's value is a valid option of its property (for showing a
 * value whose option was deleted meanwhile).
 * @param {Property} property @param {string} id
 */
export function hasOption(property, id) {
  return findOption(property, id) !== undefined;
}
