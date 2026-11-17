// @ts-check
import { ApiError } from "../api/client.js";
import { MAX_SORTS } from "./query.js";
import { findOption, MAX_OPTIONS, MAX_PROPERTIES, TITLE_ID } from "./schema.js";

/**
 * View configs: sorts, columns and board settings checked like the server
 * does (`dbschema.go`), and how a table lays out its columns.
 *
 * Pure: runs under `node --test`.
 */

/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").Sort} Sort */
/** @typedef {import("../api/types.js").Column} Column */
/** @typedef {import("../api/types.js").View} View */

export const MIN_COLUMN_WIDTH = 60;
export const MAX_COLUMN_WIDTH = 1000;
export const MAX_COLUMNS = 200;
export const MAX_VIEW_NAME = 200;
export const DEFAULT_COLUMN_WIDTH = 180;
export const DEFAULT_TITLE_WIDTH = 280;
export const MAX_HIDDEN_GROUPS = MAX_OPTIONS + 1;
/** Rows a table shows per page when its view doesn't say. */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;
/** The page sizes the table offers. */
export const PAGE_SIZES = [10, 25, 50, 100, 250, 500];

/** @typedef {import("../api/types.js").ViewType} ViewType */

/**
 * A view with empty settings.
 * @param {string} id @param {string} name @param {ViewType} type @param {string} position
 * @returns {View}
 */
export function newView(id, name, type, position) {
  return {
    id,
    name,
    type,
    position,
    filter: null,
    sorts: [],
    columns: [],
    group_by: null,
    card_properties: [],
    hidden_groups: [],
    page_size: null,
  };
}

/**
 * A view as the API returns it, with the settings views saved before
 * boards don't have.
 * @param {Partial<View> & Pick<View, "id" | "name" | "position">} view
 * @returns {View}
 */
export function withDefaults(view) {
  return {
    ...newView(view.id, view.name, view.type ?? "table", view.position),
    ...view,
    group_by: view.group_by ?? null,
    card_properties: view.card_properties ?? [],
    hidden_groups: view.hidden_groups ?? [],
    page_size: view.page_size ?? null,
  };
}

/** Whether a board can group by a property: select and status. @param {Property | undefined} property */
export function canGroupBy(property) {
  return property?.type === "select" || property?.type === "status";
}

/**
 * What a new board groups by: the first status property, else the first
 * select property, else nothing.
 * @param {Property[]} schema
 * @returns {string | null}
 */
export function defaultGroupBy(schema) {
  return (
    (schema.find((p) => p.type === "status") ?? schema.find((p) => p.type === "select"))?.id ?? null
  );
}

/**
 * A view's group_by as the server stores it: null, or a select or status
 * property; an unknown property drops out.
 * @param {unknown} raw @param {Property[]} schema
 * @returns {string | null}
 */
export function parseGroupBy(raw, schema) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw invalidView("group_by is a property id or null");
  const property = schema.find((p) => p.id === raw);
  if (!property) return null;
  if (!canGroupBy(property)) throw invalidView("A board groups by a select or status property");
  return raw;
}

/**
 * A list of ids, keeping those `keep` accepts, each once.
 * @param {unknown} raw @param {string} field @param {number} max @param {(id: string) => boolean} keep
 * @returns {string[]}
 */
function parseIds(raw, field, max, keep) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string"))
    throw invalidView(`${field} is a list of ids`);
  if (raw.length > max) throw invalidView(`A view has at most ${max} ${field}`);
  /** @type {string[]} */
  const out = [];
  for (const id of raw) if (keep(id) && !out.includes(id)) out.push(id);
  return out;
}

/** The properties a board's cards show. @param {unknown} raw @param {Property[]} schema */
export function parseCardProperties(raw, schema) {
  return parseIds(
    raw,
    "card_properties",
    MAX_PROPERTIES,
    (id) => id !== TITLE_ID && schema.some((p) => p.id === id),
  );
}

/**
 * A board's hidden columns: option ids of its group_by property, "" for
 * rows without a value.
 * @param {unknown} raw @param {Property | undefined} groupBy
 */
export function parseHiddenGroups(raw, groupBy) {
  return parseIds(
    raw,
    "hidden_groups",
    MAX_HIDDEN_GROUPS,
    (id) => groupBy !== undefined && (id === "" || findOption(groupBy, id) !== undefined),
  );
}

/**
 * A view's board settings, still valid after a schema change: a group_by
 * property that's gone or can't group any more drops out (with the hidden
 * groups), as do cards' properties that are gone and hidden options that are.
 * @param {View} view @param {Property[]} schema
 * @returns {View}
 */
export function fitSchema(view, schema) {
  const groupBy = schema.find((p) => p.id === view.group_by);
  const group_by = view.group_by !== null && canGroupBy(groupBy) ? view.group_by : null;
  return {
    ...view,
    group_by,
    card_properties: view.card_properties.filter(
      (id) => id !== TITLE_ID && schema.some((p) => p.id === id),
    ),
    hidden_groups:
      group_by && groupBy
        ? view.hidden_groups.filter((id) => id === "" || findOption(groupBy, id))
        : [],
  };
}

/**
 * How many rows a table shows per page: null (the default) or 1–1000.
 * @param {unknown} raw
 * @returns {number | null}
 */
export function parsePageSize(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1 || raw > MAX_PAGE_SIZE)
    throw invalidView(`page_size is 1–${MAX_PAGE_SIZE} or null`);
  return raw;
}

/** The rows per page a view's table shows. @param {Pick<View, "page_size"> | undefined} view */
export function pageSizeOf(view) {
  const size = view?.page_size;
  return typeof size === "number" && size >= 1 ? size : DEFAULT_PAGE_SIZE;
}

/**
 * One page of a table: its first row's index, how many rows it has, and
 * how many pages there are (at least one). `page` past the end is the last.
 * @param {number} total @param {number} size @param {number} page
 */
export function pageSlice(total, size, page) {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.max(0, Math.min(page, pages - 1));
  const start = current * size;
  return { page: current, pages, start, count: Math.max(0, Math.min(size, total - start)) };
}

/** The page sizes to offer: the standard ones and the view's own. @param {number} current */
export function pageSizeChoices(current) {
  return PAGE_SIZES.includes(current) ? PAGE_SIZES : [...PAGE_SIZES, current].sort((a, b) => a - b);
}

/** @param {string} message */
export const invalidView = (message) => new ApiError(400, "invalid_view", message);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Sorts as a view stores them: on known properties, each property once.
 * @param {unknown} raw
 * @param {Property[]} schema
 * @returns {Sort[]}
 */
export function parseSorts(raw, schema) {
  if (!Array.isArray(raw) || !raw.every(isObject))
    throw invalidView("sorts is a list of {property_id, direction}");
  if (raw.length > MAX_SORTS) throw invalidView(`A view has at most ${MAX_SORTS} sorts`);
  /** @type {Sort[]} */
  const out = [];
  for (const sort of raw) {
    if (sort.direction !== "ascending" && sort.direction !== "descending") {
      throw invalidView("A sort's direction is ascending or descending");
    }
    const id = sort.property_id;
    if (
      typeof id !== "string" ||
      !schema.some((p) => p.id === id) ||
      out.some((s) => s.property_id === id)
    )
      continue;
    out.push({ property_id: id, direction: sort.direction });
  }
  return out;
}

/**
 * Columns as a view stores them: on known properties, each once.
 * @param {unknown} raw
 * @param {Property[]} schema
 * @returns {Column[]}
 */
export function parseColumns(raw, schema) {
  if (!Array.isArray(raw) || !raw.every(isObject))
    throw invalidView("columns is a list of {property_id, width?, hidden?}");
  if (raw.length > MAX_COLUMNS) throw invalidView(`A view has at most ${MAX_COLUMNS} columns`);
  /** @type {Column[]} */
  const out = [];
  for (const column of raw) {
    const width = column.width;
    if (
      width !== undefined &&
      width !== null &&
      (!Number.isInteger(width) ||
        /** @type {number} */ (width) < MIN_COLUMN_WIDTH ||
        /** @type {number} */ (width) > MAX_COLUMN_WIDTH)
    ) {
      throw invalidView(`Column widths are ${MIN_COLUMN_WIDTH}–${MAX_COLUMN_WIDTH}`);
    }
    if (column.hidden !== undefined && typeof column.hidden !== "boolean")
      throw invalidView("A column's hidden is true or false");
    const id = column.property_id;
    if (
      typeof id !== "string" ||
      !schema.some((p) => p.id === id) ||
      out.some((c) => c.property_id === id)
    )
      continue;
    /** @type {Column} */
    const next = { property_id: id };
    if (typeof width === "number") next.width = width;
    if (column.hidden === true) next.hidden = true;
    out.push(next);
  }
  return out;
}

/**
 * A table's columns, in order: the view's listed ones, then the rest of the
 * schema, each with its width and whether it's hidden.
 * @param {View} view
 * @param {Property[]} schema
 * @returns {{ property: Property, width: number, hidden: boolean }[]}
 */
export function layoutColumns(view, schema) {
  const byId = new Map(schema.map((p) => [p.id, p]));
  /** @type {{ property: Property, width: number, hidden: boolean }[]} */
  const out = [];
  const seen = new Set();
  for (const column of view.columns) {
    const property = byId.get(column.property_id);
    if (!property || seen.has(property.id)) continue;
    seen.add(property.id);
    out.push({
      property,
      width: column.width ?? defaultWidth(property),
      hidden: column.hidden === true,
    });
  }
  for (const property of schema) {
    if (!seen.has(property.id))
      out.push({ property, width: defaultWidth(property), hidden: false });
  }
  return out;
}

/** @param {Property} property */
export function defaultWidth(property) {
  return property.type === "title"
    ? DEFAULT_TITLE_WIDTH
    : property.type === "checkbox"
      ? 100
      : DEFAULT_COLUMN_WIDTH;
}

/**
 * The view's columns with one column changed (added to the list if it
 * wasn't in it yet), in full display order, so later schema changes don't
 * reorder what the user arranged.
 * @param {View} view
 * @param {Property[]} schema
 * @param {string} propertyId
 * @param {Partial<Pick<Column, "width" | "hidden">>} patch
 * @returns {Column[]}
 */
export function withColumn(view, schema, propertyId, patch) {
  return layoutColumns(view, schema).map(({ property, width, hidden }) => {
    /** @type {Column} */
    const column = { property_id: property.id };
    const w = property.id === propertyId && "width" in patch ? patch.width : width;
    const h = property.id === propertyId && "hidden" in patch ? patch.hidden : hidden;
    if (w !== undefined && w !== defaultWidth(property)) column.width = w;
    if (h) column.hidden = true;
    return column;
  });
}

/**
 * The view's columns after moving one to another place in display order.
 * @param {View} view
 * @param {Property[]} schema
 * @param {string} propertyId
 * @param {number} toIndex Index in the full layout, after removing the moved column.
 * @returns {Column[]}
 */
export function movedColumns(view, schema, propertyId, toIndex) {
  const columns = withColumn(view, schema, propertyId, {});
  const from = columns.findIndex((c) => c.property_id === propertyId);
  if (from < 0) return columns;
  const [moved] = columns.splice(from, 1);
  columns.splice(Math.max(0, Math.min(toIndex, columns.length)), 0, moved);
  return columns;
}
