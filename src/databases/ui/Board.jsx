// @ts-check

import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import {
  addProperty,
  addRow,
  moveCard,
  trashRows,
  updateRow,
  useColumnRows,
} from "../../data/databases.js";
import { displayTitle } from "../../data/pages.js";
import { cx } from "../../lib/cx.js";
import { scrollParent, startDrag } from "../../lib/dnd.js";
import Button from "../../ui/Button.jsx";
import {
  IconEye,
  IconEyeOff,
  IconMore,
  IconOpen,
  IconPlus,
  IconTrash,
} from "../../ui/icons/index.jsx";
import Menu, { MenuGroup, MenuItem, MenuSeparator } from "../../ui/Menu.jsx";
import { IconGlyph } from "../../ui/PageIcon.jsx";
import {
  boardColumns,
  cardProperties,
  columnGroup,
  columnName,
  dropCard,
  groupProperty,
  NO_VALUE,
  withHiddenGroup,
} from "../board.js";
import { rowComparator } from "../query.js";
import { isEmptyValue } from "../schema.js";
import { canGroupBy } from "../views.js";
import styles from "./Database.module.css";
import { CellValue, PropertyIcon, Tag } from "./values.jsx";

/** @typedef {import("../../api/types.js").Database} Database */
/** @typedef {import("../../api/types.js").View} View */
/** @typedef {import("../../api/types.js").Row} Row */
/** @typedef {import("../../api/types.js").Property} Property */
/** @typedef {import("../../api/types.js").Member} Member */
/** @typedef {import("../board.js").BoardColumn} BoardColumn */
/** @typedef {{ column: string, index: number }} DropTarget */

/**
 * A database view as a board: one column per option of the view's group_by
 * property (and "No <property>" first), cards in each, filtered and sorted
 * on the server one column at a time (docs/databases.md, Section 3.1).
 *
 * Cards drag between and within columns (pointer events, `lib/dnd.js`);
 * a drop changes the card's value and its place in the manual order in
 * one request. With sorts, the order isn't manual: only the column changes.
 *
 * Keyboard: arrows move between cards, Enter opens one (⌘Enter: full
 * page), ⌥ + arrows move the focused card (up and down within its column,
 * left and right to the next column).
 *
 * @param {{
 *   database: Database,
 *   view: View,
 *   workspaceId: string,
 *   readOnly: boolean,
 *   members: readonly Member[] | undefined,
 *   label: string,
 *   onOpenRow: (id: string, full: boolean) => void,
 *   onChangeView: (patch: Partial<Pick<View, "group_by" | "hidden_groups">>) => void,
 * }} props
 */
export default function Board(props) {
  const property = createMemo(() => groupProperty(props.view, props.database.properties));
  return (
    <Show
      when={property()}
      keyed
      fallback={
        <NoGroup
          database={props.database}
          readOnly={props.readOnly}
          onGroupBy={(id) => props.onChangeView({ group_by: id })}
        />
      }
    >
      {(p) => <Columns {...props} property={p} />}
    </Show>
  );
}

/**
 * A board with nothing to group by: pick a property, or add a status.
 * @param {{ database: Database, readOnly: boolean, onGroupBy: (propertyId: string) => void }} props
 */
function NoGroup(props) {
  const groupable = () => props.database.properties.filter(canGroupBy);
  return (
    <div class={cx(styles.notice, styles.boardEmpty)}>
      <Show
        when={groupable().length > 0}
        fallback={
          <>
            <p>
              A board shows rows in columns by a select or status property. This database has none
              yet.
            </p>
            <Show when={!props.readOnly}>
              <Button
                onClick={() =>
                  props.onGroupBy(
                    addProperty(props.database.id, { name: "Status", type: "status" }),
                  )
                }
              >
                <IconPlus size={16} /> Add a Status property
              </Button>
            </Show>
          </>
        }
      >
        <p>Group this board by:</p>
        <div class={styles.boardChoices}>
          <For each={groupable()}>
            {(p) => (
              <Button onClick={() => props.onGroupBy(p.id)}>
                <PropertyIcon type={p.type} /> {p.name}
              </Button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

/**
 * @param {Parameters<typeof Board>[0] & { property: Property }} props
 */
function Columns(props) {
  /** @type {HTMLDivElement | undefined} */
  let scroller;
  const [dragging, setDragging] = createSignal(/** @type {string | null} */ (null));
  const [drop, setDrop] = createSignal(/** @type {DropTarget | null} */ (null));
  const [naming, setNaming] = createSignal(/** @type {string | null} */ (null));
  const [cardMenu, setCardMenu] = createSignal(
    /** @type {{ row: Row, column: string, anchor: HTMLElement } | null} */ (null),
  );
  const [columnMenu, setColumnMenu] = createSignal(
    /** @type {{ column: BoardColumn, anchor: HTMLElement } | null} */ (null),
  );
  const [announcement, setAnnouncement] = createSignal("");

  const databaseId = () => props.database.id;
  const columns = createMemo(() => boardColumns(props.view, props.database.properties));
  const shown = () => columns().filter((c) => !c.hidden);
  const hidden = () => columns().filter((c) => c.hidden);
  const sorted = () => props.view.sorts.length > 0;
  const shownProperties = createMemo(() => cardProperties(props.view, props.database.properties));
  /** @param {string} columnId */
  const queryFor = (columnId) => ({
    filter: props.view.filter,
    sorts: props.view.sorts,
    group: columnGroup(props.property.id, columnId),
  });
  /** @param {string} columnId */
  const nameOf = (columnId) => {
    const column = columns().find((c) => c.id === columnId);
    return column ? columnName(props.property, column) : "";
  };

  /** Rows by id, as the columns have them, for drops and keyboard moves. */
  const rowsById = new Map();
  /** @param {string} id */
  const listOf = (id) =>
    /** @type {HTMLElement | null} */ (
      scroller?.querySelector(`[data-column-list="${CSS.escape(id)}"]`) ?? null
    );
  /** @param {string} id */
  const cardIds = (id) =>
    [...(listOf(id)?.querySelectorAll("[data-card]") ?? [])].map(
      (el) => /** @type {HTMLElement} */ (el).dataset.card ?? "",
    );

  /**
   * Moves a card: `index` is the gap it's dropped in among the target
   * column's cards as shown. Returns whether anything changed.
   * @param {Row} row @param {string} from @param {string} to @param {number} index
   */
  function move(row, from, to, index) {
    const ids = cardIds(to);
    const result = dropCard({ ids, cardId: row.id, from, to, index, sorted: sorted() });
    if (!result) return false;
    /** @type {Record<string, string | null> | undefined} */
    const properties =
      result.to !== undefined
        ? { [props.property.id]: result.to === NO_VALUE ? null : result.to }
        : undefined;
    if (sorted()) {
      // It goes where the sorts put it, not where it was dropped.
      const values = { ...row.properties };
      if (result.to === NO_VALUE) delete values[props.property.id];
      else if (result.to !== undefined) values[props.property.id] = result.to;
      const moved = { ...row, properties: values };
      const compare = rowComparator(props.view.sorts, props.database.properties);
      const others = ids.filter((id) => id !== row.id).flatMap((id) => rowsById.get(id) ?? []);
      const at = others.findIndex((other) => compare(moved, other) < 0);
      result.index = at < 0 ? others.length : at;
    }
    void moveCard({
      databaseId: databaseId(),
      row,
      ...(properties && { properties }),
      ...(result.after !== undefined && { after: result.after }),
      target: { query: queryFor(to), index: result.index },
    });
    const title = displayTitle(row.title);
    setAnnouncement(
      from !== to
        ? `Moved ${title} to ${nameOf(to)}`
        : `Moved ${title} to position ${result.index + 1}`,
    );
    return true;
  }

  /** @param {PointerEvent} event @param {Row} row @param {string} from */
  function startCardDrag(event, row, from) {
    if (props.readOnly) return;
    if (/** @type {HTMLElement} */ (event.target).closest("button, a, input")) return;
    const card = /** @type {HTMLElement} */ (event.currentTarget);
    startDrag(event, {
      resolve(x, y) {
        const lists = /** @type {HTMLElement[]} */ ([
          ...(scroller?.querySelectorAll("[data-column-list]") ?? []),
        ]);
        const list = lists.find((el) => {
          const rect = el.parentElement?.getBoundingClientRect() ?? el.getBoundingClientRect();
          return x >= rect.left && x <= rect.right;
        });
        if (!list) return null;
        const cards = /** @type {HTMLElement[]} */ ([...list.querySelectorAll("[data-card]")]);
        let index = cards.length;
        for (let i = 0; i < cards.length; i++) {
          const rect = cards[i].getBoundingClientRect();
          if (y < rect.top + rect.height / 2) {
            index = i;
            break;
          }
        }
        return { column: list.dataset.columnList ?? "", index };
      },
      onStart: () => setDragging(row.id),
      onMove: setDrop,
      onEnd: () => {
        setDragging(null);
        setDrop(null);
      },
      onDrop: (/** @type {DropTarget} */ target) => move(row, from, target.column, target.index),
      preview() {
        const clone = /** @type {HTMLElement} */ (card.cloneNode(true));
        clone.classList.add(styles.cardPreview);
        clone.style.width = `${card.offsetWidth}px`;
        return clone;
      },
      scrollContainer: scrollParent(scroller ?? null),
      scrollContainerX: scroller ?? null,
    });
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const card = /** @type {HTMLElement} */ (event.target).closest("[data-card]");
    if (!(card instanceof HTMLElement) || event.target !== card) return;
    const id = card.dataset.card ?? "";
    const from = card.closest("[data-column-list]")?.getAttribute("data-column-list") ?? "";
    const visible = shown().map((c) => c.id);
    const ids = cardIds(from);
    const index = ids.indexOf(id);
    const focusCard = (/** @type {string} */ cardId) =>
      /** @type {HTMLElement | null} */ (
        scroller?.querySelector(`[data-card="${CSS.escape(cardId)}"]`)
      )?.focus();
    // After a move, once the card is drawn in its new place.
    const refocus = (/** @type {string} */ cardId) =>
      requestAnimationFrame(() => focusCard(cardId));

    if (event.key === "Enter") {
      event.preventDefault();
      props.onOpenRow(id, event.metaKey || event.ctrlKey);
      return;
    }
    const vertical = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
    const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!vertical && !horizontal) return;
    event.preventDefault();
    const nextColumn = visible[visible.indexOf(from) + horizontal];

    if (event.altKey) {
      const row = rowsById.get(id);
      if (props.readOnly || !row) return;
      if (vertical) {
        if (sorted()) return setAnnouncement("The view is sorted: cards keep its order");
        // The gap above the card before it, or below the card after it.
        const gap = vertical < 0 ? index - 1 : index + 2;
        if (gap < 0 || gap > ids.length) return;
        if (move(row, from, from, gap)) refocus(id);
      } else if (nextColumn !== undefined) {
        if (move(row, from, nextColumn, Math.min(index, cardIds(nextColumn).length))) refocus(id);
      }
      return;
    }
    if (vertical) {
      const next = ids[index + vertical];
      if (next) focusCard(next);
    } else if (nextColumn !== undefined) {
      const others = cardIds(nextColumn);
      const next = others[Math.min(index, others.length - 1)];
      if (next) focusCard(next);
    }
  }

  /** @param {BoardColumn} column */
  function addCard(column) {
    const id = addRow({
      databaseId: databaseId(),
      workspaceId: props.workspaceId,
      properties: column.id === NO_VALUE ? {} : { [props.property.id]: column.id },
    });
    setNaming(id);
  }

  return (
    <div class={styles.board}>
      <div
        ref={scroller}
        class={styles.boardScroll}
        role="group"
        aria-label={props.label}
        aria-roledescription="board"
        onKeyDown={onKeyDown}
      >
        <For each={shown()}>
          {(column) => (
            <Column
              column={column}
              property={props.property}
              query={queryFor(column.id)}
              databaseId={databaseId()}
              shownProperties={shownProperties()}
              members={props.members}
              readOnly={props.readOnly}
              dragging={dragging()}
              drop={drop()?.column === column.id ? /** @type {DropTarget} */ (drop()).index : null}
              naming={naming()}
              rowsById={rowsById}
              onNamed={() => setNaming(null)}
              onAddCard={() => addCard(column)}
              onOpenRow={props.onOpenRow}
              onCardPointerDown={(event, row) => startCardDrag(event, row, column.id)}
              onCardMenu={(row, anchor) => setCardMenu({ row, column: column.id, anchor })}
              onColumnMenu={(anchor) => setColumnMenu({ column, anchor })}
            />
          )}
        </For>
        <Show when={shown().length === 0}>
          <p class={styles.boardNote}>Every group is hidden.</p>
        </Show>
        <Show when={hidden().length > 0}>
          <section class={styles.hiddenGroups} aria-label="Hidden groups">
            <h3 class={styles.columnTitle}>Hidden groups</h3>
            <For each={hidden()}>
              {(column) => (
                <button
                  type="button"
                  class={styles.menuItem}
                  aria-label={`Show ${columnName(props.property, column)}`}
                  onClick={() =>
                    props.onChangeView({
                      hidden_groups: withHiddenGroup(props.view, column.id, false),
                    })
                  }
                >
                  <ColumnLabel property={props.property} column={column} />
                  <IconEye size={16} />
                </button>
              )}
            </For>
          </section>
        </Show>
      </div>
      <div class="visually-hidden" role="status" aria-live="polite">
        {announcement()}
      </div>

      <Menu
        open={cardMenu() !== null}
        onOpenChange={(open) => !open && setCardMenu(null)}
        anchor={() => cardMenu()?.anchor}
        label={`${displayTitle(cardMenu()?.row.title ?? "")} actions`}
        placement="bottom-end"
      >
        {/* Keyed: an item closes the menu (clearing cardMenu) before its onSelect runs. */}
        <Show when={cardMenu()} keyed>
          {(menu) => (
            <>
              <MenuItem
                icon={<IconOpen size={16} />}
                onSelect={() => props.onOpenRow(menu.row.id, false)}
              >
                Open in side peek
              </MenuItem>
              <MenuItem
                icon={<IconOpen size={16} />}
                onSelect={() => props.onOpenRow(menu.row.id, true)}
              >
                Open as full page
              </MenuItem>
              <Show when={!props.readOnly}>
                <MenuSeparator />
                <MenuGroup label="Move to">
                  <For each={shown().filter((c) => c.id !== menu.column)}>
                    {(column) => (
                      <MenuItem onSelect={() => move(menu.row, menu.column, column.id, 0)}>
                        Move to {columnName(props.property, column)}
                      </MenuItem>
                    )}
                  </For>
                </MenuGroup>
                <MenuSeparator />
                <MenuItem
                  icon={<IconTrash size={16} />}
                  onSelect={() =>
                    void trashRows({
                      databaseId: databaseId(),
                      workspaceId: props.workspaceId,
                      ids: [menu.row.id],
                      title: menu.row.title,
                    })
                  }
                >
                  Delete
                </MenuItem>
              </Show>
            </>
          )}
        </Show>
      </Menu>
      <Menu
        open={columnMenu() !== null}
        onOpenChange={(open) => !open && setColumnMenu(null)}
        anchor={() => columnMenu()?.anchor}
        label="Group actions"
        placement="bottom-end"
      >
        <Show when={columnMenu()} keyed>
          {(menu) => (
            <MenuItem
              icon={<IconEyeOff size={16} />}
              onSelect={() =>
                props.onChangeView({
                  hidden_groups: withHiddenGroup(props.view, menu.column.id, true),
                })
              }
            >
              Hide group
            </MenuItem>
          )}
        </Show>
      </Menu>
    </div>
  );
}

/** A column's name: its option as a tag, or "No …". @param {{ property: Property, column: BoardColumn }} props */
function ColumnLabel(props) {
  return (
    <Show
      when={props.column.option}
      fallback={<span class={styles.columnNone}>{columnName(props.property, props.column)}</span>}
    >
      {(option) => <Tag option={option()} status={props.property.type === "status"} />}
    </Show>
  );
}

/**
 * One column: its header (name, count, menu), its cards, a "Load more"
 * when there are more than are loaded, and a "New" button.
 * @param {{
 *   column: BoardColumn,
 *   property: Property,
 *   query: import("../../data/databases.js").RowQuery,
 *   databaseId: string,
 *   shownProperties: Property[],
 *   members: readonly Member[] | undefined,
 *   readOnly: boolean,
 *   dragging: string | null,
 *   drop: number | null,
 *   naming: string | null,
 *   rowsById: Map<string, Row>,
 *   onNamed: () => void,
 *   onAddCard: () => void,
 *   onOpenRow: (id: string, full: boolean) => void,
 *   onCardPointerDown: (event: PointerEvent, row: Row) => void,
 *   onCardMenu: (row: Row, anchor: HTMLElement) => void,
 *   onColumnMenu: (anchor: HTMLElement) => void,
 * }} props
 */
function Column(props) {
  const [pages, setPages] = createSignal(1);
  const rows = useColumnRows(
    () => props.databaseId,
    () => props.query,
    pages,
  );
  const name = () => columnName(props.property, props.column);
  // Cards by id, so a row object replaced by the server's answer updates
  // its card in place (keeping focus and a title being typed).
  const ids = createMemo(() => rows.rows().map((row) => row.id), [], {
    equals: (a, b) => a.length === b.length && a.every((id, i) => id === b[i]),
  });
  const byId = createMemo(() => new Map(rows.rows().map((row) => [row.id, row])));
  createEffect(() => {
    for (const row of rows.rows()) props.rowsById.set(row.id, row);
  });
  onCleanup(() => {
    for (const row of rows.rows()) props.rowsById.delete(row.id);
  });

  return (
    <section class={styles.column} aria-label={name()}>
      <header class={styles.columnHead}>
        <ColumnLabel property={props.property} column={props.column} />
        <span class={styles.columnCount} aria-label={`${rows.total() ?? 0} cards`}>
          {rows.total() ?? ""}
        </span>
        <button
          type="button"
          class={cx(styles.iconOnly, styles.columnMenuButton)}
          aria-label={`${name()} actions`}
          aria-haspopup="menu"
          onClick={(event) => props.onColumnMenu(event.currentTarget)}
        >
          <IconMore size={16} />
        </button>
      </header>
      <div
        class={styles.cards}
        role="list"
        data-column-list={props.column.id}
        data-drop-end={props.drop !== null && props.drop >= rows.rows().length ? "" : undefined}
      >
        <For each={ids()}>
          {(id, index) => (
            <Show when={byId().get(id)}>
              {(row) => (
                <Card
                  row={row()}
                  shownProperties={props.shownProperties}
                  members={props.members}
                  readOnly={props.readOnly}
                  dragging={props.dragging === id}
                  dropBefore={props.drop === index()}
                  naming={props.naming === id}
                  databaseId={props.databaseId}
                  onNamed={props.onNamed}
                  onOpen={(full) => props.onOpenRow(id, full)}
                  onPointerDown={(event) => props.onCardPointerDown(event, row())}
                  onMenu={(anchor) => props.onCardMenu(row(), anchor)}
                />
              )}
            </Show>
          )}
        </For>
        <Show when={rows.rows().length === 0 && !rows.loading()}>
          <p class={styles.columnEmpty}>No cards</p>
        </Show>
      </div>
      <Show when={rows.error()}>
        <p class={styles.columnEmpty} role="alert">
          Couldn't load these cards.
        </p>
      </Show>
      <Show when={!rows.loading() && rows.rows().length < (rows.total() ?? 0)}>
        <button type="button" class={styles.columnButton} onClick={() => setPages((n) => n + 1)}>
          Load more ({(rows.total() ?? 0) - rows.rows().length})
        </button>
      </Show>
      <Show when={!props.readOnly}>
        <button
          type="button"
          class={styles.columnButton}
          aria-label={`New card in ${name()}`}
          onClick={() => props.onAddCard()}
        >
          <IconPlus size={16} /> New
        </button>
      </Show>
    </section>
  );
}

/**
 * A card: the row's title and the view's card properties (those with a
 * value). A new card starts with its title being typed.
 * @param {{
 *   row: Row,
 *   shownProperties: Property[],
 *   members: readonly Member[] | undefined,
 *   readOnly: boolean,
 *   dragging: boolean,
 *   dropBefore: boolean,
 *   naming: boolean,
 *   databaseId: string,
 *   onNamed: () => void,
 *   onOpen: (full: boolean) => void,
 *   onPointerDown: (event: PointerEvent) => void,
 *   onMenu: (anchor: HTMLElement) => void,
 * }} props
 */
function Card(props) {
  const values = () =>
    props.shownProperties.filter((p) => !isEmptyValue(props.row.properties[p.id]));
  return (
    <article
      class={styles.card}
      role="listitem"
      tabindex={props.naming ? -1 : 0}
      aria-label={displayTitle(props.row.title)}
      data-card={props.row.id}
      data-dragging={props.dragging ? "" : undefined}
      data-drop={props.dropBefore ? "before" : undefined}
      onPointerDown={(event) => props.onPointerDown(event)}
      onClick={(event) => {
        if (props.naming || /** @type {HTMLElement} */ (event.target).closest("button, a, input"))
          return;
        props.onOpen(event.metaKey || event.ctrlKey);
      }}
    >
      <Show
        when={props.naming}
        fallback={
          <div class={styles.cardTitle}>
            <Show when={props.row.icon}>
              <span class={styles.titleIcon}>
                <IconGlyph icon={/** @type {string} */ (props.row.icon)} />
              </span>
            </Show>
            <span class={cx(!props.row.title && styles.empty)}>
              {displayTitle(props.row.title)}
            </span>
          </div>
        }
      >
        <input
          class={styles.cardInput}
          placeholder="Type a name…"
          aria-label="Card name"
          maxLength={2000}
          ref={(el) => requestAnimationFrame(() => el.focus())}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => {
            // Removed from the page (the card went away): not a "done".
            if (!event.currentTarget.isConnected) return;
            const title = event.currentTarget.value.trim();
            if (title) void updateRow(props.databaseId, props.row.id, { title });
            props.onNamed();
          }}
        />
      </Show>
      <Show when={values().length > 0}>
        <div class={styles.cardProperties}>
          <For each={values()}>
            {(property) => (
              <div class={styles.cardProperty}>
                <Show
                  when={property.type === "checkbox"}
                  fallback={
                    <CellValue
                      property={property}
                      value={props.row.properties[property.id]}
                      members={props.members}
                    />
                  }
                >
                  <span class={styles.cardCheck}>
                    <input
                      type="checkbox"
                      class={styles.checkbox}
                      checked
                      disabled
                      aria-label={property.name}
                    />{" "}
                    {property.name}
                  </span>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
      <button
        type="button"
        class={cx(styles.rowButton, styles.cardMenu)}
        aria-label={`${displayTitle(props.row.title)} actions`}
        aria-haspopup="menu"
        onClick={(event) => props.onMenu(event.currentTarget)}
      >
        <IconMore size={16} />
      </button>
    </article>
  );
}
