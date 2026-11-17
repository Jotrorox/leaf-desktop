// @ts-check
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js";
import { ApiError } from "../../api/client.js";
import { canEdit } from "../../api/roles.js";
import {
  addRow,
  createView,
  defaultCardProperties,
  deleteView,
  rememberedView,
  rememberView,
  updateView,
  useDatabase,
  useMembers,
} from "../../data/databases.js";
import { displayTitle, renamePage, setTitleDraft } from "../../data/pages.js";
import { cx } from "../../lib/cx.js";
import { location, navigate } from "../../lib/router/index.js";
import Button from "../../ui/Button.jsx";
import ConfirmDialog from "../../ui/ConfirmDialog.jsx";
import {
  IconBoard,
  IconEye,
  IconEyeOff,
  IconFilter,
  IconOpen,
  IconPlus,
  IconSort,
  IconTable,
} from "../../ui/icons/index.jsx";
import Menu, { MenuGroup, MenuItem, MenuSeparator } from "../../ui/Menu.jsx";
import Popover, { createToggleHandlers } from "../../ui/Popover.jsx";
import { boardColumns, groupProperty, NO_VALUE, withCardProperty } from "../board.js";
import { describeFilter } from "../format.js";
import { groupItems, groupOp, makeGroup } from "../query.js";
import { TITLE_ID } from "../schema.js";
import {
  canGroupBy,
  defaultGroupBy,
  layoutColumns,
  MAX_VIEW_NAME,
  pageSizeChoices,
  pageSizeOf,
  withColumn,
} from "../views.js";
import Board from "./Board.jsx";
import styles from "./Database.module.css";
import FilterBuilder, { newCondition, SortBuilder } from "./FilterBuilder.jsx";
import Table from "./Table.jsx";
import { PropertyIcon } from "./values.jsx";

/** @typedef {import("../../api/types.js").Page} Page */
/** @typedef {import("../../api/types.js").View} View */
/** @typedef {import("../../api/types.js").Database} Database */
/** @typedef {import("../../api/databases.js").ViewPatch} ViewPatch */

/** A view type's icon. @param {{ type: View["type"], size?: number }} props */
function ViewIcon(props) {
  return (
    <Show when={props.type === "board"} fallback={<IconTable size={props.size ?? 16} />}>
      <IconBoard size={props.size ?? 16} />
    </Show>
  );
}

/**
 * A database: its views as tabs, filter and sort controls with chips for
 * what's applied, and the active view as a table or a board. Full page (`inline`
 * false) under the page header, or inline in a page (the editor's database
 * block) with its own title.
 *
 * Viewers can still filter and sort: their changes stay on their screen
 * (the query runs on the server either way) instead of being saved.
 *
 * @param {{ page: Page, inline?: boolean }} props `page`: the database's page.
 */
export default function DatabaseView(props) {
  const query = useDatabase(() => props.page.id);
  return (
    <Switch>
      <Match when={query.data()}>
        {(db) => <Loaded page={props.page} database={db()} inline={props.inline} />}
      </Match>
      <Match when={query.error()}>
        {(error) => (
          <div class={cx(styles.database, styles.notice)} role="alert">
            <p>
              {error() instanceof ApiError && /** @type {ApiError} */ (error()).status === 0
                ? "Can't reach the server to load this database."
                : "Couldn't load this database."}
            </p>
            <Button onClick={() => void query.refetch()}>Retry</Button>
          </div>
        )}
      </Match>
      <Match when={true}>
        <div
          class={cx(styles.database, styles.notice)}
          role="status"
          aria-label="Loading database"
        />
      </Match>
    </Switch>
  );
}

/** @param {{ page: Page, database: Database, inline?: boolean }} props */
function Loaded(props) {
  const members = useMembers(() => props.page.workspace_id);
  const readOnly = () => !canEdit(props.page.role) || props.page.archived_at !== null;
  const [viewId, setViewId] = createSignal(rememberedView(props.page.id));
  const [local, setLocal] = createSignal(/** @type {Record<string, Partial<View>>} */ ({}));
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [sortOpen, setSortOpen] = createSignal(false);
  const [propsOpen, setPropsOpen] = createSignal(false);
  /** @type {HTMLButtonElement | undefined} */
  let filterButton;
  /** @type {HTMLButtonElement | undefined} */
  let sortButton;
  /** @type {HTMLButtonElement | undefined} */
  let propsButton;
  /** Where the filter builder opens from: its button or a chip. */
  let filterAnchor = /** @type {HTMLElement | undefined} */ (undefined);
  let sortAnchor = /** @type {HTMLElement | undefined} */ (undefined);

  /** The active view, with a viewer's own unsaved filter and sorts on top. */
  const view = createMemo(() => {
    const views = props.database.views;
    const found = views.find((v) => v.id === viewId()) ?? views[0];
    return found ? { ...found, ...local()[found.id] } : undefined;
  });
  createEffect(
    on(
      () => view()?.id,
      (id) => id && rememberView(props.page.id, id),
    ),
  );

  /** Saves a change to the view, or keeps it on screen only for viewers. @param {ViewPatch} patch */
  function changeView(patch) {
    const v = view();
    if (!v) return;
    if (readOnly()) setLocal((all) => ({ ...all, [v.id]: { ...all[v.id], ...patch } }));
    else void updateView(props.database.id, v.id, patch);
  }

  /** Adds a rule on a property and opens the filter builder. @param {string} propertyId */
  function addFilter(propertyId) {
    const v = view();
    const property = props.database.properties.find((p) => p.id === propertyId);
    if (!v || !property) return;
    const filter = v.filter ?? { and: [] };
    changeView({
      filter: makeGroup(groupOp(filter), [...groupItems(filter), newCondition(property)]),
    });
    filterAnchor = filterButton;
    setFilterOpen(true);
  }

  /** @param {string} id @param {boolean} full */
  function openRow(id, full) {
    if (full) navigate(`/p/${encodeURIComponent(id)}`);
    else navigate(`${location().pathname}?peek=${encodeURIComponent(id)}`, { scroll: false });
  }

  function newRowInPeek() {
    // On a board, the new row goes in the first column shown.
    const v = view();
    const property = v?.type === "board" ? groupProperty(v, props.database.properties) : undefined;
    const first =
      v && property ? boardColumns(v, props.database.properties).find((c) => !c.hidden) : undefined;
    const properties =
      property && first && first.id !== NO_VALUE ? { [property.id]: first.id } : {};
    const id = addRow({
      databaseId: props.database.id,
      workspaceId: props.page.workspace_id,
      properties,
    });
    openRow(id, false);
  }

  /** Changes the view's layout; a new board groups by the first status or select. @param {View["type"]} type */
  function setLayout(type) {
    const v = view();
    if (!v || v.type === type) return;
    /** @type {ViewPatch} */
    const patch = { type };
    if (type === "board" && !groupProperty(v, props.database.properties)) {
      const groupBy = defaultGroupBy(props.database.properties);
      patch.group_by = groupBy;
      patch.hidden_groups = [];
      if (v.card_properties.length === 0)
        patch.card_properties = defaultCardProperties(props.database.properties, groupBy);
    }
    changeView(patch);
  }

  const filterCount = () =>
    view()?.filter
      ? groupItems(/** @type {NonNullable<View["filter"]>} */ (view()?.filter)).length
      : 0;
  const hiddenCount = () =>
    view()?.type === "table"
      ? layoutColumns(/** @type {View} */ (view()), props.database.properties).filter(
          (c) => c.hidden,
        ).length
      : 0;
  const filterToggle = createToggleHandlers(filterOpen, (open) => {
    filterAnchor = filterButton;
    setFilterOpen(open);
  });
  const sortToggle = createToggleHandlers(sortOpen, (open) => {
    sortAnchor = sortButton;
    setSortOpen(open);
  });
  const propsToggle = createToggleHandlers(propsOpen, setPropsOpen);

  return (
    <section
      class={cx(styles.database, styles.wide, props.inline && styles.inline)}
      aria-label={displayTitle(props.page.title)}
    >
      <Show when={props.inline}>
        <InlineTitle page={props.page} readOnly={readOnly()} />
      </Show>
      <div class={styles.bar}>
        <ViewTabs
          database={props.database}
          activeId={view()?.id}
          readOnly={readOnly()}
          onSelect={setViewId}
          onLayout={setLayout}
        />
        <div class={styles.actions}>
          <button
            ref={filterButton}
            type="button"
            class={cx(styles.action, filterCount() > 0 && styles.actionActive)}
            aria-haspopup="dialog"
            aria-expanded={filterOpen()}
            {...filterToggle}
          >
            <IconFilter size={16} /> Filter
          </button>
          <button
            ref={sortButton}
            type="button"
            class={cx(styles.action, (view()?.sorts.length ?? 0) > 0 && styles.actionActive)}
            aria-haspopup="dialog"
            aria-expanded={sortOpen()}
            {...sortToggle}
          >
            <IconSort size={16} /> Sort
          </button>
          <Show when={!readOnly()}>
            <button
              ref={propsButton}
              type="button"
              class={styles.action}
              aria-haspopup="dialog"
              aria-expanded={propsOpen()}
              aria-label={hiddenCount() ? `Properties, ${hiddenCount()} hidden` : "Properties"}
              {...propsToggle}
            >
              <Show when={hiddenCount()} fallback={<IconEye size={16} />}>
                <IconEyeOff size={16} />
              </Show>
            </button>
            <Button variant="primary" class={styles.newButton} onClick={newRowInPeek}>
              New
            </Button>
          </Show>
        </div>
      </div>

      <Show when={view()} fallback={<p class={styles.notice}>This database has no views.</p>}>
        {(v) => (
          <>
            <Show when={filterCount() > 0 || v().sorts.length > 0}>
              <div class={styles.chips} role="group" aria-label="Filters and sorts">
                <Show when={v().sorts.length > 0}>
                  <button
                    type="button"
                    class={styles.chip}
                    onClick={(event) => {
                      sortAnchor = event.currentTarget;
                      setSortOpen(true);
                    }}
                  >
                    <IconSort size={14} />
                    <span class={styles.chipText}>
                      {v().sorts.length === 1
                        ? `Sorted by ${props.database.properties.find((p) => p.id === v().sorts[0].property_id)?.name ?? "?"}`
                        : `${v().sorts.length} sorts`}
                    </span>
                  </button>
                </Show>
                <For
                  each={
                    v().filter
                      ? groupItems(/** @type {NonNullable<View["filter"]>} */ (v().filter))
                      : []
                  }
                >
                  {(item, index) => (
                    <button
                      type="button"
                      class={styles.chip}
                      onClick={(event) => {
                        filterAnchor = event.currentTarget;
                        setFilterOpen(true);
                      }}
                    >
                      <Show
                        when={index() === 0}
                        fallback={
                          <span>
                            {groupOp(/** @type {NonNullable<View["filter"]>} */ (v().filter)) ===
                            "or"
                              ? "or"
                              : "and"}
                          </span>
                        }
                      >
                        <IconFilter size={14} />
                      </Show>
                      <span class={styles.chipText}>
                        {describeFilter(item, props.database.properties, members.data())}
                      </span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <Show
              when={v().type === "board"}
              fallback={
                <Table
                  database={props.database}
                  view={v()}
                  workspaceId={props.page.workspace_id}
                  readOnly={readOnly()}
                  members={members.data()}
                  label={`${displayTitle(props.page.title)}: ${v().name || "Untitled view"}`}
                  onOpenRow={openRow}
                  onAddFilter={addFilter}
                  onChangeView={changeView}
                />
              }
            >
              <Board
                database={props.database}
                view={v()}
                workspaceId={props.page.workspace_id}
                readOnly={readOnly()}
                members={members.data()}
                label={`${displayTitle(props.page.title)}: ${v().name || "Untitled view"}`}
                onOpenRow={openRow}
                onChangeView={changeView}
              />
            </Show>

            <FilterBuilder
              open={filterOpen()}
              onOpenChange={setFilterOpen}
              anchor={() => (filterAnchor?.isConnected ? filterAnchor : filterButton)}
              schema={props.database.properties}
              members={members.data()}
              filter={v().filter}
              onChange={(filter) => changeView({ filter })}
            />
            <SortBuilder
              open={sortOpen()}
              onOpenChange={setSortOpen}
              anchor={() => (sortAnchor?.isConnected ? sortAnchor : sortButton)}
              schema={props.database.properties}
              sorts={v().sorts}
              onChange={(sorts) => changeView({ sorts })}
            />
            <Show when={!readOnly()}>
              <Popover
                open={propsOpen()}
                onOpenChange={setPropsOpen}
                anchor={() => propsButton}
                placement="bottom-end"
                class={styles.panel}
                role="dialog"
                aria-label="View settings"
              >
                <Show when={v().type === "board"}>
                  <BoardSettings database={props.database} view={v()} onChange={changeView} />
                </Show>
                <Show when={v().type === "table"}>
                  <label class={styles.panelTitle} for={`page-size-${v().id}`}>
                    Rows per page
                  </label>
                  <select
                    id={`page-size-${v().id}`}
                    class={cx(styles.field, styles.groupField)}
                    value={pageSizeOf(v())}
                    onChange={(event) =>
                      changeView({ page_size: Number(event.currentTarget.value) })
                    }
                  >
                    <For each={pageSizeChoices(pageSizeOf(v()))}>
                      {(size) => <option value={size}>{size}</option>}
                    </For>
                  </select>
                  <div class={styles.panelTitle}>Properties in this view</div>
                  <For each={layoutColumns(v(), props.database.properties)}>
                    {(column) => (
                      <button
                        type="button"
                        class={styles.menuItem}
                        aria-pressed={!column.hidden}
                        onClick={() =>
                          changeView({
                            columns: withColumn(
                              v(),
                              props.database.properties,
                              column.property.id,
                              { hidden: !column.hidden },
                            ),
                          })
                        }
                      >
                        <PropertyIcon type={column.property.type} />
                        <span class={styles.ellipsis} style={{ flex: "1" }}>
                          {column.property.name}
                        </span>
                        <Show when={column.hidden} fallback={<IconEye size={16} />}>
                          <IconEyeOff size={16} />
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
              </Popover>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/**
 * An inline database's title (its page's), editable in place, and a way to
 * open it as a full page.
 * @param {{ page: Page, readOnly: boolean }} props
 */
function InlineTitle(props) {
  const [value, setValue] = createSignal(props.page.title);
  let editing = false;
  createEffect(
    on(
      () => props.page.title,
      (title) => !editing && setValue(title),
    ),
  );
  return (
    <div class={styles.inlineHead} data-handle-line>
      <IconTable size={18} class={styles.inlineIcon} />
      <input
        class={styles.inlineTitle}
        value={value()}
        placeholder="Untitled"
        aria-label="Database title"
        readOnly={props.readOnly}
        maxLength={2000}
        onFocus={() => (editing = true)}
        onInput={(event) => {
          setValue(event.currentTarget.value);
          setTitleDraft(props.page.workspace_id, props.page.id, event.currentTarget.value);
        }}
        onBlur={() => {
          editing = false;
          if (value() !== props.page.title)
            void renamePage(props.page.workspace_id, props.page.id, value());
        }}
        onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
      />
      <Button
        variant="ghost"
        class={styles.openFull}
        onClick={() => navigate(`/p/${encodeURIComponent(props.page.id)}`)}
      >
        <IconOpen size={16} /> Open
      </Button>
    </div>
  );
}

/**
 * The view tabs. Clicking the active tab opens its menu (rename, layout,
 * duplicate, delete); "+" adds a table or a board.
 * @param {{
 *   database: Database,
 *   activeId: string | undefined,
 *   readOnly: boolean,
 *   onSelect: (id: string) => void,
 *   onLayout: (type: View["type"]) => void,
 * }} props
 */
function ViewTabs(props) {
  const [renaming, setRenaming] = createSignal(/** @type {string | null} */ (null));
  /** @type {HTMLButtonElement | undefined} */
  let addButton;
  const [adding, setAdding] = createSignal(false);
  /** @param {View["type"]} type */
  const addView = (type) => {
    const label = type === "board" ? "Board" : "Table";
    const n = props.database.views.filter((v) => v.type === type).length;
    props.onSelect(createView(props.database.id, { name: n ? `${label} ${n + 1}` : label, type }));
  };
  const [menuFor, setMenuFor] = createSignal(
    /** @type {{ id: string, anchor: HTMLElement } | null} */ (null),
  );
  const [confirming, setConfirming] = createSignal(/** @type {View | null} */ (null));
  const viewOf = (/** @type {string} */ id) => props.database.views.find((v) => v.id === id);

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const ids = props.database.views.map((v) => v.id);
    const index = ids.indexOf(props.activeId ?? "");
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step || index < 0) return;
    event.preventDefault();
    const next = ids[(index + step + ids.length) % ids.length];
    props.onSelect(next);
    queueMicrotask(() =>
      /** @type {HTMLElement | null} */ (
        document.querySelector(`[data-view-tab="${CSS.escape(next)}"]`)
      )?.focus(),
    );
  }

  return (
    <div class={styles.tabs} role="tablist" aria-label="Views" onKeyDown={onKeyDown}>
      <For each={props.database.views}>
        {(v) => (
          <Show
            when={renaming() !== v.id}
            fallback={
              <input
                class={styles.tabInput}
                value={v.name}
                maxLength={MAX_VIEW_NAME}
                aria-label="View name"
                ref={(el) => queueMicrotask(() => el.select())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    event.currentTarget.value = v.name;
                    event.currentTarget.blur();
                  }
                }}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  setRenaming(null);
                  if (name && name !== v.name) void updateView(props.database.id, v.id, { name });
                }}
              />
            }
          >
            <button
              type="button"
              class={styles.tab}
              role="tab"
              aria-selected={v.id === props.activeId}
              tabindex={v.id === props.activeId ? 0 : -1}
              data-view-tab={v.id}
              onClick={(event) => {
                if (v.id === props.activeId && !props.readOnly)
                  setMenuFor({ id: v.id, anchor: event.currentTarget });
                else props.onSelect(v.id);
              }}
              onDblClick={() => !props.readOnly && setRenaming(v.id)}
            >
              <ViewIcon type={v.type} />
              {v.name || "Untitled view"}
            </button>
          </Show>
        )}
      </For>
      <Show when={!props.readOnly}>
        <button
          ref={addButton}
          type="button"
          class={styles.action}
          aria-label="Add a view"
          aria-haspopup="menu"
          aria-expanded={adding()}
          onClick={() => setAdding(true)}
        >
          <IconPlus size={16} />
        </button>
        <Menu
          open={adding()}
          onOpenChange={setAdding}
          anchor={() => addButton}
          label="Add a view"
          placement="bottom-start"
        >
          <MenuItem icon={<IconTable size={16} />} onSelect={() => addView("table")}>
            Table
          </MenuItem>
          <MenuItem icon={<IconBoard size={16} />} onSelect={() => addView("board")}>
            Board
          </MenuItem>
        </Menu>
      </Show>
      <Menu
        open={menuFor() !== null}
        onOpenChange={(open) => !open && setMenuFor(null)}
        anchor={() => menuFor()?.anchor}
        label="View actions"
        placement="bottom-start"
      >
        {/* Keyed: an item closes the menu (clearing menuFor) before its onSelect runs. */}
        <Show when={viewOf(menuFor()?.id ?? "")} keyed>
          {(v) => (
            <>
              <MenuItem onSelect={() => setRenaming(v.id)}>Rename</MenuItem>
              <MenuSeparator />
              <MenuGroup label="Layout">
                <MenuItem
                  icon={<IconTable size={16} />}
                  checked={v.type === "table"}
                  onSelect={() => props.onLayout("table")}
                >
                  Table
                </MenuItem>
                <MenuItem
                  icon={<IconBoard size={16} />}
                  checked={v.type === "board"}
                  onSelect={() => props.onLayout("board")}
                >
                  Board
                </MenuItem>
              </MenuGroup>
              <MenuSeparator />
              <MenuItem
                onSelect={() =>
                  props.onSelect(
                    createView(props.database.id, {
                      name: `${v.name || "Untitled view"} (copy)`,
                      from: v,
                    }),
                  )
                }
              >
                Duplicate
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                disabled={props.database.views.length <= 1}
                onSelect={() => setConfirming(v)}
              >
                Delete view
              </MenuItem>
            </>
          )}
        </Show>
      </Menu>
      <ConfirmDialog
        open={confirming() !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Delete the view “${confirming()?.name || "Untitled view"}”?`}
        description="Its filters, sorts and layout settings go with it. The rows stay."
        confirmLabel="Delete view"
        onConfirm={() => {
          const v = confirming();
          if (!v) return;
          const other = props.database.views.find((x) => x.id !== v.id);
          if (other) props.onSelect(other.id);
          void deleteView(props.database.id, v.id);
        }}
      />
    </div>
  );
}

/**
 * A board's settings in the properties panel: what it groups by, and which
 * properties its cards show.
 * @param {{ database: Database, view: View, onChange: (patch: ViewPatch) => void }} props
 */
function BoardSettings(props) {
  const groupable = () => props.database.properties.filter(canGroupBy);
  const property = () => groupProperty(props.view, props.database.properties);
  return (
    <>
      <label class={styles.panelTitle} for="board-group-by">
        Group by
      </label>
      <select
        id="board-group-by"
        class={cx(styles.field, styles.groupField)}
        value={property()?.id ?? ""}
        onChange={(event) => props.onChange({ group_by: event.currentTarget.value || null })}
      >
        <Show when={!property()}>
          <option value="">None</option>
        </Show>
        <For each={groupable()}>{(p) => <option value={p.id}>{p.name}</option>}</For>
      </select>
      <div class={styles.panelTitle}>Properties on cards</div>
      <For each={props.database.properties.filter((p) => p.id !== TITLE_ID)}>
        {(p) => {
          const on = () => props.view.card_properties.includes(p.id);
          return (
            <button
              type="button"
              class={styles.menuItem}
              aria-pressed={on()}
              onClick={() =>
                props.onChange({ card_properties: withCardProperty(props.view, p.id, !on()) })
              }
            >
              <PropertyIcon type={p.type} />
              <span class={styles.ellipsis} style={{ flex: "1" }}>
                {p.name}
              </span>
              <Show when={on()} fallback={<IconEyeOff size={16} />}>
                <IconEye size={16} />
              </Show>
            </button>
          );
        }}
      </For>
    </>
  );
}
