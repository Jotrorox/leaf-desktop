// @ts-check
import { createEffect, createMemo, onCleanup, untrack } from "solid-js";
import * as api from "../api/databases.js";
import {
  restorePage as apiRestorePage,
  trashPage as apiTrashPage,
  updatePage as apiUpdatePage,
} from "../api/pages.js";
import { matchesGroup, pruneFilter } from "../databases/query.js";
import {
  changeType,
  defaultStatusOptions,
  isOptionType,
  keepOptions,
  newShortId,
  nthColor,
} from "../databases/schema.js";
import { defaultGroupBy, newView, withDefaults } from "../databases/views.js";
import { keyBetween } from "../lib/fractional-index.js";
import {
  createMutation,
  createQuery,
  invalidate,
  queryClient,
  readQuery,
} from "../lib/query/index.js";
import { readStorage, writeStorage } from "../lib/storage.js";
import { dismissToast, toast } from "../ui/Toast.jsx";
import { displayTitle, failed, newPageId, keys as pageKeys, pageScope } from "./pages.js";
import { planPlacement } from "./row-place.js";

/**
 * Databases: their schema and views, their rows (loaded a chunk at a time
 * as the table scrolls), and the mutations that change them. Every
 * mutation is optimistic, like the page tree's (`data/pages.js`): the table
 * changes at once, and a failure rolls back exactly that change with a toast.
 *
 * Cache layout:
 * - `["database", id]`: Database (schema and views)
 * - `["rows", id, { filter, sorts }, chunk]`: RowPage, rows `chunk * CHUNK_SIZE` on
 * - `["rows", id, { filter, sorts, group }, chunk]`: the same for one board column
 * - `["members", workspaceId]`: Member[]
 * - rows are pages too: `["page", rowId]` once a row is opened
 *
 * Scopes: schema and view writes share `database:<id>`; row writes take
 * `rows:<id>` (chunk fetches wait for it) and the database's scope too, so
 * a value never reaches the server before the option it uses.
 */

/** @typedef {import("../api/types.js").Database} Database */
/** @typedef {import("../api/types.js").View} View */
/** @typedef {import("../api/types.js").Row} Row */
/** @typedef {import("../api/types.js").RowPage} RowPage */
/** @typedef {import("../api/types.js").Property} Property */
/** @typedef {import("../api/types.js").PropertyValue} PropertyValue */
/** @typedef {import("../api/types.js").Page} Page */
/** @typedef {import("../api/types.js").Member} Member */
/** @typedef {import("../lib/query/key.js").QueryKey} QueryKey */
/** @typedef {import("../api/types.js").RowGroup} RowGroup */
/** @typedef {{ filter: View["filter"], sorts: View["sorts"], group?: RowGroup }} RowQuery */

/** Rows per request. The table asks for the chunks around what's on screen. */
export const CHUNK_SIZE = 100;

export const dbKeys = {
  /** @param {string} id */
  database: (id) => ["database", id],
  /** @param {string} id */
  rowsAll: (id) => ["rows", id],
  /** @param {string} id @param {RowQuery} query @param {number} chunk */
  rows: (id, query, chunk) => ["rows", id, query, chunk],
  /** @param {string} workspaceId */
  members: (workspaceId) => ["members", workspaceId],
};

const STALE_TIME = { database: 30_000, rows: 30_000, members: 5 * 60_000 };

/** @param {string} id */
const dbScope = (id) => `database:${id}`;
/** @param {string} id */
const rowsScope = (id) => `rows:${id}`;

// Fetchers

/** @param {{ key: QueryKey, signal: AbortSignal }} context @returns {Promise<Database>} */
async function fetchDatabase({ key, signal }) {
  const id = /** @type {string} */ (key[1]);
  // A database that's still being created (its page) isn't there yet.
  await queryClient.whenIdle(pageScope(id));
  await queryClient.whenIdle(dbScope(id));
  const db = await api.getDatabase(id, { signal });
  // A server from before boards sends views without their settings.
  return { ...db, views: db.views.map(withDefaults) };
}

/** @param {{ key: QueryKey, signal: AbortSignal }} context @returns {Promise<RowPage>} */
async function fetchChunk({ key, signal }) {
  const [, id, query, chunk] = /** @type {[string, string, RowQuery, number]} */ (key);
  await queryClient.whenIdle(rowsScope(id));
  return api.queryDatabase(
    id,
    {
      filter: query.filter,
      sorts: query.sorts,
      group: query.group ?? null,
      offset: chunk * CHUNK_SIZE,
      limit: CHUNK_SIZE,
    },
    { signal },
  );
}

/** @param {{ key: QueryKey, signal: AbortSignal }} context @returns {Promise<Member[]>} */
function fetchMembers({ key, signal }) {
  return api.listMembers(/** @type {string} */ (key[1]), { signal });
}

// Hooks

/** @param {() => string | undefined} id */
export function useDatabase(id) {
  return createQuery(
    () => {
      const current = id();
      return current ? dbKeys.database(current) : null;
    },
    fetchDatabase,
    { staleTime: STALE_TIME.database },
  );
}

/** @param {() => string | undefined} workspaceId */
export function useMembers(workspaceId) {
  return createQuery(
    () => {
      const ws = workspaceId();
      return ws ? dbKeys.members(ws) : null;
    },
    fetchMembers,
    { staleTime: STALE_TIME.members },
  );
}

/**
 * A view's rows, loaded a chunk at a time: the first chunk always (it
 * gives the total), and those overlapping `range` (row indexes, end
 * exclusive), one chunk of slack on each side.
 * @param {() => string} databaseId
 * @param {() => RowQuery} query
 * @param {() => { start: number, end: number }} range
 */
export function useRows(databaseId, query, range) {
  const needed = createMemo(
    () => {
      const { start, end } = range();
      const first = Math.max(0, Math.floor(start / CHUNK_SIZE) - 1);
      const last = Math.max(first, Math.floor(Math.max(start, end - 1) / CHUNK_SIZE) + 1);
      const out = [0];
      for (let i = Math.max(1, first); i <= last; i++) out.push(i);
      return out;
    },
    [0],
    { equals: (a, b) => a.length === b.length && a.every((n, i) => n === b[i]) },
  );
  // The query, compared by value: a new but equal object doesn't refetch.
  const stableQuery = createMemo(query, undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });

  createEffect(() => {
    const id = databaseId();
    const q = stableQuery();
    const chunks = needed();
    untrack(() => {
      const stops = chunks.map((chunk) => {
        const key = dbKeys.rows(id, q, chunk);
        const stop = queryClient.observe(key);
        queryClient.fetch(key, fetchChunk, { staleTime: STALE_TIME.rows }).catch(() => {});
        return stop;
      });
      onCleanup(() => stops.forEach((stop) => stop()));
    });
  });

  /** @param {number} chunk */
  const chunkData = (chunk) =>
    /** @type {RowPage | undefined} */ (readQuery(dbKeys.rows(databaseId(), stableQuery(), chunk)));
  const first = () => queryClient.getState(dbKeys.rows(databaseId(), stableQuery(), 0));

  return {
    /** Matching rows in all; undefined until the first chunk is in. */
    total: () => chunkData(0)?.total,
    /** @param {number} index */
    row: (index) => chunkData(Math.floor(index / CHUNK_SIZE))?.rows[index % CHUNK_SIZE],
    error: () => (readQuery(dbKeys.rows(databaseId(), stableQuery(), 0)), first().error),
    refetch: () => invalidate(dbKeys.rowsAll(databaseId())),
  };
}

/**
 * One board column's rows: its first `pages()` chunks, in order.
 * @param {() => string} databaseId
 * @param {() => RowQuery} query With the column's `group`.
 * @param {() => number} pages How many chunks to load (1 and up: "Load more" adds one).
 */
export function useColumnRows(databaseId, query, pages) {
  const stableQuery = createMemo(query, undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  createEffect(() => {
    const id = databaseId();
    const q = stableQuery();
    const count = Math.max(1, pages());
    untrack(() => {
      const stops = [];
      for (let chunk = 0; chunk < count; chunk++) {
        const key = dbKeys.rows(id, q, chunk);
        stops.push(queryClient.observe(key));
        queryClient.fetch(key, fetchChunk, { staleTime: STALE_TIME.rows }).catch(() => {});
      }
      onCleanup(() => stops.forEach((stop) => stop()));
    });
  });
  /** @param {number} chunk */
  const chunkData = (chunk) =>
    /** @type {RowPage | undefined} */ (readQuery(dbKeys.rows(databaseId(), stableQuery(), chunk)));
  return {
    /** Matching rows in all; undefined until the first chunk is in. */
    total: () => chunkData(0)?.total,
    /** The loaded rows, each once (a card moved between chunks can briefly be in two). */
    rows: createMemo(() => {
      /** @type {Row[]} */
      const out = [];
      const seen = new Set();
      for (let chunk = 0; chunk < Math.max(1, pages()); chunk++) {
        const data = chunkData(chunk);
        if (!data) break;
        for (const row of data.rows) {
          if (seen.has(row.id)) continue;
          seen.add(row.id);
          out.push(row);
        }
      }
      return out;
    }),
    /** Some of the asked-for chunks are still loading. */
    loading: () => {
      for (let chunk = 0; chunk < Math.max(1, pages()); chunk++) if (!chunkData(chunk)) return true;
      return false;
    },
    error: () => (
      chunkData(0), queryClient.getState(dbKeys.rows(databaseId(), stableQuery(), 0)).error
    ),
  };
}

// The view a viewer last had open, per database (this browser only).

/** @param {string} databaseId @returns {string | undefined} */
export function rememberedView(databaseId) {
  const value = readStorage(`leaf.db.view.${databaseId}`);
  return typeof value === "string" ? value : undefined;
}

/** @param {string} databaseId @param {string} viewId */
export function rememberView(databaseId, viewId) {
  writeStorage(`leaf.db.view.${databaseId}`, viewId);
}

// Helpers

/**
 * @param {RowPage | undefined} page
 * @param {string} id
 * @param {(row: Row) => Row} change
 */
function patchRowIn(page, id, change) {
  if (!page || !page.rows.some((row) => row.id === id)) return page;
  return { ...page, rows: page.rows.map((row) => (row.id === id ? change(row) : row)) };
}

/**
 * Applies values to a row's: null clears one.
 * @param {Record<string, PropertyValue>} values
 * @param {Record<string, PropertyValue | null>} patch
 */
function mergeValues(values, patch) {
  const next = { ...values };
  for (const [id, value] of Object.entries(patch)) {
    if (
      value === null ||
      value === "" ||
      value === false ||
      (Array.isArray(value) && value.length === 0)
    )
      delete next[id];
    else next[id] = value;
  }
  return next;
}

/** @param {QueryKey} key */
const queryOfKey = (key) => /** @type {RowQuery} */ (key[2]);

/**
 * Optimistically changes a row in every cached query of its database (see
 * `placeRow` in `row-place.js`).
 * @param {import("../lib/query/mutation.js").OptimisticTx} tx
 * @param {string} databaseId
 * @param {Row} before The row as the caches have it now.
 * @param {(row: Row) => Row} change
 * @param {{ query: RowQuery, index: number }} [target]
 */
function placeRow(tx, databaseId, before, change, target) {
  const keys = queryClient.keys(dbKeys.rowsAll(databaseId));
  for (const { key, update } of planPlacement({
    keys,
    get: tx.get,
    before,
    change,
    target,
    chunkSize: CHUNK_SIZE,
  }))
    tx.update(key, update);
}

/** Every cached board column query of a database, as keys to invalidate. @param {string} databaseId */
function columnKeys(databaseId) {
  return queryClient.keys(dbKeys.rowsAll(databaseId)).filter((key) => queryOfKey(key).group);
}

/** @param {string} id @returns {Database | undefined} */
export function cachedDatabase(id) {
  return queryClient.getData(dbKeys.database(id));
}

// Rows

/**
 * @typedef {object} AddRowVars
 * @property {string} databaseId
 * @property {string} workspaceId
 * @property {string} id
 * @property {string} title
 * @property {Record<string, PropertyValue>} properties
 */

const addRowMut = createMutation({
  /** @param {AddRowVars} vars */
  mutationFn: (vars) =>
    api.createRow(vars.databaseId, { id: vars.id, title: vars.title, properties: vars.properties }),
  scope: (vars) => [pageScope(vars.id), rowsScope(vars.databaseId), dbScope(vars.databaseId)],
  optimistic(vars, tx) {
    const now = new Date().toISOString();
    /** @type {Row} */
    const row = {
      id: vars.id,
      database_id: vars.databaseId,
      title: vars.title,
      icon: null,
      properties: vars.properties,
      position: "",
      created_at: now,
      updated_at: now,
    };
    // At the end of every cached query (board columns: those it's in): the
    // total grows, and the last chunk gets it.
    const keys = queryClient.keys(dbKeys.rowsAll(vars.databaseId)).filter((key) => {
      const group = queryOfKey(key).group;
      return !group || matchesGroup(row, group);
    });
    for (const key of keys)
      tx.update(key, (/** @type {RowPage | undefined} */ page) =>
        page ? { ...page, total: page.total + 1 } : page,
      );
    for (const key of keys) {
      const page = /** @type {RowPage | undefined} */ (tx.get(key));
      const chunk = /** @type {number} */ (key[3]);
      if (page && Math.floor((page.total - 1) / CHUNK_SIZE) === chunk) {
        tx.update(key, (/** @type {RowPage | undefined} */ p) =>
          p && !p.rows.some((r) => r.id === row.id) ? { ...p, rows: [...p.rows, row] } : p,
        );
      }
    }
    /** @type {Page} */
    const page = {
      id: vars.id,
      workspace_id: vars.workspaceId,
      parent_id: vars.databaseId,
      title: vars.title,
      icon: null,
      cover: null,
      position: "",
      has_children: false,
      archived_at: null,
      created_at: now,
      updated_at: now,
      kind: "row",
      properties: vars.properties,
    };
    tx.update(pageKeys.page(vars.id), (old) => old ?? page);
  },
  onSuccess(row) {
    for (const key of queryClient.keys(dbKeys.rowsAll(row.database_id))) {
      queryClient.setData(key, (/** @type {RowPage | undefined} */ page) =>
        patchRowIn(page, row.id, () => row),
      );
    }
  },
  onError: (error) => failed("Couldn't add the row", error),
});

/**
 * Adds a row at the end; returns its id at once.
 * @param {{ databaseId: string, workspaceId: string, title?: string, properties?: Record<string, PropertyValue> }} input
 */
export function addRow({ databaseId, workspaceId, title = "", properties = {} }) {
  const id = newPageId();
  void addRowMut.mutate({ databaseId, workspaceId, id, title, properties });
  return id;
}

/**
 * @typedef {object} UpdateRowVars
 * @property {string} databaseId
 * @property {string} id
 * @property {{ title?: string, icon?: string | null, properties?: Record<string, PropertyValue | null> }} patch
 */

const updateRowMut = createMutation({
  /** @param {UpdateRowVars} vars */
  mutationFn: (vars) => apiUpdatePage(vars.id, vars.patch),
  scope: (vars) => [pageScope(vars.id), rowsScope(vars.databaseId), dbScope(vars.databaseId)],
  optimistic(vars, tx) {
    /** @param {Row} row @returns {Row} */
    const change = (row) => {
      const next = { ...row };
      if (vars.patch.title !== undefined) next.title = vars.patch.title;
      if (vars.patch.icon !== undefined) next.icon = vars.patch.icon;
      if (vars.patch.properties)
        next.properties = mergeValues(row.properties, vars.patch.properties);
      return next;
    };
    // The row as it is now: from any cached query that has it.
    /** @type {Row | undefined} */
    let current;
    for (const key of queryClient.keys(dbKeys.rowsAll(vars.databaseId))) {
      current = /** @type {RowPage | undefined} */ (tx.get(key))?.rows.find(
        (row) => row.id === vars.id,
      );
      if (current) break;
    }
    if (current) placeRow(tx, vars.databaseId, current, change);
    const pageKey = pageKeys.page(vars.id);
    if (queryClient.getData(pageKey) !== undefined) {
      tx.update(pageKey, (/** @type {Page | undefined} */ page) => {
        if (!page) return page;
        const next = { ...page };
        if (vars.patch.title !== undefined) next.title = vars.patch.title;
        if (vars.patch.icon !== undefined) next.icon = vars.patch.icon;
        if (vars.patch.properties)
          next.properties = mergeValues(page.properties ?? {}, vars.patch.properties);
        return next;
      });
    }
  },
  onSuccess(page, vars) {
    if (queryClient.getData(pageKeys.page(page.id)) !== undefined)
      queryClient.setData(pageKeys.page(page.id), page);
    for (const key of queryClient.keys(dbKeys.rowsAll(vars.databaseId))) {
      queryClient.setData(key, (/** @type {RowPage | undefined} */ rows) =>
        patchRowIn(rows, page.id, (row) => ({
          ...row,
          title: page.title,
          icon: page.icon,
          properties: page.properties ?? row.properties,
          updated_at: page.updated_at,
        })),
      );
    }
  },
  onError: (error, vars) =>
    failed("title" in vars.patch ? "Couldn't rename the row" : "Couldn't save the change", error),
  // A value change can move the row to another board column: get its place there.
  invalidates: (vars) => (vars.patch.properties ? columnKeys(vars.databaseId) : []),
});

/**
 * @typedef {object} MoveCardVars
 * @property {string} databaseId
 * @property {Row} row As it was.
 * @property {Record<string, PropertyValue | null>} [properties] Its new column's value.
 * @property {string | null} [after] Its place in the manual order (null: first); missing: unchanged.
 * @property {{ query: RowQuery, index: number }} target The column it goes to, and where it shows there.
 */

const moveCardMut = createMutation({
  /** @param {MoveCardVars} vars */
  mutationFn: (vars) =>
    api.moveRow(vars.databaseId, vars.row.id, {
      ...(vars.after !== undefined && { after_id: vars.after }),
      ...(vars.properties && { properties: vars.properties }),
    }),
  scope: (vars) => [pageScope(vars.row.id), rowsScope(vars.databaseId), dbScope(vars.databaseId)],
  optimistic(vars, tx) {
    const properties = vars.properties;
    placeRow(
      tx,
      vars.databaseId,
      vars.row,
      (row) => (properties ? { ...row, properties: mergeValues(row.properties, properties) } : row),
      vars.target,
    );
    const pageKey = pageKeys.page(vars.row.id);
    if (properties && queryClient.getData(pageKey) !== undefined) {
      tx.update(
        pageKey,
        (/** @type {Page | undefined} */ page) =>
          page && { ...page, properties: mergeValues(page.properties ?? {}, properties) },
      );
    }
  },
  onSuccess(row) {
    for (const key of queryClient.keys(dbKeys.rowsAll(row.database_id))) {
      queryClient.setData(key, (/** @type {RowPage | undefined} */ page) =>
        patchRowIn(page, row.id, () => row),
      );
    }
    const pageKey = pageKeys.page(row.id);
    if (queryClient.getData(pageKey) !== undefined) {
      queryClient.setData(
        pageKey,
        (/** @type {Page | undefined} */ page) =>
          page && { ...page, properties: row.properties, updated_at: row.updated_at },
      );
    }
  },
  onError: (error) => failed("Couldn't move the card", error),
  // The manual order changed: tables without sorts show it too.
  invalidates: (vars) => [dbKeys.rowsAll(vars.databaseId)],
});

/**
 * Moves a card on a board: to another column (`properties`), to another
 * place in the manual order (`after`), or both, in one request.
 * @param {MoveCardVars} vars
 */
export function moveCard(vars) {
  return moveCardMut.mutate(vars);
}

/**
 * Changes a row's title, icon or values (null clears a value).
 * @param {string} databaseId
 * @param {string} id
 * @param {UpdateRowVars["patch"]} patch
 */
export function updateRow(databaseId, id, patch) {
  return updateRowMut.mutate({ databaseId, id, patch });
}

const trashRowsMut = createMutation({
  /** @param {{ databaseId: string, workspaceId: string, ids: string[] }} vars */
  async mutationFn(vars) {
    for (const id of vars.ids) await apiTrashPage(id);
  },
  scope: (vars) => [rowsScope(vars.databaseId), ...vars.ids.map(pageScope)],
  optimistic(vars, tx) {
    const gone = new Set(vars.ids);
    tx.updateAll(dbKeys.rowsAll(vars.databaseId), (/** @type {RowPage | undefined} */ page) => {
      if (!page) return page;
      const rows = page.rows.filter((row) => !gone.has(row.id));
      // Rows in chunks that aren't loaded can't be counted out.
      return { rows, total: Math.max(rows.length, page.total - (page.rows.length - rows.length)) };
    });
  },
  onError: (error, vars) =>
    failed(vars.ids.length === 1 ? "Couldn't delete the row" : "Couldn't delete the rows", error),
  // Later chunks shifted; the trash has them now.
  invalidates: (vars) => [
    dbKeys.rowsAll(vars.databaseId),
    pageKeys.trash(vars.workspaceId),
    ...vars.ids.map((id) => pageKeys.page(id)),
  ],
});

/**
 * Moves rows to the trash, with an Undo toast.
 * @param {{ databaseId: string, workspaceId: string, ids: string[], title?: string }} input
 */
export async function trashRows({ databaseId, workspaceId, ids, title }) {
  if (ids.length === 0) return;
  const label =
    ids.length === 1 ? `Deleted “${displayTitle(title ?? "")}”` : `Deleted ${ids.length} rows`;
  const toastId = toast({
    title: label,
    action: { label: "Undo", onClick: () => void restoreRows({ databaseId, workspaceId, ids }) },
  });
  try {
    await trashRowsMut.mutateAsync({ databaseId, workspaceId, ids });
  } catch {
    dismissToast(toastId);
  }
}

const restoreRowsMut = createMutation({
  /** @param {{ databaseId: string, workspaceId: string, ids: string[] }} vars */
  async mutationFn(vars) {
    for (const id of vars.ids) await apiRestorePage(id);
  },
  scope: (vars) => [rowsScope(vars.databaseId), ...vars.ids.map(pageScope)],
  onError: (error) => failed("Couldn't restore the rows", error),
  invalidates: (vars) => [
    dbKeys.rowsAll(vars.databaseId),
    pageKeys.trash(vars.workspaceId),
    ...vars.ids.map((id) => pageKeys.page(id)),
  ],
});

/** @param {{ databaseId: string, workspaceId: string, ids: string[] }} input */
export function restoreRows(input) {
  return restoreRowsMut.mutate(input);
}

// Properties

/**
 * @typedef {object} SchemaVars
 * @property {string} databaseId
 * @property {string} what For the error toast.
 * @property {(db: Database) => Database} change The optimistic change.
 * @property {() => Promise<Database>} send
 * @property {boolean} [refetchRows] Values change on the server (type change).
 * @property {(rows: RowPage) => RowPage} [changeRows] What the change does to cached rows.
 */

const schemaMut = createMutation({
  /** @param {SchemaVars} vars */
  mutationFn: (vars) => vars.send(),
  scope: (vars) => dbScope(vars.databaseId),
  optimistic(vars, tx) {
    tx.update(
      dbKeys.database(vars.databaseId),
      (/** @type {Database | undefined} */ db) => db && vars.change(db),
    );
    const changeRows = vars.changeRows;
    if (changeRows)
      tx.updateAll(
        dbKeys.rowsAll(vars.databaseId),
        (/** @type {RowPage | undefined} */ page) => page && changeRows(page),
      );
  },
  onSuccess(db) {
    queryClient.setData(dbKeys.database(db.id), db);
  },
  onError: (error, vars) => failed(vars.what, error),
  invalidates: (vars) => (vars.refetchRows ? [dbKeys.rowsAll(vars.databaseId)] : []),
});

/**
 * @param {Database} db
 * @param {string} propertyId
 * @param {(property: Property) => Property} change
 * @returns {Database}
 */
function withProperty(db, propertyId, change) {
  return { ...db, properties: db.properties.map((p) => (p.id === propertyId ? change(p) : p)) };
}

/**
 * Adds a property; returns its id.
 * @param {string} databaseId
 * @param {{ name: string, type: Property["type"] }} input
 */
export function addProperty(databaseId, { name, type }) {
  const id = newShortId();
  /** @type {Property} */
  const property = { id, name, type };
  if (isOptionType(type))
    property.options = type === "status" ? defaultStatusOptions(newShortId) : [];
  void schemaMut.mutate({
    databaseId,
    what: `Couldn't add “${name}”`,
    change: (db) =>
      db.properties.some((p) => p.id === id)
        ? db
        : { ...db, properties: [...db.properties, property] },
    send: () =>
      api.addProperty(databaseId, {
        id,
        name,
        type,
        ...(property.options && { options: property.options }),
      }),
  });
  return id;
}

/**
 * Renames a property.
 * @param {string} databaseId @param {string} propertyId @param {string} name
 */
export function renameProperty(databaseId, propertyId, name) {
  return schemaMut.mutate({
    databaseId,
    what: "Couldn't rename the property",
    change: (db) => withProperty(db, propertyId, (p) => ({ ...p, name })),
    send: () => api.updateProperty(databaseId, propertyId, { name }),
  });
}

/**
 * Changes a property's type. The server converts every row's value; the
 * rows are refetched once it has.
 * @param {string} databaseId @param {Property} property @param {Property["type"]} type
 */
export function changePropertyType(databaseId, property, type) {
  // Between option types the options carry over; otherwise they come from
  // the values, which only the server has all of.
  const preview = changeType(property, type, [], newShortId).property;
  return schemaMut.mutate({
    databaseId,
    what: `Couldn't change the type of “${property.name}”`,
    change: (db) => ({
      ...withProperty(db, property.id, () => preview),
      views: db.views.map((view) => ({ ...view, filter: pruneFilter(view.filter, property.id) })),
    }),
    send: () => api.updateProperty(databaseId, property.id, { type }),
    refetchRows: true,
  });
}

/**
 * Replaces a property's options. Values using a removed option lose it.
 * @param {string} databaseId @param {Property} property @param {NonNullable<Property["options"]>} options
 */
export function setOptions(databaseId, property, options) {
  const next = { ...property, options };
  const removed = (property.options ?? []).some((o) => !options.some((x) => x.id === o.id));
  return schemaMut.mutate({
    databaseId,
    what: `Couldn't change the options of “${property.name}”`,
    change: (db) => withProperty(db, property.id, (p) => ({ ...p, options })),
    send: () => api.updateProperty(databaseId, property.id, { options }),
    // Rows that had a removed option go to their boards' "No ..." columns.
    refetchRows: removed,
    changeRows: (page) => {
      let changed = false;
      const rows = page.rows.map((row) => {
        const value = row.properties[property.id];
        if (value === undefined) return row;
        const kept = keepOptions(next, value);
        if (JSON.stringify(kept) === JSON.stringify(value)) return row;
        changed = true;
        const properties = { ...row.properties };
        if (kept === null) delete properties[property.id];
        else properties[property.id] = kept;
        return { ...row, properties };
      });
      return changed ? { ...page, rows } : page;
    },
  });
}

/**
 * Adds an option (and returns it), e.g. a new tag typed into a cell. Its
 * value can be set right away: row writes wait for schema writes.
 * @param {string} databaseId @param {Property} property @param {string} name
 */
export function addOption(databaseId, property, name) {
  const options = property.options ?? [];
  /** @type {import("../api/types.js").SelectOption} */
  const option = { id: newShortId(), name, color: nthColor(options.length) };
  if (property.type === "status") option.group = "to_do";
  void setOptions(databaseId, property, [...options, option]);
  return option;
}

/** @param {string} databaseId @param {Property} property */
export function deleteProperty(databaseId, property) {
  return schemaMut.mutate({
    databaseId,
    what: `Couldn't delete “${property.name}”`,
    change: (db) => ({
      ...db,
      properties: db.properties.filter((p) => p.id !== property.id),
      views: db.views.map((view) => ({
        ...view,
        filter: pruneFilter(view.filter, property.id),
        sorts: view.sorts.filter((s) => s.property_id !== property.id),
        columns: view.columns.filter((c) => c.property_id !== property.id),
      })),
    }),
    send: () => api.deleteProperty(databaseId, property.id),
  });
}

// Views

/**
 * @typedef {object} ViewVars
 * @property {string} databaseId
 * @property {string} viewId
 * @property {import("../api/databases.js").ViewPatch} patch
 */

const updateViewMut = createMutation({
  /** @param {ViewVars} vars */
  mutationFn: (vars) => api.updateView(vars.databaseId, vars.viewId, vars.patch),
  scope: (vars) => dbScope(vars.databaseId),
  optimistic(vars, tx) {
    tx.update(
      dbKeys.database(vars.databaseId),
      (/** @type {Database | undefined} */ db) =>
        db && {
          ...db,
          views: db.views.map((view) =>
            view.id === vars.viewId ? { ...view, ...vars.patch } : view,
          ),
        },
    );
  },
  onSuccess(view, vars) {
    queryClient.setData(
      dbKeys.database(vars.databaseId),
      (/** @type {Database | undefined} */ db) =>
        db && { ...db, views: db.views.map((v) => (v.id === view.id ? view : v)) },
    );
  },
  onError: (error) => failed("Couldn't change the view", error),
});

/**
 * Changes a view's name, type, filter, sorts, columns or board settings.
 * @param {string} databaseId @param {string} viewId @param {ViewVars["patch"]} patch
 */
export function updateView(databaseId, viewId, patch) {
  return updateViewMut.mutate({ databaseId, viewId, patch });
}

const createViewMut = createMutation({
  /** @param {{ databaseId: string, view: View }} vars */
  mutationFn: (vars) => {
    const { id, name, type, filter, sorts, columns, group_by, card_properties, hidden_groups } =
      vars.view;
    return api.createView(vars.databaseId, {
      id,
      name,
      type,
      filter,
      sorts,
      columns,
      group_by,
      card_properties,
      hidden_groups,
    });
  },
  scope: (vars) => dbScope(vars.databaseId),
  optimistic(vars, tx) {
    tx.update(dbKeys.database(vars.databaseId), (/** @type {Database | undefined} */ db) =>
      db && !db.views.some((v) => v.id === vars.view.id)
        ? { ...db, views: [...db.views, vars.view] }
        : db,
    );
  },
  onSuccess(view, vars) {
    queryClient.setData(
      dbKeys.database(vars.databaseId),
      (/** @type {Database | undefined} */ db) =>
        db && { ...db, views: db.views.map((v) => (v.id === view.id ? view : v)) },
    );
  },
  onError: (error) => failed("Couldn't add the view", error),
});

/**
 * The properties a new board's cards show: a few that fit on a card.
 * @param {Property[]} schema @param {string | null} groupBy
 */
export function defaultCardProperties(schema, groupBy) {
  const fits = ["select", "status", "person", "date"];
  return schema
    .filter((p) => p.id !== groupBy && fits.includes(p.type))
    .slice(0, 3)
    .map((p) => p.id);
}

/**
 * Adds a view (a table, or a board grouped by the first status or select
 * property), optionally copying another's settings; returns its id.
 * @param {string} databaseId @param {{ name: string, type?: View["type"], from?: View }} input
 */
export function createView(databaseId, { name, type, from }) {
  const db = cachedDatabase(databaseId);
  const last = db?.views.at(-1)?.position ?? null;
  const schema = db?.properties ?? [];
  /** @type {View} */
  const view = from
    ? { ...structuredClone(from), id: newShortId(), name, position: keyBetween(last, null) }
    : newView(newShortId(), name, type ?? "table", keyBetween(last, null));
  if (!from && view.type === "board") {
    view.group_by = defaultGroupBy(schema);
    view.card_properties = defaultCardProperties(schema, view.group_by);
  }
  void createViewMut.mutate({ databaseId, view });
  return view.id;
}

const deleteViewMut = createMutation({
  /** @param {{ databaseId: string, viewId: string }} vars */
  mutationFn: (vars) => api.deleteView(vars.databaseId, vars.viewId),
  scope: (vars) => dbScope(vars.databaseId),
  optimistic(vars, tx) {
    tx.update(
      dbKeys.database(vars.databaseId),
      (/** @type {Database | undefined} */ db) =>
        db && { ...db, views: db.views.filter((v) => v.id !== vars.viewId) },
    );
  },
  onError: (error) => failed("Couldn't delete the view", error),
});

/** @param {string} databaseId @param {string} viewId */
export function deleteView(databaseId, viewId) {
  return deleteViewMut.mutate({ databaseId, viewId });
}
