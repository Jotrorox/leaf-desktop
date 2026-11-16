// @ts-check
import { createEffect, createMemo, onCleanup } from "solid-js";
import { ApiError } from "../api/client.js";
import * as api from "../api/pages.js";
import { createMutation, createQuery, queryClient, readQuery } from "../lib/query/index.js";
import { location, navigate } from "../lib/router/index.js";
import { dismissToast, toast } from "../ui/Toast.jsx";
import {
  insertByPosition,
  patchNode,
  placeNode,
  positionAfter,
  removeNode,
  toTreeNode,
  wouldCreateCycle,
} from "./tree-ops.js";

/**
 * Pages and workspaces: query keys, Solid hooks, and the mutations that
 * change them. Every mutation is optimistic: the sidebar, breadcrumbs, page
 * header and trash update at once, and a failure rolls back exactly that
 * change and shows a toast.
 *
 * Cache layout:
 * - `["workspaces"]`: Workspace[]
 * - `["tree", workspaceId, parentId | null]`: TreeNode[], one level each, loaded lazily
 * - `["page", id]`: Page
 * - `["trash", workspaceId]`: Page[]
 *
 * Writes are serialized per resource with mutation scopes: `page:<id>` for
 * the page itself, `children:<parent>` for a list of siblings. Fetchers wait
 * for their scope, so a read never overtakes a write still in flight (a GET
 * of a page that's still being created would 404).
 */

/** @typedef {import("../api/types.js").Page} Page */
/** @typedef {import("../api/types.js").TreeNode} TreeNode */
/** @typedef {import("../api/types.js").Workspace} Workspace */
/** @typedef {import("../lib/query/key.js").QueryKey} QueryKey */
/** @typedef {(key: QueryKey, update: (data: any) => any) => void} Update */

export const keys = {
  workspaces: () => ["workspaces"],
  /** @param {string} workspaceId */
  treeAll: (workspaceId) => ["tree", workspaceId],
  /** @param {string} workspaceId @param {string | null} parentId */
  tree: (workspaceId, parentId) => ["tree", workspaceId, parentId],
  /** @param {string} id */
  page: (id) => ["page", id],
  /** @param {string} workspaceId */
  trash: (workspaceId) => ["trash", workspaceId],
};

const STALE_TIME = { workspaces: 5 * 60_000, tree: 30_000, page: 30_000, trash: 10_000 };

/** The mutation scope of a page's own fields (rows' values too: `data/databases.js`). @param {string} id */
export const pageScope = (id) => `page:${id}`;
/** @param {string} workspaceId @param {string | null} parentId */
const childrenScope = (workspaceId, parentId) => `children:${parentId ?? `root:${workspaceId}`}`;

/** @param {string} title */
export function displayTitle(title) {
  return title.trim() || "Untitled";
}

/** A new page id. The client picks it so optimistic pages never change id. */
export function newPageId() {
  return crypto.randomUUID();
}

// Fetchers. They read their parameters from the key, so one function serves every entry.

/** @param {{ signal: AbortSignal }} context @returns {Promise<Workspace[]>} */
function fetchWorkspaces({ signal }) {
  return api.listWorkspaces({ signal });
}

/** @param {{ key: QueryKey, signal: AbortSignal }} context @returns {Promise<TreeNode[]>} */
async function fetchTree({ key, signal }) {
  const [, workspaceId, parentId] = /** @type {[string, string, string | null]} */ (key);
  await queryClient.whenIdle(childrenScope(workspaceId, parentId));
  return api.getTree(workspaceId, parentId, { signal });
}

/** @param {{ key: QueryKey, signal: AbortSignal }} context @returns {Promise<Page>} */
async function fetchPage({ key, signal }) {
  const id = /** @type {string} */ (key[1]);
  await queryClient.whenIdle(pageScope(id));
  return api.getPage(id, { signal });
}

/** @param {{ key: QueryKey, signal: AbortSignal }} context @returns {Promise<Page[]>} */
function fetchTrash({ key, signal }) {
  return api.listTrash(/** @type {string} */ (key[1]), { signal });
}

// Prefetching (desktop: `desktop/prefetch.js` warms the cache in the background)

/**
 * Loads one level of the tree into the cache, unless it's fresh there.
 * @param {string} workspaceId @param {string | null} parentId
 * @returns {Promise<TreeNode[]>}
 */
export function prefetchChildren(workspaceId, parentId) {
  return queryClient.fetch(keys.tree(workspaceId, parentId), fetchTree, {
    staleTime: STALE_TIME.tree,
  });
}

/**
 * Loads a page into the cache, unless it's fresh there.
 * @param {string} id
 * @returns {Promise<Page>}
 */
export function prefetchPage(id) {
  return queryClient.fetch(keys.page(id), fetchPage, { staleTime: STALE_TIME.page });
}

/** Loads the workspaces into the cache. @returns {Promise<Workspace[]>} */
export function prefetchWorkspaces() {
  return queryClient.fetch(keys.workspaces(), fetchWorkspaces, {
    staleTime: STALE_TIME.workspaces,
  });
}

// Hooks

/**
 * The current workspace: the first one the user belongs to (there's no
 * switcher yet).
 */
export function useWorkspace() {
  const query = createQuery(keys.workspaces(), fetchWorkspaces, {
    staleTime: STALE_TIME.workspaces,
  });
  const workspace = createMemo(() => query.data()?.[0]);
  return {
    workspace,
    id: () => workspace()?.id,
    loading: query.loading,
    error: query.error,
    refetch: query.refetch,
  };
}

/**
 * One level of the tree: the children of `parentId` (null: top level).
 * @param {() => string | undefined} workspaceId
 * @param {string | null} parentId
 */
export function useChildren(workspaceId, parentId) {
  return createQuery(
    () => {
      const ws = workspaceId();
      return ws ? keys.tree(ws, parentId) : null;
    },
    fetchTree,
    { staleTime: STALE_TIME.tree },
  );
}

/** @param {() => string | undefined} id */
export function usePage(id) {
  return createQuery(
    () => {
      const current = id();
      return current ? keys.page(current) : null;
    },
    fetchPage,
    { staleTime: STALE_TIME.page },
  );
}

/** @param {() => string | undefined} workspaceId */
export function useTrash(workspaceId) {
  return createQuery(
    () => {
      const ws = workspaceId();
      return ws ? keys.trash(ws) : null;
    },
    fetchTrash,
    { staleTime: STALE_TIME.trash },
  );
}

/**
 * The ancestors of page `id`, top level first. Read from the page cache
 * and followed upward one `GET /v1/pages/:id` at a time where it's missing
 * (the API has no ancestors endpoint yet). Reactive: renames and moves show
 * up at once. The page itself must be loaded by someone else (`usePage`).
 * @param {() => string | undefined} id
 * @returns {() => { ancestors: Page[], complete: boolean }}
 */
export function usePagePath(id) {
  const path = createMemo(
    () => {
      /** @type {Page[]} */
      const ancestors = [];
      const current = id();
      /** @type {string | null} */
      let missing = null;
      const seen = new Set(current ? [current] : []);
      /** @type {Page | undefined} */
      const page = current ? readQuery(keys.page(current)) : undefined;
      let parentId = page?.parent_id ?? null;
      while (parentId && !seen.has(parentId) && ancestors.length < 64) {
        seen.add(parentId);
        const parent = /** @type {Page | undefined} */ (readQuery(keys.page(parentId)));
        if (!parent) {
          missing = parentId;
          break;
        }
        ancestors.unshift(parent);
        parentId = parent.parent_id;
      }
      return { ancestors, missing };
    },
    undefined,
    {
      // Re-run dependents only when the path itself changes, not on every
      // cache notification (an error refetching an ancestor would loop).
      equals: (a, b) =>
        a.missing === b.missing &&
        a.ancestors.length === b.ancestors.length &&
        a.ancestors.every((page, i) => page === b.ancestors[i]),
    },
  );

  const missing = createMemo(() => path().missing);
  createEffect(() => {
    const parentId = missing();
    if (parentId)
      queryClient
        .fetch(keys.page(parentId), fetchPage, { staleTime: STALE_TIME.page })
        .catch(() => {});
  });
  // Keep the ancestors cached while they're shown.
  createEffect(() => {
    const stops = path().ancestors.map((page) => queryClient.observe(keys.page(page.id)));
    onCleanup(() => stops.forEach((stop) => stop()));
  });

  return () => ({ ancestors: path().ancestors, complete: path().missing === null });
}

// Cache helpers

/** Whether an entry has data or is about to, so an optimistic layer on it matters. @param {QueryKey} key */
function isCached(key) {
  const state = queryClient.getState(key);
  return state.data !== undefined || state.fetching;
}

/**
 * The node for `id` in whichever cached tree list holds it.
 * @param {string} workspaceId
 * @param {string} id
 * @returns {{ node: TreeNode, parentId: string | null } | null}
 */
export function findNode(workspaceId, id) {
  for (const key of queryClient.keys(keys.treeAll(workspaceId))) {
    const node = /** @type {TreeNode[] | undefined} */ (queryClient.getData(key))?.find(
      (item) => item.id === id,
    );
    if (node) return { node, parentId: /** @type {string | null} */ (key[2]) };
  }
  return null;
}

/**
 * Cached children of `parentId`, if loaded. Not reactive.
 * @param {string} workspaceId
 * @param {string | null} parentId
 * @returns {TreeNode[] | undefined}
 */
export function cachedChildren(workspaceId, parentId) {
  return queryClient.getData(keys.tree(workspaceId, parentId));
}

/**
 * A page's parent as far as the cache knows: null at the top level,
 * undefined when unknown.
 * @param {string} workspaceId
 * @param {string} id
 */
export function parentOf(workspaceId, id) {
  const page = /** @type {Page | undefined} */ (queryClient.getData(keys.page(id)));
  return page ? page.parent_id : findNode(workspaceId, id)?.parentId;
}

/**
 * @template {object} T
 * @param {T} item
 * @param {Partial<T>} patch
 * @returns {T}
 */
function withPatch(item, patch) {
  return Object.entries(patch).some(([name, value]) => /** @type {any} */ (item)[name] !== value)
    ? { ...item, ...patch }
    : item;
}

/**
 * Applies a field change to every cached copy of a page: its tree node, its
 * page entry and its trash entry.
 * @param {Update} update
 * @param {string} workspaceId
 * @param {string} id
 * @param {Partial<Page>} patch
 */
function patchEverywhere(update, workspaceId, id, patch) {
  /** @type {Partial<TreeNode>} */
  const nodePatch = {};
  for (const name of /** @type {const} */ (["title", "icon", "has_children", "parent_id"])) {
    if (name in patch) /** @type {any} */ (nodePatch)[name] = patch[name];
  }
  if (Object.keys(nodePatch).length) {
    for (const key of queryClient.keys(keys.treeAll(workspaceId)))
      update(key, (list) => patchNode(list, id, nodePatch));
  }
  if (isCached(keys.page(id))) update(keys.page(id), (page) => page && withPatch(page, patch));
  if (isCached(keys.trash(workspaceId)))
    update(keys.trash(workspaceId), (list) => patchNode(list, id, patch));
}

/**
 * After a page leaves `parentId`: if the parent's (loaded) children are now
 * only that page, the parent loses its chevron.
 * @param {Update} update
 * @param {string} workspaceId
 * @param {string | null | undefined} parentId
 * @param {string} leavingId
 */
function maybeClearHasChildren(update, workspaceId, parentId, leavingId) {
  if (!parentId) return;
  const siblings = cachedChildren(workspaceId, parentId);
  if (siblings?.every((node) => node.id === leavingId))
    patchEverywhere(update, workspaceId, parentId, { has_children: false });
}

/**
 * Writes the server's version of a page into the cache: its page entry,
 * and its node in the right tree list (removed from any other).
 * @param {Page} page
 */
function reconcile(page) {
  queryClient.setData(keys.page(page.id), page);
  // A database's rows aren't in the tree.
  if (page.kind === "row") return;
  const node = toTreeNode(page);
  for (const key of queryClient.keys(keys.treeAll(page.workspace_id))) {
    queryClient.setData(key, (/** @type {TreeNode[] | undefined} */ list) =>
      key[2] === page.parent_id ? insertByPosition(list, node) : removeNode(list, page.id),
    );
  }
  if (page.parent_id) {
    const parentId = page.parent_id;
    for (const key of queryClient.keys(keys.treeAll(page.workspace_id))) {
      queryClient.setData(key, (/** @type {TreeNode[] | undefined} */ list) =>
        patchNode(list, parentId, { has_children: true }),
      );
    }
  }
}

/**
 * The failure toast every mutation shows after rolling back.
 * @param {string} title
 * @param {unknown} error
 */
export function failed(title, error) {
  if (error instanceof DOMException && error.name === "AbortError") return;
  let reason = "Something went wrong.";
  if (error instanceof ApiError) {
    reason =
      error.status === 0
        ? "Can't reach the server."
        : /[.!?]$/.test(error.message)
          ? error.message
          : `${error.message}.`;
  }
  toast({
    title,
    description: `${reason} Your change was undone.`,
    tone: "danger",
    duration: 8000,
  });
}

// Create

/**
 * @typedef {object} CreateVars
 * @property {string} id
 * @property {string} workspaceId
 * @property {string | null} parentId
 * @property {string | null | undefined} afterId
 * @property {string} title
 * @property {"page" | "database"} kind
 */

const createMut = createMutation({
  /** @param {CreateVars} vars */
  mutationFn: (vars) =>
    api.createPage({
      id: vars.id,
      workspace_id: vars.workspaceId,
      parent_id: vars.parentId,
      ...(vars.afterId !== undefined && { after_id: vars.afterId }),
      title: vars.title,
      ...(vars.kind === "database" && { kind: vars.kind }),
    }),
  scope: (vars) => [pageScope(vars.id), childrenScope(vars.workspaceId, vars.parentId)],
  optimistic(vars, tx) {
    const now = new Date().toISOString();
    /** @type {Page} */
    const page = {
      id: vars.id,
      workspace_id: vars.workspaceId,
      parent_id: vars.parentId,
      title: vars.title,
      icon: null,
      cover: null,
      position: "",
      has_children: false,
      archived_at: null,
      created_at: now,
      updated_at: now,
      kind: vars.kind,
    };
    tx.update(keys.page(vars.id), (old) => old ?? page);
    const listKey = keys.tree(vars.workspaceId, vars.parentId);
    if (isCached(listKey)) {
      tx.update(listKey, (/** @type {TreeNode[] | undefined} */ list) => {
        if (!list || list.some((node) => node.id === vars.id)) return list;
        const position = positionAfter(list, vars.afterId, vars.id, "");
        return placeNode(list, toTreeNode({ ...page, position }), vars.afterId);
      });
    }
    if (vars.parentId)
      patchEverywhere(tx.update, vars.workspaceId, vars.parentId, { has_children: true });
  },
  onSuccess: reconcile,
  onError(error, vars) {
    failed("Couldn't create the page", error);
    // Don't leave the user on a page that doesn't exist.
    if (location().pathname === `/p/${encodeURIComponent(vars.id)}`) {
      navigate(vars.parentId ? `/p/${encodeURIComponent(vars.parentId)}` : "/", { replace: true });
    }
  },
});

/**
 * Creates a page; returns its id at once (the page is in the cache already).
 * @param {{ workspaceId: string, parentId?: string | null, afterId?: string | null, title?: string, kind?: "page" | "database" }} input
 *   `afterId` null: first among its siblings; omitted: last. A database
 *   gets its schema and first view on the server (`data/databases.js` loads them).
 */
export function createPage({ workspaceId, parentId = null, afterId, title = "", kind = "page" }) {
  const id = newPageId();
  void createMut.mutate({ id, workspaceId, parentId, afterId, title, kind });
  return id;
}

// Update (title, icon, cover)

/**
 * @typedef {object} UpdateVars
 * @property {string} workspaceId
 * @property {string} id
 * @property {import("../api/types.js").UpdatePageInput} patch
 * @property {string} title The title before the change, for the error message.
 */

const updateMut = createMutation({
  /** @param {UpdateVars} vars */
  mutationFn: (vars) => api.updatePage(vars.id, vars.patch),
  scope: (vars) => pageScope(vars.id),
  optimistic: (vars, tx) => {
    // Row values go through data/databases.js; only the page's own fields here.
    const { properties: _, ...patch } = vars.patch;
    patchEverywhere(tx.update, vars.workspaceId, vars.id, patch);
  },
  onSuccess(page) {
    if (queryClient.getData(keys.page(page.id)) !== undefined)
      queryClient.setData(keys.page(page.id), page);
    for (const key of [
      ...queryClient.keys(keys.treeAll(page.workspace_id)),
      keys.trash(page.workspace_id),
    ]) {
      queryClient.setData(key, (/** @type {TreeNode[] | undefined} */ list) =>
        patchNode(list, page.id, { title: page.title, icon: page.icon }),
      );
    }
  },
  onError(error, vars) {
    const what =
      "title" in vars.patch
        ? `Couldn't rename “${displayTitle(vars.title)}”`
        : "icon" in vars.patch
          ? "Couldn't change the icon"
          : "Couldn't change the cover";
    failed(what, error);
  },
});

/**
 * @param {string} workspaceId
 * @param {string} id
 * @param {import("../api/types.js").UpdatePageInput} patch
 */
export function updatePage(workspaceId, id, patch) {
  const title =
    /** @type {Page | undefined} */ (queryClient.getData(keys.page(id)))?.title ??
    findNode(workspaceId, id)?.node.title ??
    "";
  return updateMut.mutate({ workspaceId, id, patch, title });
}

/** @param {string} id */
const draftLayer = (id) => `draft:title:${id}`;

/**
 * Shows a title that's being typed everywhere the page appears (sidebar,
 * breadcrumbs) before it's saved. `renamePage` replaces it with the real change.
 * @param {string} workspaceId
 * @param {string} id
 * @param {string} title
 */
export function setTitleDraft(workspaceId, id, title) {
  const layer = draftLayer(id);
  patchEverywhere((key, update) => void queryClient.setLayer(key, layer, update), workspaceId, id, {
    title,
  });
}

/** @param {string} workspaceId @param {string} id */
export function clearTitleDraft(workspaceId, id) {
  const layer = draftLayer(id);
  for (const key of [
    ...queryClient.keys(keys.treeAll(workspaceId)),
    keys.page(id),
    keys.trash(workspaceId),
  ]) {
    queryClient.removeLayer(key, layer);
  }
}

/**
 * Saves a new title (and drops the draft, if any).
 * @param {string} workspaceId
 * @param {string} id
 * @param {string} title
 */
export function renamePage(workspaceId, id, title) {
  clearTitleDraft(workspaceId, id);
  return updatePage(workspaceId, id, { title });
}

// Move

/**
 * @typedef {object} MoveVars
 * @property {string} workspaceId
 * @property {string} id
 * @property {string | null | undefined} fromParentId
 * @property {string | null} parentId
 * @property {string | null | undefined} afterId undefined: last child.
 * @property {string} title
 */

const moveMut = createMutation({
  /** @param {MoveVars} vars */
  async mutationFn(vars) {
    let afterId = vars.afterId;
    if (afterId === undefined) {
      // "Last child": runs after earlier writes to that list (scope), so the cache is current.
      const siblings =
        cachedChildren(vars.workspaceId, vars.parentId) ??
        (await api.getTree(vars.workspaceId, vars.parentId));
      afterId = siblings.filter((node) => node.id !== vars.id).at(-1)?.id ?? null;
    }
    return api.movePage(vars.id, { parent_id: vars.parentId, after_id: afterId });
  },
  scope: (vars) => [
    pageScope(vars.id),
    childrenScope(vars.workspaceId, vars.fromParentId ?? null),
    childrenScope(vars.workspaceId, vars.parentId),
  ],
  optimistic(vars, tx) {
    const page = /** @type {Page | undefined} */ (queryClient.getData(keys.page(vars.id)));
    const known = findNode(vars.workspaceId, vars.id)?.node ?? (page && toTreeNode(page));
    for (const key of queryClient.keys(keys.treeAll(vars.workspaceId))) {
      if (key[2] !== vars.parentId) {
        tx.update(key, (list) => removeNode(list, vars.id));
      } else if (known) {
        tx.update(key, (/** @type {TreeNode[] | undefined} */ list) => {
          if (!list) return list;
          // Prefer the list's own (fresher) copy if a refetch already has it.
          const current = list.find((node) => node.id === vars.id) ?? known;
          const position = positionAfter(list, vars.afterId, vars.id, current.position);
          return placeNode(
            list,
            withPatch(current, { parent_id: vars.parentId, position }),
            vars.afterId,
          );
        });
      }
    }
    if (vars.fromParentId !== vars.parentId)
      maybeClearHasChildren(tx.update, vars.workspaceId, vars.fromParentId, vars.id);
    if (vars.parentId)
      patchEverywhere(tx.update, vars.workspaceId, vars.parentId, { has_children: true });
    if (isCached(keys.page(vars.id)))
      tx.update(keys.page(vars.id), (old) => old && withPatch(old, { parent_id: vars.parentId }));
  },
  onSuccess: reconcile,
  onError: (error, vars) => failed(`Couldn't move “${displayTitle(vars.title)}”`, error),
});

/**
 * Moves a page under `parentId`, after `afterId` (null: first; undefined: last).
 * Refuses (with a toast) to move a page into itself or its own subpages.
 * @param {{ workspaceId: string, id: string, parentId: string | null, afterId: string | null | undefined }} input
 * @returns {boolean} Whether the move was started.
 */
export function movePage({ workspaceId, id, parentId, afterId }) {
  if (wouldCreateCycle(id, parentId, (pageId) => parentOf(workspaceId, pageId))) {
    toast({
      title: "Can't move a page into itself",
      description: "Pick a place outside the page and its subpages.",
      tone: "danger",
    });
    return false;
  }
  const title =
    findNode(workspaceId, id)?.node.title ??
    /** @type {Page | undefined} */ (queryClient.getData(keys.page(id)))?.title ??
    "";
  void moveMut.mutate({
    workspaceId,
    id,
    fromParentId: parentOf(workspaceId, id),
    parentId,
    afterId,
    title,
  });
  return true;
}

// Trash, restore, delete

/**
 * @typedef {object} TrashVars
 * @property {string} workspaceId
 * @property {string} id
 * @property {string | null | undefined} parentId
 * @property {string} title
 */

/**
 * A trash entry for a page, built from whatever the cache knows about it.
 * @param {TrashVars} vars
 * @param {string} archivedAt
 * @returns {Page}
 */
function trashEntry(vars, archivedAt) {
  const page = /** @type {Page | undefined} */ (queryClient.getData(keys.page(vars.id)));
  const node = findNode(vars.workspaceId, vars.id)?.node;
  return {
    id: vars.id,
    workspace_id: vars.workspaceId,
    parent_id: vars.parentId ?? null,
    title: page?.title ?? node?.title ?? vars.title,
    icon: page?.icon ?? node?.icon ?? null,
    cover: page?.cover ?? null,
    position: page?.position ?? node?.position ?? "",
    has_children: node?.has_children ?? page?.has_children ?? false,
    archived_at: archivedAt,
    created_at: page?.created_at ?? archivedAt,
    updated_at: archivedAt,
  };
}

const trashMut = createMutation({
  /** @param {TrashVars} vars */
  mutationFn: (vars) => api.trashPage(vars.id),
  scope: (vars) => [pageScope(vars.id), childrenScope(vars.workspaceId, vars.parentId ?? null)],
  optimistic(vars, tx) {
    const now = new Date().toISOString();
    const entry = trashEntry(vars, now);
    maybeClearHasChildren(tx.update, vars.workspaceId, vars.parentId, vars.id);
    for (const key of queryClient.keys(keys.treeAll(vars.workspaceId)))
      tx.update(key, (list) => removeNode(list, vars.id));
    if (isCached(keys.page(vars.id)))
      tx.update(keys.page(vars.id), (page) => page && withPatch(page, { archived_at: now }));
    if (isCached(keys.trash(vars.workspaceId))) {
      tx.update(keys.trash(vars.workspaceId), (/** @type {Page[] | undefined} */ list) =>
        !list || list.some((item) => item.id === vars.id) ? list : [entry, ...list],
      );
    }
  },
  onError: (error, vars) =>
    failed(`Couldn't move “${displayTitle(vars.title)}” to the trash`, error),
  // Subpages were archived with it.
  invalidates: (vars) => [keys.trash(vars.workspaceId), ["page"]],
});

/**
 * Moves a page (and its subpages) to the trash, with an Undo toast.
 * @param {string} workspaceId
 * @param {string} id
 */
export async function trashPage(workspaceId, id) {
  const found = findNode(workspaceId, id);
  const page = /** @type {Page | undefined} */ (queryClient.getData(keys.page(id)));
  const title = found?.node.title ?? page?.title ?? "";
  const parentId = found ? found.parentId : page?.parent_id;
  const vars = { workspaceId, id, parentId, title };
  // What the page looked like, so Undo can put it back right away.
  const snapshot = trashEntry(vars, new Date().toISOString());
  const toastId = toast({
    title: `Moved “${displayTitle(title)}” to the trash`,
    action: { label: "Undo", onClick: () => void restorePage(workspaceId, id, snapshot) },
  });
  try {
    await trashMut.mutateAsync(vars);
  } catch {
    dismissToast(toastId);
  }
}

/**
 * @typedef {object} RestoreVars
 * @property {string} workspaceId
 * @property {string} id
 * @property {Page | undefined} trashed What the cache knows about it.
 */

const restoreMut = createMutation({
  /** @param {RestoreVars} vars */
  mutationFn: (vars) => api.restorePage(vars.id),
  scope: (vars) => [
    pageScope(vars.id),
    childrenScope(vars.workspaceId, vars.trashed?.parent_id ?? null),
    childrenScope(vars.workspaceId, null),
  ],
  optimistic(vars, tx) {
    const trashKey = keys.trash(vars.workspaceId);
    const trashList = /** @type {Page[] | undefined} */ (queryClient.getData(trashKey));
    tx.update(trashKey, (list) => removeNode(list, vars.id));
    if (isCached(keys.page(vars.id)))
      tx.update(keys.page(vars.id), (page) => page && withPatch(page, { archived_at: null }));
    const trashed = vars.trashed;
    if (!trashed) return;
    // A page whose parent is still in the trash comes back at the top level.
    const parentGone =
      trashed.parent_id !== null &&
      (trashList?.some((item) => item.id === trashed.parent_id) ||
        Boolean(
          /** @type {Page | undefined} */ (queryClient.getData(keys.page(trashed.parent_id)))
            ?.archived_at,
        ));
    const parentId = parentGone ? null : trashed.parent_id;
    const listKey = keys.tree(vars.workspaceId, parentId);
    const node = toTreeNode({ ...trashed, parent_id: parentId });
    if (isCached(listKey)) tx.update(listKey, (list) => insertByPosition(list, node));
    if (parentId) patchEverywhere(tx.update, vars.workspaceId, parentId, { has_children: true });
  },
  onSuccess: reconcile,
  onError: (error, vars) =>
    failed(`Couldn't restore “${displayTitle(vars.trashed?.title ?? "")}”`, error),
  invalidates: (vars) => [keys.trash(vars.workspaceId), ["page"]],
});

/**
 * Takes a page out of the trash.
 * @param {string} workspaceId
 * @param {string} id
 * @param {Page} [known] What the page looked like, when the caller knows
 *   better than the cache (Undo right after trashing it).
 */
export function restorePage(workspaceId, id, known) {
  const trashed =
    /** @type {Page[] | undefined} */ (queryClient.getData(keys.trash(workspaceId)))?.find(
      (page) => page.id === id,
    ) ??
    /** @type {Page | undefined} */ (queryClient.getData(keys.page(id))) ??
    known;
  return restoreMut.mutate({ workspaceId, id, trashed });
}

const deleteMut = createMutation({
  /** @param {{ workspaceId: string, id: string, title: string }} vars */
  mutationFn: (vars) => api.deletePageForever(vars.id),
  scope: (vars) => pageScope(vars.id),
  optimistic: (vars, tx) =>
    tx.update(keys.trash(vars.workspaceId), (list) => removeNode(list, vars.id)),
  onError: (error, vars) => failed(`Couldn't delete “${displayTitle(vars.title)}”`, error),
  invalidates: (vars) => [keys.trash(vars.workspaceId), keys.page(vars.id)],
});

/**
 * Deletes an archived page and its subpages for good.
 * @param {string} workspaceId
 * @param {string} id
 * @param {string} title
 */
export function deletePageForever(workspaceId, id, title) {
  return deleteMut.mutate({ workspaceId, id, title });
}

// Duplicate

const duplicateMut = createMutation({
  /** @param {{ workspaceId: string, id: string, copyId: string, parentId: string | null, title: string }} vars */
  mutationFn: (vars) => api.duplicatePage(vars.id, { id: vars.copyId }),
  scope: (vars) => [
    pageScope(vars.id),
    pageScope(vars.copyId),
    childrenScope(vars.workspaceId, vars.parentId),
  ],
  optimistic(vars, tx) {
    const source = findNode(vars.workspaceId, vars.id)?.node;
    const listKey = keys.tree(vars.workspaceId, vars.parentId);
    if (!source || !isCached(listKey)) return;
    tx.update(listKey, (/** @type {TreeNode[] | undefined} */ list) => {
      if (!list || list.some((node) => node.id === vars.copyId)) return list;
      const copy = {
        ...source,
        id: vars.copyId,
        title: `${displayTitle(source.title)} (copy)`,
        position: positionAfter(list, vars.id, vars.copyId, source.position),
      };
      return placeNode(list, copy, vars.id);
    });
  },
  onSuccess: reconcile,
  onError: (error, vars) => failed(`Couldn't duplicate “${displayTitle(vars.title)}”`, error),
});

/**
 * Copies a page and its subpages, right after it. Returns the copy's id.
 * @param {string} workspaceId
 * @param {string} id
 */
export function duplicatePage(workspaceId, id) {
  const found = findNode(workspaceId, id);
  const copyId = newPageId();
  void duplicateMut.mutate({
    workspaceId,
    id,
    copyId,
    parentId: found?.parentId ?? null,
    title: found?.node.title ?? "",
  });
  return copyId;
}
