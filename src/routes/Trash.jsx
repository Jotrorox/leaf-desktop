// @ts-check
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { useBreadcrumbs } from "../app/breadcrumbs.js";
import {
  deletePageForever,
  displayTitle,
  restorePage,
  useTrash,
  useWorkspace,
} from "../data/pages.js";
import { Link } from "../lib/router/index.js";
import { timeAgo } from "../lib/time.js";
import Button from "../ui/Button.jsx";
import ConfirmDialog from "../ui/ConfirmDialog.jsx";
import { IconRestore, IconTrash } from "../ui/icons/index.jsx";
import PageIcon from "../ui/PageIcon.jsx";
import stub from "./Stub.module.css";
import styles from "./Trash.module.css";

/** @typedef {import("../api/types.js").Page} Page */

/**
 * `/trash`: pages moved to the trash (not their subpages, which come back
 * with them). Restore is immediate; deleting forever asks first. Both are
 * optimistic and roll back with a toast on failure.
 */
export default function Trash() {
  useBreadcrumbs(() => [{ label: "Trash" }]);
  const workspace = useWorkspace();
  const trash = useTrash(workspace.id);
  const [confirming, setConfirming] = createSignal(/** @type {Page | null} */ (null));

  /**
   * Removing a row takes the focused button with it: move focus to the
   * next row (or the previous one, or the page) once it's gone.
   * @param {string} id
   */
  function keepFocusAfterRemoving(id) {
    const rows = [...document.querySelectorAll(`.${styles.row}`)];
    const index = rows.findIndex((row) => row.getAttribute("data-id") === id);
    const next = rows[index + 1] ?? rows[index - 1];
    const target = /** @type {HTMLElement | null} */ (
      next?.querySelector("a") ?? document.getElementById("main")
    );
    requestAnimationFrame(() => target?.focus());
  }

  return (
    <>
      <h1 class={stub.title}>Trash</h1>
      <p class={stub.lead}>
        Deleted pages stay here until you delete them forever. Subpages come back with their page.
      </p>

      <Switch>
        <Match when={trash.data()?.length === 0}>
          <p class={styles.empty}>The trash is empty.</p>
        </Match>
        <Match when={trash.data()}>
          {(pages) => (
            <ul role="list" class={styles.list}>
              <For each={pages()}>
                {(page) => (
                  <li class={styles.row} data-id={page.id}>
                    <Link href={`/p/${encodeURIComponent(page.id)}`} class={styles.link}>
                      <PageIcon icon={page.icon} />
                      <span class={styles.title}>{displayTitle(page.title)}</span>
                      <Show when={page.archived_at}>
                        {(at) => <span class={styles.meta}>Deleted {timeAgo(at())}</span>}
                      </Show>
                    </Link>
                    <div class={styles.actions}>
                      <Button
                        variant="ghost"
                        class={styles.action}
                        onClick={() => {
                          keepFocusAfterRemoving(page.id);
                          void restorePage(page.workspace_id, page.id);
                        }}
                      >
                        <IconRestore size={16} />
                        Restore<span class="visually-hidden"> “{displayTitle(page.title)}”</span>
                      </Button>
                      <Button
                        variant="ghost"
                        class={styles.action}
                        onClick={() => setConfirming(page)}
                      >
                        <IconTrash size={16} />
                        Delete forever
                        <span class="visually-hidden"> “{displayTitle(page.title)}”</span>
                      </Button>
                    </div>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Match>
        <Match when={trash.error() || workspace.error()}>
          <div class={styles.error} role="alert">
            <p>Couldn't load the trash.</p>
            <Button
              onClick={() => void (workspace.error() ? workspace.refetch() : trash.refetch())}
            >
              Retry
            </Button>
          </div>
        </Match>
        <Match when={true}>
          <div class={styles.skeleton} role="status" aria-label="Loading the trash">
            <span />
            <span />
          </div>
        </Match>
      </Switch>

      <ConfirmDialog
        open={confirming() !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Delete “${displayTitle(confirming()?.title ?? "")}” forever?`}
        description="The page and its subpages will be gone for good. This can't be undone."
        confirmLabel="Delete forever"
        onConfirm={() => {
          const page = confirming();
          if (!page) return;
          keepFocusAfterRemoving(page.id);
          void deletePageForever(page.workspace_id, page.id, page.title);
        }}
      />
    </>
  );
}
