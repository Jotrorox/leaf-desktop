// @ts-check
import { For, Show } from "solid-js";
import {
  addProperty,
  changePropertyType,
  renameProperty,
  setOptions,
} from "../../data/databases.js";
import {
  IconArrowDown,
  IconArrowUp,
  IconClose,
  IconEyeOff,
  IconFilter,
  IconTrash,
} from "../../ui/icons/index.jsx";
import Popover from "../../ui/Popover.jsx";
import {
  isOptionType,
  MAX_PROPERTY_NAME,
  newShortId,
  nthColor,
  OPTION_COLORS,
  PROPERTY_TYPES,
  STATUS_GROUPS,
  typeLabel,
} from "../schema.js";
import styles from "./Database.module.css";
import { PropertyIcon } from "./values.jsx";

/** @typedef {import("../../api/types.js").Property} Property */
/** @typedef {import("../../api/types.js").SelectOption} SelectOption */

/**
 * A column's menu: its name, type and options, and what the view does with
 * it (sort, filter, hide). Viewers only get the view actions that don't
 * write (none), so they see the name and type read-only.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   databaseId: string,
 *   property: Property,
 *   readOnly: boolean,
 *   onSort: (direction: "ascending" | "descending") => void,
 *   onFilter: () => void,
 *   onHide: () => void,
 *   onDelete: () => void,
 * }} props `onDelete`: asks first (the menu closes).
 */
export default function PropertyMenu(props) {
  const isTitle = () => props.property.type === "title";

  /** @param {string} name */
  const rename = (name) => {
    const next = name.trim();
    if (next && next !== props.property.name)
      void renameProperty(props.databaseId, props.property.id, next);
  };

  /** @param {(options: SelectOption[]) => SelectOption[]} change */
  const changeOptions = (change) =>
    void setOptions(props.databaseId, props.property, change(props.property.options ?? []));

  /** Runs an action, then closes (closing unmounts this menu). @param {() => void} action */
  const thenClose = (action) => () => {
    action();
    props.onOpenChange(false);
  };

  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      placement="bottom-start"
      class={styles.panel}
      role="dialog"
      aria-label={`Property ${props.property.name}`}
    >
      <input
        class={styles.field}
        value={props.property.name}
        maxLength={MAX_PROPERTY_NAME}
        aria-label="Property name"
        readOnly={props.readOnly}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            rename(event.currentTarget.value);
            props.onOpenChange(false);
          }
        }}
        onBlur={(event) => rename(event.currentTarget.value)}
      />
      <div style={{ height: "var(--space-2)" }} />
      <label class={styles.panelTitle} style={{ display: "block" }}>
        Type
        <select
          class={styles.field}
          style={{ "margin-top": "var(--space-1)" }}
          value={props.property.type}
          disabled={props.readOnly || isTitle()}
          onChange={(event) =>
            void changePropertyType(
              props.databaseId,
              props.property,
              /** @type {Property["type"]} */ (event.currentTarget.value),
            )
          }
        >
          <Show when={isTitle()}>
            <option value="title">Title</option>
          </Show>
          <For each={PROPERTY_TYPES}>{(t) => <option value={t.type}>{t.label}</option>}</For>
        </select>
      </label>

      <Show when={isOptionType(props.property.type) && !props.readOnly}>
        <div class={styles.panelTitle} style={{ "margin-top": "var(--space-3)" }}>
          Options
        </div>
        <For each={props.property.options ?? []}>
          {(option) => (
            <div class={styles.optionRow}>
              <input
                class={`${styles.field} ${styles.optionName}`}
                value={option.name}
                aria-label="Option name"
                maxLength={200}
                onKeyDown={(event) => event.key === "Enter" && event.currentTarget.blur()}
                onBlur={(event) => {
                  const name = event.currentTarget.value.trim();
                  if (name && name !== option.name)
                    changeOptions((list) =>
                      list.map((o) => (o.id === option.id ? { ...o, name } : o)),
                    );
                  else event.currentTarget.value = option.name;
                }}
              />
              <select
                class={`${styles.field} ${styles.colorSelect}`}
                value={option.color}
                aria-label={`Color of ${option.name}`}
                onChange={(event) => {
                  const color = event.currentTarget.value;
                  changeOptions((list) =>
                    list.map((o) => (o.id === option.id ? { ...o, color } : o)),
                  );
                }}
              >
                <For each={OPTION_COLORS}>
                  {(color) => (
                    <option value={color}>{color[0].toUpperCase() + color.slice(1)}</option>
                  )}
                </For>
              </select>
              <Show when={props.property.type === "status"}>
                <select
                  class={`${styles.field} ${styles.colorSelect}`}
                  value={option.group ?? "to_do"}
                  aria-label={`Group of ${option.name}`}
                  onChange={(event) => {
                    const group = /** @type {SelectOption["group"]} */ (event.currentTarget.value);
                    changeOptions((list) =>
                      list.map((o) => (o.id === option.id ? { ...o, group } : o)),
                    );
                  }}
                >
                  <For each={STATUS_GROUPS}>{(g) => <option value={g.id}>{g.label}</option>}</For>
                </select>
              </Show>
              <button
                type="button"
                class={styles.iconOnly}
                aria-label={`Delete option ${option.name}`}
                onClick={() => changeOptions((list) => list.filter((o) => o.id !== option.id))}
              >
                <IconClose size={16} />
              </button>
            </div>
          )}
        </For>
        <input
          class={styles.field}
          style={{ "margin-top": "var(--space-1)" }}
          placeholder="Add an option…"
          aria-label="New option"
          maxLength={200}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const name = event.currentTarget.value.trim();
            if (!name) return;
            event.currentTarget.value = "";
            changeOptions((list) => {
              /** @type {SelectOption} */
              const option = { id: newShortId(), name, color: nthColor(list.length) };
              if (props.property.type === "status") option.group = "to_do";
              return [...list, option];
            });
          }}
        />
      </Show>

      <div class={styles.separator} style={{ "margin-top": "var(--space-2)" }} />
      <button
        type="button"
        class={styles.menuItem}
        onClick={thenClose(() => props.onSort("ascending"))}
      >
        <IconArrowUp size={16} /> Sort ascending
      </button>
      <button
        type="button"
        class={styles.menuItem}
        onClick={thenClose(() => props.onSort("descending"))}
      >
        <IconArrowDown size={16} /> Sort descending
      </button>
      <button type="button" class={styles.menuItem} onClick={thenClose(props.onFilter)}>
        <IconFilter size={16} /> Filter
      </button>
      <Show when={!props.readOnly}>
        <button type="button" class={styles.menuItem} onClick={thenClose(props.onHide)}>
          <IconEyeOff size={16} /> Hide in view
        </button>
        <Show when={!isTitle()}>
          <button
            type="button"
            class={styles.menuItem}
            data-danger
            onClick={thenClose(props.onDelete)}
          >
            <IconTrash size={16} /> Delete property
          </button>
        </Show>
      </Show>
    </Popover>
  );
}

/**
 * "+" at the end of the header: pick a type, get a new column.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   databaseId: string,
 *   onAdded: (id: string) => void,
 * }} props
 */
export function AddPropertyMenu(props) {
  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      placement="bottom-end"
      class={styles.panel}
      role="dialog"
      aria-label="Add a property"
    >
      <div class={styles.panelTitle}>Add a property</div>
      <For each={PROPERTY_TYPES}>
        {(t) => (
          <button
            type="button"
            class={styles.menuItem}
            onClick={() => {
              props.onOpenChange(false);
              props.onAdded(
                addProperty(props.databaseId, { name: typeLabel(t.type), type: t.type }),
              );
            }}
          >
            <PropertyIcon type={t.type} /> {t.label}
          </button>
        )}
      </For>
    </Popover>
  );
}
