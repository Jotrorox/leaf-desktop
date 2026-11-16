// @ts-check
import { createEffect, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { ApiError } from "../api/client.js";
import { canEdit } from "../api/roles.js";
import { useBreadcrumbs } from "../app/breadcrumbs.js";
import { forgetPage, rememberPage } from "../app/recent.js";
import {
  deletePageForever,
  displayTitle,
  keys,
  restorePage,
  usePage,
  usePagePath,
} from "../data/pages.js";
import DatabaseView from "../databases/ui/DatabaseView.jsx";
import RowProperties from "../databases/ui/RowProperties.jsx";
import Editor from "../editor/ui/Editor.jsx";
import { invalidate } from "../lib/query/index.js";
import { Link, navigate } from "../lib/router/index.js";
import Button from "../ui/Button.jsx";
import ConfirmDialog from "../ui/ConfirmDialog.jsx";
import { IconRestore, IconTrash } from "../ui/icons/index.jsx";
import styles from "./Page.module.css";
import PageHeader from "./page/PageHeader.jsx";

/** @typedef {import("../api/types.js").Page} PageData */

/**
 * `/p/:pageId`. Keyed by id, so each page gets a fresh view (title field,
 * pickers) instead of reusing the previous page's.
 * @param {{ params: import("../lib/router/match.js").Params }} props
 */
export default function Page(props) {
  return (
    <Show when={props.params.pageId} keyed>
      {(id) => <PageScreen id={id} />}
    </Show>
  );
}

/** @param {{ id: string }} props */
function PageScreen(props) {
  const query = usePage(() => props.id);
  const path = usePagePath(() => props.id);

  useBreadcrumbs(() => {
    const page = query.data();
    if (!page)
      return query.error() ? [{ label: isNotFound(query.error()) ? "Not found" : "Error" }] : [];
    return [
      ...path().ancestors.map((ancestor) => ({
        label: displayTitle(ancestor.title),
        icon: ancestor.icon,
        href: `/p/${encodeURIComponent(ancestor.id)}`,
      })),
      { label: displayTitle(page.title), icon: page.icon },
    ];
  });

  // Quick find's recent pages: this one, as it looks now (settled, so a
  // title being typed is saved once).
  createEffect(() => {
    const page = query.data();
    if (!page || page.id !== props.id) {
      if (isNotFound(query.error())) forgetPage(props.id);
      return;
    }
    const entry = {
      id: page.id,
      title: page.title,
      icon: page.icon,
      kind: page.kind,
      path: path().ancestors.map((ancestor) => displayTitle(ancestor.title)),
    };
    const timer = setTimeout(() => rememberPage(entry), 600);
    onCleanup(() => clearTimeout(timer));
  });

  return (
    <Switch>
      <Match when={query.data()}>{(page) => <PageView page={page()} />}</Match>
      <Match when={query.error()}>
        {(error) => <PageError error={error()} onRetry={() => void query.refetch()} />}
      </Match>
      <Match when={query.loading()}>
        <div class={styles.skeleton} role="status" aria-label="Loading page">
          <span class={styles.skeletonTitle} />
          <span />
          <span />
        </div>
      </Match>
    </Switch>
  );
}

/** @param {{ page: PageData }} props */
function PageView(props) {
  return (
    <article class={styles.page}>
      <Show when={props.page.archived_at !== null}>
        <TrashBanner page={props.page} />
      </Show>
      <PageContent page={props.page} />
    </article>
  );
}

/**
 * A page's header and body: a database's views, or the document (under a
 * row's properties, for a database row). The side peek shows rows with it
 * too, and so does the public view (`readOnly`, whatever the role).
 * @param {{ page: PageData, readOnly?: boolean }} props
 */
export function PageContent(props) {
  const archived = () => props.page.archived_at !== null;
  /** The user may only view (or comment on) the page. */
  const viewOnly = () => props.readOnly === true || !canEdit(props.page.role);
  const readOnly = () => archived() || viewOnly();
  /** @type {import("../editor/ui/Editor.jsx").EditorApi | undefined} */
  let editor;
  /** @type {(() => void) | undefined} */
  let focusTitle;
  return (
    <>
      <PageHeader
        page={props.page}
        readOnly={readOnly()}
        onTitleExit={() => editor?.focusStart()}
        focusRef={(fn) => (focusTitle = fn)}
      />
      <Show when={props.page.kind === "row"}>
        <RowProperties page={props.page} readOnly={readOnly()} />
      </Show>
      <Show when={props.page.kind === "database"}>
        <DatabaseView page={props.readOnly ? { ...props.page, role: "view" } : props.page} />
      </Show>
      {/* Remounted when the page goes to or comes back from the trash, or the role changes: read-only is fixed per editor. */}
      <Show
        when={
          props.page.kind !== "database" &&
          (archived() ? "archived" : viewOnly() ? "view-only" : "editable")
        }
        keyed
      >
        {(mode) => (
          <Editor
            pageId={props.page.id}
            readOnly={mode !== "editable"}
            viewOnly={mode === "view-only"}
            ref={(api) => (editor = api)}
            onExitTop={() => focusTitle?.()}
            onReadOnly={() => {
              // Someone moved the page to the trash (or deleted it): show that.
              void invalidate(keys.page(props.page.id));
              void invalidate(keys.treeAll(props.page.workspace_id));
            }}
          />
        )}
      </Show>
    </>
  );
}

/**
 * Shown on an archived page: restore it, or delete it for good (for those
 * who can edit it).
 * @param {{ page: PageData }} props
 */
function TrashBanner(props) {
  const [confirming, setConfirming] = createSignal(false);
  return (
    <div class={styles.banner} role="status">
      <p class={styles.bannerText}>This page is in the trash.</p>
      <Show when={canEdit(props.page.role)}>
        <div class={styles.bannerActions}>
          <Button onClick={() => void restorePage(props.page.workspace_id, props.page.id)}>
            <IconRestore size={16} />
            Restore page
          </Button>
          <Button onClick={() => setConfirming(true)}>
            <IconTrash size={16} />
            Delete forever
          </Button>
        </div>
      </Show>
      <ConfirmDialog
        open={confirming()}
        onOpenChange={setConfirming}
        title={`Delete “${displayTitle(props.page.title)}” forever?`}
        description="The page and its subpages will be gone for good. This can't be undone."
        confirmLabel="Delete forever"
        onConfirm={() => {
          void deletePageForever(props.page.workspace_id, props.page.id, props.page.title);
          navigate("/trash", { replace: true });
        }}
      />
    </div>
  );
}

/** @param {unknown} error */
function isNotFound(error) {
  return error instanceof ApiError && error.status === 404;
}

/** @param {{ error: unknown, onRetry: () => void }} props */
function PageError(props) {
  return (
    <Show
      when={!isNotFound(props.error)}
      fallback={
        <div class={styles.message}>
          <h1 class={styles.messageTitle}>This page doesn't exist</h1>
          <p class={styles.messageText}>
            It may have been deleted, or the link is wrong. <Link href="/">Go to Home</Link>
          </p>
        </div>
      }
    >
      <div class={styles.message} role="alert">
        <h1 class={styles.messageTitle}>Couldn't load this page</h1>
        <p class={styles.messageText}>
          {props.error instanceof ApiError && props.error.status === 0
            ? "Can't reach the server. Check your connection and try again."
            : "Something went wrong on our side. Try again in a moment."}
        </p>
        <div class={styles.messageActions}>
          <Button variant="primary" onClick={() => props.onRetry()}>
            Retry
          </Button>
        </div>
      </div>
    </Show>
  );
}
