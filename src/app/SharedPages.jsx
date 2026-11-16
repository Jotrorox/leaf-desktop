// @ts-check
import { For, Show } from "solid-js";
import { displayTitle } from "../data/pages.js";
import { useShared } from "../data/sharing.js";
import { Link } from "../lib/router/index.js";
import PageIcon from "../ui/PageIcon.jsx";
import styles from "./Sidebar.module.css";

/**
 * The sidebar's "Shared" section: pages people outside your workspaces
 * shared with you (subpages open from the page). Hidden when there are none.
 */
export default function SharedPages() {
  const shared = useShared();
  return (
    <Show when={(shared.data() ?? []).length > 0}>
      <h2 id="sidebar-shared" class={styles.sectionLabel}>
        Shared with you
      </h2>
      <ul role="list" class={styles.list} aria-labelledby="sidebar-shared">
        <For each={shared.data()}>
          {(page) => (
            <li>
              <Link href={`/p/${encodeURIComponent(page.id)}`} class={styles.link}>
                <PageIcon icon={page.icon} kind={page.kind} size={18} />
                <span class={styles.label}>{displayTitle(page.title)}</span>
              </Link>
            </li>
          )}
        </For>
      </ul>
    </Show>
  );
}
