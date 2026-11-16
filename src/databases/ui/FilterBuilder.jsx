// @ts-check
import {
  createEffect,
  createSignal,
  For,
  Index,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from "solid-js";
import { IconClose, IconPlus } from "../../ui/icons/index.jsx";
import Popover from "../../ui/Popover.jsx";
import { memberName, operatorLabel } from "../format.js";
import {
  groupItems,
  groupOp,
  isGroup,
  MAX_FILTER_DEPTH,
  makeGroup,
  operatorsFor,
  takesValue,
} from "../query.js";
import styles from "./Database.module.css";

/** @typedef {import("../../api/types.js").Property} Property */
/** @typedef {import("../../api/types.js").Member} Member */
/** @typedef {import("../../api/types.js").Filter} Filter */
/** @typedef {import("../../api/types.js").FilterGroup} FilterGroup */
/** @typedef {import("../../api/types.js").FilterCondition} FilterCondition */
/** @typedef {import("../../api/types.js").Sort} Sort */

/** How long typing in a value waits before the view (and the rows) change. */
const COMMIT_DELAY = 350;

/**
 * A new condition on a property: its first operator, no value yet.
 * @param {Property} property @returns {FilterCondition}
 */
export function newCondition(property) {
  /** @type {FilterCondition} */
  const condition = { property_id: property.id, operator: operatorsFor(property.type)[0] };
  if (property.type === "checkbox") condition.value = true;
  return condition;
}

/**
 * The filter builder: nested and/or groups of conditions, as the view
 * stores them (docs/databases.md, Section 3). Edits apply to a draft that's
 * saved shortly after the last change, so typing doesn't query per key.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   schema: Property[],
 *   members: readonly Member[] | undefined,
 *   filter: FilterGroup | null,
 *   onChange: (filter: FilterGroup | null) => void,
 * }} props
 */
export default function FilterBuilder(props) {
  const [draft, setDraft] = createSignal(/** @type {FilterGroup} */ ({ and: [] }));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  let dirty = false;

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) setDraft(structuredClone(props.filter ?? { and: [] }));
        else flush();
      },
    ),
  );

  function flush() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    const value = draft();
    props.onChange(groupItems(value).length === 0 ? null : value);
  }
  onCleanup(flush);

  /** @param {FilterGroup} next @param {boolean} [now] Structural changes apply at once. */
  function change(next, now = true) {
    setDraft(next);
    dirty = true;
    clearTimeout(timer);
    if (now) flush();
    else timer = setTimeout(flush, COMMIT_DELAY);
  }

  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      placement="bottom-start"
      class={`${styles.panel} ${styles.widePanel}`}
      role="dialog"
      aria-label="Filters"
    >
      <Show when={groupItems(draft()).length === 0}>
        <p class={styles.panelTitle}>
          No filters yet. Rows that match every rule show; add groups for “or”.
        </p>
      </Show>
      <GroupEditor
        group={draft()}
        depth={0}
        schema={props.schema}
        members={props.members}
        onChange={change}
      />
    </Popover>
  );
}

/**
 * @param {{
 *   group: FilterGroup,
 *   depth: number,
 *   schema: Property[],
 *   members: readonly Member[] | undefined,
 *   onChange: (group: FilterGroup, now?: boolean) => void,
 * }} props
 */
function GroupEditor(props) {
  const items = () => groupItems(props.group);
  const op = () => groupOp(props.group);
  /** @param {Filter[]} next @param {boolean} [now] */
  const setItems = (next, now) => props.onChange(makeGroup(op(), next), now);
  /** @param {number} index @param {Filter | null} item @param {boolean} [now] */
  const setItem = (index, item, now) =>
    setItems(
      item === null
        ? items().filter((_, i) => i !== index)
        : items().map((x, i) => (i === index ? item : x)),
      now,
    );
  const first = () => props.schema[0];

  return (
    <div class={styles.rules}>
      <Index each={items()}>
        {(item, index) => {
          const lead = () =>
            index === 0 ? (
              <span class={styles.conj}>Where</span>
            ) : index === 1 ? (
              <select
                class={`${styles.field} ${styles.conjSelect}`}
                value={op()}
                aria-label="Combine rules with"
                onChange={(event) =>
                  props.onChange(
                    makeGroup(/** @type {"and" | "or"} */ (event.currentTarget.value), items()),
                  )
                }
              >
                <option value="and">And</option>
                <option value="or">Or</option>
              </select>
            ) : (
              <span class={styles.conj}>{op() === "and" ? "And" : "Or"}</span>
            );
          return (
            <Show
              when={!isGroup(item())}
              fallback={
                <div class={styles.ruleGroup}>
                  {lead()}
                  <div class={styles.groupBox}>
                    <GroupEditor
                      group={/** @type {FilterGroup} */ (item())}
                      depth={props.depth + 1}
                      schema={props.schema}
                      members={props.members}
                      onChange={(group, now) => setItem(index, group, now)}
                    />
                  </div>
                  <button
                    type="button"
                    class={styles.iconOnly}
                    aria-label="Remove group"
                    onClick={() => setItem(index, null)}
                  >
                    <IconClose size={16} />
                  </button>
                </div>
              }
            >
              <ConditionEditor
                lead={lead()}
                condition={/** @type {FilterCondition} */ (item())}
                schema={props.schema}
                members={props.members}
                onChange={(condition, now) => setItem(index, condition, now)}
                onRemove={() => setItem(index, null)}
              />
            </Show>
          );
        }}
      </Index>
      <div class={styles.addLinks}>
        <button
          type="button"
          class={styles.menuItem}
          style={{ width: "auto" }}
          disabled={!first()}
          onClick={() => setItems([...items(), newCondition(first())])}
        >
          <IconPlus size={16} /> Add a rule
        </button>
        <Show when={props.depth < MAX_FILTER_DEPTH - 1}>
          <button
            type="button"
            class={styles.menuItem}
            style={{ width: "auto" }}
            disabled={!first()}
            onClick={() =>
              setItems([
                ...items(),
                makeGroup(op() === "and" ? "or" : "and", [newCondition(first())]),
              ])
            }
          >
            <IconPlus size={16} /> Add a group
          </button>
        </Show>
      </div>
    </div>
  );
}

/**
 * @param {{
 *   lead: import("solid-js").JSX.Element,
 *   condition: FilterCondition,
 *   schema: Property[],
 *   members: readonly Member[] | undefined,
 *   onChange: (condition: FilterCondition, now?: boolean) => void,
 *   onRemove: () => void,
 * }} props
 */
function ConditionEditor(props) {
  const property = () => props.schema.find((p) => p.id === props.condition.property_id);
  /** @param {FilterCondition["value"] | undefined} value @param {boolean} [now] */
  const setValue = (value, now = true) => {
    /** @type {FilterCondition} */
    const next = { property_id: props.condition.property_id, operator: props.condition.operator };
    if (value !== undefined && value !== "") next.value = value;
    props.onChange(next, now);
  };
  return (
    <div class={styles.rule}>
      {props.lead}
      <select
        class={styles.field}
        value={props.condition.property_id}
        aria-label="Property"
        onChange={(event) => {
          const next = props.schema.find((p) => p.id === event.currentTarget.value);
          if (next) props.onChange(newCondition(next));
        }}
      >
        <Show when={!property()}>
          <option value={props.condition.property_id}>Deleted property</option>
        </Show>
        <For each={props.schema}>{(p) => <option value={p.id}>{p.name}</option>}</For>
      </select>
      <select
        class={styles.field}
        value={props.condition.operator}
        aria-label="Condition"
        onChange={(event) => {
          const operator = event.currentTarget.value;
          /** @type {FilterCondition} */
          const next = { property_id: props.condition.property_id, operator };
          if (takesValue(operator) && props.condition.value !== undefined)
            next.value = props.condition.value;
          props.onChange(next);
        }}
      >
        <For
          each={
            property()
              ? operatorsFor(/** @type {Property} */ (property()).type)
              : [props.condition.operator]
          }
        >
          {(operator) => (
            <option value={operator}>{operatorLabel(operator, property()?.type)}</option>
          )}
        </For>
      </select>
      <Show when={property() && takesValue(props.condition.operator)} fallback={<span />}>
        <ValueField
          property={/** @type {Property} */ (property())}
          value={props.condition.value}
          members={props.members}
          onChange={setValue}
        />
      </Show>
      <button
        type="button"
        class={styles.iconOnly}
        aria-label="Remove rule"
        onClick={() => props.onRemove()}
      >
        <IconClose size={16} />
      </button>
    </div>
  );
}

/**
 * A condition's value, as the property's type takes it.
 * @param {{
 *   property: Property,
 *   value: FilterCondition["value"],
 *   members: readonly Member[] | undefined,
 *   onChange: (value: FilterCondition["value"] | undefined, now?: boolean) => void,
 * }} props
 */
function ValueField(props) {
  const type = () => props.property.type;
  return (
    <Switch
      fallback={
        <input
          class={styles.field}
          value={typeof props.value === "string" ? props.value : ""}
          placeholder="Value"
          aria-label="Value"
          onInput={(event) => props.onChange(event.currentTarget.value, false)}
        />
      }
    >
      <Match when={type() === "number"}>
        <input
          class={styles.field}
          type="number"
          step="any"
          value={typeof props.value === "number" ? String(props.value) : ""}
          placeholder="Value"
          aria-label="Value"
          onInput={(event) => {
            const n = event.currentTarget.valueAsNumber;
            props.onChange(Number.isFinite(n) ? n : undefined, false);
          }}
        />
      </Match>
      <Match when={type() === "date"}>
        <input
          class={styles.field}
          type="date"
          value={typeof props.value === "string" ? props.value : ""}
          aria-label="Date"
          onChange={(event) => props.onChange(event.currentTarget.value || undefined)}
        />
      </Match>
      <Match when={type() === "checkbox"}>
        <select
          class={styles.field}
          value={props.value === false ? "false" : "true"}
          aria-label="Value"
          onChange={(event) => props.onChange(event.currentTarget.value === "true")}
        >
          <option value="true">Checked</option>
          <option value="false">Unchecked</option>
        </select>
      </Match>
      <Match when={type() === "select" || type() === "status" || type() === "multi_select"}>
        <select
          class={styles.field}
          value={typeof props.value === "string" ? props.value : ""}
          aria-label="Option"
          onChange={(event) => props.onChange(event.currentTarget.value || undefined)}
        >
          <option value="">Any option</option>
          <For each={props.property.options ?? []}>
            {(option) => <option value={option.id}>{option.name}</option>}
          </For>
        </select>
      </Match>
      <Match when={type() === "person"}>
        <select
          class={styles.field}
          value={typeof props.value === "string" ? props.value : ""}
          aria-label="Person"
          onChange={(event) => props.onChange(event.currentTarget.value || undefined)}
        >
          <option value="">Anyone</option>
          <For each={props.members ?? []}>
            {(member) => <option value={member.id}>{memberName(props.members, member.id)}</option>}
          </For>
        </select>
      </Match>
    </Switch>
  );
}

/**
 * The sort builder: a list of property and direction pairs, first one wins.
 * @param {{
 *   open: boolean,
 *   onOpenChange: (open: boolean) => void,
 *   anchor: () => HTMLElement | undefined,
 *   schema: Property[],
 *   sorts: Sort[],
 *   onChange: (sorts: Sort[]) => void,
 * }} props
 */
export function SortBuilder(props) {
  const unused = () => props.schema.filter((p) => !props.sorts.some((s) => s.property_id === p.id));
  /** @param {number} index @param {Sort | null} sort */
  const setSort = (index, sort) =>
    props.onChange(
      sort === null
        ? props.sorts.filter((_, i) => i !== index)
        : props.sorts.map((s, i) => (i === index ? sort : s)),
    );
  return (
    <Popover
      open={props.open}
      onOpenChange={props.onOpenChange}
      anchor={props.anchor}
      placement="bottom-start"
      class={styles.panel}
      style={{ width: "380px" }}
      role="dialog"
      aria-label="Sorts"
    >
      <Show when={props.sorts.length === 0}>
        <p class={styles.panelTitle}>
          No sorts yet: rows are in the order they were added or dragged into.
        </p>
      </Show>
      <div class={styles.rules}>
        <Index each={props.sorts}>
          {(sort, index) => (
            <div class={styles.sortRow}>
              <select
                class={styles.field}
                value={sort().property_id}
                aria-label="Sort by"
                onChange={(event) =>
                  setSort(index, { ...sort(), property_id: event.currentTarget.value })
                }
              >
                <For
                  each={props.schema.filter(
                    (p) =>
                      p.id === sort().property_id ||
                      !props.sorts.some((s) => s.property_id === p.id),
                  )}
                >
                  {(p) => <option value={p.id}>{p.name}</option>}
                </For>
              </select>
              <select
                class={styles.field}
                value={sort().direction}
                aria-label="Direction"
                onChange={(event) =>
                  setSort(index, {
                    ...sort(),
                    direction: /** @type {Sort["direction"]} */ (event.currentTarget.value),
                  })
                }
              >
                <option value="ascending">Ascending</option>
                <option value="descending">Descending</option>
              </select>
              <button
                type="button"
                class={styles.iconOnly}
                aria-label="Remove sort"
                onClick={() => setSort(index, null)}
              >
                <IconClose size={16} />
              </button>
            </div>
          )}
        </Index>
      </div>
      <div class={styles.addLinks}>
        <button
          type="button"
          class={styles.menuItem}
          style={{ width: "auto" }}
          disabled={unused().length === 0 || props.sorts.length >= 10}
          onClick={() =>
            props.onChange([
              ...props.sorts,
              { property_id: unused()[0].id, direction: "ascending" },
            ])
          }
        >
          <IconPlus size={16} /> Add a sort
        </button>
      </div>
    </Popover>
  );
}
