// @ts-check
import { nKeysBetween } from "../../lib/fractional-index.js";
import { createPrng } from "../../lib/prng.js";

/**
 * The mock's sample database ("Product roadmap"), and made-up rows for it:
 * the seed's two dozen, or thousands from the dev menu for trying a big table.
 */

/** @typedef {import("../types.js").Property} Property */
/** @typedef {import("../types.js").View} View */
/** @typedef {import("../types.js").PropertyValue} PropertyValue */

export const ROADMAP_ID = "pg_roadmap";

/** @type {Property[]} */
export const ROADMAP_SCHEMA = [
  { id: "title", name: "Name", type: "title" },
  {
    id: "status",
    name: "Status",
    type: "status",
    options: [
      { id: "st_todo", name: "Not started", color: "default", group: "to_do" },
      { id: "st_doing", name: "In progress", color: "blue", group: "in_progress" },
      { id: "st_review", name: "In review", color: "purple", group: "in_progress" },
      { id: "st_done", name: "Done", color: "green", group: "complete" },
    ],
  },
  {
    id: "priority",
    name: "Priority",
    type: "select",
    options: [
      { id: "pr_high", name: "High", color: "red" },
      { id: "pr_med", name: "Medium", color: "yellow" },
      { id: "pr_low", name: "Low", color: "gray" },
    ],
  },
  {
    id: "tags",
    name: "Tags",
    type: "multi_select",
    options: [
      { id: "tg_editor", name: "Editor", color: "blue" },
      { id: "tg_sync", name: "Sync", color: "purple" },
      { id: "tg_db", name: "Databases", color: "orange" },
      { id: "tg_mobile", name: "Mobile", color: "pink" },
      { id: "tg_infra", name: "Infra", color: "brown" },
    ],
  },
  { id: "owner", name: "Owner", type: "person" },
  { id: "due", name: "Due", type: "date" },
  { id: "estimate", name: "Estimate", type: "number" },
  { id: "shipped", name: "Shipped", type: "checkbox" },
  { id: "spec", name: "Spec", type: "url" },
  { id: "notes", name: "Notes", type: "text" },
];

const BOARD_DEFAULTS = { group_by: null, card_properties: [], hidden_groups: [] };

/** @type {View[]} */
export const ROADMAP_VIEWS = [
  {
    id: "vw_all",
    name: "All work",
    type: "table",
    position: "a0",
    filter: null,
    sorts: [],
    columns: [{ property_id: "title", width: 300 }],
    ...BOARD_DEFAULTS,
  },
  {
    id: "vw_open",
    name: "Open, by due date",
    type: "table",
    position: "a1",
    filter: { and: [{ property_id: "status", operator: "does_not_equal", value: "st_done" }] },
    sorts: [
      { property_id: "due", direction: "ascending" },
      { property_id: "priority", direction: "ascending" },
    ],
    columns: [
      { property_id: "notes", hidden: true },
      { property_id: "spec", hidden: true },
    ],
    ...BOARD_DEFAULTS,
  },
  {
    id: "vw_board",
    name: "Board",
    type: "board",
    position: "a2",
    filter: null,
    sorts: [],
    columns: [],
    group_by: "status",
    card_properties: ["priority", "owner", "due"],
    hidden_groups: [],
  },
];

const VERBS = [
  "Ship",
  "Design",
  "Prototype",
  "Fix",
  "Speed up",
  "Write tests for",
  "Document",
  "Polish",
  "Plan",
  "Review",
];
const THINGS = [
  "slash menu",
  "table view",
  "board view",
  "offline outbox",
  "remote cursors",
  "IME input",
  "mobile toolbar",
  "share popover",
  "image uploads",
  "quick find",
  "filter builder",
  "page history",
  "trash",
  "sidebar drag and drop",
];
const NOTES = [
  "",
  "",
  "Needs a design pass",
  "Blocked on the backend",
  "Follow up with QA",
  "See the spec",
  "Ready to pick up",
];
const MEMBERS = ["user_mock", "user_ada", "user_grace"];

/**
 * Made-up rows, `count` of them, numbered from `start`.
 * @param {number} count
 * @param {{ start?: number, seed?: number, after?: string | null }} [options] `after`: the last row's position.
 * @returns {{ id: string, title: string, position: string, properties: Record<string, PropertyValue> }[]}
 */
export function makeRoadmapRows(count, { start = 0, seed = 7, after = null } = {}) {
  const rng = createPrng(seed + start);
  const positions = nKeysBetween(after, null, count);
  const base = Date.UTC(2026, 9, 1);
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    /** @type {Record<string, PropertyValue>} */
    const properties = {};
    const status = rng.pick(["st_todo", "st_todo", "st_doing", "st_review", "st_done", "st_done"]);
    properties.status = status;
    if (rng.next() < 0.85)
      properties.priority = rng.pick(["pr_high", "pr_med", "pr_med", "pr_low"]);
    const tags = ["tg_editor", "tg_sync", "tg_db", "tg_mobile", "tg_infra"].filter(
      () => rng.next() < 0.3,
    );
    if (tags.length) properties.tags = tags;
    if (rng.next() < 0.8) properties.owner = [rng.pick(MEMBERS)];
    if (rng.next() < 0.75)
      properties.due = new Date(base + rng.int(90) * 86_400_000).toISOString().slice(0, 10);
    if (rng.next() < 0.7) properties.estimate = rng.pick([0.5, 1, 2, 3, 5, 8, 13]);
    if (status === "st_done" && rng.next() < 0.7) properties.shipped = true;
    if (rng.next() < 0.3) properties.spec = `https://leaf.test/specs/${n + 1}`;
    const note = rng.pick(NOTES);
    if (note) properties.notes = note;
    return {
      id: `row_${String(n + 1).padStart(5, "0")}`,
      title: `${rng.pick(VERBS)} ${rng.pick(THINGS)}${n >= 24 ? ` #${n + 1}` : ""}`,
      position: positions[i],
      properties,
    };
  });
}
