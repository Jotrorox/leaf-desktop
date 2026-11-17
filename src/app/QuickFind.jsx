// @ts-check

import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
import { search } from "../api/search.js";
import { displayTitle, keys as pageKeys, useWorkspace } from "../data/pages.js";
import { webUrl } from "../desktop/env.js";
import { cx } from "../lib/cx.js";
import { fuzzyFilter } from "../lib/fuzzy.js";
import { queryClient } from "../lib/query/index.js";
import { location, navigate } from "../lib/router/index.js";
import { shortcuts } from "../lib/shortcuts.js";
import {
  IconCompose,
  IconKeyboard,
  IconLink,
  IconSearch,
  IconSettings,
  IconShare,
  IconSidebar,
  IconTable,
  IconTrash,
} from "../ui/icons/index.jsx";
import Kbd from "../ui/Kbd.jsx";
import PageIcon from "../ui/PageIcon.jsx";
import { toggleSidebar } from "./layout.js";
import { openNewPage } from "./new-page.js";
import { preloadPage } from "./preload.js";
import styles from "./QuickFind.module.css";
import { recent } from "./recent.js";
import { openShortcutsDialog } from "./ShortcutsDialog.jsx";
import { setShareOpen } from "./share/open.js";

/**
 * Quick find (⌘K or ⌘P): jump to any page, or run an action, from the
 * keyboard. With nothing typed it lists recently visited pages and the
 * actions. Typing matches, at once, pages this browser already knows
 * (recent ones and the loaded tree) by their letters in order
 * (`lib/fuzzy.js`, so "mn" finds "Meeting notes"), and asks the server
 * (debounced, the previous request aborted) for the rest, including pages
 * whose content matches. Titles from both are ranked together; content-only
 * matches come after, with the text around the match.
 */

const [open, setOpen] = createSignal(false);

/** Opens quick find. */
export function openQuickFind() {
  setOpen(true);
}

const DEBOUNCE = 150;
const MAX_PAGES = 12;

/**
 * @typedef {object} PageItem
 * @property {"page"} type
 * @property {string} id
 * @property {string} title
 * @property {string | null} icon
 * @property {string | undefined} kind
 * @property {string[]} path
 * @property {string | null} snippet
 * @property {number[]} [positions] Matched characters of the title.
 */

/**
 * @typedef {object} ActionItem
 * @property {"action"} type
 * @property {string} id
 * @property {string} label
 * @property {string[]} keywords
 * @property {import("solid-js").JSX.Element} icon
 * @property {string} [shortcut]
 * @property {() => void} run
 * @property {number[]} [positions]
 */

/** @typedef {PageItem | ActionItem} Item */

/** The page open in the app, if any. */
function currentPageId() {
  const match = /^\/p\/([^/]+)/.exec(location().pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function QuickFind() {
  const listId = createUniqueId();
  const workspace = useWorkspace();
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  const [server, setServer] = createSignal(
    /** @type {import("../api/types.js").SearchResult[]} */ ([]),
  );
  const [state, setState] = createSignal(
    /** @type {"idle" | "loading" | "done" | "error"} */ ("idle"),
  );
  /** @type {HTMLDialogElement | undefined} */
  let dialog;
  /** @type {HTMLInputElement | undefined} */
  let input;
  /** @type {HTMLDivElement | undefined} */
  let list;
  /** @type {Element | null} */
  let returnTo = null;
  /** @type {(() => void) | undefined} */
  let releaseScope;

  onCleanup(
    shortcuts.register({
      keys: ["mod+k", "mod+p"],
      description: "Search and jump to a page",
      allowInInputs: true,
      handler: () => setOpen((o) => !o),
    }),
  );

  createEffect(
    on(open, (isOpen) => {
      if (!dialog) return;
      if (isOpen && !dialog.open) {
        returnTo = document.activeElement;
        setQuery("");
        setServer([]);
        setState("idle");
        setActive(0);
        dialog.showModal();
        releaseScope = shortcuts.pushScope("quick-find", { exclusive: true });
        queueMicrotask(() => input?.focus());
      } else if (!isOpen && dialog.open) {
        dialog.close();
      }
    }),
  );

  function finishClose() {
    releaseScope?.();
    releaseScope = undefined;
    if (open()) setOpen(false);
    inflight?.abort();
    const active_ = document.activeElement;
    if (
      returnTo instanceof HTMLElement &&
      returnTo.isConnected &&
      (!active_ || active_ === document.body)
    )
      returnTo.focus();
    returnTo = null;
  }

  // The server's matches, debounced; the previous request is aborted.
  /** @type {AbortController | null} */
  let inflight = null;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  onCleanup(() => {
    clearTimeout(timer);
    inflight?.abort();
  });
  createEffect(
    on([query, open], ([q, isOpen]) => {
      clearTimeout(timer);
      inflight?.abort();
      if (!isOpen) return;
      const text = q.trim();
      if (text === "") {
        setServer([]);
        setState("idle");
        return;
      }
      setState("loading");
      timer = setTimeout(() => {
        const controller = new AbortController();
        inflight = controller;
        search(text, { signal: controller.signal, limit: 20 })
          .then((found) => {
            if (controller.signal.aborted) return;
            setServer(found);
            setState("done");
          })
          .catch(() => {
            if (!controller.signal.aborted) setState("error");
          });
      }, DEBOUNCE);
    }),
  );

  /** Pages this browser knows: recent ones, then the loaded tree. */
  const known = () => {
    /** @type {Map<string, PageItem>} */
    const out = new Map();
    for (const page of recent()) {
      const cached = /** @type {import("../api/types.js").Page | undefined} */ (
        queryClient.getData(pageKeys.page(page.id))
      );
      if (cached?.archived_at) continue;
      out.set(page.id, {
        type: "page",
        id: page.id,
        title: cached?.title ?? page.title,
        icon: cached ? cached.icon : page.icon,
        kind: cached?.kind ?? page.kind,
        path: page.path,
        snippet: null,
      });
    }
    const ws = workspace.id();
    if (ws) {
      /** @type {Map<string, import("../api/types.js").TreeNode>} */
      const nodes = new Map();
      for (const key of queryClient.keys(pageKeys.treeAll(ws))) {
        for (const node of /** @type {import("../api/types.js").TreeNode[]} */ (
          queryClient.getData(key) ?? []
        ))
          nodes.set(node.id, node);
      }
      /** @param {import("../api/types.js").TreeNode} node */
      const pathOf = (node) => {
        /** @type {string[]} */
        const path = [];
        for (
          let p = node.parent_id ? nodes.get(node.parent_id) : undefined;
          p && path.length < 64;
          p = p.parent_id ? nodes.get(p.parent_id) : undefined
        ) {
          path.unshift(displayTitle(p.title));
        }
        return path;
      };
      for (const node of nodes.values()) {
        if (!out.has(node.id))
          out.set(node.id, {
            type: "page",
            id: node.id,
            title: node.title,
            icon: node.icon,
            kind: node.kind,
            path: pathOf(node),
            snippet: null,
          });
      }
    }
    return [...out.values()];
  };

  /** @type {() => ActionItem[]} */
  const actions = () => {
    const ws = workspace.id();
    const pageId = currentPageId();
    /** @type {ActionItem[]} */
    const all = [
      {
        type: "action",
        id: "new-page",
        label: "New page",
        keywords: ["create", "add", "page"],
        icon: <IconCompose size={16} />,
        run: () => ws && openNewPage({ workspaceId: ws }),
      },
      {
        type: "action",
        id: "new-database",
        label: "New database",
        keywords: ["create", "table", "board"],
        icon: <IconTable size={16} />,
        run: () => ws && openNewPage({ workspaceId: ws, kind: "database" }),
      },
    ];
    if (pageId) {
      all.push(
        {
          type: "action",
          id: "share",
          label: "Share this page",
          keywords: ["invite", "permissions", "public", "link", "access"],
          icon: <IconShare size={16} />,
          run: () => setShareOpen(true),
        },
        {
          type: "action",
          id: "copy-link",
          label: "Copy link to this page",
          keywords: ["url", "copy"],
          icon: <IconLink size={16} />,
          run: () =>
            void navigator.clipboard?.writeText(webUrl(location().pathname)).catch(() => {}),
        },
      );
    }
    all.push(
      {
        type: "action",
        id: "trash",
        label: "Open trash",
        keywords: ["deleted", "restore", "bin"],
        icon: <IconTrash size={16} />,
        run: () => navigate("/trash"),
      },
      {
        type: "action",
        id: "settings",
        label: "Settings",
        keywords: ["preferences", "theme", "account"],
        icon: <IconSettings size={16} />,
        run: () => navigate("/settings"),
      },
      {
        type: "action",
        id: "sidebar",
        label: "Show or hide the sidebar",
        keywords: ["toggle", "collapse"],
        icon: <IconSidebar size={16} />,
        shortcut: "mod+\\",
        run: toggleSidebar,
      },
      {
        type: "action",
        id: "shortcuts",
        label: "Keyboard shortcuts",
        keywords: ["keys", "help", "hotkeys"],
        icon: <IconKeyboard size={16} />,
        shortcut: "mod+/",
        run: openShortcutsDialog,
      },
    );
    return all;
  };

  /** What the list shows, in sections. */
  const sections = createMemo(() => {
    const q = query().trim();
    if (q === "") {
      const pages = known()
        .filter((page) => recent().some((r) => r.id === page.id))
        .slice(0, 8);
      return [
        { label: "Recent", items: /** @type {Item[]} */ (pages) },
        { label: "Actions", items: /** @type {Item[]} */ (actions()) },
      ].filter((section) => section.items.length > 0);
    }
    // Titles: what's known locally plus the server's title matches, ranked together.
    /** @type {Map<string, PageItem>} */
    const candidates = new Map(known().map((page) => [page.id, page]));
    const fromServer = server();
    for (const result of fromServer) {
      const local = candidates.get(result.id);
      candidates.set(result.id, {
        type: "page",
        id: result.id,
        title: result.title,
        icon: result.icon,
        kind: result.kind,
        path: result.path.map(displayTitle),
        snippet: result.snippet ?? local?.snippet ?? null,
      });
    }
    const titled = fuzzyFilter(q, [...candidates.values()], (page) => displayTitle(page.title)).map(
      ({ item, match }) => ({
        ...item,
        positions: match.positions,
      }),
    );
    const shown = new Set(titled.map((page) => page.id));
    // The server matched the rest by content (or by words across title and text).
    const content = fromServer
      .filter((result) => !shown.has(result.id))
      .map((result) => /** @type {PageItem} */ ({ ...candidates.get(result.id), type: "page" }));
    // Actions match by label, or by a keyword starting with the query.
    const lower = q.toLowerCase();
    const byLabel = fuzzyFilter(q, actions(), (action) => action.label).map(({ item, match }) => ({
      ...item,
      positions: match.positions,
    }));
    const byKeyword = actions().filter(
      (action) =>
        !byLabel.some((a) => a.id === action.id) &&
        action.keywords.some((word) => word.startsWith(lower)),
    );
    const matchingActions = [...byLabel, ...byKeyword].slice(0, 4);
    return [
      { label: "Pages", items: /** @type {Item[]} */ (titled.slice(0, MAX_PAGES)) },
      { label: "In page content", items: /** @type {Item[]} */ (content.slice(0, MAX_PAGES)) },
      { label: "Actions", items: /** @type {Item[]} */ (matchingActions) },
    ].filter((section) => section.items.length > 0);
  });

  const flat = createMemo(() => sections().flatMap((section) => section.items));

  // Keep the selection on the best match while results arrive.
  createEffect(on(query, () => setActive(0)));
  createEffect(() => {
    const n = flat().length;
    if (untrack(active) >= n) setActive(Math.max(0, n - 1));
  });
  createEffect(() => {
    const index = active();
    list?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  });
  // The selected page loads ahead of Enter.
  createEffect(() => {
    const item = flat()[active()];
    if (open() && item && item.type !== "action") preloadPage(item.id);
  });

  /** @param {Item} item */
  function pick(item) {
    setOpen(false);
    if (item.type === "action") item.run();
    else navigate(`/p/${encodeURIComponent(item.id)}`);
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    if (event.isComposing) return;
    const n = flat().length;
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) {
      event.preventDefault();
      if (n) setActive((i) => (i + 1) % n);
    } else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) {
      event.preventDefault();
      if (n) setActive((i) => (i - 1 + n) % n);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = flat()[active()];
      if (item) pick(item);
    } else if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "p")) {
      // The shortcut again closes it.
      event.preventDefault();
      setOpen(false);
    }
  }

  const status = () => {
    if (query().trim() === "") return null;
    if (flat().length > 0) return state() === "loading" ? "Searching…" : null;
    return state() === "error"
      ? "Couldn't search. Check your connection."
      : state() === "done"
        ? "No results"
        : "Searching…";
  };

  return (
    <dialog
      ref={dialog}
      class={styles.dialog}
      aria-label="Quick find"
      onCancel={(event) => {
        event.preventDefault();
        setOpen(false);
      }}
      onClose={finishClose}
      onClick={(event) => {
        if (event.target === dialog) setOpen(false);
      }}
    >
      <Show when={open()}>
        <div class={styles.panel}>
          <div class={styles.field}>
            <IconSearch size={18} />
            <input
              ref={input}
              class={styles.input}
              type="text"
              placeholder="Search pages or type a command…"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat().length > 0 ? `${listId}-${active()}` : undefined}
              autocomplete="off"
              spellcheck={false}
              value={query()}
              onInput={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
            <Kbd keys="escape" />
          </div>
          <div ref={list} id={listId} class={styles.list} role="listbox" aria-label="Results">
            <For each={sections()}>
              {(section) => (
                <div role="group" aria-label={section.label} class={styles.section}>
                  <div class={styles.sectionLabel} aria-hidden="true">
                    {section.label}
                  </div>
                  <For each={section.items}>
                    {(item) => {
                      const i = flat().indexOf(item);
                      return (
                        <div
                          id={`${listId}-${i}`}
                          data-index={i}
                          role="option"
                          aria-selected={active() === i}
                          class={cx(styles.option, active() === i && styles.optionActive)}
                          onPointerMove={() => setActive(i)}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => pick(item)}
                        >
                          <Show
                            when={item.type === "page" ? /** @type {PageItem} */ (item) : null}
                            fallback={
                              <>
                                <span class={styles.icon}>
                                  {/** @type {ActionItem} */ (item).icon}
                                </span>
                                <span class={styles.text}>
                                  <span class={styles.title}>
                                    <Highlight
                                      text={/** @type {ActionItem} */ (item).label}
                                      positions={item.positions}
                                    />
                                  </span>
                                </span>
                                <Show when={/** @type {ActionItem} */ (item).shortcut}>
                                  {(keys) => <Kbd keys={keys()} />}
                                </Show>
                              </>
                            }
                          >
                            {(page) => (
                              <>
                                <PageIcon
                                  icon={page().icon}
                                  kind={page().kind}
                                  size={18}
                                  class={styles.icon}
                                />
                                <span class={styles.text}>
                                  <span class={styles.title}>
                                    <Highlight
                                      text={displayTitle(page().title)}
                                      positions={page().positions}
                                    />
                                  </span>
                                  <Show when={page().snippet}>
                                    {(snippet) => <span class={styles.snippet}>{snippet()}</span>}
                                  </Show>
                                  <Show when={page().path.length > 0}>
                                    <span class={styles.path}>{page().path.join(" / ")}</span>
                                  </Show>
                                </span>
                              </>
                            )}
                          </Show>
                        </div>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
            <Show when={status()}>
              {(text) => (
                <div class={styles.status} role="status">
                  {text()}
                </div>
              )}
            </Show>
          </div>
          <div class={styles.footer} aria-hidden="true">
            <span>
              <Kbd keys="arrowup" /> <Kbd keys="arrowdown" /> to move
            </span>
            <span>
              <Kbd keys="enter" /> to open
            </span>
          </div>
        </div>
      </Show>
    </dialog>
  );
}

/**
 * Text with the matched characters in bold.
 * @param {{ text: string, positions?: number[] }} props
 */
function Highlight(props) {
  const parts = () => {
    const chars = [...props.text];
    const marked = new Set(props.positions ?? []);
    /** @type {{ text: string, hit: boolean }[]} */
    const out = [];
    chars.forEach((char, i) => {
      const hit = marked.has(i);
      const last = out.at(-1);
      if (last && last.hit === hit) last.text += char;
      else out.push({ text: char, hit });
    });
    return out;
  };
  return (
    <For each={parts()}>
      {(part) => (part.hit ? <mark class={styles.hit}>{part.text}</mark> : part.text)}
    </For>
  );
}
