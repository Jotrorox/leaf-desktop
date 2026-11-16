// @ts-check
import { keyBetween, nKeysBetween } from "../../lib/fractional-index.js";
import { makeRoadmapRows, ROADMAP_ID, ROADMAP_SCHEMA, ROADMAP_VIEWS } from "./seed-database.js";

/**
 * Starting data for the mock backend, after the UI canvas's sidebar: a few
 * nested pages and something in the trash.
 */

/** @typedef {import("./db.js").DbState} DbState */
/** @typedef {import("./db.js").PageRow} PageRow */

export const MOCK_WORKSPACE_ID = "ws_personal";

/**
 * @typedef {object} SeedPage
 * @property {string} id
 * @property {string} title
 * @property {string | null} [icon]
 * @property {string | null} [cover]
 * @property {SeedPage[]} [children]
 * @property {boolean} [trashed]
 */

/** @type {SeedPage[]} */
const TREE = [
  {
    id: "pg_getting_started",
    title: "Getting started",
    icon: "👋",
    children: [
      { id: "pg_basics", title: "The basics", icon: "📄" },
      { id: "pg_shortcuts", title: "Keyboard shortcuts", icon: "⌨️" },
      { id: "pg_invite", title: "Invite your team", icon: "✉️" },
    ],
  },
  {
    id: "pg_kickoff",
    title: "Project Kickoff",
    icon: "🚩",
    cover: "color:blue",
    children: [
      {
        id: "pg_meeting_notes",
        title: "Meeting notes",
        icon: "📝",
        children: [
          { id: "pg_notes_kickoff", title: "Oct 6 · Kickoff", icon: null },
          { id: "pg_notes_review", title: "Oct 9 · Design review", icon: null },
        ],
      },
      { id: "pg_tasks", title: "Tasks", icon: "✅" },
      { id: "pg_research", title: "Research links", icon: "🔗" },
    ],
  },
  {
    id: "pg_journal",
    title: "Journal",
    icon: "📓",
    cover: "gradient:dusk",
    children: [
      { id: "pg_journal_mon", title: "Monday", icon: null },
      { id: "pg_journal_tue", title: "Tuesday", icon: null },
    ],
  },
  {
    id: "pg_reading",
    title: "Reading list",
    icon: "📚",
    children: [
      { id: "pg_ddia", title: "Designing Data-Intensive Applications", icon: "📕" },
      { id: "pg_pragprog", title: "The Pragmatic Programmer", icon: "📗" },
      { id: "pg_thinking", title: "Thinking, Fast and Slow", icon: "📘" },
    ],
  },
  { id: "pg_empty", title: "", icon: null },
  {
    id: "pg_old_roadmap",
    title: "Old roadmap",
    icon: "🗺️",
    trashed: true,
    children: [{ id: "pg_q3_ideas", title: "Q3 ideas", icon: "💡" }],
  },
];

/**
 * @param {Date} [now]
 * @param {{ database?: boolean }} [options] `database`: add the sample
 *   database ("Product roadmap", top level, with rows). The browser's mock
 *   has it; tests that mirror the backend's seed don't.
 * @returns {DbState}
 */
export function seedState(now = new Date(), { database = false } = {}) {
  const created = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const trashedAt = new Date(now.getTime() - 2 * 86_400_000).toISOString();
  /** @type {PageRow[]} */
  const pages = [];

  /**
   * @param {SeedPage[]} items
   * @param {string | null} parentId
   * @param {string | null} trashRoot
   */
  function add(items, parentId, trashRoot) {
    const positions = nKeysBetween(null, null, items.length);
    items.forEach((item, index) => {
      const root = trashRoot ?? (item.trashed ? item.id : null);
      pages.push({
        id: item.id,
        workspace_id: MOCK_WORKSPACE_ID,
        parent_id: parentId,
        title: item.title,
        icon: item.icon ?? null,
        cover: item.cover ?? null,
        position: positions[index],
        archived_at: root ? trashedAt : null,
        trash_root: root,
        created_at: created,
        updated_at: created,
      });
      add(item.children ?? [], item.id, root);
    });
  }
  add(TREE, null, null);

  /** @type {DbState["databases"]} */
  const databases = {};
  if (database) {
    const live = pages.filter((p) => p.parent_id === null && !p.archived_at);
    const reading = live.findIndex((p) => p.id === "pg_reading");
    pages.push({
      id: ROADMAP_ID,
      workspace_id: MOCK_WORKSPACE_ID,
      parent_id: null,
      title: "Product roadmap",
      icon: "🚀",
      cover: null,
      position: keyBetween(live[reading].position, live[reading + 1]?.position ?? null),
      archived_at: null,
      trash_root: null,
      created_at: created,
      updated_at: created,
      kind: "database",
      properties: {},
    });
    for (const row of makeRoadmapRows(24)) {
      pages.push({
        id: row.id,
        workspace_id: MOCK_WORKSPACE_ID,
        parent_id: ROADMAP_ID,
        title: row.title,
        icon: null,
        cover: null,
        position: row.position,
        archived_at: null,
        trash_root: null,
        created_at: created,
        updated_at: created,
        kind: "row",
        properties: row.properties,
      });
    }
    databases[ROADMAP_ID] = {
      properties: structuredClone(ROADMAP_SCHEMA),
      views: structuredClone(ROADMAP_VIEWS),
    };
  }

  return {
    workspaces: [{ id: MOCK_WORKSPACE_ID, name: "My workspace", icon: null, created_at: created }],
    pages,
    databases,
  };
}
