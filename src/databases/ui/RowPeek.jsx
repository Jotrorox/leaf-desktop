// @ts-check
import { createMemo, Match, onMount, Show, Switch } from "solid-js";
import { ApiError } from "../../api/client.js";
import { usePage } from "../../data/pages.js";
import { location, navigate } from "../../lib/router/index.js";
import { PageContent } from "../../routes/Page.jsx";
import Button from "../../ui/Button.jsx";
import IconButton from "../../ui/IconButton.jsx";
import { IconClose, IconOpen } from "../../ui/icons/index.jsx";
import styles from "./Database.module.css";

/**
 * The side peek: a row's page beside the table it was opened from. It's in
 * the URL (`?peek=<row id>`), so Back closes it and a link opens it.
 */
export default function RowPeek() {
  const id = createMemo(() => new URLSearchParams(location().search).get("peek"));
  return (
    <Show when={id()} keyed>
      {(rowId) => <PeekPanel id={rowId} />}
    </Show>
  );
}

/** @param {{ id: string }} props */
function PeekPanel(props) {
  const query = usePage(() => props.id);
  /** @type {HTMLElement | undefined} */
  let panel;
  const close = () => navigate(location().pathname, { scroll: false });
  onMount(() => panel?.focus({ preventScroll: true }));

  return (
    <aside
      ref={panel}
      class={styles.peek}
      role="dialog"
      aria-label={query.data() ? `Row: ${query.data()?.title || "Untitled"}` : "Row"}
      tabindex="-1"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (
          event.target instanceof Element &&
          event.target.closest("[popover], dialog, [data-editor]")
        )
          return;
        event.preventDefault();
        close();
      }}
    >
      <div class={styles.peekBar}>
        <IconButton label="Close" onClick={close}>
          <IconClose />
        </IconButton>
        <Button variant="ghost" onClick={() => navigate(`/p/${encodeURIComponent(props.id)}`)}>
          <IconOpen size={16} /> Open as page
        </Button>
      </div>
      <div class={styles.peekScroll}>
        <div class={styles.peekBody}>
          <Switch>
            <Match when={query.data()}>{(page) => <PageContent page={page()} />}</Match>
            <Match when={query.error()}>
              {(error) => (
                <p class={styles.notice} role="alert">
                  {error() instanceof ApiError && /** @type {ApiError} */ (error()).status === 404
                    ? "This row doesn't exist any more."
                    : "Couldn't load this row."}
                </p>
              )}
            </Match>
          </Switch>
        </div>
      </div>
    </aside>
  );
}
