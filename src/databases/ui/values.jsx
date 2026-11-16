// @ts-check
import { For, Match, Show, Switch } from "solid-js";
import { Dynamic } from "solid-js/web";
import { cx } from "../../lib/cx.js";
import {
  IconCalendar,
  IconCheckbox,
  IconHash,
  IconLink,
  IconList,
  IconPerson,
  IconSelect,
  IconStatus,
  IconText,
} from "../../ui/icons/index.jsx";
import { formatDate, formatNumber, initials, memberName, tagColors } from "../format.js";
import { findOption } from "../schema.js";
import styles from "./Database.module.css";

/** @typedef {import("../../api/types.js").Property} Property */
/** @typedef {import("../../api/types.js").PropertyValue} PropertyValue */
/** @typedef {import("../../api/types.js").Member} Member */
/** @typedef {import("../../api/types.js").SelectOption} SelectOption */

const ICONS = {
  title: IconText,
  text: IconText,
  number: IconHash,
  select: IconSelect,
  multi_select: IconList,
  status: IconStatus,
  date: IconCalendar,
  person: IconPerson,
  checkbox: IconCheckbox,
  url: IconLink,
};

/** A property type's icon. @param {{ type: Property["type"], size?: number }} props */
export function PropertyIcon(props) {
  return <Dynamic component={ICONS[props.type] ?? IconText} size={props.size ?? 16} />;
}

/**
 * An option as a colored tag.
 * @param {{ option: SelectOption, status?: boolean, onRemove?: () => void }} props
 */
export function Tag(props) {
  return (
    <span
      class={cx(styles.tag, props.status && styles.statusTag)}
      style={tagColors(props.option.color)}
    >
      <Show when={props.status}>
        <span class={styles.statusDot} aria-hidden="true" />
      </Show>
      <span class={styles.ellipsis}>{props.option.name}</span>
      <Show when={props.onRemove}>
        {(remove) => (
          <button
            type="button"
            class={styles.tagRemove}
            tabindex={-1}
            aria-label={`Remove ${props.option.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              event.stopPropagation();
              remove()();
            }}
          >
            ×
          </button>
        )}
      </Show>
    </span>
  );
}

/** @param {{ id: string, members: readonly Member[] | undefined }} props */
export function Person(props) {
  const member = () => props.members?.find((m) => m.id === props.id);
  const name = () => memberName(props.members, props.id);
  return (
    <span class={styles.person}>
      <Show
        when={member()?.avatar_url}
        fallback={
          <span class={styles.avatar} aria-hidden="true">
            {initials(name())}
          </span>
        }
      >
        {(url) => <img class={styles.avatar} src={url()} alt="" />}
      </Show>
      <span class={styles.ellipsis}>{name()}</span>
    </span>
  );
}

/**
 * A value as the table and the properties block show it. Checkboxes are
 * drawn by their cell (they're clickable).
 * @param {{
 *   property: Property,
 *   value: PropertyValue | undefined,
 *   members: readonly Member[] | undefined,
 *   placeholder?: string,
 * }} props `placeholder`: shown when empty (the properties block says "Empty").
 */
export function CellValue(props) {
  const ids = () => (Array.isArray(props.value) ? props.value : []);
  const empty = () =>
    props.value === undefined ||
    props.value === "" ||
    (Array.isArray(props.value) && props.value.length === 0);
  return (
    <Show
      when={!empty()}
      fallback={props.placeholder ? <span class={styles.empty}>{props.placeholder}</span> : null}
    >
      <Switch fallback={<span class={styles.ellipsis}>{String(props.value)}</span>}>
        <Match when={props.property.type === "number" && typeof props.value === "number"}>
          <span class={styles.ellipsis}>{formatNumber(/** @type {number} */ (props.value))}</span>
        </Match>
        <Match when={props.property.type === "select" || props.property.type === "status"}>
          <Show when={findOption(props.property, String(props.value))}>
            {(option) => <Tag option={option()} status={props.property.type === "status"} />}
          </Show>
        </Match>
        <Match when={props.property.type === "multi_select"}>
          <span class={styles.tags}>
            <For each={ids()}>
              {(id) => (
                <Show when={findOption(props.property, id)}>
                  {(option) => <Tag option={option()} />}
                </Show>
              )}
            </For>
          </span>
        </Match>
        <Match when={props.property.type === "person"}>
          <span class={styles.tags}>
            <For each={ids()}>{(id) => <Person id={id} members={props.members} />}</For>
          </span>
        </Match>
        <Match when={props.property.type === "date"}>
          <span class={styles.ellipsis}>{formatDate(String(props.value))}</span>
        </Match>
        <Match when={props.property.type === "url"}>
          <a
            class={styles.link}
            href={safeUrl(String(props.value))}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {String(props.value)}
          </a>
        </Match>
        <Match when={props.property.type === "checkbox"}>
          <input
            type="checkbox"
            class={styles.checkbox}
            checked={props.value === true}
            disabled
            aria-label={props.property.name}
          />
        </Match>
      </Switch>
    </Show>
  );
}

/**
 * A URL value as a link target: web and mail links as they are, a bare
 * domain as https, anything else (javascript:) not at all.
 * @param {string} value
 */
export function safeUrl(value) {
  const v = value.trim();
  if (/^(https?:|mailto:)/i.test(v)) return v;
  if (/^[^\s:/]+\.[^\s:/]+/.test(v)) return `https://${v}`;
  return undefined;
}
