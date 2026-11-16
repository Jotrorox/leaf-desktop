// @ts-check
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { cx } from "../../lib/cx.js";
import { dropZone, scrollParent, startDrag } from "../../lib/dnd.js";
import { IconCopy, IconPlus, IconTrash } from "../../ui/icons/index.jsx";
import Menu, { MenuGroup, MenuItem, MenuSeparator } from "../../ui/Menu.jsx";
import { COLORS } from "../blocks/colors.js";
import { BLOCKS, hasText } from "../blocks/schema.js";
import { holdsBlocks, showsChildren } from "../commands/commands.js";
import { copyMath } from "../math/copy.js";
import styles from "./EditorUI.module.css";
import { TURN_INTO_TYPES, useCoarsePointer } from "./InlineToolbar.jsx";

/** @typedef {import("../editor.js").EditorController} EditorController */

/**
 * @typedef {object} DropTarget
 * @property {{ parent: string | null, after: string | null }} to
 * @property {{ top: number, left: number, width: number }} line Where the drop indicator goes, relative to the editor.
 */

/** The row element of a block (its marker and text, or its divider). @param {HTMLElement} root @param {string} id */
function rowOf(root, id) {
  return /** @type {HTMLElement | null} */ (
    root.querySelector(`[data-block-id="${CSS.escape(id)}"] > [data-row]`)
  );
}

/**
 * The grip and + shown next to the block under the mouse, dragging blocks
 * by the grip, and the block menu (click the grip, or ⌘/ at the caret):
 * delete, duplicate, turn into, color, move up and down. Actions apply to
 * every selected block when the block is part of a selection.
 *
 * On touch screens there's no hover, so the grip is hidden; the block menu
 * opens from the mobile toolbar instead.
 *
 * @param {{ ed: EditorController, container: () => HTMLElement | undefined }} props
 */
export default function BlockHandle(props) {
  const ed = props.ed;
  const coarse = useCoarsePointer();
  const [hovered, setHovered] = createSignal(/** @type {string | null} */ (null));
  const [handlePos, setHandlePos] = createSignal({ top: 0, left: 0 });
  const [indicator, setIndicator] = createSignal(/** @type {DropTarget["line"] | null} */ (null));
  const [dragging, setDragging] = createSignal(false);
  /** The block menu: which blocks, and which part of it is showing. */
  const [menu, setMenu] = createSignal(
    /** @type {{ ids: string[], view: "main" | "turn" | "color" } | null} */ (null),
  );
  const [anchorPos, setAnchorPos] = createSignal({ top: 0, left: 0, height: 0 });
  /** @type {HTMLDivElement | undefined} */
  let anchor;
  let frame = 0;
  /** Whether closing the block menu hands focus back to the editor (it was opened from the keyboard). */
  let focusEditor = false;

  /** Rows on screen, in order, with their blocks. */
  function rows() {
    const root = ed.root;
    if (!root) return [];
    return [...root.querySelectorAll("[data-block-id] > [data-row]")].map((row) => ({
      row: /** @type {HTMLElement} */ (row),
      id: /** @type {string} */ (/** @type {HTMLElement} */ (row.parentElement).dataset.blockId),
      rect: row.getBoundingClientRect(),
    }));
  }

  /** The row at a height on screen (or the nearest one, within reach). @param {number} y @param {(id: string) => boolean} [skip] */
  function rowAt(y, skip) {
    let best = null;
    let distance = Infinity;
    for (const r of rows()) {
      if (r.rect.height === 0 || skip?.(r.id)) continue;
      if (y >= r.rect.top && y < r.rect.bottom) return r;
      const d = y < r.rect.top ? r.rect.top - y : y - r.rect.bottom;
      if (d < distance) {
        distance = d;
        best = r;
      }
    }
    return best;
  }

  /** Line up the handle with a block's first line. @param {string} id */
  function placeHandle(id) {
    const container = props.container();
    const root = ed.root;
    const row = root && rowOf(root, id);
    if (!container || !row) return;
    const box = container.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (row.hasAttribute("data-embed")) {
      // An embed (a database, an image) has no text line: line up with its
      // marked first line (an inline database's title), else its top.
      const marked = /** @type {HTMLElement | null} */ (row.querySelector("[data-handle-line]"));
      const first = (marked ?? row.firstElementChild ?? row).getBoundingClientRect();
      const height = marked ? first.height : 24;
      setHandlePos({
        top: first.top - box.top + Math.max(0, (height - 24) / 2),
        left: rect.left - box.left,
      });
      return;
    }
    const text = /** @type {HTMLElement | null} */ (row.querySelector("[data-text]"));
    const line = text ? parseFloat(getComputedStyle(text).lineHeight) || 24 : rect.height;
    const textTop = text ? text.getBoundingClientRect().top : rect.top;
    setHandlePos({
      top: textTop - box.top + Math.max(0, (Math.min(line, rect.height) - 24) / 2),
      left: rect.left - box.left,
    });
  }

  function onPointerMove(/** @type {PointerEvent} */ event) {
    if (dragging() || menu() || event.pointerType === "touch") return;
    const y = event.clientY;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const r = rowAt(y);
      if (!r || y < r.rect.top - 8 || y > r.rect.bottom + 8) {
        setHovered(null);
        return;
      }
      setHovered(r.id);
      placeHandle(r.id);
    });
  }

  function onPointerLeave() {
    if (dragging() || menu()) return;
    cancelAnimationFrame(frame);
    setHovered(null);
  }

  onMount(() => {
    const container = props.container();
    container?.addEventListener("pointermove", onPointerMove);
    container?.addEventListener("pointerleave", onPointerLeave);
    // The block under the handle can change or go away while typing.
    const hide = () => !dragging() && !menu() && setHovered(null);
    ed.root?.addEventListener("keydown", hide);
    ed.onBlockMenu = (id) => openMenu(id, true);
    onCleanup(() => {
      cancelAnimationFrame(frame);
      container?.removeEventListener("pointermove", onPointerMove);
      container?.removeEventListener("pointerleave", onPointerLeave);
      ed.root?.removeEventListener("keydown", hide);
      ed.onBlockMenu = () => {};
    });
  });

  /** @param {string} id @param {boolean} editorFocus Return focus to the editor when it closes. */
  function openMenu(id, editorFocus) {
    if (ed.readOnly || !ed.doc.hasBlock(id)) return;
    const ids = ed.blockTargets(id);
    const container = props.container();
    // (A table's cell opens its table's menu.)
    const row = ed.root && rowOf(ed.root, ids.includes(id) ? id : ids[0]);
    if (container && row) {
      const box = container.getBoundingClientRect();
      const rect = row.getBoundingClientRect();
      setAnchorPos({
        top: rect.top - box.top,
        left: rect.left - box.left,
        height: Math.min(rect.height, 28),
      });
    }
    ed.closeSuggestion();
    ed.setHighlighted(ids);
    focusEditor = editorFocus;
    setMenu({ ids, view: "main" });
  }

  function closeMenu() {
    setMenu(null);
    ed.setHighlighted([]);
  }

  /** @param {"main" | "turn" | "color"} view */
  function showView(view) {
    const m = menu();
    if (!m) return;
    // Close, then open the next part on the next frame, so focus lands in it.
    setMenu(null);
    requestAnimationFrame(() => setMenu({ ...m, view }));
  }

  // --- Drag and drop ---------------------------------------------------------

  /**
   * Where dropping `ids` at the pointer puts them. Moving the pointer left
   * of a last child's indent drops after its parent instead; well to the
   * right of a block, into it.
   * @param {string[]} ids @param {number} x @param {number} y
   * @returns {DropTarget | null}
   */
  function dropTarget(ids, x, y) {
    const container = props.container();
    const root = ed.root;
    if (!container || !root) return null;
    const doc = ed.doc;
    const moving = new Set(ids);
    const inside = (/** @type {string} */ id) => {
      for (
        let a = /** @type {string | null | undefined} */ (id);
        typeof a === "string";
        a = doc.parentOf(a)
      )
        if (moving.has(a)) return true;
      return false;
    };
    const r = rowAt(y, inside);
    if (!r) return null;
    const box = container.getBoundingClientRect();
    const zone = dropZone(y - r.rect.top, r.rect.height, { inside: false });
    const parentOf = (/** @type {string} */ id) => doc.parentOf(id) ?? null;
    const siblings = (/** @type {string} */ id) =>
      doc.children(parentOf(id)).filter((s) => !moving.has(s));
    const left = (/** @type {DOMRect} */ rect) => rect.left - box.left;
    const width = Math.max(0, box.right - r.rect.left);

    if (zone === "before") {
      const list = siblings(r.id);
      const i = list.indexOf(r.id);
      return {
        to: { parent: parentOf(r.id), after: i > 0 ? list[i - 1] : null },
        line: { top: r.rect.top - box.top, left: left(r.rect), width },
      };
    }
    if (
      doc.children(r.id).length > 0 &&
      showsChildren(ed.ctx, r.id) &&
      holdsBlocks(doc.getType(r.id))
    ) {
      return {
        to: { parent: r.id, after: null },
        line: { top: r.rect.bottom - box.top, left: left(r.rect) + 24, width: width - 24 },
      };
    }
    // Well right of the block: nest it there.
    if (x > r.rect.left + 64 && hasText(doc.getType(r.id))) {
      return {
        to: { parent: r.id, after: null },
        line: { top: r.rect.bottom - box.top, left: left(r.rect) + 24, width: width - 24 },
      };
    }
    // Left of a last child's indent: after its parent (and so on up).
    let target = r.id;
    let rect = r.rect;
    for (;;) {
      const parent = parentOf(target);
      if (parent === null) break;
      const list = siblings(target);
      if (list[list.length - 1] !== target || x >= rect.left - 8) break;
      const parentRow = rowOf(root, parent);
      if (!parentRow) break;
      target = parent;
      rect = parentRow.getBoundingClientRect();
    }
    return {
      to: { parent: parentOf(target), after: target },
      line: {
        top: r.rect.bottom - box.top,
        left: left(rect),
        width: Math.max(0, box.right - rect.left),
      },
    };
  }

  /** @param {string[]} ids */
  function preview(ids) {
    const el = document.createElement("div");
    el.className = styles.dragPreview;
    const first = ids[0];
    const text = hasText(ed.doc.getType(first))
      ? ed.doc.getText(first)
      : (BLOCKS[ed.doc.getType(first)]?.label ?? "Block");
    el.textContent = (text.trim() || BLOCKS[ed.doc.getType(first)]?.label || "Block").slice(0, 60);
    if (ids.length > 1) {
      const more = document.createElement("span");
      more.className = styles.dragCount;
      more.textContent = `+${ids.length - 1}`;
      el.append(more);
    }
    return el;
  }

  /** @param {PointerEvent} event */
  function onGripPointerDown(event) {
    const id = hovered();
    if (!id || ed.readOnly) return;
    const ids = ed.blockTargets(id);
    startDrag(event, {
      resolve: (x, y) => dropTarget(ids, x, y),
      onMove: (target) => setIndicator(target?.line ?? null),
      onStart: () => {
        setDragging(true);
        ed.closeSuggestion();
        ed.setHighlighted(ids);
      },
      onEnd: () => {
        setDragging(false);
        setIndicator(null);
        ed.setHighlighted([]);
        setHovered(null);
      },
      onDrop: (target) => ed.moveBlocks(ids, target.to),
      preview: () => preview(ids),
      scrollContainer: scrollParent(props.container() ?? null),
    });
  }

  // --- Menu ------------------------------------------------------------------

  const ids = () => menu()?.ids ?? [];
  const first = () => ids()[0];
  const currentType = () => {
    const id = first();
    if (!id) return null;
    ed.version(id);
    const types = new Set(ids().map((i) => ed.doc.getType(i)));
    return types.size === 1 ? ed.doc.getType(id) : null;
  };
  const currentColor = () => {
    const id = first();
    if (!id) return null;
    ed.version(id);
    const colors = new Set(ids().map((i) => ed.doc.getAttrs(i).color ?? null));
    const only = colors.size === 1 ? [...colors][0] : null;
    return typeof only === "string" ? only : null;
  };
  /** Whether every block the menu is for has a table option on. @param {string} key */
  const allTables = (key) =>
    ids().length > 0 && ids().every((id) => (ed.version(id), ed.doc.getAttrs(id)[key] === true));
  /** Whether every block the menu is for is a numbered equation. */
  const allNumbered = () => {
    const numbers = ed.equationNumbering().numbers;
    return ids().length > 0 && ids().every((id) => numbers.has(id));
  };
  /** An item's action, on the blocks the menu is for. @param {(ids: string[]) => void} fn */
  const run = (fn) => () => {
    const targets = ids();
    closeMenu();
    fn(targets);
  };
  const focusOnClose = () => {
    if (!focusEditor || !menu()) return null;
    queueMicrotask(() => ed.restoreFocus());
    return ed.root;
  };
  /**
   * A part of the menu closed (Escape, a click outside, or an item about
   * to run). Items run right after this, so wait: one that opens another
   * part, or runs an action, has dealt with the menu by then.
   * @param {"main" | "turn" | "color"} view
   */
  const onClosed = (view) => (/** @type {boolean} */ open) => {
    if (open) return;
    queueMicrotask(() => {
      if (menu()?.view === view) closeMenu();
    });
  };

  return (
    <>
      <Show when={!ed.readOnly && !coarse() && (hovered() !== null || menu() !== null)}>
        <div
          class={cx(styles.handle, dragging() && styles.handleDragging)}
          style={{ top: `${handlePos().top}px`, left: `${handlePos().left}px` }}
        >
          <button
            type="button"
            class={styles.handleButton}
            tabIndex={-1}
            aria-label="Add a block below"
            title="Add a block below"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const id = hovered();
              if (id) ed.insertBelow(id);
            }}
          >
            <IconPlus size={16} />
          </button>
          <button
            type="button"
            class={cx(styles.handleButton, styles.grip)}
            tabIndex={-1}
            aria-label="Drag to move, click for options"
            title="Drag to move · Click for options"
            onMouseDown={(event) => event.preventDefault()}
            onPointerDown={onGripPointerDown}
            onClick={() => {
              const id = hovered();
              if (id) openMenu(id, false);
            }}
          >
            <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">
              <For each={[3, 8, 13]}>
                {(cy) => (
                  <>
                    <circle cx="2.5" cy={cy} r="1.3" fill="currentColor" />
                    <circle cx="7.5" cy={cy} r="1.3" fill="currentColor" />
                  </>
                )}
              </For>
            </svg>
          </button>
        </div>
      </Show>
      <Show when={indicator()}>
        {(line) => (
          <div
            class={styles.dropLine}
            style={{
              top: `${line().top - 1}px`,
              left: `${line().left}px`,
              width: `${line().width}px`,
            }}
          />
        )}
      </Show>
      <div
        ref={anchor}
        class={styles.menuAnchor}
        style={{
          top: `${anchorPos().top}px`,
          left: `${anchorPos().left}px`,
          height: `${anchorPos().height}px`,
        }}
      />
      <Menu
        anchor={() => anchor}
        open={menu()?.view === "main"}
        onOpenChange={onClosed("main")}
        label="Block actions"
        placement="left-start"
        focusOnClose={focusOnClose}
      >
        <MenuItem icon={<IconTrash size={16} />} onSelect={run((t) => ed.deleteBlocks(t))}>
          Delete
        </MenuItem>
        <MenuItem
          icon={<IconCopy size={16} />}
          shortcut="mod+d"
          onSelect={run((t) => ed.duplicateBlocks(t))}
        >
          Duplicate
        </MenuItem>
        <Show when={currentType() === "table"}>
          <MenuSeparator />
          <For
            each={
              /** @type {const} */ ([
                ["header_row", "Header row"],
                ["header_column", "Header column"],
              ])
            }
          >
            {([key, label]) => (
              <MenuItem
                checked={allTables(key)}
                onSelect={() => {
                  const on = !allTables(key);
                  run((t) => ed.setTableOption(t, key, on))();
                }}
              >
                {label}
              </MenuItem>
            )}
          </For>
        </Show>
        <Show when={currentType() === "equation"}>
          <MenuSeparator />
          <MenuItem
            onSelect={run(
              (t) =>
                void copyMath(
                  t.map((id) => ed.doc.getText(id)),
                  "tex",
                  true,
                  ed.mathMacros(),
                ),
            )}
          >
            Copy as TeX
          </MenuItem>
          <MenuItem
            onSelect={run(
              (t) =>
                void copyMath(
                  t.map((id) => ed.doc.getText(id)),
                  "mathml",
                  true,
                  ed.mathMacros(),
                  ed.equationNumbering().refs,
                ),
            )}
          >
            Copy as MathML
          </MenuItem>
          <MenuItem
            checked={allNumbered()}
            onSelect={() => {
              // Read before the menu closes (and forgets its blocks).
              const numbered = !allNumbered();
              run((t) => ed.setEquationsNumbered(t, numbered))();
            }}
          >
            Numbered
          </MenuItem>
          <MenuItem onSelect={run(() => ed.setMacrosOpen(true))}>Page macros…</MenuItem>
        </Show>
        <MenuSeparator />
        <MenuItem onSelect={() => showView("turn")} textValue="Turn into">
          Turn into…
        </MenuItem>
        <MenuItem onSelect={() => showView("color")} textValue="Color">
          Color…
        </MenuItem>
        <MenuSeparator />
        <MenuItem shortcut="mod+shift+arrowup" onSelect={run((t) => ed.moveBlocksBy(-1, t))}>
          Move up
        </MenuItem>
        <MenuItem shortcut="mod+shift+arrowdown" onSelect={run((t) => ed.moveBlocksBy(1, t))}>
          Move down
        </MenuItem>
      </Menu>
      <Menu
        anchor={() => anchor}
        open={menu()?.view === "turn"}
        onOpenChange={onClosed("turn")}
        label="Turn into"
        placement="left-start"
        focusOnClose={focusOnClose}
      >
        <MenuGroup label="Turn into">
          <For each={TURN_INTO_TYPES}>
            {(type) => (
              <MenuItem
                checked={currentType() === type}
                onSelect={run((t) => ed.turnBlocksInto(t, type))}
              >
                {BLOCKS[type].label}
              </MenuItem>
            )}
          </For>
        </MenuGroup>
      </Menu>
      <Menu
        anchor={() => anchor}
        open={menu()?.view === "color"}
        onOpenChange={onClosed("color")}
        label="Color"
        placement="left-start"
        focusOnClose={focusOnClose}
      >
        <MenuGroup label="Text color">
          <MenuItem
            checked={currentColor() === null}
            icon={<span class={styles.menuSwatch}>A</span>}
            onSelect={run((t) => ed.setBlockColor(t, null))}
          >
            Default
          </MenuItem>
          <For each={COLORS}>
            {(c) => (
              <MenuItem
                checked={currentColor() === c.name}
                icon={
                  <span class={styles.menuSwatch} data-color={c.name}>
                    A
                  </span>
                }
                onSelect={run((t) => ed.setBlockColor(t, c.name))}
              >
                {c.label}
              </MenuItem>
            )}
          </For>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup label="Background">
          <For each={COLORS}>
            {(c) => (
              <MenuItem
                checked={currentColor() === `${c.name}_background`}
                icon={
                  <span class={styles.menuSwatch} data-color={`${c.name}_background`}>
                    A
                  </span>
                }
                onSelect={run((t) => ed.setBlockColor(t, `${c.name}_background`))}
                textValue={`${c.label} background`}
              >
                {c.label} background
              </MenuItem>
            )}
          </For>
        </MenuGroup>
      </Menu>
    </>
  );
}
