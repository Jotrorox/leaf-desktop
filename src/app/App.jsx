// @ts-check
import {
  createEffect,
  createMemo,
  createSignal,
  Match,
  on,
  onCleanup,
  onMount,
  Switch,
  untrack,
} from "solid-js";
import { updateProfile } from "../api/databases.js";
import { authReady, session, signingOut, signOut } from "../auth/clerk.js";
import { authPageFor, guardRedirect } from "../auth/guard.js";
import { loadMe, me, meNeedsRefresh } from "../auth/me.js";
import { useWorkspace } from "../data/pages.js";
import RowPeek from "../databases/ui/RowPeek.jsx";
import { startBackgroundSync } from "../desktop/prefetch.js";
import { listenForMenu, rememberRoute } from "../desktop/shell.js";
import { cx } from "../lib/cx.js";
import { location, navigate, Route, Routes, setScrollContainer } from "../lib/router/index.js";
import { installShortcuts, shortcuts } from "../lib/shortcuts.js";
import Home from "../routes/Home.jsx";
import NotFound from "../routes/NotFound.jsx";
import Page from "../routes/Page.jsx";
import Settings from "../routes/Settings.jsx";
import Trash from "../routes/Trash.jsx";
import Button from "../ui/Button.jsx";
import { Toaster } from "../ui/Toast.jsx";
import styles from "./App.module.css";
import AuthPage, { takeAuthPageTarget } from "./AuthPage.jsx";
import { crumbs } from "./breadcrumbs.js";
import {
  collapsed,
  narrow,
  resizing,
  setSidebarVisible,
  sidebarVisible,
  sidebarWidth,
  toggleSidebar,
} from "./layout.js";
import { openNewPage } from "./new-page.js";
import QuickFind, { openQuickFind } from "./QuickFind.jsx";
import ShortcutsDialog, { openShortcutsDialog } from "./ShortcutsDialog.jsx";
import Sidebar from "./Sidebar.jsx";
import StatusScreen from "./StatusScreen.jsx";
import TopBar from "./TopBar.jsx";

/**
 * Root: the auth gate. Until Clerk has loaded and `/v1/me` has answered it
 * shows a status screen (loading, or an error with a retry); signed-out
 * people get the sign-in and sign-up pages; signed-in ones get the shell.
 * The route guard (rules in `auth/guard.js`) keeps the URL in line.
 *
 * Desktop: the last session and `/v1/me` answer are remembered, so on
 * launch the shell renders at once from the local cache, and both are
 * confirmed in the background. The legal pages and published pages live on
 * the web (`desktop/shell.js` opens them in the browser).
 */
export default function App() {
  const authPage = createMemo(() => authPageFor(location().pathname));

  createEffect(() => {
    const s = session();
    // While signing out, Clerk navigates to sign-in itself.
    if ((s.status !== "signedIn" && s.status !== "signedOut") || signingOut()) return;
    const current = location();
    const remembered =
      s.status === "signedIn" && authPageFor(current.pathname) ? takeAuthPageTarget() : null;
    const target = guardRedirect(s.status, current, remembered);
    if (target) untrack(() => navigate(target, { replace: true }));
  });

  createEffect(() => {
    if (session().status !== "signedIn" || signingOut()) return;
    // First sign-in, or a remembered answer to refresh once Clerk is up.
    if (me().status === "idle" || (authReady() && meNeedsRefresh())) untrack(() => void loadMe());
  });

  // Tell the server how others should see us (person properties show it).
  let profileSent = "";
  createEffect(() => {
    const s = session();
    if (s.status !== "signedIn" || me().status !== "ready" || !authReady()) return;
    const profile = { name: s.user.name || null, avatar_url: s.user.imageUrl || null };
    const key = JSON.stringify([s.user.id, profile]);
    if (key === profileSent) return;
    profileSent = key;
    untrack(() => void updateProfile(profile).catch(() => {}));
  });

  const authError = () => {
    const s = session();
    return s.status === "error" ? s.message : null;
  };
  const meError = () => {
    const state = me();
    return state.status === "error" ? state.error : null;
  };

  return (
    <>
      <Switch fallback={<StatusScreen />}>
        <Match when={authError()}>
          {(message) => (
            <StatusScreen
              tone="error"
              title="Couldn't start sign-in"
              message="leaf couldn't reach its sign-in service. Check your connection, then retry."
              detail={message()}
            >
              <Button variant="primary" onClick={() => window.location.reload()}>
                Retry
              </Button>
            </StatusScreen>
          )}
        </Match>
        <Match when={session().status === "signedOut" && authPage()} keyed>
          {(page) => <AuthPage page={/** @type {"sign-in" | "sign-up"} */ (page)} />}
        </Match>
        <Match when={session().status === "signedIn" && !authPage() && !signingOut()}>
          <Switch fallback={<StatusScreen />}>
            <Match when={meError()}>{(error) => <MeError error={error()} />}</Match>
            <Match when={me().status === "ready"}>
              <Shell />
            </Match>
          </Switch>
        </Match>
      </Switch>
      <Toaster />
    </>
  );
}

/**
 * `/v1/me` failed: say why, and offer a retry (and a way out).
 * @param {{ error: import("../api/client.js").ApiError }} props
 */
function MeError(props) {
  const unreachable = () => props.error.status === 0 && props.error.code === "network_error";
  return (
    <StatusScreen
      tone="error"
      title={unreachable() ? "Can't reach the server" : "Couldn't load your account"}
      message={
        unreachable()
          ? "The leaf API isn't responding. Check your connection, or that the backend is running, then retry."
          : "The server couldn't load your account. Retry, or sign out and back in."
      }
      detail={[props.error.status || null, props.error.code, props.error.message]
        .filter(Boolean)
        .join(" · ")}
    >
      <Button variant="primary" onClick={() => void loadMe()}>
        Retry
      </Button>
      <Button onClick={() => void signOut().catch((err) => console.error("Sign-out failed:", err))}>
        Sign out
      </Button>
    </StatusScreen>
  );
}

/** App shell: sidebar, top bar with breadcrumbs, and the routed content column. */
function Shell() {
  /** @type {HTMLElement | undefined} */
  let main;
  const [announcement, setAnnouncement] = createSignal("");
  const drawerOpen = () => narrow() && sidebarVisible();

  const workspace = useWorkspace();

  // Desktop: reopen this page next launch; keep a local copy of every note
  // once Clerk has confirmed the session; answer the native menus.
  createEffect(rememberRoute);
  createEffect(() => {
    if (!authReady()) return;
    onCleanup(startBackgroundSync());
  });
  onMount(() => {
    const menu = listenForMenu({
      "new-page": () => {
        const id = workspace.id();
        if (id) openNewPage({ workspaceId: id });
      },
      "quick-find": openQuickFind,
      settings: () => navigate("/settings"),
      "toggle-sidebar": toggleSidebar,
      back: () => history.back(),
      forward: () => history.forward(),
      shortcuts: openShortcutsDialog,
    });
    onCleanup(() => void menu.then((unlisten) => unlisten()));
  });

  onMount(() => {
    if (main) setScrollContainer(main);
    const cleanups = [
      installShortcuts(),
      shortcuts.register({
        keys: "mod+\\",
        description: "Show or hide the sidebar",
        allowInInputs: true,
        handler: toggleSidebar,
      }),
      shortcuts.register({
        keys: "?",
        description: "Keyboard shortcuts",
        handler: openShortcutsDialog,
      }),
      shortcuts.register({
        keys: "mod+/",
        description: "Keyboard shortcuts",
        allowInInputs: true,
        handler: openShortcutsDialog,
      }),
    ];
    onCleanup(() => {
      setScrollContainer(null);
      for (const cleanup of cleanups) cleanup();
    });
  });

  createEffect(() => {
    const current = crumbs().at(-1);
    document.title = current ? `${current.label} · leaf` : "leaf";
  });

  // Tell screen readers that the page changed: the new title, once it's set.
  createEffect(
    on(
      () => location().pathname,
      () => queueMicrotask(() => setAnnouncement(document.title)),
      { defer: true },
    ),
  );

  // Keep focus somewhere sensible when the sidebar opens or closes: the
  // button that toggled it disappears, and a hidden sidebar is inert.
  createEffect(
    on(
      sidebarVisible,
      (visible) => {
        const active = document.activeElement;
        const lost = !active || active === document.body;
        if (visible && (lost || narrow())) document.getElementById("sidebar-hide")?.focus();
        if (!visible && (lost || document.getElementById("sidebar")?.contains(active))) {
          document.getElementById("sidebar-show")?.focus();
        }
      },
      { defer: true },
    ),
  );

  return (
    <div
      class={cx(
        styles.shell,
        narrow() && styles.narrow,
        !narrow() && collapsed() && styles.collapsed,
        resizing() && styles.resizing,
      )}
      style={{ "--sidebar-width": `${sidebarWidth()}px` }}
    >
      <a
        href="#main"
        class={styles.skipLink}
        onClick={(event) => {
          event.preventDefault();
          main?.focus();
        }}
      >
        Skip to content
      </a>

      <Sidebar />
      <div
        class={cx(styles.scrim, drawerOpen() && styles.scrimVisible)}
        aria-hidden="true"
        onClick={() => setSidebarVisible(false)}
      />

      <div class={styles.main} inert={drawerOpen() || undefined}>
        <TopBar />
        <main ref={main} id="main" tabindex="-1" class={styles.scroller}>
          <div class={styles.frame}>
            <div class={styles.content}>
              <Routes fallback={NotFound}>
                <Route path="/" component={Home} />
                <Route path="/p/:pageId" component={Page} />
                <Route path="/trash" component={Trash} />
                <Route path="/settings" component={Settings} />
              </Routes>
            </div>
          </div>
        </main>
      </div>

      <RowPeek />
      <QuickFind />
      <ShortcutsDialog />
      <div class="visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement()}
      </div>
    </div>
  );
}
