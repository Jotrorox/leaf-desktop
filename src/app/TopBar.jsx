// @ts-check

import { createEffect, on, Show } from "solid-js";
import { usePage } from "../data/pages.js";
import { webUrl } from "../desktop/env.js";
import { saveStatus } from "../editor/sync/status.js";
import { cx } from "../lib/cx.js";
import { location, navigate } from "../lib/router/index.js";
import IconButton from "../ui/IconButton.jsx";
import {
  IconEye,
  IconEyeOff,
  IconKeyboard,
  IconLink,
  IconMenu,
  IconMore,
  IconSettings,
  IconSidebar,
} from "../ui/icons/index.jsx";
import Menu, { MenuItem, MenuSeparator } from "../ui/Menu.jsx";
import { toast } from "../ui/Toast.jsx";
import Breadcrumbs from "./Breadcrumbs.jsx";
import { narrow, setSidebarVisible, sidebarVisible } from "./layout.js";
import Presence from "./Presence.jsx";
import { openShortcutsDialog } from "./ShortcutsDialog.jsx";
import { setShareOpen } from "./share/open.js";
import ShareButton from "./share/SharePanel.jsx";
import styles from "./TopBar.module.css";
import { setPageExpanded } from "./tree/expanded.js";
import { setShowsRowPages, showsRowPages } from "./tree/row-pages.js";

async function copyLink() {
  try {
    await navigator.clipboard.writeText(
      webUrl(location().pathname + location().search + location().hash),
    );
    toast({ title: "Link copied" });
  } catch {
    toast({
      title: "Couldn't copy the link",
      description: "Clipboard access was blocked.",
      tone: "danger",
    });
  }
}

const SAVE_LABELS = {
  saved: "Saved",
  saving: "Saving…",
  offline: "Offline – will retry",
  error: "Couldn't save",
  "view-only": "View only",
  loading: "",
};

/** The page the app shows, if any. */
function currentPageId() {
  const match = /^\/p\/([^/]+)/.exec(location().pathname);
  return match ? decodeURIComponent(match[1]) : undefined;
}

/** Slim bar above the content: sidebar toggle (while it's hidden), breadcrumbs, who else is here, sharing, page actions. */
export default function TopBar() {
  const page = usePage(currentPageId);
  // The share panel belongs to the page it was opened on.
  createEffect(
    on(
      () => location().pathname,
      () => setShareOpen(false),
      { defer: true },
    ),
  );
  const shareable = () => {
    const p = page.data();
    return p && p.id === currentPageId() && p.archived_at === null ? p : null;
  };
  return (
    <header class={cx(styles.topbar, !sidebarVisible() && styles.leading)} data-tauri-drag-region>
      <Show when={!sidebarVisible()}>
        <IconButton
          id="sidebar-show"
          label={narrow() ? "Open sidebar" : "Show sidebar"}
          shortcut={"mod+\\"}
          tooltipPlacement="bottom-start"
          aria-controls="sidebar"
          aria-expanded="false"
          onClick={() => setSidebarVisible(true)}
        >
          <Show when={narrow()} fallback={<IconSidebar />}>
            <IconMenu />
          </Show>
        </IconButton>
      </Show>

      <Breadcrumbs />

      <div class={styles.actions}>
        <Presence />
        <Show when={saveStatus() && saveStatus() !== "loading" ? saveStatus() : null}>
          {(status) => (
            <span class={styles.saveStatus} data-status={status()} role="status" aria-live="polite">
              {SAVE_LABELS[status()]}
            </span>
          )}
        </Show>
        <Show when={shareable()}>{(p) => <ShareButton pageId={p().id} title={p().title} />}</Show>
        <Menu
          label="Page actions"
          placement="bottom-end"
          trigger={(props) => (
            <IconButton {...props} label="More actions" tooltipPlacement="bottom-end">
              <IconMore />
            </IconButton>
          )}
        >
          <MenuItem icon={<IconLink />} onSelect={copyLink}>
            Copy link
          </MenuItem>
          <Show when={shareable()?.kind === "database" ? shareable() : null}>
            {(db) => (
              <Show
                when={showsRowPages(db().id)}
                fallback={
                  <MenuItem
                    icon={<IconEye />}
                    onSelect={() => {
                      setShowsRowPages(db().id, true);
                      setPageExpanded(db().id, true);
                    }}
                  >
                    Show rows in the sidebar
                  </MenuItem>
                }
              >
                <MenuItem icon={<IconEyeOff />} onSelect={() => setShowsRowPages(db().id, false)}>
                  Hide rows from the sidebar
                </MenuItem>
              </Show>
            )}
          </Show>
          <MenuItem icon={<IconKeyboard />} shortcut="mod+/" onSelect={openShortcutsDialog}>
            Keyboard shortcuts
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={<IconSettings />} onSelect={() => navigate("/settings")}>
            Settings
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}
