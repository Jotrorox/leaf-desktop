// @ts-check

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
} from "solid-js";
import {
  addOption,
  addRow,
  deleteProperty,
  trashRows,
  updateRow,
  updateView,
  useRows,
} from "../../data/databases.js";
import { displayTitle } from "../../data/pages.js";
import { scrollParent, startDrag } from "../../lib/dnd.js";
import ConfirmDialog from "../../ui/ConfirmDialog.jsx";
import {
  IconArrowDown,
  IconArrowUp,
  IconMore,
  IconOpen,
  IconPlus,
  IconTrash,
} from "../../ui/icons/index.jsx";
import Menu, { MenuItem, MenuSeparator } from "../../ui/Menu.jsx";
import { IconGlyph } from "../../ui/PageIcon.jsx";
import { createToggleHandlers } from "../../ui/Popover.jsx";
import { isEmptyValue, isOptionType } from "../schema.js";
import {
  layoutColumns,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  movedColumns,
  withColumn,
} from "../views.js";
import styles from "./Database.module.css";
import {
  DatePicker,
  editText,
  OptionPicker,
  PersonPicker,
  parseText,
  TextInput,
} from "./editors.jsx";
import PropertyMenu, { AddPropertyMenu } from "./PropertyMenu.jsx";
import { CellValue, PropertyIcon } from "./values.jsx";

/** @typedef {import("../../api/types.js").Database} Database */
/** @typedef {import("../../api/types.js").View} View */
/** @typedef {import("../../api/types.js").Row} Row */
/** @typedef {import("../../api/types.js").Property} Property */
/** @typedef {import("../../api/types.js").PropertyValue} PropertyValue */
/** @typedef {import("../../api/types.js").Member} Member */
/** @typedef {{ property: Property, width: number, hidden: boolean }} ColumnLayout */
/** @typedef {{ row: number, col: number }} CellPos */

/** Rows drawn past the edges of the screen, each way. */
const OVERSCAN = 8;

/**
 * A database view as a table. Rows are drawn only around what's on screen
 * (fixed row height: a 5,000-row table has ~50 rows in the DOM) and loaded
 * a chunk at a time from the server, filtered and sorted there.
 *
 * Keyboard (ARIA grid): arrows move between cells, Enter edits (Enter
 * again saves and moves down), typing starts editing a text cell, Delete
 * clears, Space ticks a checkbox, Escape stops editing.
 *
 * @param {{
 *   database: Database,
 *   view: View,
 *   workspaceId: string,
 *   readOnly: boolean,
 *   members: readonly Member[] | undefined,
 *   onOpenRow: (id: string, full: boolean) => void,
 *   onAddFilter: (propertyId: string) => void,
 *   label: string,
 * }} props
 */
export default function Table(props) {
  /** @type {HTMLDivElement | undefined} */
  let grid;
  /** @type {HTMLDivElement | undefined} */
  let body;
  const [rowHeight, setRowHeight] = createSignal(36);
  const [range, setRange] = createSignal({ start: 0, end: 40 });
  const [widths, setWidths] = createSignal(/** @type {Record<string, number>} */ ({}));
  const [active, setActive] = createSignal(/** @type {CellPos | null} */ (null));
  const [editing, setEditing] = createSignal(
    /** @type {(CellPos & { initial?: string }) | null} */ (null),
  );
  const [menu, setMenu] = createSignal(
    /** @type {{ id: string, anchor: HTMLElement } | null} */ (null),
  );
  const [adding, setAdding] = createSignal(false);
  const [dropAt, setDropAt] = createSignal(
    /** @type {{ index: number, side: "before" | "after" } | null} */ (null),
  );
  const [rowMenu, setRowMenu] = createSignal(
    /** @type {{ row: Row, anchor: HTMLElement } | null} */ (null),
  );
  const [deleting, setDeleting] = createSignal(/** @type {Property | null} */ (null));
  /** @type {HTMLButtonElement | undefined} */
  let addButton;

  const schema = () => props.database.properties;
  const databaseId = () => props.database.id;
  const columns = createMemo(() =>
    layoutColumns(props.view, schema())
      .filter((c) => !c.hidden)
      .map((c) => ({ ...c, width: widths()[c.property.id] ?? c.width })),
  );
  const totalWidth = () =>
    columns().reduce((sum, c) => sum + c.width, 0) + (props.readOnly ? 0 : 40);
  const rows = useRows(
    databaseId,
    () => ({ filter: props.view.filter, sorts: props.view.sorts }),
    range,
  );
  const total = () => rows.total() ?? 0;
  const visible = createMemo(() => {
    const { start, end } = range();
    const out = [];
    for (let i = start; i < Math.min(end, total()); i++) out.push(i);
    return out;
  });
  const sortOf = (/** @type {string} */ id) => props.view.sorts.find((s) => s.property_id === id);

  // Which rows are on screen: the body's place in its scrolling ancestor.
  onMount(() => {
    if (!body) return;
    const coarse = matchMedia("(pointer: coarse)");
    const readHeight = () => setRowHeight(coarse.matches ? 44 : 36);
    readHeight();
    coarse.addEventListener("change", readHeight);
    const scroller = /** @type {HTMLElement} */ (
      scrollParent(body.parentElement) ?? document.scrollingElement
    );
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (!body) return;
      const viewport =
        scroller === document.scrollingElement
          ? { top: 0, height: innerHeight }
          : { top: scroller.getBoundingClientRect().top, height: scroller.clientHeight };
      const offset = viewport.top - body.getBoundingClientRect().top;
      const h = untrack(rowHeight);
      const start = Math.max(0, Math.floor(offset / h) - OVERSCAN);
      const end = Math.max(start, Math.ceil((offset + viewport.height) / h) + OVERSCAN);
      const current = untrack(range);
      if (current.start !== start || current.end !== end) setRange({ start, end });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    const target = scroller === document.scrollingElement ? window : scroller;
    target.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(body);
    measure();
    onCleanup(() => {
      cancelAnimationFrame(frame);
      coarse.removeEventListener("change", readHeight);
      target.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer.disconnect();
    });
  });

  // A filter or sort change starts over at the top.
  createEffect(
    on(
      () => JSON.stringify([props.view.id, props.view.filter, props.view.sorts]),
      () => {
        setActive(null);
        setEditing(null);
      },
      { defer: true },
    ),
  );

  /** @param {CellPos} pos */
  const cellEl = (pos) =>
    /** @type {HTMLElement | null} */ (
      grid?.querySelector(`[data-cell="${pos.row}:${pos.col}"]`) ?? null
    );

  /** Scrolls a row into view (it may not be drawn yet), then focuses the cell. @param {CellPos} pos */
  function focusCell(pos) {
    setActive(pos);
    if (!body) return;
    const scroller = scrollParent(body.parentElement);
    const h = rowHeight();
    const top = body.getBoundingClientRect().top + pos.row * h;
    const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight };
    if (scroller && (top < view.top + h || top + h > view.bottom - h)) {
      scroller.scrollTop += top < view.top + h ? top - view.top - h : top + h - view.bottom + h;
    }
    const el = cellEl(pos);
    if (el) el.focus({ preventScroll: true });
    // Not drawn yet: once the scroll has brought it in.
    else
      requestAnimationFrame(() =>
        requestAnimationFrame(
          () => untrack(active) === pos && cellEl(pos)?.focus({ preventScroll: true }),
        ),
      );
  }

  /** @param {CellPos} pos @param {number} dRow @param {number} dCol */
  function move(pos, dRow, dCol) {
    const row = Math.max(0, Math.min(total() - 1, pos.row + dRow));
    const col = Math.max(0, Math.min(columns().length - 1, pos.col + dCol));
    focusCell({ row, col });
  }

  /** @param {CellPos} pos */
  const columnAt = (pos) => columns()[pos.col]?.property;

  /** @param {Row} row @param {Property} property @returns {PropertyValue | undefined} */
  const valueOf = (row, property) =>
    property.type === "title" ? row.title : row.properties[property.id];

  /** @param {Row} row @param {Property} property @param {PropertyValue | null} value */
  function save(row, property, value) {
    if (property.type === "title") {
      const title = typeof value === "string" ? value : "";
      if (title !== row.title) void updateRow(databaseId(), row.id, { title });
      return;
    }
    const before = row.properties[property.id] ?? null;
    if (
      JSON.stringify(before) === JSON.stringify(value) ||
      (isEmptyValue(before) && isEmptyValue(value))
    )
      return;
    void updateRow(databaseId(), row.id, { properties: { [property.id]: value } });
  }

  /** Starts editing a cell, or acts on it right away (a checkbox). @param {CellPos} pos @param {string} [initial] */
  function edit(pos, initial) {
    const property = columnAt(pos);
    const row = rows.row(pos.row);
    if (!property || !row || props.readOnly) return;
    if (property.type === "checkbox") {
      save(row, property, row.properties[property.id] === true ? null : true);
      return;
    }
    setActive(pos);
    setEditing({ ...pos, initial });
  }

  /** @param {boolean} [refocus] */
  function stopEditing(refocus = true) {
    const pos = editing();
    setEditing(null);
    if (pos && refocus) requestAnimationFrame(() => cellEl(pos)?.focus({ preventScroll: true }));
  }

  /** @param {KeyboardEvent} event */
  function onGridKeyDown(event) {
    const pos = active();
    if (!pos || editing() || event.defaultPrevented) return;
    if (!(event.target instanceof HTMLElement) || !event.target.matches("[data-cell]")) return;
    const property = columnAt(pos);
    const row = rows.row(pos.row);
    const mod = event.metaKey || event.ctrlKey;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        return move(pos, mod ? total() : 1, 0);
      case "ArrowUp":
        event.preventDefault();
        return move(pos, mod ? -total() : -1, 0);
      case "ArrowRight":
        event.preventDefault();
        return move(pos, 0, 1);
      case "ArrowLeft":
        event.preventDefault();
        return move(pos, 0, -1);
      case "Home":
        event.preventDefault();
        return move(pos, mod ? -total() : 0, -columns().length);
      case "End":
        event.preventDefault();
        return move(pos, mod ? total() : 0, columns().length);
      case "PageDown":
      case "PageUp": {
        event.preventDefault();
        const page = Math.max(1, range().end - range().start - 2 * OVERSCAN - 1);
        return move(pos, event.key === "PageDown" ? page : -page, 0);
      }
      case "Enter":
        event.preventDefault();
        if (mod && row) return props.onOpenRow(row.id, event.shiftKey);
        return edit(pos);
      case " ":
        if (property?.type === "checkbox") {
          event.preventDefault();
          return edit(pos);
        }
        break;
      case "ContextMenu":
      case "F10":
        if (row && !props.readOnly && (event.key === "ContextMenu" || event.shiftKey)) {
          event.preventDefault();
          setRowMenu({ row, anchor: /** @type {HTMLElement} */ (event.target) });
        }
        return;
      case "Backspace":
      case "Delete":
        if (row && property && !props.readOnly) {
          event.preventDefault();
          save(row, property, property.type === "title" ? "" : null);
        }
        return;
    }
    // Typing starts editing a text cell with what was typed.
    if (
      event.key.length === 1 &&
      !mod &&
      !event.altKey &&
      property &&
      ["title", "text", "number", "url"].includes(property.type)
    ) {
      event.preventDefault();
      edit(pos, event.key);
    }
  }

  function newRow() {
    const index = total();
    addRow({ databaseId: databaseId(), workspaceId: props.workspaceId });
    const titleCol = Math.max(
      0,
      columns().findIndex((c) => c.property.type === "title"),
    );
    focusCell({ row: index, col: titleCol });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setEditing({ row: index, col: titleCol })),
    );
  }

  // Column widths: dragged live, saved to the view on release.
  /** @param {PointerEvent} event @param {ColumnLayout} column */
  function startResize(event, column) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = column.width;
    const id = column.property.id;
    const handle = /** @type {HTMLElement} */ (event.currentTarget);
    handle.setPointerCapture(event.pointerId);
    handle.classList.add(styles.resizing);
    /** @param {PointerEvent} e */
    const onMove = (e) => {
      const width = Math.round(
        Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, startWidth + e.clientX - startX)),
      );
      setWidths((w) => ({ ...w, [id]: width }));
    };
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      handle.classList.remove(styles.resizing);
      const width = widths()[id];
      if (width !== undefined && width !== startWidth) {
        void updateView(databaseId(), props.view.id, {
          columns: withColumn(props.view, schema(), id, { width }),
        });
      }
      // The view's own width takes over once it's in.
      queueMicrotask(() =>
        setWidths((w) => Object.fromEntries(Object.entries(w).filter(([key]) => key !== id))),
      );
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  }

  // Column order: drag a header sideways.
  /** @param {PointerEvent} event @param {number} index */
  function startColumnDrag(event, index) {
    if (props.readOnly || !grid) return;
    const headers = () =>
      /** @type {HTMLElement[]} */ ([...(grid?.querySelectorAll("[data-header]") ?? [])]);
    const source = columns()[index];
    startDrag(event, {
      resolve(x) {
        const list = headers();
        for (let i = 0; i < list.length; i++) {
          const rect = list[i].getBoundingClientRect();
          if (x < rect.left + rect.width / 2)
            return { index: i, side: /** @type {const} */ ("before") };
        }
        return list.length
          ? { index: list.length - 1, side: /** @type {const} */ ("after") }
          : null;
      },
      onMove: (target) => setDropAt(target),
      onEnd: () => setDropAt(null),
      onDrop(target) {
        // Where it lands among all columns (hidden ones too), the source taken out.
        const all = layoutColumns(props.view, schema());
        const visibleIds = columns().map((c) => c.property.id);
        const anchorId = visibleIds[target.index];
        const order = all.map((c) => c.property.id).filter((id) => id !== source.property.id);
        let to = order.indexOf(anchorId);
        if (to < 0) return;
        if (target.side === "after") to += 1;
        if (anchorId === source.property.id) return;
        void updateView(databaseId(), props.view.id, {
          columns: movedColumns(props.view, schema(), source.property.id, to),
        });
      },
    });
  }

  /** @param {Property} property @param {"ascending" | "descending"} direction */
  function sortBy(property, direction) {
    const others = props.view.sorts.filter((s) => s.property_id !== property.id);
    void updateView(databaseId(), props.view.id, {
      sorts: [{ property_id: property.id, direction }, ...others].slice(0, 10),
    });
  }

  const menuProperty = () => {
    const m = menu();
    return m ? schema().find((p) => p.id === m.id) : undefined;
  };

  return (
    <div class={styles.scroll}>
      <div
        ref={grid}
        class={styles.grid}
        style={{ width: `${totalWidth()}px` }}
        role="grid"
        aria-label={props.label}
        aria-rowcount={total() + 1}
        aria-colcount={columns().length}
        aria-readonly={props.readOnly || undefined}
        onKeyDown={onGridKeyDown}
      >
        <div class={styles.headerRow} role="row" aria-rowindex={1}>
          <Index each={columns()}>
            {(column, index) => (
              <div
                class={styles.headerCell}
                style={{ width: `${column().width}px` }}
                role="columnheader"
                aria-sort={sortOf(column().property.id)?.direction ?? undefined}
                data-header
                data-drop={dropAt()?.index === index ? dropAt()?.side : undefined}
              >
                <button
                  type="button"
                  class={styles.headerButton}
                  aria-haspopup="dialog"
                  aria-expanded={menu()?.id === column().property.id}
                  onPointerDown={(event) => startColumnDrag(event, index)}
                  onClick={(event) => {
                    const id = column().property.id;
                    setMenu(menu()?.id === id ? null : { id, anchor: event.currentTarget });
                  }}
                >
                  <PropertyIcon type={column().property.type} />
                  <span class={styles.headerName}>{column().property.name}</span>
                  <Show when={sortOf(column().property.id)}>
                    {(sort) => (
                      <span class={styles.sortMark} aria-hidden="true">
                        {sort().direction === "ascending" ? (
                          <IconArrowUp size={14} />
                        ) : (
                          <IconArrowDown size={14} />
                        )}
                      </span>
                    )}
                  </Show>
                </button>
                <Show when={!props.readOnly}>
                  <div
                    class={styles.resize}
                    aria-hidden="true"
                    onPointerDown={(event) => startResize(event, column())}
                  />
                </Show>
              </div>
            )}
          </Index>
          <Show when={!props.readOnly}>
            <button
              ref={addButton}
              type="button"
              class={styles.addColumn}
              aria-label="Add a property"
              aria-haspopup="dialog"
              aria-expanded={adding()}
              {...createToggleHandlers(adding, setAdding)}
            >
              <IconPlus size={16} />
            </button>
          </Show>
        </div>

        <div
          ref={body}
          class={styles.body}
          style={{ height: `${total() * rowHeight()}px` }}
          role="rowgroup"
        >
          <For each={visible()}>
            {(index) => (
              <TableRow
                index={index}
                row={rows.row(index)}
                top={index * rowHeight()}
                columns={columns()}
                active={active()}
                editing={editing()}
                readOnly={props.readOnly}
                members={props.members}
                databaseId={databaseId()}
                workspaceId={props.workspaceId}
                valueOf={valueOf}
                onActivate={(col) => setActive({ row: index, col })}
                onEdit={(col) => edit({ row: index, col })}
                onSave={save}
                onStopEditing={stopEditing}
                onMove={(dRow, dCol) => {
                  const pos = { row: index, col: active()?.col ?? 0 };
                  stopEditing(false);
                  move(pos, dRow, dCol);
                }}
                onOpenRow={props.onOpenRow}
                onRowMenu={(row, anchor) => setRowMenu({ row, anchor })}
              />
            )}
          </For>
        </div>

        <Show when={!props.readOnly}>
          <button
            type="button"
            class={styles.newRow}
            style={{ width: `${totalWidth()}px` }}
            onClick={newRow}
          >
            <IconPlus size={16} /> New
          </button>
        </Show>
      </div>

      <Show when={menuProperty()}>
        {(property) => (
          <PropertyMenu
            open
            onOpenChange={(open) => !open && setMenu(null)}
            anchor={() => menu()?.anchor}
            databaseId={databaseId()}
            property={property()}
            readOnly={props.readOnly}
            onSort={(direction) => sortBy(property(), direction)}
            onFilter={() => props.onAddFilter(property().id)}
            onHide={() =>
              void updateView(databaseId(), props.view.id, {
                columns: withColumn(props.view, schema(), property().id, { hidden: true }),
              })
            }
            onDelete={() => setDeleting(property())}
          />
        )}
      </Show>
      <ConfirmDialog
        open={deleting() !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete “${deleting()?.name ?? ""}”?`}
        description="Its values go from every row, and views stop using it. This can't be undone."
        confirmLabel="Delete property"
        onConfirm={() => {
          const property = deleting();
          if (property) void deleteProperty(databaseId(), property);
        }}
      />
      <Menu
        open={rowMenu() !== null}
        onOpenChange={(open) => !open && setRowMenu(null)}
        anchor={() => rowMenu()?.anchor}
        label={`${displayTitle(rowMenu()?.row.title ?? "")} actions`}
        placement="bottom-end"
      >
        {/* Keyed: an item closes the menu (clearing rowMenu) before its onSelect runs. */}
        <Show when={rowMenu()?.row} keyed>
          {(row) => (
            <>
              <MenuItem
                icon={<IconOpen size={16} />}
                onSelect={() => props.onOpenRow(row.id, false)}
              >
                Open in side peek
              </MenuItem>
              <MenuItem
                icon={<IconOpen size={16} />}
                onSelect={() => props.onOpenRow(row.id, true)}
              >
                Open as full page
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                icon={<IconTrash size={16} />}
                onSelect={() =>
                  void trashRows({
                    databaseId: databaseId(),
                    workspaceId: props.workspaceId,
                    ids: [row.id],
                    title: row.title,
                  })
                }
              >
                Delete
              </MenuItem>
            </>
          )}
        </Show>
      </Menu>
      <Show when={!props.readOnly}>
        <AddPropertyMenu
          open={adding()}
          onOpenChange={setAdding}
          anchor={() => addButton}
          databaseId={databaseId()}
          onAdded={(id) =>
            requestAnimationFrame(() => {
              const header = grid?.querySelectorAll("[data-header]");
              const index = columns().findIndex((c) => c.property.id === id);
              const button = header?.[index]?.querySelector("button");
              if (button instanceof HTMLElement) setMenu({ id, anchor: button });
            })
          }
        />
      </Show>
    </div>
  );
}

/**
 * One row of the table. `row` is undefined while its chunk loads.
 * @param {{
 *   index: number,
 *   row: Row | undefined,
 *   top: number,
 *   columns: ColumnLayout[],
 *   active: CellPos | null,
 *   editing: (CellPos & { initial?: string }) | null,
 *   readOnly: boolean,
 *   members: readonly Member[] | undefined,
 *   databaseId: string,
 *   workspaceId: string,
 *   valueOf: (row: Row, property: Property) => PropertyValue | undefined,
 *   onActivate: (col: number) => void,
 *   onEdit: (col: number) => void,
 *   onSave: (row: Row, property: Property, value: PropertyValue | null) => void,
 *   onStopEditing: (refocus?: boolean) => void,
 *   onMove: (dRow: number, dCol: number) => void,
 *   onOpenRow: (id: string, full: boolean) => void,
 *   onRowMenu: (row: Row, anchor: HTMLElement) => void,
 * }} props
 */
function TableRow(props) {
  return (
    <div
      class={props.row ? styles.row : `${styles.row} ${styles.placeholderRow}`}
      style={{ transform: `translateY(${props.top}px)` }}
      role="row"
      aria-rowindex={props.index + 2}
      aria-busy={props.row ? undefined : "true"}
      onContextMenu={(event) => {
        const row = props.row;
        if (!row || props.readOnly || !(event.target instanceof Element)) return;
        const cell = event.target.closest("[data-cell]");
        if (!(cell instanceof HTMLElement)) return;
        event.preventDefault();
        props.onRowMenu(row, cell);
      }}
    >
      <Index each={props.columns}>
        {(column, col) => (
          <Show
            when={props.row}
            fallback={
              <div class={styles.cell} style={{ width: `${column().width}px` }} role="gridcell" />
            }
          >
            {(row) => (
              <Cell
                row={row()}
                index={props.index}
                col={col}
                column={column()}
                active={props.active?.row === props.index && props.active.col === col}
                editing={
                  props.editing?.row === props.index && props.editing.col === col
                    ? props.editing
                    : null
                }
                readOnly={props.readOnly}
                members={props.members}
                databaseId={props.databaseId}
                workspaceId={props.workspaceId}
                value={props.valueOf(row(), column().property)}
                onActivate={() => props.onActivate(col)}
                onEdit={() => props.onEdit(col)}
                onSave={(value) => props.onSave(row(), column().property, value)}
                onStopEditing={props.onStopEditing}
                onMove={props.onMove}
                onOpenRow={props.onOpenRow}
                onRowMenu={props.onRowMenu}
              />
            )}
          </Show>
        )}
      </Index>
    </div>
  );
}

/**
 * @param {{
 *   row: Row,
 *   index: number,
 *   col: number,
 *   column: ColumnLayout,
 *   active: boolean,
 *   editing: { initial?: string } | null,
 *   readOnly: boolean,
 *   members: readonly Member[] | undefined,
 *   databaseId: string,
 *   workspaceId: string,
 *   value: PropertyValue | undefined,
 *   onActivate: () => void,
 *   onEdit: () => void,
 *   onSave: (value: PropertyValue | null) => void,
 *   onStopEditing: (refocus?: boolean) => void,
 *   onMove: (dRow: number, dCol: number) => void,
 *   onOpenRow: (id: string, full: boolean) => void,
 *   onRowMenu: (row: Row, anchor: HTMLElement) => void,
 * }} props
 */
function Cell(props) {
  /** @type {HTMLDivElement | undefined} */
  let el;
  const property = () => props.column.property;
  const type = () => property().type;
  const textual = () => ["title", "text", "number", "url"].includes(type());
  const popoverOpen = () => props.editing !== null && !textual();

  /** @param {boolean} open */
  const onOpenChange = (open) => {
    if (!open) props.onStopEditing(true);
  };

  return (
    <div
      ref={el}
      class={styles.cell}
      classList={{
        [styles.numberCell]: type() === "number",
        [styles.titleCell]: type() === "title",
      }}
      style={{ width: `${props.column.width}px` }}
      role="gridcell"
      tabindex={props.active ? 0 : -1}
      aria-selected={props.active || undefined}
      aria-readonly={props.readOnly || undefined}
      data-cell={`${props.index}:${props.col}`}
      data-active={props.active ? "" : undefined}
      data-editing={props.editing ? "" : undefined}
      onFocus={() => !props.active && props.onActivate()}
      onClick={(event) => {
        if (
          props.editing ||
          (event.target instanceof Element && event.target.closest("button, a, input"))
        )
          return;
        if (props.active || type() === "checkbox" || !textual()) props.onEdit();
        else props.onActivate();
      }}
      onDblClick={() => !props.editing && textual() && props.onEdit()}
    >
      <Switch>
        <Match when={props.editing && textual()}>
          <TextInput
            property={property()}
            initial={props.editing?.initial ?? editText(property(), props.value)}
            label={property().name}
            onCommit={(text, direction) => {
              const value = parseText(property(), text);
              if (value !== undefined) props.onSave(type() === "title" ? (value ?? "") : value);
              if (direction === "down") props.onMove(1, 0);
              else if (direction === "right") props.onMove(0, 1);
              else if (direction === "left") props.onMove(0, -1);
              else props.onStopEditing(false);
            }}
            onCancel={() => props.onStopEditing(true)}
          />
        </Match>
        <Match when={type() === "title"}>
          <Show when={props.row.icon}>
            <span class={styles.titleIcon} aria-hidden="true">
              <IconGlyph icon={/** @type {string} */ (props.row.icon)} />
            </span>
          </Show>
          <span class={styles.ellipsis}>{props.row.title}</span>
          <RowButtons
            row={props.row}
            readOnly={props.readOnly}
            onOpenRow={props.onOpenRow}
            onRowMenu={props.onRowMenu}
          />
        </Match>
        <Match when={type() === "checkbox"}>
          <input
            type="checkbox"
            class={styles.checkbox}
            checked={props.value === true}
            disabled={props.readOnly}
            tabindex={-1}
            aria-label={property().name}
            onClick={(event) => {
              event.preventDefault();
              props.onActivate();
              props.onEdit();
            }}
          />
        </Match>
        <Match when={true}>
          <CellValue property={property()} value={props.value} members={props.members} />
        </Match>
      </Switch>

      <Show when={popoverOpen()}>
        <Switch>
          <Match when={isOptionType(type())}>
            <OptionPicker
              open
              onOpenChange={onOpenChange}
              anchor={() => el}
              focusOnClose={() => el}
              property={property()}
              value={props.value}
              onChange={(value) => props.onSave(value)}
              onCreate={(name) => addOption(props.databaseId, property(), name)}
            />
          </Match>
          <Match when={type() === "person"}>
            <PersonPicker
              open
              onOpenChange={onOpenChange}
              anchor={() => el}
              focusOnClose={() => el}
              property={property()}
              value={props.value}
              members={props.members}
              onChange={(value) => props.onSave(value)}
            />
          </Match>
          <Match when={type() === "date"}>
            <DatePicker
              open
              onOpenChange={onOpenChange}
              anchor={() => el}
              focusOnClose={() => el}
              property={property()}
              value={props.value}
              onChange={(value) => props.onSave(value)}
            />
          </Match>
        </Switch>
      </Show>
    </div>
  );
}

/**
 * "Open" (in the side peek; with ⌘/Ctrl as a full page) and the row's menu
 * (one menu for the table, opened from here).
 * @param {{ row: Row, readOnly: boolean, onOpenRow: (id: string, full: boolean) => void, onRowMenu: (row: Row, anchor: HTMLElement) => void }} props
 */
function RowButtons(props) {
  return (
    <span class={styles.rowButtons}>
      <button
        type="button"
        class={styles.rowButton}
        tabindex={-1}
        aria-label={`Open ${displayTitle(props.row.title)}`}
        onClick={(event) => {
          event.stopPropagation();
          props.onOpenRow(props.row.id, event.metaKey || event.ctrlKey);
        }}
      >
        <IconOpen size={14} /> Open
      </button>
      <Show when={!props.readOnly}>
        <button
          type="button"
          class={styles.rowButton}
          tabindex={-1}
          aria-haspopup="menu"
          aria-label={`More actions for ${displayTitle(props.row.title)}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onRowMenu(props.row, event.currentTarget);
          }}
        >
          <IconMore size={14} />
        </button>
      </Show>
    </span>
  );
}
