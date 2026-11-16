// @ts-check
import {
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  on,
  onMount,
  Show,
} from "solid-js";
import Button from "../../ui/Button.jsx";
import { IconCheck } from "../../ui/icons/index.jsx";
import Popover from "../../ui/Popover.jsx";
import { memberName, today } from "../format.js";
import { findOption, MAX_TEXT_VALUE, STATUS_GROUPS } from "../schema.js";
import styles from "./Database.module.css";
import { Person, Tag } from "./values.jsx";

/** @typedef {import("../../api/types.js").Property} Property */
/** @typedef {import("../../api/types.js").PropertyValue} PropertyValue */
/** @typedef {import("../../api/types.js").Member} Member */
/** @typedef {import("../../api/types.js").SelectOption} SelectOption */
/** @typedef {import("solid-js").JSX.Element} JSXElement */

/**
 * @typedef {object} PickerItem
 * @property {string} id
 * @property {string} text What typing filters on.
 * @property {() => JSXElement} render
 * @property {string} [group] A heading it goes under.
 */

/**
 * A searchable list in a popover (combobox pattern: the field keeps focus,
 * ↑/↓ move the highlight, Enter picks). Picked items show at the top.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   label: string,
 *   items: PickerItem[],
 *   selected: string[],
 *   renderSelected: (id: string, remove: () => void) => JSXElement,
 *   multi: boolean,
 *   onToggle: (id: string) => void,
 *   onClear: () => void,
 *   onCreate?: (text: string) => void,
 *   placeholder: string,
 *   groups?: readonly { id: string, label: string }[],
 * }} props
 */
function ListPicker(props) {
  const id = createUniqueId();
  const [query, setQuery] = createSignal("");
  const [highlight, setHighlight] = createSignal(0);
  /** @type {HTMLInputElement | undefined} */
  let input;

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) {
          setQuery("");
          setHighlight(0);
        }
      },
    ),
  );

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    return q ? props.items.filter((item) => item.text.toLowerCase().includes(q)) : props.items;
  });
  const canCreate = () => {
    const q = query().trim();
    return (
      Boolean(props.onCreate) &&
      q !== "" &&
      !props.items.some((item) => item.text.toLowerCase() === q.toLowerCase())
    );
  };
  const grouped = createMemo(() => {
    const items = filtered();
    if (!props.groups) return [{ id: "", label: "", items }];
    return props.groups
      .map((g) => ({ ...g, items: items.filter((item) => item.group === g.id) }))
      .filter((g) => g.items.length > 0);
  });
  /** Everything ↑/↓ moves through, in the order shown: the items, then "Create". */
  const choices = createMemo(() => [
    ...grouped().flatMap((g) => g.items.map((item) => item.id)),
    ...(canCreate() ? ["\u0000create"] : []),
  ]);

  /** @param {string} choice */
  function pick(choice) {
    if (choice === "\u0000create") {
      props.onCreate?.(query().trim());
      setQuery("");
    } else {
      props.onToggle(choice);
    }
    if (!props.multi) props.onOpenChange(false);
    else input?.focus();
  }

  /** @param {KeyboardEvent} event */
  function onKeyDown(event) {
    const n = choices().length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (n) setHighlight((i) => (i + (event.key === "ArrowDown" ? 1 : -1) + n) % n);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const choice = choices()[Math.min(highlight(), n - 1)];
      if (choice !== undefined) pick(choice);
    } else if (event.key === "Backspace" && query() === "" && props.selected.length) {
      event.preventDefault();
      if (props.multi) props.onToggle(/** @type {string} */ (props.selected.at(-1)));
      else props.onClear();
    }
  }

  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      focusOnClose={props.focusOnClose}
      initialFocus={() => input}
      placement="bottom-start"
      class={styles.picker}
      role="dialog"
      aria-label={props.label}
    >
      <div class={styles.pickerHead}>
        <For each={props.selected}>
          {(item) => props.renderSelected(item, () => props.onToggle(item))}
        </For>
        <input
          ref={input}
          class={styles.pickerInput}
          placeholder={props.placeholder}
          value={query()}
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={
            choices().length ? `${id}-${Math.min(highlight(), choices().length - 1)}` : undefined
          }
          aria-label={props.label}
          onInput={(event) => {
            setQuery(event.currentTarget.value);
            setHighlight(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <div
        class={styles.pickerList}
        id={`${id}-list`}
        role="listbox"
        aria-multiselectable={props.multi}
        aria-label={props.label}
      >
        <For each={grouped()}>
          {(group) => (
            <>
              <Show when={group.label}>
                <div class={styles.pickerGroup} role="presentation">
                  {group.label}
                </div>
              </Show>
              <For each={group.items}>
                {(item) => {
                  const index = () => choices().indexOf(item.id);
                  return (
                    <div
                      id={`${id}-${index()}`}
                      class={styles.pickerItem}
                      role="option"
                      aria-selected={props.selected.includes(item.id)}
                      data-highlighted={index() === highlight() ? "" : undefined}
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseMove={() => setHighlight(index())}
                      onClick={() => pick(item.id)}
                    >
                      {item.render()}
                      <Show when={props.selected.includes(item.id)}>
                        <span class={styles.pickerCheck}>
                          <IconCheck size={16} />
                        </span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </>
          )}
        </For>
        <Show when={canCreate()}>
          <div
            id={`${id}-${choices().length - 1}`}
            class={styles.pickerItem}
            role="option"
            aria-selected="false"
            data-highlighted={highlight() === choices().length - 1 ? "" : undefined}
            onMouseDown={(event) => event.preventDefault()}
            onMouseMove={() => setHighlight(choices().length - 1)}
            onClick={() => pick("\u0000create")}
          >
            Create <Tag option={{ id: "", name: query().trim(), color: "default" }} />
          </div>
        </Show>
        <Show when={choices().length === 0}>
          <div class={styles.pickerHint}>
            {props.onCreate ? "Type to create an option" : "No matches"}
          </div>
        </Show>
      </div>
    </Popover>
  );
}

/**
 * Picks a select or status option, or several for a multi-select. Typing a
 * name that isn't there offers to create it (when `onCreate` is given).
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   property: Property,
 *   value: PropertyValue | undefined,
 *   onChange: (value: PropertyValue | null) => void,
 *   onCreate?: (name: string) => SelectOption,
 * }} props
 */
export function OptionPicker(props) {
  const multi = () => props.property.type === "multi_select";
  const status = () => props.property.type === "status";
  const selected = () =>
    Array.isArray(props.value) ? props.value : typeof props.value === "string" ? [props.value] : [];
  /** @param {string} id */
  const toggle = (id) => {
    if (multi()) {
      const current = selected();
      const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
      props.onChange(next.length ? next : null);
    } else {
      props.onChange(id);
    }
  };
  return (
    <ListPicker
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      focusOnClose={props.focusOnClose}
      label={props.property.name}
      multi={multi()}
      placeholder={props.onCreate ? "Search or create an option" : "Search options"}
      selected={selected()}
      groups={status() ? STATUS_GROUPS : undefined}
      items={(props.property.options ?? []).map((option) => ({
        id: option.id,
        text: option.name,
        group: option.group,
        render: () => <Tag option={option} status={status()} />,
      }))}
      renderSelected={(id, remove) => (
        <Show when={findOption(props.property, id)}>
          {(option) => <Tag option={option()} status={status()} onRemove={remove} />}
        </Show>
      )}
      onToggle={toggle}
      onClear={() => props.onChange(null)}
      onCreate={
        props.onCreate
          ? (name) => {
              const option = /** @type {NonNullable<typeof props.onCreate>} */ (props.onCreate)(
                name,
              );
              toggle(option.id);
            }
          : undefined
      }
    />
  );
}

/**
 * Picks workspace members.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   property: Property,
 *   value: PropertyValue | undefined,
 *   members: readonly Member[] | undefined,
 *   onChange: (value: PropertyValue | null) => void,
 * }} props
 */
export function PersonPicker(props) {
  const selected = () => (Array.isArray(props.value) ? props.value : []);
  return (
    <ListPicker
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      focusOnClose={props.focusOnClose}
      label={props.property.name}
      multi
      placeholder="Search for a person"
      selected={selected()}
      items={(props.members ?? []).map((member) => ({
        id: member.id,
        text: memberName(props.members, member.id),
        render: () => <Person id={member.id} members={props.members} />,
      }))}
      renderSelected={(id, remove) => (
        <span class={styles.tag} style={{ background: "var(--color-bg-active)" }}>
          <Person id={id} members={props.members} />
          <button
            type="button"
            class={styles.tagRemove}
            tabindex={-1}
            aria-label={`Remove ${memberName(props.members, id)}`}
            onClick={remove}
          >
            ×
          </button>
        </span>
      )}
      onToggle={(id) => {
        const current = selected();
        const next = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
        props.onChange(next.length ? next : null);
      }}
      onClear={() => props.onChange(null)}
    />
  );
}

/**
 * A date: the browser's date field, plus Today and Clear.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   focusOnClose?: () => HTMLElement | null | undefined,
 *   property: Property,
 *   value: PropertyValue | undefined,
 *   onChange: (value: PropertyValue | null) => void,
 * }} props
 */
export function DatePicker(props) {
  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      focusOnClose={props.focusOnClose}
      placement="bottom-start"
      class={styles.picker}
      role="dialog"
      aria-label={props.property.name}
    >
      <div class={styles.pickerActions}>
        <input
          type="date"
          class={styles.dateInput}
          value={typeof props.value === "string" ? props.value : ""}
          aria-label={props.property.name}
          onChange={(event) => props.onChange(event.currentTarget.value || null)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              props.onOpenChange(false);
            }
          }}
        />
      </div>
      <div class={styles.pickerActions}>
        <Button variant="ghost" onClick={() => props.onChange(today())}>
          Today
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            props.onChange(null);
            props.onOpenChange(false);
          }}
        >
          Clear
        </Button>
      </div>
    </Popover>
  );
}

/**
 * The text a value is edited as, in a field.
 * @param {Property} property @param {PropertyValue | undefined} value
 */
export function editText(property, value) {
  if (value === undefined) return "";
  if (property.type === "number") return typeof value === "number" ? String(value) : "";
  return typeof value === "string" ? value : "";
}

/**
 * What a field's text means for a property: a value, null (cleared), or
 * undefined when it's not valid (a number that isn't one: no change).
 * @param {Property} property @param {string} text
 * @returns {PropertyValue | null | undefined}
 */
export function parseText(property, text) {
  if (property.type === "number") {
    const t = text.trim().replace(/\s/g, "");
    if (t === "") return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  }
  if (property.type === "url") return text.trim() || null;
  return text === "" ? null : text.slice(0, MAX_TEXT_VALUE);
}

/**
 * A field that edits a text, number, URL or title value in place. Enter
 * and Tab save (and say which way to move on), Escape cancels, leaving
 * saves.
 * @param {{
 *   property: Property,
 *   initial: string,
 *   class?: string,
 *   label: string,
 *   onCommit: (text: string, move: "down" | "right" | "left" | null) => void,
 *   onCancel: () => void,
 * }} props
 */
export function TextInput(props) {
  /** @type {HTMLInputElement | undefined} */
  let input;
  let done = false;
  onMount(() => {
    if (!input) return;
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
  /** @param {"down" | "right" | "left" | null} move */
  const commit = (move) => {
    if (done || !input) return;
    done = true;
    props.onCommit(input.value, move);
  };
  return (
    <input
      ref={input}
      class={props.class ?? styles.inlineInput}
      value={props.initial}
      inputMode={
        props.property.type === "number"
          ? "decimal"
          : props.property.type === "url"
            ? "url"
            : undefined
      }
      maxLength={props.property.type === "title" ? 2000 : MAX_TEXT_VALUE}
      aria-label={props.label}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit("down");
        } else if (event.key === "Tab") {
          event.preventDefault();
          commit(event.shiftKey ? "left" : "right");
        } else if (event.key === "Escape") {
          event.preventDefault();
          done = true;
          props.onCancel();
        }
      }}
      onBlur={() => commit(null)}
    />
  );
}
