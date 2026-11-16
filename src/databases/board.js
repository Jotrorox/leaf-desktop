// @ts-check
import { findOption } from "./schema.js";
import { canGroupBy } from "./views.js";

/**
 * Boards: a view's rows as cards in columns, one per option of its
 * group_by property (docs/databases.md, Section 3.1). Which columns there
 * are, which column a row is in, and what dropping a card does.
 *
 * Pure: runs under `node --test`.
 */

/** @typedef {import("../api/types.js").View} View */
/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").Row} Row */
/** @typedef {import("../api/types.js").RowGroup} RowGroup */
/** @typedef {import("../api/types.js").SelectOption} SelectOption */

/** The id of the column of rows without a value. */
export const NO_VALUE = "";

/**
 * @typedef {object} BoardColumn
 * @property {string} id An option id, or NO_VALUE.
 * @property {SelectOption | null} option
 * @property {boolean} hidden
 */

/**
 * The property a board groups by, if it still can.
 * @param {View} view @param {Property[]} schema
 * @returns {Property | undefined}
 */
export function groupProperty(view, schema) {
  const property = schema.find((p) => p.id === view.group_by);
  return canGroupBy(property) ? property : undefined;
}

/**
 * A board's columns, hidden ones too: "No <property>" first, then the
 * options in the property's order. None without a group_by property.
 * @param {View} view @param {Property[]} schema
 * @returns {BoardColumn[]}
 */
export function boardColumns(view, schema) {
  const property = groupProperty(view, schema);
  if (!property) return [];
  const hidden = new Set(view.hidden_groups);
  return [
    { id: NO_VALUE, option: null, hidden: hidden.has(NO_VALUE) },
    ...(property.options ?? []).map((option) => ({
      id: option.id,
      option,
      hidden: hidden.has(option.id),
    })),
  ];
}

/** A column's name. @param {Property} property @param {BoardColumn} column */
export function columnName(property, column) {
  return column.option?.name ?? `No ${property.name}`;
}

/**
 * The query narrowing rows to a column.
 * @param {string} propertyId @param {string} columnId
 * @returns {RowGroup}
 */
export function columnGroup(propertyId, columnId) {
  return { property_id: propertyId, value: columnId === NO_VALUE ? null : columnId };
}

/**
 * The column a row is in: its option, or NO_VALUE (also for an option the
 * property doesn't have, which can't happen once the server has cleared it).
 * @param {Pick<Row, "properties">} row @param {Property} property
 */
export function columnOf(row, property) {
  const value = row.properties[property.id];
  return typeof value === "string" && findOption(property, value) ? value : NO_VALUE;
}

/**
 * The properties a board's cards show, in the view's order.
 * @param {View} view @param {Property[]} schema
 * @returns {Property[]}
 */
export function cardProperties(view, schema) {
  return view.card_properties.flatMap((id) => schema.find((p) => p.id === id) ?? []);
}

/**
 * The view's card properties with one turned on (added last) or off.
 * @param {View} view @param {string} propertyId @param {boolean} shown
 */
export function withCardProperty(view, propertyId, shown) {
  const rest = view.card_properties.filter((id) => id !== propertyId);
  return shown ? [...rest, propertyId] : rest;
}

/** A hidden_groups list with one column hidden or shown. @param {View} view @param {string} columnId @param {boolean} hidden */
export function withHiddenGroup(view, columnId, hidden) {
  const rest = view.hidden_groups.filter((id) => id !== columnId);
  return hidden ? [...rest, columnId] : rest;
}

/**
 * @typedef {object} CardMove
 * @property {string | null} [after] The row it goes after in the manual
 *   order (null: first). Missing: its place doesn't change.
 * @property {string} [to] The column it goes to, if that's another one.
 * @property {number} index Where it shows in the target column's cards, the moved card left out.
 */

/**
 * What dropping a card does. `ids` are the target column's cards as shown
 * (the dragged one among them if it's the same column); `index` is the
 * gap it was dropped in, 0 (above the first) to `ids.length` (below the
 * last). With sorts the cards' order isn't manual: only the column can
 * change. Returns null when nothing changes.
 * @param {{ ids: readonly string[], cardId: string, from: string, to: string, index: number, sorted: boolean }} drop
 * @returns {CardMove | null}
 */
export function dropCard({ ids, cardId, from, to, index, sorted }) {
  const at = ids.indexOf(cardId);
  const rest = ids.filter((id) => id !== cardId);
  // The gaps on either side of the dragged card are the same place.
  const target = Math.max(0, Math.min(at >= 0 && at < index ? index - 1 : index, rest.length));
  const moved = from !== to;
  if (sorted) return moved ? { to, index: target } : null;
  if (!moved && at === target) return null;
  /** @type {CardMove} */
  const move = { after: target === 0 ? null : rest[target - 1], index: target };
  if (moved) move.to = to;
  return move;
}

/**
 * A list of ids with `id` taken out and put back at `index` (of the list
 * without it). For drawing a move before the server has it.
 * @param {readonly string[]} ids @param {string} id @param {number} index
 */
export function placeId(ids, id, index) {
  const rest = ids.filter((x) => x !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}
