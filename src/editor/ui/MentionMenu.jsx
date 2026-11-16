// @ts-check
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { searchPages } from "../../api/pages.js";
import { displayTitle, useWorkspace } from "../../data/pages.js";
import { cx } from "../../lib/cx.js";
import PageIcon from "../../ui/PageIcon.jsx";
import styles from "./EditorUI.module.css";
import Floating from "./Floating.jsx";
import {
  openSuggestion,
  suggestionRect,
  useActiveDescendant,
  useSuggestionKeys,
} from "./SlashMenu.jsx";

/** @typedef {import("../editor.js").EditorController} EditorController */
/** @typedef {import("../../api/types.js").PageMatch} PageMatch */

const DEBOUNCE = 120;

/**
 * The `@` menu: pages whose title matches what's typed after the `@`
 * (recently edited ones when nothing is), each with where it lives. Picking
 * one puts a mention of it in the text.
 * @param {{ ed: EditorController, pageId: string, id: string }} props
 */
export default function MentionMenu(props) {
  const ed = props.ed;
  const workspace = useWorkspace();
  const s = () => openSuggestion(ed, "mention");
  const [results, setResults] = createSignal(/** @type {PageMatch[]} */ ([]));
  const [state, setState] = createSignal(/** @type {"loading" | "done" | "error"} */ ("loading"));
  const [active, setActive] = createSignal(0);

  /** @type {AbortController | null} */
  let inflight = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  onCleanup(() => {
    clearTimeout(timer);
    inflight?.abort();
  });

  createEffect(
    on(
      () => [s() !== null, s()?.query ?? "", workspace.id()],
      ([open, query, ws]) => {
        clearTimeout(timer);
        inflight?.abort();
        if (!open || !ws) {
          setResults([]);
          setState("loading");
          return;
        }
        setState("loading");
        timer = setTimeout(() => {
          const controller = new AbortController();
          inflight = controller;
          searchPages(/** @type {string} */ (ws), /** @type {string} */ (query), {
            signal: controller.signal,
            limit: 8,
          })
            .then((found) => {
              if (controller.signal.aborted) return;
              setResults(found.filter((p) => p.id !== props.pageId));
              setActive(0);
              setState("done");
            })
            .catch(() => {
              if (!controller.signal.aborted) setState("error");
            });
        }, DEBOUNCE);
      },
    ),
  );

  // Nothing matches and a word ended: it was just an "@" in the text.
  createEffect(() => {
    const open = s();
    if (open && state() === "done" && results().length === 0 && open.query.endsWith(" "))
      ed.closeSuggestion();
  });

  /** @param {PageMatch} page */
  const pick = (page) => ed.insertMention({ id: page.id, title: displayTitle(page.title) });

  /** @param {string} key */
  const keys = (key) => {
    const all = results();
    if (all.length === 0) return key !== "Enter";
    if (key === "ArrowDown") setActive((i) => (i + 1) % all.length);
    else if (key === "ArrowUp") setActive((i) => (i - 1 + all.length) % all.length);
    else if (key === "Enter") pick(all[Math.min(active(), all.length - 1)]);
    else return false;
    return true;
  };
  useSuggestionKeys(ed, () => s() !== null, keys);
  useActiveDescendant(ed, props.id, () => s() !== null && results().length > 0, active);

  return (
    <Floating open={s() !== null} rect={() => suggestionRect(ed, s())} class={styles.menu}>
      <div id={props.id} role="listbox" aria-label="Pages">
        <div class={styles.groupLabel} aria-hidden="true">
          {s()?.query ? "Pages" : "Recent pages"}
        </div>
        <For each={results()}>
          {(page, index) => (
            <div
              id={`${props.id}-${index()}`}
              role="option"
              aria-selected={active() === index()}
              class={cx(
                styles.option,
                styles.optionCompact,
                active() === index() && styles.optionActive,
              )}
              onPointerMove={() => setActive(index())}
              onClick={() => pick(page)}
            >
              <span class={styles.pageIcon} aria-hidden="true">
                <PageIcon icon={page.icon} size={16} />
              </span>
              <span class={styles.optionText}>
                <span class={styles.optionLabel}>{displayTitle(page.title)}</span>
                <Show when={page.path.length > 0}>
                  <span class={styles.optionDescription}>
                    {page.path.map(displayTitle).join(" / ")}
                  </span>
                </Show>
              </span>
            </div>
          )}
        </For>
        <Show when={results().length === 0}>
          <div class={styles.empty}>
            {state() === "loading"
              ? "Searching…"
              : state() === "error"
                ? "Couldn't search pages"
                : "No pages found"}
          </div>
        </Show>
      </div>
    </Floating>
  );
}
