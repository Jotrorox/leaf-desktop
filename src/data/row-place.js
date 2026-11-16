// @ts-check
import { matchesGroup } from "../databases/query.js";
import { hashKey } from "../lib/query/key.js";

/**
 * Where a changed row goes in a database's cached queries, before the
 * server answers (`data/databases.js` applies it as optimistic updates).
 * Tables, and other queries without a group, change the row in place. A
 * board column whose group the row leaves loses it; one it joins gets it
 * (at the end, if the column's last chunk is loaded); with `target` it
 * goes to that place in that column. Totals follow.
 *
 * Each update is a function of its own entry's data, so it still does the
 * right thing when re-applied over fresh server data: removing is a no-op
 * when the row is gone, and inserting when it's there.
 *
 * Pure: runs under `node --test`.
 */

/** @typedef {import("../api/types.js").Row} Row */
/** @typedef {import("../api/types.js").RowPage} RowPage */
/** @typedef {import("../api/types.js").RowGroup} RowGroup */
/** @typedef {import("../lib/query/key.js").QueryKey} QueryKey */
/** @typedef {{ filter: unknown, sorts: unknown, group?: RowGroup }} RowQuery */

/** @param {QueryKey} key */
const queryOfKey = (key) => /** @type {RowQuery} */ (key[2]);

/**
 * @param {{
 *   keys: QueryKey[],
 *   get: (key: QueryKey) => unknown,
 *   before: Row,
 *   change: (row: Row) => Row,
 *   target?: { query: RowQuery, index: number },
 *   chunkSize: number,
 * }} input `keys`: the database's cached row queries, `["rows", id, query, chunk]`.
 *   `before`: the row as the caches have it now. `change`: applied to it
 *   wherever it's cached. `target.index`: its place among the target
 *   column's cards, the moved one left out.
 * @returns {{ key: QueryKey, update: (page: RowPage | undefined) => RowPage | undefined }[]}
 */
export function planPlacement({ keys, get, before, change, target, chunkSize }) {
  const id = before.id;
  const after = change(before);
  /** @type {{ key: QueryKey, update: (page: RowPage | undefined) => RowPage | undefined }[]} */
  const updates = [];
  /** @type {Map<string, QueryKey[]>} */
  const byQuery = new Map();
  for (const key of keys) {
    const q = queryOfKey(key);
    if (!q.group) {
      updates.push({
        key,
        update: (page) =>
          page && page.rows.some((row) => row.id === id)
            ? { ...page, rows: page.rows.map((row) => (row.id === id ? change(row) : row)) }
            : page,
      });
      continue;
    }
    const hash = hashKey([q]);
    byQuery.set(hash, [...(byQuery.get(hash) ?? []), key]);
  }
  const targetHash = target ? hashKey([target.query]) : null;
  for (const [hash, group] of byQuery) {
    const q = queryOfKey(group[0]);
    const rowGroup = /** @type {RowGroup} */ (q.group);
    const was = matchesGroup(before, rowGroup);
    const is = matchesGroup(after, rowGroup);
    const delta = Number(is) - Number(was);
    const isTarget = target !== undefined && hash === targetHash;
    const chunks = group.map((key) => /** @type {number} */ (key[3]));
    let insertChunk = -1;
    let insertAt = 0;
    if (is && isTarget && target) {
      insertChunk = Math.min(Math.floor(target.index / chunkSize), Math.max(...chunks));
      insertAt = target.index - insertChunk * chunkSize;
    } else if (is && !was) {
      const first = /** @type {RowPage | undefined} */ (get([...group[0].slice(0, 3), 0]));
      const last = first ? Math.floor(first.total / chunkSize) : -1;
      if (chunks.includes(last)) {
        insertChunk = last;
        insertAt = Infinity;
      }
    }
    for (const key of group) {
      const chunk = /** @type {number} */ (key[3]);
      updates.push({
        key,
        update(page) {
          if (!page) return page;
          const had = page.rows.some((row) => row.id === id);
          let rows = page.rows;
          if (!is || isTarget) rows = rows.filter((row) => row.id !== id);
          else if (had) rows = rows.map((row) => (row.id === id ? change(row) : row));
          if (chunk === insertChunk && !rows.some((row) => row.id === id)) {
            rows = [...rows];
            rows.splice(
              Math.min(insertAt, rows.length),
              0,
              had ? change(/** @type {Row} */ (page.rows.find((row) => row.id === id))) : after,
            );
          }
          if (rows === page.rows && delta === 0) return page;
          return { rows, total: Math.max(rows.length, page.total + delta) };
        },
      });
    }
  }
  return updates;
}
