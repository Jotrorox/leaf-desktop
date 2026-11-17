// @ts-check
import {
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  createUniqueId,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import { ApiError } from "../../api/client.js";
import { saveDoc } from "../../api/docs.js";
import { fileUrl, IMAGE_TYPES } from "../../api/files.js";
import { searchPages } from "../../api/pages.js";
import { savePageText } from "../../api/search.js";
import { openSyncSocket } from "../../api/sync.js";
import { session } from "../../auth/clerk.js";
import { createPage, displayTitle, useWorkspace } from "../../data/pages.js";
import DatabaseEmbed from "../../databases/ui/DatabaseEmbed.jsx";
import { cx } from "../../lib/cx.js";
import { navigate } from "../../lib/router/index.js";
import Button from "../../ui/Button.jsx";
import Dialog from "../../ui/Dialog.jsx";
import {
  IconArrowDown,
  IconArrowUp,
  IconChevronLeft,
  IconChevronRight,
  IconMath,
  IconPlus,
  IconTrash,
} from "../../ui/icons/index.jsx";
import Menu, { MenuItem, MenuSeparator } from "../../ui/Menu.jsx";
import PageIcon from "../../ui/PageIcon.jsx";
import { toast } from "../../ui/Toast.jsx";
import { parseColor } from "../blocks/colors.js";
import { isPlainText, safeImageSrc, spec } from "../blocks/schema.js";
import { CELL, rowCells, tableRows } from "../commands/table.js";
import { EditorController } from "../editor.js";
import { useMathReady } from "../math/ready.js";
import { equationLabel } from "../math/refs.js";
import { renderMath } from "../math/render.js";
import { Awareness } from "../sync/awareness.js";
import { createDocCache } from "../sync/cache.js";
import { loadDoc, peekDoc } from "../sync/load.js";
import { localState, readPeer, setCollaborators, setJumpHandler } from "../sync/presence.js";
import { SyncProvider } from "../sync/provider.js";
import { setSaveStatus } from "../sync/status.js";
import { createTextSync } from "../sync/text.js";
import { renderRuns } from "../view/dom.js";
import BlockHandle from "./BlockHandle.jsx";
import styles from "./Editor.module.css";
import ImageBlock from "./ImageBlock.jsx";
import InlineToolbar from "./InlineToolbar.jsx";
import MacrosDialog from "./MacrosDialog.jsx";
import MathPopover from "./MathPopover.jsx";
import MentionMenu from "./MentionMenu.jsx";
import MobileToolbar from "./MobileToolbar.jsx";
import RemoteCursors from "./RemoteCursors.jsx";
import SlashMenu from "./SlashMenu.jsx";
import TexMenu from "./TexMenu.jsx";
import { uploadImages } from "./uploads.js";

/**
 * @typedef {object} EditorApi
 * @property {() => void} focusStart Put the caret at the start of the document.
 */

/**
 * How an editor talks to the server, when it isn't the app's own (the
 * multi-client test page runs several editors against an in-page server).
 * @typedef {object} CollabOptions
 * @property {() => ReturnType<typeof openSyncSocket>} connect
 * @property {(update: Uint8Array, options: { keepalive: boolean }) => Promise<Uint8Array>} saveHttp
 * @property {import("../sync/presence.js").LocalUser} user
 * @property {(collaborators: readonly import("../sync/presence.js").Collaborator[]) => void} [onCollaborators]
 * @property {(handles: { sync: SyncProvider, ed: EditorController }) => void} [onReady] For driving the editor from outside.
 */

/**
 * A page's document editor: loads the document, edits it, saves it, and
 * shows who else is on the page.
 *
 * @param {{
 *   pageId: string,
 *   readOnly?: boolean,
 *   viewOnly?: boolean,
 *   ref?: (api: EditorApi) => void,
 *   onExitTop?: () => void,
 *   onReadOnly?: () => void,
 * }} props `viewOnly`: read-only because the user may only view (or comment on) the page; the top bar says so.
 *   `onReadOnly`: the server says the page can't be edited any more (it went to the trash, or was deleted).
 */
export default function Editor(props) {
  // A document in memory comes back synchronously, so the page shows in
  // the same frame, without the loading placeholder.
  const [loaded, { refetch }] = createResource(
    () => props.pageId,
    (pageId) =>
      peekDoc(pageId, { readOnly: props.readOnly }) ??
      loadDoc(pageId, { readOnly: props.readOnly }),
  );
  return (
    <Switch>
      <Match when={loaded.error}>
        <div class={styles.message} role="alert">
          <p>
            {loaded.error instanceof ApiError && loaded.error.status === 0
              ? "Can't reach the server to load this page's content."
              : "Couldn't load this page's content."}
          </p>
          <Button onClick={() => void refetch()}>Retry</Button>
        </div>
      </Match>
      <Match when={loaded()}>
        {(state) => (
          <EditorView
            pageId={props.pageId}
            readOnly={props.readOnly}
            viewOnly={props.viewOnly}
            doc={state().doc}
            acked={state().acked}
            ref={props.ref}
            onExitTop={props.onExitTop}
            onReadOnly={props.onReadOnly}
          />
        )}
      </Match>
      <Match when={loaded.loading}>
        <div class={styles.skeleton} role="status" aria-label="Loading content">
          <span />
          <span />
          <span />
        </div>
      </Match>
    </Switch>
  );
}

/** The signed-in user, as others see them. @returns {import("../sync/presence.js").LocalUser} */
function signedInUser() {
  const s = session();
  if (s.status !== "signedIn") return { id: "", name: "Someone", image: null };
  return { id: s.user.id, name: s.user.name, image: s.user.imageUrl };
}

/**
 * One open document: the editor, its live sync, and presence.
 *
 * Without `collab` it's the app's page editor: it talks to the app's
 * server, keeps the local cache, reports to the top bar (save state,
 * collaborators) and listens to the window (unload, online). With `collab`
 * it's self-contained (the multi-client test page).
 *
 * @param {{
 *   pageId: string,
 *   readOnly?: boolean,
 *   viewOnly?: boolean,
 *   doc: import("../model/doc.js").Doc,
 *   acked: Map<number, number>,
 *   ref?: (api: EditorApi) => void,
 *   onExitTop?: () => void,
 *   onReadOnly?: () => void,
 *   collab?: CollabOptions,
 *   label?: string,
 * }} props
 */
export function EditorView(props) {
  // Read-only changes (trash, restore, role) remount the page view, so these are fixed for this view.
  const ed = new EditorController(props.doc, { readOnly: props.readOnly });
  ed.onExitTop = () => props.onExitTop?.();
  ed.onNavigate = (path) => navigate(path);
  const menuId = createUniqueId();
  const app = !props.collab;
  const workspace = useWorkspace();
  // An inline database is a subpage of this one; the block shows it.
  ed.onCreateDatabase = () => {
    const workspaceId = workspace.id();
    return app && workspaceId
      ? createPage({ workspaceId, parentId: props.pageId, kind: "database" })
      : null;
  };
  // Images: uploaded for this page, each block showing its upload.
  ed.onImages = (files, at) => {
    if (!app) return;
    void uploadImages(files, {
      pageId: props.pageId,
      place: (fileId, previous) => ed.insertImage(previous ?? at, { file: fileId }),
    });
  };
  ed.onPickImage = (at) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_TYPES.join(",");
    input.multiple = true;
    input.addEventListener("change", () => {
      const files = [...(input.files ?? [])];
      if (files.length > 0) ed.onImages(files, at);
    });
    input.click();
  };
  ed.imageUrl = (attrs) =>
    typeof attrs.file === "string" ? fileUrl(attrs.file) || null : safeImageSrc(attrs.src);
  const user = props.collab?.user ?? signedInUser();
  const cache = props.readOnly || !app ? null : createDocCache(props.pageId, props.doc);
  const awareness = new Awareness(props.doc.clientId);
  // A read-only editor still syncs: it shows others' changes and presence live.
  const sync = new SyncProvider({
    doc: props.doc,
    acked: props.acked,
    readOnly: props.readOnly,
    awareness,
    connect: props.collab?.connect ?? (() => openSyncSocket(props.pageId)),
    saveHttp:
      props.collab?.saveHttp ??
      ((update, { keepalive }) => saveDoc(props.pageId, update, { keepalive })),
    applyRemote: (bytes) => ed.applyRemote(bytes),
    onStatus: app ? setSaveStatus : undefined,
    onPersist: (state) => cache?.persist(state),
    // The page went to the trash meanwhile: its query refetches, and the
    // page view remounts read-only.
    onReadOnly: () => props.onReadOnly?.(),
    onGone: () => props.onReadOnly?.(),
    onTooLarge: () =>
      toast({
        title: "This page is too large to save",
        description: "New changes stay on this device only. Move some content to another page.",
        tone: "danger",
        duration: Infinity,
      }),
  });
  // A document opened from the cache is saved locally from the start.
  if (cache) cache.persist({ acked: sync.acked });
  // Its text, for search, and the files it shows (editors only; the server refuses anyone else).
  const text =
    props.readOnly || !app
      ? null
      : createTextSync({
          doc: props.doc,
          send: (report, options) => savePageText(props.pageId, report, options),
        });
  props.collab?.onReady?.({ sync, ed });

  // Presence: our cursor goes out (the last selection stays shared when
  // focus moves elsewhere, as in other editors); others' come in.
  const [collaborators, setPeers] = createSignal(
    /** @type {readonly import("../sync/presence.js").Collaborator[]} */ ([]),
  );
  onCleanup(awareness.observe(() => setPeers([...awareness.peers.values()].map(readPeer))));
  createEffect(() => {
    const sel = ed.trackedSelection();
    /** @type {{ anchor: import("../model/doc.js").RelativePosition, focus: import("../model/doc.js").RelativePosition } | null} */
    let cursor = null;
    if (sel) {
      try {
        cursor = {
          anchor: props.doc.createRelativePosition(sel.anchor.block, sel.anchor.offset),
          focus: props.doc.createRelativePosition(sel.focus.block, sel.focus.offset),
        };
      } catch {
        cursor = null;
      }
    }
    awareness.setLocal(localState(user, cursor));
  });
  createEffect(() => {
    const list = collaborators();
    if (app) setCollaborators(list);
    props.collab?.onCollaborators?.(list);
  });
  /** @type {HTMLDivElement | undefined} */
  let root;
  /** @type {HTMLDivElement | undefined} */
  let container;

  props.ref?.({ focusStart: () => ed.focusStart() });

  onMount(() => {
    if (!root) return;
    ed.mount(root);
    if (!app) return;
    setSaveStatus(props.readOnly ? (props.viewOnly ? "view-only" : null) : sync.status);
    /** Send what the server lacks, and save locally, before the page goes. */
    const flush = () => {
      sync.flushOnUnload();
      void cache?.flush();
      text?.flush();
    };
    /** @param {BeforeUnloadEvent} event */
    const beforeUnload = (event) => {
      if (!sync.dirty) return;
      const savedLocally = cache?.saved() ?? false;
      flush();
      // Unconfirmed changes that are in the local cache come back next time.
      if (!savedLocally) event.preventDefault();
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    // iOS Safari doesn't fire beforeunload; pagehide is its last chance.
    const pageHide = () => flush();
    const online = () => sync.retryNow();
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("pagehide", pageHide);
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", hidden);
    onCleanup(() => {
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("pagehide", pageHide);
      window.removeEventListener("online", online);
      document.removeEventListener("visibilitychange", hidden);
    });
  });

  onCleanup(() => {
    text?.destroy();
    sync.destroy();
    awareness.destroy();
    void cache?.flush();
    ed.destroy();
    if (app) {
      setSaveStatus(null);
      setCollaborators([]);
    }
  });

  return (
    <div ref={container} class={styles.editor}>
      <div
        ref={root}
        class={styles.content}
        contentEditable={!props.readOnly}
        role="textbox"
        aria-multiline="true"
        aria-label={props.label ?? "Page content"}
        aria-readonly={props.readOnly ? "true" : undefined}
        spellcheck
        translate="no"
        data-editor
      >
        <BlockList ed={ed} parent={null} depth={0} />
      </div>
      <Show when={props.readOnly && (ed.structure(), ed.doc.root().length === 0)}>
        <p class={styles.empty}>This page is empty.</p>
      </Show>
      <Show when={!props.readOnly}>
        <div
          class={styles.tail}
          aria-hidden="true"
          onMouseDown={(event) => {
            event.preventDefault();
            ed.focusEnd();
          }}
        />
      </Show>
      <RemoteCursors
        ed={ed}
        collaborators={collaborators}
        container={() => container}
        registerJump={app ? setJumpHandler : undefined}
      />
      <LinkDialog ed={ed} pageId={props.pageId} />
      <Show when={!props.readOnly}>
        <SlashMenu ed={ed} id={`${menuId}-slash`} />
        <MentionMenu ed={ed} pageId={props.pageId} id={`${menuId}-mention`} />
        <TexMenu ed={ed} id={`${menuId}-tex`} />
        <InlineToolbar ed={ed} />
        <MathPopover ed={ed} />
        <MacrosDialog ed={ed} />
        <BlockHandle ed={ed} container={() => container} />
        <MobileToolbar ed={ed} />
      </Show>
    </div>
  );
}

/** @param {string[]} a @param {string[]} b */
const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The visible children of `parent` (the top level for null).
 * @param {{ ed: EditorController, parent: string | null, depth: number }} props
 */
function BlockList(props) {
  const ed = props.ed;
  const ids = createMemo(
    () => {
      ed.structure();
      return ed.doc.children(props.parent);
    },
    [],
    { equals: sameIds },
  );
  // Numbered items count up through each run of consecutive ones.
  const numbers = createMemo(() => {
    /** @type {Map<string, number>} */
    const out = new Map();
    let n = 0;
    for (const id of ids()) {
      ed.version(id);
      if (ed.doc.getType(id) === "numbered") out.set(id, ++n);
      else n = 0;
    }
    return out;
  });
  return (
    <For each={ids()}>
      {(id) => <Block ed={ed} id={id} depth={props.depth} number={numbers().get(id)} />}
    </For>
  );
}

const BULLETS = ["•", "◦", "▪"];

/**
 * One block: its row (marker and text) and, below, its children.
 * @param {{ ed: EditorController, id: string, depth: number, number?: number }} props
 */
function Block(props) {
  const ed = props.ed;
  const id = props.id;
  const type = createMemo(() => {
    ed.version(id);
    return ed.doc.getType(id);
  });
  const attrs = createMemo(() => {
    ed.version(id);
    return ed.doc.getAttrs(id);
  });
  const children = createMemo(
    () => {
      ed.structure();
      return ed.doc.children(id);
    },
    [],
    { equals: sameIds },
  );
  const open = () => type() !== "toggle" || ed.isOpen(id);
  const editing = () => type() === "equation" && ed.isEditingEquation(id);
  const color = () => {
    const c = parseColor(attrs().color);
    return c ? (c.background ? `${c.name}_background` : c.name) : undefined;
  };

  return (
    <div
      class={styles.block}
      data-block-id={id}
      data-type={type()}
      data-highlighted={ed.highlighted().has(id) ? "" : undefined}
    >
      <Show
        when={
          type() !== "divider" &&
          type() !== "database" &&
          type() !== "image" &&
          type() !== "table" &&
          type() !== "table_row"
        }
        fallback={
          <Switch
            fallback={
              <div class={styles.divider} contentEditable={false} data-row>
                <hr />
              </div>
            }
          >
            <Match when={type() === "database"}>
              <div contentEditable={false} data-row data-embed>
                <DatabaseEmbed
                  databaseId={typeof attrs().database === "string" ? String(attrs().database) : ""}
                />
              </div>
            </Match>
            <Match when={type() === "image"}>
              <div contentEditable={false} data-row data-embed>
                <ImageBlock ed={ed} id={id} attrs={attrs()} />
              </div>
            </Match>
            <Match when={type() === "table"}>
              <TableView ed={ed} id={id} attrs={attrs()} color={color()} />
            </Match>
            <Match when={type() === "table_row"}>
              {/* A row outside its table (an older client moved it): its cells show below. */}
              <div contentEditable={false} data-row />
            </Match>
          </Switch>
        }
      >
        <div
          class={cx(
            styles.row,
            styles[`type_${type()}`],
            type() === "todo" && attrs().checked === true && styles.checked,
          )}
          data-row
          data-color={color()}
          data-editing={editing() ? "" : undefined}
        >
          <Switch>
            <Match when={type() === "bulleted"}>
              <span class={styles.marker} contentEditable={false} aria-hidden="true">
                {BULLETS[props.depth % BULLETS.length]}
              </span>
            </Match>
            <Match when={type() === "numbered"}>
              <span
                class={cx(styles.marker, styles.number)}
                contentEditable={false}
                aria-hidden="true"
              >
                {props.number ?? 1}.
              </span>
            </Match>
            <Match when={type() === "todo"}>
              <span class={styles.marker} contentEditable={false}>
                <input
                  type="checkbox"
                  class={styles.checkbox}
                  checked={attrs().checked === true}
                  disabled={ed.readOnly}
                  aria-label="Done"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.preventDefault();
                    ed.toggleChecked(id);
                  }}
                />
              </span>
            </Match>
            <Match when={type() === "toggle"}>
              <span class={styles.marker} contentEditable={false}>
                <button
                  type="button"
                  class={cx(styles.toggle, open() && styles.toggleOpen)}
                  aria-expanded={open()}
                  aria-label={open() ? "Collapse" : "Expand"}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => ed.toggleOpen(id)}
                >
                  <IconChevronRight size={16} />
                </button>
              </span>
            </Match>
            <Match when={type() === "callout"}>
              <span
                class={cx(styles.marker, styles.calloutIcon)}
                contentEditable={false}
                aria-hidden="true"
              >
                {String(attrs().icon ?? "💡")}
              </span>
            </Match>
            <Match when={type() === "equation"}>
              <EquationView ed={ed} id={id} editing={editing()} />
            </Match>
          </Switch>
          <BlockText ed={ed} id={id} type={type()} />
          <Show when={editing()}>
            <EquationBar ed={ed} id={id} />
          </Show>
        </div>
      </Show>
      <Show when={children().length > 0 && open() && type() !== "table" && type() !== CELL}>
        <div class={cx(styles.children, type() === "callout" && styles.calloutChildren)}>
          <BlockList ed={ed} parent={id} depth={props.depth + 1} />
        </div>
      </Show>
    </div>
  );
}

/** What the row and column menus offer, and what they're called. */
const ROW_ACTIONS = /** @type {const} */ ([
  ["row-above", "Insert row above"],
  ["row-below", "Insert row below"],
  ["move-row-up", "Move row up"],
  ["move-row-down", "Move row down"],
  ["delete-row", "Delete row"],
]);
const COLUMN_ACTIONS = /** @type {const} */ ([
  ["column-left", "Insert column left"],
  ["column-right", "Insert column right"],
  ["move-column-left", "Move column left"],
  ["move-column-right", "Move column right"],
  ["delete-column", "Delete column"],
]);

/** @type {Record<string, () => import("solid-js").JSX.Element>} */
const ACTION_ICONS = {
  "row-above": () => <IconPlus size={16} />,
  "row-below": () => <IconPlus size={16} />,
  "column-left": () => <IconPlus size={16} />,
  "column-right": () => <IconPlus size={16} />,
  "move-row-up": () => <IconArrowUp size={16} />,
  "move-row-down": () => <IconArrowDown size={16} />,
  "move-column-left": () => <IconChevronLeft size={16} />,
  "move-column-right": () => <IconChevronRight size={16} />,
  "delete-row": () => <IconTrash size={16} />,
  "delete-column": () => <IconTrash size={16} />,
};

/**
 * A table block: a grid of cells, each a text block of its own, so typing,
 * formatting and collaboration work in it as anywhere. Rows short of cells
 * (see table.js) show gaps. While the caret is in a cell, handles on its
 * row and column open their menus; + buttons at the end add a row or a
 * column.
 * @param {{ ed: EditorController, id: string, attrs: Record<string, unknown>, color?: string }} props
 */
function TableView(props) {
  const ed = props.ed;
  const rows = createMemo(
    () => {
      ed.structure();
      return tableRows(ed.doc, props.id);
    },
    [],
    { equals: sameIds },
  );
  const columns = createMemo(() => {
    let n = 0;
    for (const row of rows()) n = Math.max(n, rowCells(ed.doc, row).length);
    return n;
  });
  /**
   * The cell the caret is in, when it's in this table. It stays while focus
   * is elsewhere (in a row or column menu) and goes once the caret is in
   * another block.
   */
  const [active, setActive] = createSignal(/** @type {string | null} */ (null));
  createEffect(() => {
    const block = ed.focusedBlock();
    ed.structure();
    if (block === null) {
      const current = untrack(active);
      if (current !== null && !ed.doc.isVisible(current)) setActive(null);
      return;
    }
    const row =
      ed.doc.hasBlock(block) && ed.doc.getType(block) === CELL ? ed.doc.parentOf(block) : null;
    setActive(typeof row === "string" && ed.doc.parentOf(row) === props.id ? block : null);
  });
  const [handles, setHandles] = createSignal(
    /** @type {{ row: { top: number, height: number }, column: { left: number, width: number } } | null} */ (
      null
    ),
  );
  /** @type {HTMLDivElement | undefined} */
  let scroller;

  // Line the handles up with the active cell (again when anything in the table changes size).
  const place = () => {
    const cell = active();
    const td =
      cell && scroller
        ? /** @type {HTMLElement | null} */ (
            scroller.querySelector(`[data-cell="${CSS.escape(cell)}"]`)
          )
        : null;
    if (!td || !scroller) {
      setHandles(null);
      return;
    }
    const box = scroller.getBoundingClientRect();
    const rect = td.getBoundingClientRect();
    setHandles({
      row: { top: rect.top - box.top + scroller.scrollTop, height: rect.height },
      column: { left: rect.left - box.left + scroller.scrollLeft, width: rect.width },
    });
  };
  createEffect(() => {
    const cell = active();
    if (cell) ed.version(cell);
    ed.structure();
    queueMicrotask(place);
  });
  onMount(() => {
    if (!scroller) return;
    const observer = new ResizeObserver(() => place());
    observer.observe(scroller);
    const table = scroller.querySelector("table");
    if (table) observer.observe(table);
    onCleanup(() => observer.disconnect());
  });

  /** @param {import("../editor.js").TableAction} action */
  const act = (action) => {
    const cell = active();
    if (cell) ed.tableAction(cell, action);
  };

  return (
    <div class={styles.table} data-row data-color={props.color}>
      <div ref={scroller} class={styles.tableScroll}>
        <div class={styles.tableFrame}>
          <table
            class={styles.tableGrid}
            data-header-row={props.attrs.header_row === true ? "" : undefined}
            data-header-column={props.attrs.header_column === true ? "" : undefined}
          >
            <tbody>
              <For each={rows()}>{(row) => <TableRow ed={ed} id={row} columns={columns()} />}</For>
            </tbody>
          </table>
          <Show when={!ed.readOnly}>
            <button
              type="button"
              class={cx(styles.tableAdd, styles.tableAddColumn)}
              contentEditable={false}
              data-embed
              tabIndex={-1}
              aria-label="Add a column"
              title="Add a column"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => ed.tableAction(props.id, "add-column")}
            >
              <IconPlus size={14} />
            </button>
            <button
              type="button"
              class={cx(styles.tableAdd, styles.tableAddRow)}
              contentEditable={false}
              data-embed
              tabIndex={-1}
              aria-label="Add a row"
              title="Add a row"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => ed.tableAction(props.id, "add-row")}
            >
              <IconPlus size={14} />
            </button>
          </Show>
        </div>
        <Show when={!ed.readOnly && handles()}>
          {(at) => (
            <>
              <TableHandle
                class={styles.rowHandle}
                style={{ top: `${at().row.top}px`, height: `${at().row.height}px` }}
                label="Row options"
                actions={ROW_ACTIONS}
                onAction={act}
                focusOnClose={() => ed.root}
              />
              <TableHandle
                class={styles.columnHandle}
                style={{ left: `${at().column.left}px`, width: `${at().column.width}px` }}
                label="Column options"
                actions={COLUMN_ACTIONS}
                onAction={act}
                focusOnClose={() => ed.root}
              />
            </>
          )}
        </Show>
      </div>
    </div>
  );
}

/**
 * One table row: its cells, then empty gaps up to the widest row.
 * @param {{ ed: EditorController, id: string, columns: number }} props
 */
function TableRow(props) {
  const ed = props.ed;
  const cells = createMemo(
    () => {
      ed.structure();
      return rowCells(ed.doc, props.id);
    },
    [],
    { equals: sameIds },
  );
  const gaps = () =>
    Array.from({ length: Math.max(0, props.columns - cells().length) }, (_, i) => i);
  return (
    <tr>
      <For each={cells()}>
        {(cell) => (
          <td class={styles.cell} data-cell={cell}>
            <BlockText ed={ed} id={cell} type={CELL} />
          </td>
        )}
      </For>
      <For each={gaps()}>
        {() => <td class={styles.cellGap} contentEditable={false} aria-hidden="true" />}
      </For>
    </tr>
  );
}

/**
 * A handle on the active cell's row or column, opening its menu. Pressing
 * it keeps the caret where it is.
 * @param {{ class: string, style: Record<string, string>, label: string, actions: readonly (readonly [import("../editor.js").TableAction, string])[], onAction: (action: import("../editor.js").TableAction) => void, focusOnClose: () => HTMLElement | null }} props
 */
function TableHandle(props) {
  return (
    <Menu
      label={props.label}
      focusOnClose={props.focusOnClose}
      trigger={(trigger) => (
        <button
          {...trigger}
          type="button"
          class={cx(styles.tableHandle, props.class)}
          style={props.style}
          contentEditable={false}
          data-embed
          tabIndex={-1}
          aria-label={props.label}
          title={props.label}
          onMouseDown={(event) => event.preventDefault()}
        >
          <span class={styles.tableHandleDots} aria-hidden="true" />
        </button>
      )}
    >
      <For each={props.actions}>
        {([action, label], i) => (
          <>
            <Show when={i() === props.actions.length - 1}>
              <MenuSeparator />
            </Show>
            <MenuItem icon={ACTION_ICONS[action]()} onSelect={() => props.onAction(action)}>
              {label}
            </MenuItem>
          </>
        )}
      </For>
    </Menu>
  );
}

/**
 * A block's text element. Its content is drawn by `renderRuns`, not by
 * Solid, so it can be patched precisely and left alone during IME input.
 * @param {{ ed: EditorController, id: string, type: string }} props
 */
function BlockText(props) {
  const ed = props.ed;
  const id = props.id;
  /** @type {HTMLDivElement | undefined} */
  let el;
  const heading = () =>
    props.type === "h1" ? 2 : props.type === "h2" ? 3 : props.type === "h3" ? 4 : null;
  const showPlaceholder = () => props.type !== "p" || ed.focusedBlock() === id;

  onMount(() => {
    if (!el) return;
    ed.textEls.set(id, el);
    onCleanup(() => {
      if (ed.textEls.get(id) === el) ed.textEls.delete(id);
    });
  });

  return (
    <div
      ref={(node) => {
        el = node;
        // Drawn now and after every change to this block (except mid-composition).
        createRenderVersion(ed, id, node);
      }}
      class={styles.text}
      data-text={id}
      data-placeholder={spec(props.type).placeholder}
      data-show-placeholder={showPlaceholder() ? "" : undefined}
      role={heading() ? "heading" : undefined}
      aria-level={heading() ?? undefined}
      spellcheck={isPlainText(props.type) ? false : undefined}
    />
  );
}

/**
 * An equation block's formula, centred. While its TeX doesn't parse, the
 * last formula that did stays, dimmed, with the error under it, so the
 * page doesn't jump around while someone types. Pressing it puts the
 * caret in the source (shown below it while editing). A numbered one has
 * its number on the right, as in LaTeX.
 * @param {{ ed: EditorController, id: string, editing: boolean }} props
 */
function EquationView(props) {
  const ed = props.ed;
  const ready = useMathReady();
  const source = createMemo(() => {
    ed.version(props.id);
    return ed.doc.getText(props.id);
  });
  let lastGood = "";
  /** @typedef {{ kind: "empty" | "pending" | "ok" | "error", html: string, tex: string, error: string }} Drawn */
  const drawn = createMemo(() => {
    ready();
    const tex = source();
    /** @type {Drawn} */
    const out = { kind: "empty", html: "", tex, error: "" };
    if (tex.trim() === "") return out;
    const result = renderMath(tex, {
      display: true,
      macros: ed.mathMacros(),
      refs: ed.equationNumbering().refs,
    });
    if (!result) return { ...out, kind: /** @type {const} */ ("pending") };
    if (result.html !== null) {
      lastGood = result.html;
      return { ...out, kind: /** @type {const} */ ("ok"), html: result.html };
    }
    // Half a command while its completions are up isn't an error yet.
    const s = ed.suggestion();
    if (s?.kind === "tex" && s.block === props.id && lastGood)
      return { ...out, kind: /** @type {const} */ ("ok"), html: lastGood };
    return { ...out, kind: /** @type {const} */ ("error"), html: lastGood, error: result.error };
  });
  const value = drawn;
  const number = () => ed.equationNumbering().numbers.get(props.id);
  return (
    <Show when={!(drawn().kind === "empty" && (props.editing || ed.readOnly))}>
      <div
        class={styles.equation}
        contentEditable={false}
        data-state={drawn().kind}
        data-numbered={number() !== undefined ? "" : undefined}
        onMouseDown={(event) => {
          if (ed.readOnly || event.button !== 0) return;
          event.preventDefault();
          ed.focusBlock(props.id);
        }}
      >
        <Switch>
          <Match when={drawn().kind === "empty"}>
            <span class={styles.equationEmpty}>
              <IconMath size={18} />
              Add a TeX equation
            </span>
          </Match>
          <Match when={drawn().kind === "pending"}>
            <code class={styles.equationSource}>{value().tex}</code>
          </Match>
          <Match when={drawn().kind === "ok"}>
            <div class={styles.equationMath} innerHTML={value().html} />
          </Match>
          <Match when={drawn().kind === "error"}>
            <Show
              when={value().html}
              fallback={<code class={styles.equationSource}>{value().tex}</code>}
            >
              <div
                class={cx(styles.equationMath, styles.equationStale)}
                innerHTML={value().html}
                aria-hidden="true"
              />
            </Show>
            <p class={styles.equationError} role="status">
              {value().error}
            </p>
          </Match>
        </Switch>
        <Show when={number()}>{(n) => <span class={styles.equationNumber}>({n()})</span>}</Show>
      </div>
    </Show>
  );
}

/**
 * Under an equation's source while it's edited: where to look up TeX,
 * page macros, numbering it, and Done (as Escape: the caret moves on).
 * Says so when its `\label` can't be referenced: another numbered
 * equation has it, or this one isn't numbered.
 * @param {{ ed: EditorController, id: string }} props
 */
function EquationBar(props) {
  const ed = props.ed;
  const numbered = () => ed.equationNumbering().numbers.has(props.id);
  const label = createMemo(() => {
    ed.version(props.id);
    return equationLabel(ed.doc.getText(props.id));
  });
  const note = () => {
    if (label() === null) return null;
    if (!numbered()) return "Number this equation to reference its label.";
    if (ed.equationNumbering().duplicates.has(props.id))
      return `An equation above is already labelled “${label()}”.`;
    return null;
  };
  return (
    <div
      class={styles.equationBar}
      contentEditable={false}
      data-embed
      // Keep the caret (and so the open source) while clicking here.
      onMouseDown={(event) => event.preventDefault()}
    >
      <Show when={note()}>{(text) => <p class={styles.equationNote}>{text()}</p>}</Show>
      <span class={styles.equationLinks}>
        <a
          class={styles.equationHelp}
          href="https://katex.org/docs/supported.html"
          target="_blank"
          rel="noopener noreferrer"
        >
          TeX reference
        </a>
        <button
          type="button"
          class={styles.equationHelp}
          onClick={() => props.ed.setMacrosOpen(true)}
        >
          Page macros
        </button>
        <button
          type="button"
          class={styles.equationHelp}
          aria-pressed={numbered()}
          onClick={() => ed.setEquationsNumbered([props.id], !numbered())}
        >
          {numbered() ? "Remove number" : "Number equation"}
        </button>
      </span>
      <Button
        variant="primary"
        class={styles.equationDone}
        title="Done (Esc)"
        onClick={() => props.ed.leaveEquation(props.id)}
      >
        Done
      </Button>
    </div>
  );
}

/**
 * @param {EditorController} ed @param {string} id @param {HTMLElement} el
 */
function createRenderVersion(ed, id, el) {
  createRenderEffect(() => {
    ed.version(id);
    if (ed.isComposingIn(id)) return;
    renderRuns(el, ed.doc.getTextRuns(id), {
      macros: ed.mathMacros(),
      refs: ed.equationNumbering().refs,
    });
  });
}

/**
 * ⌘K: a small dialog asking for the link's address. Typing something that
 * isn't an address lists pages with that title, to link to one of them.
 * @param {{ ed: EditorController, pageId: string }} props
 */
function LinkDialog(props) {
  const [value, setValue] = createSignal("");
  const request = () => props.ed.linkRequest();
  const workspace = useWorkspace();
  const [pages, setPages] = createSignal(
    /** @type {import("../../api/types.js").PageMatch[]} */ ([]),
  );
  const looksLikeAddress = (/** @type {string} */ v) => /[./:@]/.test(v);
  /** @type {AbortController | null} */
  let search = null;
  createEffect(
    on([value, () => request() !== null, workspace.id], ([v, open, ws]) => {
      search?.abort();
      const query = String(v).trim();
      if (!open || !ws || query === "" || looksLikeAddress(query)) {
        setPages([]);
        return;
      }
      const controller = new AbortController();
      search = controller;
      searchPages(String(ws), query, { signal: controller.signal, limit: 5 })
        .then(
          (found) =>
            !controller.signal.aborted && setPages(found.filter((p) => p.id !== props.pageId)),
        )
        .catch(() => !controller.signal.aborted && setPages([]));
    }),
  );
  onCleanup(() => search?.abort());
  return (
    <Dialog
      open={request() !== null}
      onOpenChange={(open) => {
        if (!open) props.ed.finishLink(null);
      }}
      title={request()?.href ? "Edit link" : "Add link"}
    >
      <form
        class={styles.linkForm}
        onSubmit={(event) => {
          event.preventDefault();
          props.ed.finishLink(value());
        }}
      >
        <input
          class={styles.linkInput}
          type="text"
          inputMode="url"
          placeholder="Paste or type a link"
          aria-label="Link address"
          value={request()?.href ?? ""}
          ref={(input) => {
            setValue(request()?.href ?? "");
            queueMicrotask(() => {
              input.focus();
              input.select();
            });
          }}
          onInput={(event) => setValue(event.currentTarget.value)}
        />
        <Show when={pages().length > 0}>
          <div class={styles.linkPages} role="group" aria-label="Link to a page">
            <For each={pages()}>
              {(page) => (
                <button
                  type="button"
                  class={styles.linkPage}
                  onClick={() => props.ed.finishLink(`/p/${encodeURIComponent(page.id)}`)}
                >
                  <span class={styles.linkPageIcon} aria-hidden="true">
                    <PageIcon icon={page.icon} size={16} />
                  </span>
                  <span class={styles.linkPageTitle}>{displayTitle(page.title)}</span>
                  <Show when={page.path.length > 0}>
                    <span class={styles.linkPagePath}>
                      {page.path.map(displayTitle).join(" / ")}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class={styles.linkActions}>
          <Show when={request()?.href}>
            <Button type="button" onClick={() => props.ed.finishLink("")}>
              Remove link
            </Button>
          </Show>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
