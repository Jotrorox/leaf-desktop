// @ts-check
import { For, Show } from "solid-js";
import { Link } from "../lib/router/index.js";
import { IconChevronRight } from "../ui/icons/index.jsx";
import PageIcon from "../ui/PageIcon.jsx";
import styles from "./Breadcrumbs.module.css";
import { crumbs } from "./breadcrumbs.js";

/** The path to the current page. Earlier crumbs are links; the last is the current page. */
export default function Breadcrumbs() {
  return (
    <nav class={styles.breadcrumbs} aria-label="Breadcrumb">
      <ol role="list" class={styles.list}>
        <For each={crumbs()}>
          {(crumb, index) => (
            <li class={styles.item}>
              <Show when={index() > 0}>
                <IconChevronRight size={14} class={styles.separator} />
              </Show>
              <Show
                when={index() < crumbs().length - 1 && crumb.href}
                fallback={
                  <span class={styles.current} aria-current="page">
                    <CrumbIcon icon={crumb.icon} />
                    <span class={styles.text}>{crumb.label}</span>
                  </span>
                }
              >
                {(href) => (
                  <Link href={href()} class={styles.link} aria-current={undefined}>
                    <CrumbIcon icon={crumb.icon} />
                    <span class={styles.text}>{crumb.label}</span>
                  </Link>
                )}
              </Show>
            </li>
          )}
        </For>
      </ol>
    </nav>
  );
}

/** A page crumb's icon; nothing for crumbs that aren't pages. @param {{ icon: string | null | undefined }} props */
function CrumbIcon(props) {
  return (
    <Show when={props.icon !== undefined}>
      <PageIcon icon={props.icon} size={16} />
    </Show>
  );
}
