// @ts-check
import { For, Show } from "solid-js";
import { useBreadcrumbs } from "../app/breadcrumbs.js";
import { openNewPage } from "../app/new-page.js";
import { displayTitle, useChildren, useWorkspace } from "../data/pages.js";
import { Link } from "../lib/router/index.js";
import Button from "../ui/Button.jsx";
import { IconPlus } from "../ui/icons/index.jsx";
import PageIcon from "../ui/PageIcon.jsx";
import styles from "./Stub.module.css";

export default function Home() {
  useBreadcrumbs(() => [{ label: "Home" }]);
  const workspace = useWorkspace();
  const pages = useChildren(workspace.id, null);
  const newPage = () => {
    const id = workspace.id();
    if (id) openNewPage({ workspaceId: id });
  };

  return (
    <>
      <h1 class={styles.title}>Home</h1>
      <p class={styles.lead}>
        <Show when={workspace.workspace()} fallback="Your workspace.">
          {(ws) => <>Welcome to {ws().name}.</>}
        </Show>
      </p>
      <section class={styles.section} aria-labelledby="home-pages">
        <div class={styles.sectionHeader}>
          <h2 id="home-pages" class={styles.sectionTitle}>
            Pages
          </h2>
          <Button
            variant="ghost"
            class={styles.sectionAction}
            disabled={!workspace.id()}
            onClick={newPage}
          >
            <IconPlus size={16} />
            New page
          </Button>
        </div>
        <Show when={pages.data()?.length !== 0} fallback={<p class={styles.lead}>No pages yet.</p>}>
          <ul role="list" class={styles.pageList}>
            <For each={pages.data()}>
              {(page) => (
                <li>
                  <Link href={`/p/${encodeURIComponent(page.id)}`} class={styles.pageLink}>
                    <PageIcon icon={page.icon} />
                    {displayTitle(page.title)}
                  </Link>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </section>
    </>
  );
}
