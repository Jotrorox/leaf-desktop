// @ts-check
import { createSignal, For, Match, Show, Switch } from "solid-js";
import { addOption, updateRow, useDatabase, useMembers } from "../../data/databases.js";
import { isEmptyValue, isOptionType } from "../schema.js";
import styles from "./Database.module.css";
import {
  DatePicker,
  editText,
  OptionPicker,
  PersonPicker,
  parseText,
  TextInput,
} from "./editors.jsx";
import { CellValue, PropertyIcon } from "./values.jsx";

/** @typedef {import("../../api/types.js").Page} Page */
/** @typedef {import("../../api/types.js").Property} Property */
/** @typedef {import("../../api/types.js").PropertyValue} PropertyValue */
/** @typedef {import("../../api/types.js").Member} Member */

/**
 * A row's properties, above its content: each property's name and value,
 * edited in place (the same editors as the table's cells).
 * @param {{ page: Page, readOnly: boolean }} props `page`: the row's page.
 */
export default function RowProperties(props) {
  const databaseId = () => props.page.parent_id ?? undefined;
  const database = useDatabase(databaseId);
  const members = useMembers(() => props.page.workspace_id);
  const properties = () => (database.data()?.properties ?? []).filter((p) => p.type !== "title");

  return (
    <Show when={properties().length > 0}>
      <div class={styles.properties} role="group" aria-label="Properties">
        <For each={properties()}>
          {(property) => (
            <PropertyRow
              property={property}
              value={props.page.properties?.[property.id]}
              members={members.data()}
              readOnly={props.readOnly}
              databaseId={/** @type {string} */ (databaseId())}
              onSave={(value) => {
                const before = props.page.properties?.[property.id] ?? null;
                if (
                  JSON.stringify(before) === JSON.stringify(value) ||
                  (isEmptyValue(before) && isEmptyValue(value))
                )
                  return;
                void updateRow(/** @type {string} */ (databaseId()), props.page.id, {
                  properties: { [property.id]: value },
                });
              }}
            />
          )}
        </For>
      </div>
    </Show>
  );
}

/**
 * @param {{
 *   property: Property,
 *   value: PropertyValue | undefined,
 *   members: readonly Member[] | undefined,
 *   readOnly: boolean,
 *   databaseId: string,
 *   onSave: (value: PropertyValue | null) => void,
 * }} props
 */
function PropertyRow(props) {
  const [editing, setEditing] = createSignal(false);
  /** @type {HTMLButtonElement | undefined} */
  let button;
  const type = () => props.property.type;
  const textual = () => ["text", "number", "url"].includes(type());
  const label = () => `${props.property.name}`;
  /** @param {boolean} open */
  const onOpenChange = (open) => setEditing(open);

  return (
    <div class={styles.property}>
      <div class={styles.propertyLabel}>
        <PropertyIcon type={type()} />
        <span class={styles.ellipsis}>{props.property.name}</span>
      </div>
      <Switch>
        <Match when={type() === "checkbox"}>
          <label class={styles.propertyValue}>
            <input
              type="checkbox"
              class={styles.checkbox}
              checked={props.value === true}
              disabled={props.readOnly}
              aria-label={label()}
              onChange={(event) => props.onSave(event.currentTarget.checked ? true : null)}
            />
          </label>
        </Match>
        <Match when={editing() && textual()}>
          <div class={styles.propertyValue} style={{ padding: "0" }}>
            <TextInput
              property={props.property}
              initial={editText(props.property, props.value)}
              class={styles.propertyInput}
              label={label()}
              onCommit={(text) => {
                const value = parseText(props.property, text);
                if (value !== undefined) props.onSave(value);
                setEditing(false);
                queueMicrotask(() => button?.focus());
              }}
              onCancel={() => {
                setEditing(false);
                queueMicrotask(() => button?.focus());
              }}
            />
          </div>
        </Match>
        <Match when={true}>
          <button
            ref={button}
            type="button"
            class={`${styles.propertyValue} ${styles.wrap}`}
            aria-label={`${label()}: edit`}
            aria-haspopup={textual() ? undefined : "dialog"}
            aria-expanded={textual() ? undefined : editing()}
            disabled={props.readOnly}
            onClick={() => setEditing(true)}
          >
            <CellValue
              property={props.property}
              value={props.value}
              members={props.members}
              placeholder="Empty"
            />
          </button>
        </Match>
      </Switch>
      <Show when={editing() && !textual() && !props.readOnly}>
        <Switch>
          <Match when={isOptionType(type())}>
            <OptionPicker
              open
              onOpenChange={onOpenChange}
              anchor={() => button}
              property={props.property}
              value={props.value}
              onChange={props.onSave}
              onCreate={(name) => addOption(props.databaseId, props.property, name)}
            />
          </Match>
          <Match when={type() === "person"}>
            <PersonPicker
              open
              onOpenChange={onOpenChange}
              anchor={() => button}
              property={props.property}
              value={props.value}
              members={props.members}
              onChange={props.onSave}
            />
          </Match>
          <Match when={type() === "date"}>
            <DatePicker
              open
              onOpenChange={onOpenChange}
              anchor={() => button}
              property={props.property}
              value={props.value}
              onChange={props.onSave}
            />
          </Match>
        </Switch>
      </Show>
    </div>
  );
}
