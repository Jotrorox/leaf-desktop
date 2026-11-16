// @ts-check
import { createEffect, lazy, on, Show } from "solid-js";
import { useWorkspace } from "../data/pages.js";
import { cx } from "../lib/cx.js";
import { Link, location } from "../lib/router/index.js";
import Button from "../ui/Button.jsx";
import IconButton from "../ui/IconButton.jsx";
import { IconCollapse, IconCompose, IconHome, IconSearch, IconTable } from "../ui/icons/index.jsx";
import Kbd from "../ui/Kbd.jsx";
import LogoMark from "../ui/LogoMark.jsx";
import {
  narrow,
  resizing,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  setResizing,
  setSidebarVisible,
  setSidebarWidth,
  sidebarVisible,
  sidebarWidth,
} from "./layout.js";
import { openNewPage } from "./new-page.js";
import { openQuickFind } from "./QuickFind.jsx";
import SharedPages from "./SharedPages.jsx";
import styles from "./Sidebar.module.css";
import PageTree from "./tree/PageTree.jsx";
import UserMenu from "./UserMenu.jsx";

/**
 * The mock backend's dev menu. The flag is spelled out at each use so Vite
 * folds it before bundling, and normal builds don't even emit the chunk.
 */
const MockMenu =
  import.meta.env.VITE_API_MOCK === "1" ? lazy(() => import("./MockMenu.jsx")) : null;

export default function Sidebar() {
  const workspace = useWorkspace();
  const newPage = () => {
    const id = workspace.id();
    if (id) openNewPage({ workspaceId: id });
  };
  const newDatabase = () => {
    const id = workspace.id();
    if (id) openNewPage({ workspaceId: id, kind: "database" });
  };

  // A drawer covers the page, so following a link should reveal it.
  createEffect(
    on(
      () => location().pathname,
      () => narrow() && setSidebarVisible(false),
      { defer: true },
    ),
  );

  return (
    <aside
      id="sidebar"
      class={cx(styles.sidebar, narrow() && styles.drawer, !sidebarVisible() && styles.hidden)}
      aria-label="Sidebar"
      inert={!sidebarVisible() || undefined}
      onKeyDown={(event) => {
        // Escape in an open popover closes just the popover.
        const inPopover = event.target instanceof Element && event.target.closest("[popover]");
        if (event.key === "Escape" && narrow() && !inPopover && !event.defaultPrevented)
          setSidebarVisible(false);
      }}
    >
      <div class={styles.inner}>
        <div class={styles.header} data-tauri-drag-region>
          <LogoMark size={20} />
          <span class={styles.workspace} data-tauri-drag-region>
            {workspace.workspace()?.name ?? "leaf"}
          </span>
          {MockMenu && <MockMenu />}
          <IconButton label="New database" disabled={!workspace.id()} onClick={newDatabase}>
            <IconTable />
          </IconButton>
          <IconButton label="New page" disabled={!workspace.id()} onClick={newPage}>
            <IconCompose />
          </IconButton>
          <IconButton
            id="sidebar-hide"
            class={styles.hideButton}
            label={narrow() ? "Close sidebar" : "Hide sidebar"}
            shortcut={"mod+\\"}
            aria-controls="sidebar"
            aria-expanded="true"
            onClick={() => setSidebarVisible(false)}
          >
            <IconCollapse />
          </IconButton>
        </div>

        <nav class={styles.nav} aria-label="Workspace">
          <ul role="list" class={styles.list}>
            <li>
              <button
                type="button"
                class={styles.link}
                onClick={openQuickFind}
                aria-keyshortcuts="Meta+K Control+K"
              >
                <IconSearch />
                <span class={styles.label}>Search</span>
                <Kbd keys="mod+k" class={styles.linkHint} />
              </button>
            </li>
            <li>
              <Link href="/" class={styles.link}>
                <IconHome />
                <span class={styles.label}>Home</span>
              </Link>
            </li>
          </ul>
          <h2 id="sidebar-pages" class={styles.sectionLabel}>
            Pages
          </h2>
          <Show
            when={workspace.id()}
            keyed
            fallback={
              <Show when={workspace.error()}>
                <div class={styles.sectionMessage} role="alert">
                  <p>Couldn't load your workspace.</p>
                  <Button onClick={() => void workspace.refetch()}>Retry</Button>
                </div>
              </Show>
            }
          >
            {(id) => <PageTree workspaceId={id} aria-labelledby="sidebar-pages" />}
          </Show>
          <SharedPages />
        </nav>

        <div class={styles.footer}>
          <UserMenu />
        </div>
      </div>

      <Show when={!narrow() && sidebarVisible()}>
        <ResizeHandle />
      </Show>
    </aside>
  );
}

/**
 * Drag the sidebar's edge to resize it; double-click resets the width.
 * Keyboard: focus the edge, then ←/→ (Shift for bigger steps), Home/End.
 */
function ResizeHandle() {
  const STEP = 16;
  let startX = 0;
  let startWidth = 0;

  /** @param {PointerEvent & { currentTarget: HTMLDivElement }} event */
  function onPointerDown(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    startX = event.clientX;
    startWidth = sidebarWidth();
    setResizing(true);
  }

  /** @param {PointerEvent & { currentTarget: HTMLDivElement }} event */
  function onPointerMove(event) {
    if (!resizing() || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    setSidebarWidth(startWidth + event.clientX - startX, { persist: false });
  }

  function endResize() {
    if (!resizing()) return;
    setResizing(false);
    setSidebarWidth(sidebarWidth());
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const step = event.shiftKey ? STEP * 4 : STEP;
    if (event.key === "ArrowLeft") setSidebarWidth(sidebarWidth() - step);
    else if (event.key === "ArrowRight") setSidebarWidth(sidebarWidth() + step);
    else if (event.key === "Home") setSidebarWidth(SIDEBAR_MIN_WIDTH);
    else if (event.key === "End") setSidebarWidth(SIDEBAR_MAX_WIDTH);
    else return;
    event.preventDefault();
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-controls="sidebar"
      aria-valuemin={SIDEBAR_MIN_WIDTH}
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuenow={sidebarWidth()}
      tabindex="0"
      class={styles.resizer}
      data-active={resizing() || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endResize}
      onPointerCancel={endResize}
      onLostPointerCapture={endResize}
      onDblClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={onKeyDown}
    />
  );
}
