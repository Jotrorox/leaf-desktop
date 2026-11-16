// @ts-check
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  useContext,
} from "solid-js";
import { CHUNK_SIZE, trashRows, updateRow, useRows } from "../../data/databases.js";
import {
  cachedChildren,
  displayTitle,
  duplicatePage,
  findNode,
  movePage,
  keys as pageKeys,
  parentOf,
  renamePage,
  trashPage,
  useChildren,
  usePagePath,
} from "../../data/pages.js";
import { isNoopMove, keyboardMove, resolveDrop } from "../../data/tree-ops.js";
import { dropZone, scrollParent, startDrag } from "../../lib/dnd.js";
import { readQuery } from "../../lib/query/index.js";
import { Link, location, matchPath } from "../../lib/router/index.js";
import { isApplePlatform } from "../../lib/shortcuts.js";
import { createTypeaheadBuffer, findTypeaheadMatch } from "../../lib/typeahead.js";
import Button from "../../ui/Button.jsx";
import IconButton from "../../ui/IconButton.jsx";
import {
  IconChevronRight,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconMore,
  IconPencil,
  IconPlus,
  IconTable,
  IconTrash,
} from "../../ui/icons/index.jsx";
import Menu, { MenuItem, MenuSeparator } from "../../ui/Menu.jsx";
import PageIcon, { iconText } from "../../ui/PageIcon.jsx";
import { openNewPage, openNewRow } from "../new-page.js";
import { expandAll, isExpanded, setPageExpanded, toggleExpanded } from "./expanded.js";
import styles from "./PageTree.module.css";
import { setShowsRowPages, showsRowPages } from "./row-pages.js";

/** @typedef {import("../../api/types.js").TreeNode} TreeNode */
/** @typedef {import("../../api/types.js").Row} Row */
/** @typedef {import("../../api/types.js").Page} Page */
/** @typedef {import("../../lib/query/solid.js").QueryResult<TreeNode[]>} ChildrenQuery */

/**
 * Where a dragged page would land: on row `id`, in `zone`. `expanded`: the
 * row's children are showing, so "after" means "first child".
 * @typedef {{ id: string, parentId: string | null, zone: "before" | "after" | "inside", expanded: boolean }} DropTarget
 */

/**
 * @typedef {object} TreeApi
 * @property {string} workspaceId
 * @property {() => string | null} renamingId
 * @property {(id: string | null) => void} setRenamingId
 * @property {() => string | null} draggingId
 * @property {() => DropTarget | null} dropTarget
 * @property {(event: PointerEvent, id: string) => void} onItemPointerDown
 */

const TreeContext = createContext(/** @type {TreeApi | undefined} */ (undefined));

function useTree() {
  const tree = useContext(TreeContext);
  if (!tree) throw new Error("Tree items must be inside <PageTree>");
  return tree;
}

/**
 * The sidebar's page tree (ARIA tree pattern). Each level loads when it's
 * first expanded; expand state persists (`expanded.js`), and the current
 * page's ancestors expand on their own.
 *
 * A database can list its rows inside it, as subpages (`row-pages.js`,
 * toggled from its "…" menu). Rows can't be dragged, and nothing drops
 * among them: they belong to the database.
 *
 * Mouse: click opens, the chevron toggles, hovering a row shows "…" (rename,
 * duplicate, trash) and "+" (add a page inside), and dragging a row moves
 * it: the top or bottom quarter of a row drops before or after it, the
 * middle drops inside. Escape cancels a drag.
 *
 * Keyboard (one tab stop, roving focus): ↑/↓ move, → expands or enters,
 * ← collapses or goes to the parent, Home/End, `*` expands all siblings,
 * type to jump, Enter opens, F2 renames, Shift+F10 opens the actions menu,
 * Delete or ⌘⌫ moves to the trash, and ⌘⇧↑/↓/→/← move the page up, down,
 * into the page above, or out of its parent.
 *
 * @param {{ workspaceId: string, "aria-labelledby"?: string }} props
 */
export default function PageTree(props) {
  /** @type {HTMLUListElement | undefined} */
  let tree;
  /** @type {string | null} */
  let lastFocusedId = null;
  let focusFrame = 0;
  const typeahead = createTypeaheadBuffer();
  const [renamingId, setRenamingId] = createSignal(/** @type {string | null} */ (null));
  const [draggingId, setDraggingId] = createSignal(/** @type {string | null} */ (null));
  const [dropTarget, setDropTarget] = createSignal(/** @type {DropTarget | null} */ (null), {
    equals: sameTarget,
  });
  const root = useChildren(() => props.workspaceId, null);

  // Reveal the current page: expand its ancestors as they become known.
  const currentId = createMemo(() => matchPath("/p/:pageId", location().pathname)?.pageId);
  const path = usePagePath(currentId);
  const ancestorIds = /** @type {import("solid-js").Accessor<string[]>} */ (
    createMemo(() => path().ancestors.map((page) => page.id), undefined, { equals: sameArray })
  );
  createEffect(() => expandAll(ancestorIds()));

  /** @returns {HTMLElement[]} */
  function items() {
    return tree
      ? [.../** @type {NodeListOf<HTMLElement>} */ (tree.querySelectorAll('[role="treeitem"]'))]
      : [];
  }

  /** One item is the tab stop: the last focused, else the current page, else the first. */
  function syncTabStop() {
    const list = items();
    const active =
      list.find((el) => el.dataset.id === lastFocusedId) ??
      list.find((el) => el.getAttribute("aria-current") === "page") ??
      list[0];
    for (const el of list) {
      const value = el === active ? "0" : "-1";
      if (el.getAttribute("tabindex") !== value) el.setAttribute("tabindex", value);
    }
  }

  onMount(() => {
    if (!tree) return;
    const observer = new MutationObserver(syncTabStop);
    observer.observe(tree, { childList: true, subtree: true });
    syncTabStop();
    onCleanup(() => {
      observer.disconnect();
      cancelAnimationFrame(focusFrame);
    });
  });

  // aria-current moved: unless the user is working in the tree, the tab stop follows it.
  createEffect(
    on(
      () => location().pathname,
      () => {
        if (!tree?.contains(document.activeElement)) lastFocusedId = null;
        queueMicrotask(syncTabStop);
      },
      { defer: true },
    ),
  );

  /** @param {HTMLElement | undefined} el */
  function focusEl(el) {
    if (!el) return;
    lastFocusedId = el.dataset.id ?? null;
    syncTabStop();
    el.focus();
  }

  /** @param {string} id */
  function itemFor(id) {
    return /** @type {HTMLElement | null} */ (
      tree?.querySelector(`[role="treeitem"][data-id="${CSS.escape(id)}"]`) ?? null
    );
  }

  /**
   * Focuses an item that may not be rendered yet (a page just moved into a
   * level that's still loading). Gives up after about a second.
   * @param {string} id
   */
  function focusSoon(id) {
    cancelAnimationFrame(focusFrame);
    let frames = 0;
    const attempt = () => {
      const el = itemFor(id);
      if (el) focusEl(el);
      else if (++frames < 60) focusFrame = requestAnimationFrame(attempt);
    };
    attempt();
  }

  /** @param {FocusEvent} event */
  function onFocusIn(event) {
    const item = event.target instanceof HTMLElement && event.target.closest('[role="treeitem"]');
    if (!(item instanceof HTMLElement)) return;
    lastFocusedId = item.dataset.id ?? null;
    syncTabStop();
  }

  /**
   * @param {string} id
   * @param {string | null} parentId
   * @param {"up" | "down" | "in" | "out"} direction
   */
  function moveWithKeyboard(id, parentId, direction) {
    const siblings = (cachedChildren(props.workspaceId, parentId) ?? []).map((node) => node.id);
    const grandparentId = parentId ? parentOf(props.workspaceId, parentId) : null;
    const placement = keyboardMove(direction, id, siblings, parentId, grandparentId);
    if (!placement) return;
    if (direction === "in" && placement.parentId) setPageExpanded(placement.parentId, true);
    if (movePage({ workspaceId: props.workspaceId, id, ...placement })) focusSoon(id);
  }

  /**
   * Trashes the item and moves focus to the next item outside its subtree
   * (or the previous one).
   * @param {HTMLElement[]} list
   * @param {number} index
   */
  function trashItem(list, index) {
    const item = list[index];
    const level = Number(item.getAttribute("aria-level"));
    const next =
      list.slice(index + 1).find((el) => Number(el.getAttribute("aria-level")) <= level) ??
      list[index - 1];
    const id = /** @type {string} */ (item.dataset.id);
    const databaseId = item.dataset.databaseId;
    if (databaseId)
      void trashRows({
        databaseId,
        workspaceId: props.workspaceId,
        ids: [id],
        title: item.dataset.title,
      });
    else void trashPage(props.workspaceId, id);
    if (next?.dataset.id) focusSoon(next.dataset.id);
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const item = event.target;
    if (!(item instanceof HTMLElement) || item.getAttribute("role") !== "treeitem") return;
    const list = items();
    const index = list.indexOf(item);
    const id = /** @type {string} */ (item.dataset.id);
    const parentId = item.dataset.parentId || null;
    const expandable = item.hasAttribute("aria-expanded");
    const expanded = item.getAttribute("aria-expanded") === "true";
    const level = Number(item.getAttribute("aria-level"));
    const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
    const otherMod = isApplePlatform() ? event.ctrlKey : event.metaKey;

    /** @type {Record<string, "up" | "down" | "in" | "out">} */
    const moves = { ArrowUp: "up", ArrowDown: "down", ArrowRight: "in", ArrowLeft: "out" };
    if (mod && event.shiftKey && !event.altKey && moves[event.key]) {
      event.preventDefault();
      // A row's place is the database's (its views' sorts, or the board).
      if (!item.dataset.databaseId) moveWithKeyboard(id, parentId, moves[event.key]);
      return;
    }
    if (mod && event.key === "Backspace") {
      event.preventDefault();
      trashItem(list, index);
      return;
    }
    // Leave other modified keys (browser shortcuts, app shortcuts) alone.
    if (event.altKey || mod || otherMod) return;

    switch (event.key) {
      case "ArrowDown":
        focusEl(list[index + 1]);
        break;
      case "ArrowUp":
        focusEl(list[index - 1]);
        break;
      case "ArrowRight":
        if (expandable && !expanded) setPageExpanded(id, true);
        else if (expanded && Number(list[index + 1]?.getAttribute("aria-level")) > level)
          focusEl(list[index + 1]);
        break;
      case "ArrowLeft":
        if (expanded) setPageExpanded(id, false);
        else if (parentId) focusEl(itemFor(parentId) ?? undefined);
        break;
      case "Home":
        focusEl(list[0]);
        break;
      case "End":
        focusEl(list.at(-1));
        break;
      case "*":
        expandAll(
          list
            .filter(
              (el) =>
                (el.dataset.parentId || null) === parentId && el.hasAttribute("aria-expanded"),
            )
            .map((el) => /** @type {string} */ (el.dataset.id)),
        );
        break;
      case "F2":
        setRenamingId(id);
        break;
      case "F10":
        if (!event.shiftKey) return;
        openMenu(item);
        break;
      case "ContextMenu":
        openMenu(item);
        break;
      case "Delete":
        trashItem(list, index);
        break;
      case "Enter":
        // The link opens the page.
        return;
      default: {
        if (event.key.length !== 1) return;
        if (event.key === " " && !typeahead.active) break;
        const labels = list.map((el) => el.dataset.title ?? "");
        const match = findTypeaheadMatch(labels, index, typeahead.push(event.key));
        if (match >= 0) focusEl(list[match]);
      }
    }
    event.preventDefault();
  }

  /** @param {HTMLElement} item */
  function openMenu(item) {
    /** @type {HTMLElement | null | undefined} */ (
      item.closest("li")?.querySelector("[data-menu-trigger]")
    )?.click();
  }

  /**
   * The drop target under the pointer, or null where a drop isn't allowed:
   * outside the tree, and on the dragged page or anything inside it.
   * @param {number} x
   * @param {number} y
   * @param {string} draggedId
   * @returns {DropTarget | null}
   */
  function resolveTarget(x, y, draggedId) {
    const row = document.elementFromPoint(x, y)?.closest("[data-row]");
    if (!(row instanceof HTMLElement) || !tree?.contains(row)) return null;
    for (let li = row.closest("li"); li; li = li.parentElement?.closest("li") ?? null) {
      if (li.dataset.id === draggedId) return null;
    }
    const rect = row.getBoundingClientRect();
    return {
      id: /** @type {string} */ (row.dataset.id),
      parentId: row.dataset.parentId || null,
      zone: dropZone(y - rect.top, rect.height),
      expanded: row.dataset.open === "true",
    };
  }

  /**
   * @param {string} draggedId
   * @param {DropTarget} target
   */
  function drop(draggedId, target) {
    const siblings = (cachedChildren(props.workspaceId, target.parentId) ?? []).map(
      (node) => node.id,
    );
    const placement = resolveDrop(target.zone, target, siblings, draggedId);
    const from = findNode(props.workspaceId, draggedId);
    if (from) {
      const fromSiblings = (cachedChildren(props.workspaceId, from.parentId) ?? []).map(
        (node) => node.id,
      );
      if (isNoopMove({ id: draggedId, parentId: from.parentId }, fromSiblings, placement)) return;
    }
    if (target.zone === "inside" && placement.parentId) setPageExpanded(placement.parentId, true);
    movePage({ workspaceId: props.workspaceId, id: draggedId, ...placement });
  }

  /** @param {string} id */
  function dragPreview(id) {
    const node = findNode(props.workspaceId, id)?.node;
    const el = document.createElement("div");
    el.className = styles.preview;
    const icon = iconText(node?.icon);
    el.textContent = `${icon ? `${icon} ` : ""}${displayTitle(node?.title ?? "")}`;
    return el;
  }

  /** @type {TreeApi} */
  const api = {
    get workspaceId() {
      return props.workspaceId;
    },
    renamingId,
    setRenamingId,
    draggingId,
    dropTarget,
    onItemPointerDown(event, id) {
      if (renamingId() === id) return;
      if (event.target instanceof Element && event.target.closest("[data-toggle]")) return;
      startDrag(event, {
        scrollContainer: scrollParent(tree ?? null),
        preview: () => dragPreview(id),
        resolve: (x, y) => resolveTarget(x, y, id),
        onStart: () => setDraggingId(id),
        onMove: (target) => setDropTarget(target),
        onDrop: (target) => drop(id, target),
        onEnd: () => {
          setDraggingId(null);
          setDropTarget(null);
        },
      });
    },
  };

  return (
    <TreeContext.Provider value={api}>
      <Show when={root.loading()}>
        <div class={styles.skeleton} role="status" aria-label="Loading pages">
          <span />
          <span />
          <span />
        </div>
      </Show>
      <Show when={root.error() && !root.data()}>
        <div class={styles.message} role="alert">
          <p>Couldn't load your pages.</p>
          <Button onClick={() => void root.refetch()}>Retry</Button>
        </div>
      </Show>
      <Show when={root.data()?.length === 0}>
        <div class={styles.message}>
          <p>No pages yet.</p>
          <Button onClick={() => openNewPage({ workspaceId: props.workspaceId })}>
            <IconPlus size={16} />
            Add a page
          </Button>
        </div>
      </Show>
      <ul
        ref={tree}
        role="tree"
        aria-labelledby={props["aria-labelledby"]}
        class={styles.tree}
        hidden={!root.data()?.length}
        onKeyDown={onKeyDown}
        onFocusIn={onFocusIn}
      >
        <Level parentId={null} level={1} query={root} />
      </ul>
    </TreeContext.Provider>
  );
}

/**
 * The rows of one level. Keyed by id (not by node object), so updating a
 * page's title or moving it within the level keeps its row and subtree.
 * @param {{ parentId: string | null, level: number, query: ChildrenQuery }} props
 */
function Level(props) {
  const nodes = () => props.query.data() ?? [];
  const ids = /** @type {import("solid-js").Accessor<string[]>} */ (
    createMemo(() => nodes().map((node) => node.id), undefined, { equals: sameArray })
  );
  const byId = createMemo(() => new Map(nodes().map((node) => [node.id, node])));
  return (
    <For each={ids()}>
      {(id, index) => (
        <TreeItem
          id={id}
          node={() => byId().get(id)}
          parentId={props.parentId}
          level={props.level}
          posinset={index() + 1}
          setsize={ids().length}
        />
      )}
    </For>
  );
}

/**
 * An expanded page's children: loads them, and says so while loading, on
 * error, or when there are none.
 * @param {{ parentId: string, level: number }} props
 */
function ChildLevel(props) {
  const tree = useTree();
  const query = useChildren(() => tree.workspaceId, props.parentId);
  return (
    <>
      <Level parentId={props.parentId} level={props.level} query={query} />
      <Show when={query.loading()}>
        <li role="none" class={styles.status} style={{ "--level": props.level }}>
          Loading…
        </li>
      </Show>
      <Show when={query.error() && !query.data()}>
        <li role="none" class={styles.status} style={{ "--level": props.level }}>
          Couldn't load.
          <button type="button" class={styles.retry} onClick={() => void query.refetch()}>
            Retry
          </button>
        </li>
      </Show>
      <Show when={query.data()?.length === 0}>
        <li role="none" class={styles.status} style={{ "--level": props.level }}>
          No pages inside
        </li>
      </Show>
    </>
  );
}

/**
 * @param {{
 *   id: string,
 *   node: () => TreeNode | undefined,
 *   parentId: string | null,
 *   level: number,
 *   posinset: number,
 *   setsize: number,
 * }} props
 */
function TreeItem(props) {
  const tree = useTree();
  const groupId = createUniqueId();
  /** @type {HTMLAnchorElement | undefined} */
  let link;
  // Keep the last node while the row is being removed.
  const node = createMemo(
    (/** @type {TreeNode | undefined} */ previous) => props.node() ?? previous,
  );
  const title = () => displayTitle(node()?.title ?? "");
  /** A database holds rows, not pages. */
  const isDatabase = () => node()?.kind === "database";
  /** Its rows show inside it, as subpages. */
  const rowsShown = () => isDatabase() && showsRowPages(props.id);
  const expandable = () => Boolean(node()?.has_children) || rowsShown();
  const open = () => expandable() && isExpanded(props.id);
  const dropZoneHere = () => {
    const target = tree.dropTarget();
    if (target?.id !== props.id) return undefined;
    return target.zone === "after" && target.expanded ? "first-child" : target.zone;
  };

  const addChild = () => openNewPage({ workspaceId: tree.workspaceId, parentId: props.id });
  const addDatabase = () =>
    openNewPage({ workspaceId: tree.workspaceId, parentId: props.id, kind: "database" });
  const addRow = () => openNewRow({ workspaceId: tree.workspaceId, databaseId: props.id });
  /** @param {boolean} value */
  function showRows(value) {
    setShowsRowPages(props.id, value);
    if (value) setPageExpanded(props.id, true);
  }

  /** @param {string | null} value @param {boolean} refocus */
  function finishRename(value, refocus) {
    tree.setRenamingId(null);
    const next = value?.trim();
    if (next !== undefined && next !== (node()?.title ?? ""))
      void renamePage(tree.workspaceId, props.id, next);
    if (refocus) link?.focus();
  }

  return (
    <li role="none" class={styles.item} data-id={props.id}>
      <div
        class={styles.row}
        style={{ "--level": props.level }}
        data-row
        data-id={props.id}
        data-parent-id={props.parentId ?? ""}
        data-open={open() ? "true" : undefined}
        data-drop={dropZoneHere()}
        data-dragging={tree.draggingId() === props.id || undefined}
        data-renaming={tree.renamingId() === props.id || undefined}
      >
        <Link
          ref={(el) => (link = el)}
          href={`/p/${encodeURIComponent(props.id)}`}
          role="treeitem"
          tabindex="-1"
          draggable={false}
          class={styles.link}
          aria-level={props.level}
          aria-setsize={props.setsize}
          aria-posinset={props.posinset}
          aria-expanded={expandable() ? open() : undefined}
          aria-owns={open() ? groupId : undefined}
          data-id={props.id}
          data-parent-id={props.parentId ?? ""}
          data-title={title()}
          onPointerDown={(event) => tree.onItemPointerDown(event, props.id)}
        >
          <span
            class={styles.toggle}
            data-toggle
            aria-hidden="true"
            onClick={(event) => {
              // Toggle without following the link.
              event.preventDefault();
              if (expandable()) toggleExpanded(props.id);
            }}
          >
            <Show when={expandable()}>
              <IconChevronRight size={14} class={styles.chevron} />
            </Show>
          </span>
          <PageIcon icon={node()?.icon} kind={node()?.kind} size={18} />
          <span class={styles.label}>{title()}</span>
        </Link>

        <Show when={tree.renamingId() === props.id}>
          <RenameInput initial={node()?.title ?? ""} onDone={finishRename} />
        </Show>

        <div class={styles.actions}>
          <Menu
            label={`Actions for ${title()}`}
            placement="bottom-start"
            focusOnClose={() => link}
            trigger={(triggerProps) => (
              <IconButton
                {...triggerProps}
                label="Rename, duplicate, delete…"
                size="small"
                tabindex="-1"
                data-menu-trigger
              >
                <IconMore size={16} />
              </IconButton>
            )}
          >
            <Show when={!isDatabase()}>
              <MenuItem icon={<IconPlus />} onSelect={addChild}>
                Add a page inside
              </MenuItem>
              <MenuItem icon={<IconTable />} onSelect={addDatabase}>
                Add a database inside
              </MenuItem>
            </Show>
            <Show when={isDatabase()}>
              <Show
                when={rowsShown()}
                fallback={
                  <MenuItem icon={<IconEye />} onSelect={() => showRows(true)}>
                    Show rows in the sidebar
                  </MenuItem>
                }
              >
                <MenuItem icon={<IconPlus />} onSelect={addRow}>
                  Add a row
                </MenuItem>
                <MenuItem icon={<IconEyeOff />} onSelect={() => showRows(false)}>
                  Hide rows from the sidebar
                </MenuItem>
              </Show>
            </Show>
            <MenuItem
              icon={<IconPencil />}
              shortcut="f2"
              onSelect={() => tree.setRenamingId(props.id)}
            >
              Rename
            </MenuItem>
            <MenuItem
              icon={<IconCopy />}
              onSelect={() => void duplicatePage(tree.workspaceId, props.id)}
            >
              Duplicate
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              icon={<IconTrash />}
              shortcut="mod+backspace"
              onSelect={() => void trashPage(tree.workspaceId, props.id)}
            >
              Move to trash
            </MenuItem>
          </Menu>
          <Show when={!isDatabase()}>
            <IconButton
              label="Add a page inside"
              size="small"
              tabindex="-1"
              class={styles.addButton}
              onClick={addChild}
            >
              <IconPlus size={16} />
            </IconButton>
          </Show>
          <Show when={rowsShown()}>
            <IconButton
              label="Add a row"
              size="small"
              tabindex="-1"
              class={styles.addButton}
              onClick={addRow}
            >
              <IconPlus size={16} />
            </IconButton>
          </Show>
        </div>
      </div>

      <Show when={open()}>
        <ul role="group" id={groupId} class={styles.group}>
          <Show
            when={rowsShown()}
            fallback={<ChildLevel parentId={props.id} level={props.level + 1} />}
          >
            <RowLevel databaseId={props.id} level={props.level + 1} />
          </Show>
        </ul>
      </Show>
    </li>
  );
}

/**
 * A database's rows, as its subpages: the first chunk, in the database's
 * own order (no filter or sorts: views can differ), and a link to the rest.
 * @param {{ databaseId: string, level: number }} props
 */
function RowLevel(props) {
  const rows = useRows(
    () => props.databaseId,
    () => ({ filter: null, sorts: [] }),
    () => ({ start: 0, end: CHUNK_SIZE }),
  );
  const shown = createMemo(() => {
    /** @type {Row[]} */
    const out = [];
    const count = Math.min(rows.total() ?? 0, CHUNK_SIZE);
    for (let i = 0; i < count; i++) {
      const row = rows.row(i);
      if (row) out.push(row);
    }
    return out;
  }, []);
  const ids = /** @type {import("solid-js").Accessor<string[]>} */ (
    createMemo(() => shown().map((row) => row.id), undefined, { equals: sameArray })
  );
  const byId = createMemo(() => new Map(shown().map((row) => [row.id, row])));
  const more = () => (rows.total() ?? 0) - ids().length;
  return (
    <>
      <For each={ids()}>
        {(id, index) => (
          <RowItem
            id={id}
            row={() => byId().get(id)}
            databaseId={props.databaseId}
            level={props.level}
            posinset={index() + 1}
            setsize={rows.total() ?? ids().length}
          />
        )}
      </For>
      <Show when={rows.total() === undefined && !rows.error()}>
        <li role="none" class={styles.status} style={{ "--level": props.level }}>
          Loading…
        </li>
      </Show>
      <Show when={rows.error() && rows.total() === undefined}>
        <li role="none" class={styles.status} style={{ "--level": props.level }}>
          Couldn't load.
          <button type="button" class={styles.retry} onClick={() => rows.refetch()}>
            Retry
          </button>
        </li>
      </Show>
      <Show when={rows.total() === 0}>
        <li role="none" class={styles.status} style={{ "--level": props.level }}>
          No rows
        </li>
      </Show>
      <Show when={more() > 0}>
        <li role="none" class={styles.status} style={{ "--level": props.level }}>
          <Link
            href={`/p/${encodeURIComponent(props.databaseId)}`}
            class={styles.retry}
            tabindex="-1"
          >
            {more()} more in the database
          </Link>
        </li>
      </Show>
    </>
  );
}

/**
 * One row of a database, in the tree: opens, renames and goes to the trash
 * like a page, but doesn't drag (see `PageTree`).
 * @param {{
 *   id: string,
 *   row: () => Row | undefined,
 *   databaseId: string,
 *   level: number,
 *   posinset: number,
 *   setsize: number,
 * }} props
 */
function RowItem(props) {
  const tree = useTree();
  /** @type {HTMLAnchorElement | undefined} */
  let link;
  const row = createMemo((/** @type {Row | undefined} */ previous) => props.row() ?? previous);
  // The row's page, once it's open, has the title as it's being typed.
  const page = () => /** @type {Page | undefined} */ (readQuery(pageKeys.page(props.id)));
  const rawTitle = () => page()?.title ?? row()?.title ?? "";
  const icon = () => (page() ? page()?.icon : row()?.icon) ?? null;
  const title = () => displayTitle(rawTitle());
  const trash = () =>
    void trashRows({
      databaseId: props.databaseId,
      workspaceId: tree.workspaceId,
      ids: [props.id],
      title: rawTitle(),
    });

  /** @param {string | null} value @param {boolean} refocus */
  function finishRename(value, refocus) {
    tree.setRenamingId(null);
    const next = value?.trim();
    if (next !== undefined && next !== rawTitle())
      void updateRow(props.databaseId, props.id, { title: next });
    if (refocus) link?.focus();
  }

  return (
    <li role="none" class={styles.item} data-id={props.id}>
      <div
        class={styles.row}
        style={{ "--level": props.level }}
        data-renaming={tree.renamingId() === props.id || undefined}
      >
        <Link
          ref={(el) => (link = el)}
          href={`/p/${encodeURIComponent(props.id)}`}
          role="treeitem"
          tabindex="-1"
          draggable={false}
          class={styles.link}
          aria-level={props.level}
          aria-setsize={props.setsize}
          aria-posinset={props.posinset}
          data-id={props.id}
          data-parent-id={props.databaseId}
          data-database-id={props.databaseId}
          data-title={title()}
        >
          <span class={styles.toggle} aria-hidden="true" />
          <PageIcon icon={icon()} kind="row" size={18} />
          <span class={styles.label}>{title()}</span>
        </Link>

        <Show when={tree.renamingId() === props.id}>
          <RenameInput initial={rawTitle()} onDone={finishRename} />
        </Show>

        <div class={styles.actions}>
          <Menu
            label={`Actions for ${title()}`}
            placement="bottom-start"
            focusOnClose={() => link}
            trigger={(triggerProps) => (
              <IconButton
                {...triggerProps}
                label="Rename, delete…"
                size="small"
                tabindex="-1"
                data-menu-trigger
              >
                <IconMore size={16} />
              </IconButton>
            )}
          >
            <MenuItem
              icon={<IconPencil />}
              shortcut="f2"
              onSelect={() => tree.setRenamingId(props.id)}
            >
              Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<IconTrash />} shortcut="mod+backspace" onSelect={trash}>
              Move to trash
            </MenuItem>
          </Menu>
        </div>
      </div>
    </li>
  );
}

/**
 * Inline title editor over a row. Enter saves, Escape cancels, clicking
 * away saves.
 * @param {{ initial: string, onDone: (value: string | null, refocus: boolean) => void }} props
 */
function RenameInput(props) {
  /** @type {HTMLInputElement | undefined} */
  let input;
  let done = false;

  /** @param {string | null} value @param {boolean} refocus */
  function finish(value, refocus) {
    if (done) return;
    done = true;
    props.onDone(value, refocus);
  }

  onMount(() => {
    input?.focus();
    input?.select();
  });

  return (
    <input
      ref={input}
      class={styles.rename}
      value={props.initial}
      aria-label="Page title"
      placeholder="Untitled"
      maxLength={2000}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(event.currentTarget.value, true);
        } else if (event.key === "Escape") {
          // Just the rename: not the drawer around the sidebar.
          event.preventDefault();
          event.stopPropagation();
          finish(null, true);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value, false)}
    />
  );
}

/** @param {readonly unknown[]} a @param {readonly unknown[]} b */
function sameArray(a, b) {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/** @param {DropTarget | null} a @param {DropTarget | null} b */
function sameTarget(a, b) {
  return (
    a === b ||
    (a !== null && b !== null && a.id === b.id && a.zone === b.zone && a.expanded === b.expanded)
  );
}
