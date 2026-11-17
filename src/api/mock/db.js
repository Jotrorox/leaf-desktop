// @ts-check

import {
  checkFilter,
  parseFilter,
  parseGroup,
  pruneFilter,
  runQuery,
} from "../../databases/query.js";
import {
  changeType,
  defaultSchema,
  defaultStatusOptions,
  invalidProperty,
  isOptionType,
  isValidId,
  keepOptions,
  MAX_PROPERTIES,
  normalizeValue,
  PROPERTY_TYPES,
  validateOptions,
  validatePropertyName,
} from "../../databases/schema.js";
import {
  defaultGroupBy,
  fitSchema,
  invalidView,
  MAX_VIEW_NAME,
  newView,
  parseCardProperties,
  parseColumns,
  parseGroupBy,
  parseHiddenGroups,
  parsePageSize,
  parseSorts,
  withDefaults,
} from "../../databases/views.js";
import { Doc } from "../../editor/model/doc.js";
import { base64ToBytes, bytesToBase64 } from "../../lib/base64.js";
import { keyBetween } from "../../lib/fractional-index.js";
import { ApiError } from "../client.js";
import { canEdit } from "../roles.js";
import { makeRoadmapRows } from "./seed-database.js";

/**
 * The mock backend's data and rules: an in-memory stand-in for the real
 * database, enforcing what the server will (positions, no cycles, no edits
 * to archived pages, trash and restore semantics). Pure: runs under
 * `node --test`. `server.js` puts HTTP-ish routing, latency and failures
 * in front of it.
 */

/** @typedef {import("../types.js").Page} Page */
/** @typedef {import("../types.js").TreeNode} TreeNode */
/** @typedef {import("../types.js").Workspace} Workspace */

/** @typedef {import("../types.js").Property} Property */
/** @typedef {import("../types.js").View} View */
/** @typedef {import("../types.js").Row} Row */
/** @typedef {import("../types.js").Member} Member */
/** @typedef {import("../types.js").PropertyValue} PropertyValue */

/**
 * A stored page. `trash_root` is the id of the page whose trashing archived
 * this one (itself, for a page trashed directly), so a restore brings back
 * exactly what went to the trash together. `kind` and `properties` are
 * optional so stored mock data from before databases still loads.
 * @typedef {Omit<Page, "has_children" | "role"> & { trash_root: string | null }} PageRow
 */

/**
 * A database's schema and views (docs/databases.md).
 * @typedef {{ properties: Property[], views: View[] }} DatabaseRow
 */

/**
 * `docs`: each page's document snapshot, base64 (pages without one have an
 * empty document). `databases`: by page id. `members`: the workspace's
 * (every workspace has the same ones).
 * @typedef {{
 *   workspaces: Workspace[],
 *   pages: PageRow[],
 *   docs?: Record<string, string>,
 *   databases?: Record<string, DatabaseRow>,
 *   members?: Member[],
 *   texts?: Record<string, string>,
 *   shares?: Record<string, Record<string, string>>,
 *   invites?: Record<string, Record<string, { role: string, created_at: string }>>,
 *   public?: string[],
 *   files?: Record<string, MockFile>,
 * }} DbState
 */

/**
 * An uploaded file's record (its bytes stay with `index.js`).
 * @typedef {{ page_id: string, name: string, content_type: string, size: number, token: string | null, uploaded: boolean }} MockFile
 */

/** Everyone's verified email (people outside the workspace too). */
export const MOCK_EMAILS = /** @type {Record<string, string>} */ ({
  user_mock: "mock@leaf.test",
  user_ada: "ada@leaf.test",
  user_grace: "grace@leaf.test",
  user_alan: "alan@leaf.test",
  user_linus: "linus@example.com",
});
/** People who've signed in but aren't in the workspace (guests to invite). */
export const MOCK_GUESTS = [{ id: "user_linus", name: "Linus Torvalds", avatar_url: null }];

/** The signed-in user, and who else is in the mock workspace. */
export const MOCK_USER_ID = "user_mock";
/** @type {Member[]} */
export const DEFAULT_MEMBERS = [
  { id: MOCK_USER_ID, role: "owner", name: "Mock User", avatar_url: null },
  { id: "user_ada", role: "edit", name: "Ada Lovelace", avatar_url: null },
  { id: "user_grace", role: "edit", name: "Grace Hopper", avatar_url: null },
  { id: "user_alan", role: "view", name: "Alan Turing", avatar_url: null },
];

const QUERY_DEFAULT_LIMIT = 100;
const QUERY_MAX_LIMIT = 500;

const MAX_TITLE = 2000;
const MAX_ICON = 16;
const MAX_COVER = 256;
const FILE_ICON = /^file:[A-Za-z0-9_-]{1,64}$/;
/** The backend's cap on a document's snapshot (docs/sync-protocol.md, Section 12). */
const MAX_DOC_SIZE = 16 << 20;

/**
 * @param {DbState} state Copied; the caller's object isn't touched.
 * @param {{ now?: () => string, newId?: () => string, maxDocSize?: number, role?: () => import("../roles.js").Role }} [options]
 *   `role`: the user's role on every page (read per request); viewers and commenters can't write.
 */
export function createDb(
  state,
  {
    now = () => new Date().toISOString(),
    newId = () => crypto.randomUUID(),
    maxDocSize = MAX_DOC_SIZE,
    role = () => "owner",
  } = {},
) {
  const workspaces = new Map(structuredClone(state.workspaces).map((ws) => [ws.id, ws]));
  /** @type {Map<string, PageRow>} */
  const pages = new Map(structuredClone(state.pages).map((page) => [page.id, page]));
  /** @type {Map<string, string>} */
  const docs = new Map(Object.entries(state.docs ?? {}));
  /** @type {Map<string, DatabaseRow>} */
  const databases = new Map(Object.entries(structuredClone(state.databases ?? {})));
  /** @type {Member[]} */
  const members = structuredClone(state.members ?? DEFAULT_MEMBERS);
  /** @type {Map<string, string>} */
  const texts = new Map(Object.entries(state.texts ?? {}));
  /** page id → user id → role. @type {Map<string, Map<string, string>>} */
  const shares = new Map(
    Object.entries(structuredClone(state.shares ?? {})).map(([id, people]) => [
      id,
      new Map(Object.entries(people)),
    ]),
  );
  /** page id → email → invite. @type {Map<string, Map<string, { role: string, created_at: string }>>} */
  const invites = new Map(
    Object.entries(structuredClone(state.invites ?? {})).map(([id, list]) => [
      id,
      new Map(Object.entries(list)),
    ]),
  );
  const publicPages = new Set(state.public ?? []);
  /** @type {Map<string, MockFile>} */
  const files = new Map(Object.entries(structuredClone(state.files ?? {})));

  /** @param {string} id */
  function workspace(id) {
    const ws = workspaces.get(id);
    if (!ws) throw new ApiError(404, "workspace_not_found", "Workspace not found");
    return ws;
  }

  /** @param {string} id */
  function page(id) {
    const row = pages.get(id);
    if (!row) throw new ApiError(404, "page_not_found", "Page not found");
    return row;
  }

  /** @param {string} id */
  function livePage(id) {
    const row = page(id);
    if (row.archived_at) throw new ApiError(409, "page_archived", "The page is in the trash");
    return row;
  }

  /**
   * Non-archived children, in order (a database's rows too).
   * @param {string} workspaceId
   * @param {string | null} parentId
   */
  function children(workspaceId, parentId) {
    return [...pages.values()]
      .filter(
        (row) => row.workspace_id === workspaceId && row.parent_id === parentId && !row.archived_at,
      )
      .sort((a, b) =>
        a.position < b.position
          ? -1
          : a.position > b.position
            ? 1
            : a.id < b.id
              ? -1
              : a.id > b.id
                ? 1
                : 0,
      );
  }

  /** Children as the tree shows them: without a database's rows. @param {string} workspaceId @param {string | null} parentId */
  function treeChildren(workspaceId, parentId) {
    return children(workspaceId, parentId).filter((row) => row.kind !== "row");
  }

  /** @param {PageRow} row */
  const kindOf = (row) => row.kind ?? "page";

  /** Every page under `id` (any state), not including itself. @param {string} id */
  function descendants(id) {
    /** @type {PageRow[]} */
    const found = [];
    const queue = [id];
    while (queue.length) {
      const parentId = /** @type {string} */ (queue.shift());
      for (const row of pages.values()) {
        if (row.parent_id === parentId) {
          found.push(row);
          queue.push(row.id);
        }
      }
    }
    return found;
  }

  /**
   * A position among `parentId`'s children: right after `afterId`, first
   * when it's null, last when it's undefined. `excludeId` is left out (the
   * page being moved).
   * @param {string} workspaceId
   * @param {string | null} parentId
   * @param {string | null | undefined} afterId
   * @param {string} [excludeId]
   */
  function positionFor(workspaceId, parentId, afterId, excludeId) {
    const siblings = children(workspaceId, parentId).filter((row) => row.id !== excludeId);
    if (afterId === undefined) return keyBetween(siblings.at(-1)?.position ?? null, null);
    if (afterId === null) return keyBetween(null, siblings[0]?.position ?? null);
    const index = siblings.findIndex((row) => row.id === afterId);
    if (index < 0)
      throw new ApiError(400, "invalid_after", "after_id isn't a page among the new siblings");
    return keyBetween(siblings[index].position, siblings[index + 1]?.position ?? null);
  }

  /** @param {PageRow} row @returns {Page} */
  function toPage(row) {
    const { trash_root: _, properties, kind: __, ...rest } = row;
    const kind = kindOf(row);
    /** @type {Page} */
    const out = {
      ...rest,
      has_children: treeChildren(row.workspace_id, row.id).length > 0,
      role: role(),
      kind,
    };
    if (kind === "row") out.properties = properties ?? {};
    return out;
  }

  /** Writes need a role that can edit, as on the server. */
  function writable() {
    if (!canEdit(role())) throw new ApiError(403, "read_only", "You can only view this page");
  }

  /** @param {PageRow} row @returns {TreeNode} */
  function toNode(row) {
    return {
      id: row.id,
      parent_id: row.parent_id,
      title: row.title,
      icon: row.icon,
      position: row.position,
      has_children: treeChildren(row.workspace_id, row.id).length > 0,
      kind: kindOf(row),
    };
  }

  /**
   * Checks optional title, icon and cover fields of a request body.
   * @param {Record<string, unknown>} input
   */
  function validateFields(input) {
    if ("title" in input && (typeof input.title !== "string" || input.title.length > MAX_TITLE)) {
      throw new ApiError(
        400,
        "invalid_title",
        `title must be a string of at most ${MAX_TITLE} characters`,
      );
    }
    for (const [field, max] of /** @type {const} */ ([
      ["icon", MAX_ICON],
      ["cover", MAX_COVER],
    ])) {
      const value = input[field];
      // An uploaded image (`file:<id>`) is always a fine icon.
      if (field === "icon" && typeof value === "string" && FILE_ICON.test(value)) continue;
      if (
        value !== undefined &&
        value !== null &&
        (typeof value !== "string" || value.length > max || !value)
      ) {
        throw new ApiError(
          400,
          `invalid_${field}`,
          `${field} must be null or a string of at most ${max} characters`,
        );
      }
    }
  }

  /** @param {string} id */
  function touch(id) {
    page(id).updated_at = now();
  }

  // Sharing (the server's sharing.go)

  const SHARE_ROLES = ["full_access", "edit", "comment", "view"];

  /** @param {unknown} value */
  function shareRole(value) {
    if (typeof value !== "string" || !SHARE_ROLES.includes(value)) {
      throw new ApiError(
        400,
        "invalid_role",
        'role must be "full_access", "edit", "comment" or "view"',
      );
    }
    return value;
  }

  /** A page whose sharing the mock user may change. @param {string} id */
  function sharable(id) {
    const row = page(id);
    const mine = role();
    if (mine !== "owner" && mine !== "full_access")
      throw new ApiError(
        403,
        "cant_share",
        "Only people with full access can change who has access",
      );
    return row;
  }

  /** @param {PageRow} row @param {string} userId @param {string} shareRole_ */
  function setShare(row, userId, shareRole_) {
    if (userId === MOCK_USER_ID)
      throw new ApiError(400, "own_role", "You can't change your own access");
    if (members.find((m) => m.id === userId)?.role === "owner")
      throw new ApiError(400, "owner_role", "The workspace owner always has full access");
    const people = shares.get(row.id) ?? new Map();
    people.set(userId, shareRole_);
    shares.set(row.id, people);
  }

  /** The page and its ancestors, the page first. @param {PageRow} row */
  function chainOf(row) {
    const chain = [row];
    for (
      let p = row.parent_id ? pages.get(row.parent_id) : undefined;
      p && chain.length < 128;
      p = p.parent_id ? pages.get(p.parent_id) : undefined
    )
      chain.push(p);
    return chain;
  }

  /** @param {PageRow} row @returns {import("../types.js").PageRef} */
  const refOf = (row) => ({ id: row.id, title: row.title, icon: row.icon });

  /** @param {PageRow} row @returns {import("../types.js").Sharing} */
  function readSharing(row) {
    const chain = chainOf(row);
    const mine = role();
    const canShare = mine === "owner" || mine === "full_access";
    const publicAt = chain.find((p) => publicPages.has(p.id));
    /** @type {Map<string, import("../types.js").SharingPerson>} */
    const people = new Map();
    for (const m of members) {
      const r = m.id === MOCK_USER_ID ? mine : m.role;
      people.set(m.id, {
        user_id: m.id,
        name: m.name,
        email: canShare ? (MOCK_EMAILS[m.id] ?? null) : null,
        avatar_url: m.avatar_url,
        role: r,
        source: "workspace",
        inherited_from: null,
        guest: false,
      });
    }
    // The nearest share wins (but never over the owner).
    for (const p of [...chain].reverse()) {
      for (const [userId, r] of shares.get(p.id) ?? []) {
        const known = people.get(userId);
        if (known?.role === "owner") continue;
        const guest = MOCK_GUESTS.find((g) => g.id === userId);
        const base = known ?? {
          user_id: userId,
          name: guest?.name ?? null,
          email: canShare ? (MOCK_EMAILS[userId] ?? null) : null,
          avatar_url: null,
          guest: true,
        };
        people.set(userId, {
          ...base,
          role: /** @type {import("../roles.js").Role} */ (r),
          source: p.id === row.id ? "page" : "ancestor",
          inherited_from: p.id === row.id ? null : refOf(p),
        });
      }
    }
    /** @type {Map<string, import("../types.js").SharingInvite>} */
    const pending = new Map();
    if (canShare) {
      for (const p of [...chain].reverse()) {
        for (const [email, invite] of invites.get(p.id) ?? []) {
          pending.set(email, {
            email,
            role: /** @type {import("../roles.js").Role} */ (invite.role),
            source: p.id === row.id ? "page" : "ancestor",
            inherited_from: p.id === row.id ? null : refOf(p),
            created_at: invite.created_at,
          });
        }
      }
    }
    const ws = workspace(row.workspace_id);
    return {
      page_id: row.id,
      role: mine,
      can_share: canShare,
      public: publicAt !== undefined,
      public_inherited_from: publicAt && publicAt.id !== row.id ? refOf(publicAt) : null,
      workspace: { id: ws.id, name: ws.name },
      people: [...people.values()].sort(
        (a, b) => Number(b.role === "owner") - Number(a.role === "owner"),
      ),
      invites: [...pending.values()],
    };
  }

  // Databases (docs/databases.md; the server's databases.go)

  const databaseParent = () =>
    new ApiError(400, "invalid_parent", "Pages can't go in a database; add a row to it instead");
  const databaseNotFound = () => new ApiError(404, "database_not_found", "Database not found");

  /** A new database's schema and first view. @param {string} id */
  function initDatabase(id) {
    databases.set(id, {
      properties: defaultSchema(),
      views: [newView(newId(), "Table", "table", keyBetween(null, null))],
    });
  }

  /** @param {string} id @returns {DatabaseRow} */
  function databaseOf(id) {
    const db = databases.get(id);
    if (!db) throw databaseNotFound();
    return db;
  }

  /** A database the user can see. @param {string} id */
  function databasePage(id) {
    const row = pages.get(id);
    if (!row || kindOf(row) !== "database") throw databaseNotFound();
    return row;
  }

  /** Starts a write on a database: live, and the user can edit. @param {string} id */
  function lockDatabase(id) {
    writable();
    const row = databasePage(id);
    if (row.archived_at) throw new ApiError(409, "page_archived", "The page is in the trash");
    return { row, db: databaseOf(id) };
  }

  /** @param {string} id @returns {import("../types.js").Database} */
  function readDatabase(id) {
    const row = databasePage(id);
    const db = databaseOf(id);
    return {
      id,
      workspace_id: row.workspace_id,
      properties: structuredClone(db.properties),
      views: structuredClone(db.views)
        .map(withDefaults)
        .sort((a, b) =>
          a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
        ),
    };
  }

  /** @param {Record<string, unknown>} input */
  function readProperties(input) {
    const values = input.properties;
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
      throw new ApiError(
        400,
        "invalid_properties",
        "properties must be an object of values by property id",
      );
    }
    return /** @type {Record<string, unknown>} */ (values);
  }

  /**
   * Writes a patch of values into `values`, checked against the schema.
   * @param {Property[]} schema
   * @param {Record<string, PropertyValue>} values
   * @param {Record<string, unknown>} patch
   */
  function applyValues(schema, values, patch) {
    for (const [id, raw] of Object.entries(patch)) {
      const property = schema.find((p) => p.id === id);
      if (!property) throw new ApiError(400, "invalid_value", `The database has no property ${id}`);
      if (property.type === "title")
        throw new ApiError(400, "invalid_value", "Set a row's title with title");
      const value = normalizeValue(property, raw, (userId) => members.some((m) => m.id === userId));
      if (value === null) delete values[id];
      else values[id] = value;
    }
  }

  /** @param {PageRow} row @returns {Row} */
  function toRow(row) {
    return {
      id: row.id,
      database_id: /** @type {string} */ (row.parent_id),
      title: row.title,
      icon: row.icon,
      properties: structuredClone(row.properties ?? {}),
      position: row.position,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** Every row of a database (archived too), in position order. @param {string} id */
  function allRows(id) {
    return [...pages.values()]
      .filter((row) => row.parent_id === id && kindOf(row) === "row")
      .sort((a, b) =>
        a.position < b.position ? -1 : a.position > b.position ? 1 : a.id < b.id ? -1 : 1,
      );
  }

  /** @param {DatabaseRow} db @param {(view: View) => void} change */
  function updateViews(db, change) {
    for (const view of db.views) change(view);
  }

  /**
   * Applies `name`, `type`, `filter`, `sorts`, `columns`, the board
   * settings and `page_size` from a request to a view, like the server's readViewConfig.
   * @param {View} view @param {Record<string, unknown>} input @param {Property[]} schema
   */
  function readViewConfig(view, input, schema) {
    if ("name" in input) {
      if (typeof input.name !== "string") throw invalidView("name must be a string");
      if (input.name.length > MAX_VIEW_NAME)
        throw invalidView(`View names are at most ${MAX_VIEW_NAME} characters`);
      view.name = input.name;
    }
    if ("filter" in input) view.filter = checkFilter(parseFilter(input.filter), schema);
    if ("sorts" in input) view.sorts = input.sorts === null ? [] : parseSorts(input.sorts, schema);
    if ("columns" in input)
      view.columns = input.columns === null ? [] : parseColumns(input.columns, schema);
    const setType = "type" in input;
    if (setType) {
      if (input.type !== "table" && input.type !== "board")
        throw invalidView("A view's type is table or board");
      view.type = input.type;
    }
    if ("group_by" in input) {
      const groupBy = parseGroupBy(input.group_by, schema);
      // Another property's hidden options mean nothing.
      if (groupBy !== view.group_by) view.hidden_groups = [];
      view.group_by = groupBy;
    } else if (setType && view.type === "board" && view.group_by === null) {
      view.group_by = defaultGroupBy(schema);
      view.hidden_groups = [];
    }
    if ("card_properties" in input)
      view.card_properties = parseCardProperties(input.card_properties, schema);
    if ("hidden_groups" in input)
      view.hidden_groups = parseHiddenGroups(
        input.hidden_groups,
        schema.find((p) => p.id === view.group_by),
      );
    if ("page_size" in input) view.page_size = parsePageSize(input.page_size);
  }

  /** @param {DatabaseRow} db @param {string} propertyId */
  function propertyOf(db, propertyId) {
    const property = db.properties.find((p) => p.id === propertyId);
    if (!property)
      throw new ApiError(404, "property_not_found", "The database has no such property");
    return property;
  }

  return {
    /** @returns {DbState} */
    snapshot() {
      return structuredClone({
        workspaces: [...workspaces.values()],
        pages: [...pages.values()],
        docs: Object.fromEntries(docs),
        databases: Object.fromEntries(databases),
        members,
        texts: Object.fromEntries(texts),
        shares: Object.fromEntries(
          [...shares].map(([id, people]) => [id, Object.fromEntries(people)]),
        ),
        invites: Object.fromEntries(
          [...invites].map(([id, list]) => [id, Object.fromEntries(list)]),
        ),
        public: [...publicPages],
        files: Object.fromEntries(files),
      });
    },

    // Search (the server's search.go)

    /**
     * Live pages whose title starts with, contains, has every word of, or
     * has the letters of the query in order; then those whose title and
     * text together have every word. Recently edited first within each.
     * @param {string} query
     * @param {number} [limit]
     * @returns {import("../types.js").SearchResult[]}
     */
    search(query, limit = 20) {
      const max = limit > 0 && limit <= 50 ? limit : 20;
      const q = query.trim().toLowerCase().slice(0, 200);
      const words = q.split(/\s+/).filter(Boolean).slice(0, 8);
      const letters = [...q.replace(/\s+/g, "")];
      /** @param {string} title */
      const inOrder = (title) => {
        let at = 0;
        for (const letter of letters) {
          at = title.indexOf(letter, at);
          if (at < 0) return false;
          at += letter.length;
        }
        return true;
      };
      /** @param {PageRow} row */
      const rank = (row) => {
        const title = row.title.toLowerCase();
        const text = (texts.get(row.id) ?? "").toLowerCase();
        if (q === "" || title.startsWith(q)) return 0;
        if (title.includes(q)) return 1;
        if (words.every((w) => title.includes(w))) return 2;
        if (inOrder(title)) return 3;
        if (words.every((w) => `${title} ${text}`.includes(w))) return 4;
        return -1;
      };
      return [...pages.values()]
        .filter((row) => !row.archived_at)
        .map((row) => ({ row, rank: rank(row) }))
        .filter(({ rank: r }) => r >= 0)
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            (a.row.updated_at < b.row.updated_at
              ? 1
              : a.row.updated_at > b.row.updated_at
                ? -1
                : a.row.id < b.row.id
                  ? -1
                  : 1),
        )
        .slice(0, max)
        .map(({ row }) => {
          /** @type {string[]} */
          const path = [];
          for (
            let p = row.parent_id ? pages.get(row.parent_id) : undefined;
            p;
            p = p.parent_id ? pages.get(p.parent_id) : undefined
          )
            path.unshift(p.title);
          const text = texts.get(row.id);
          const snippet =
            text && words.length > 0 && !row.title.toLowerCase().includes(q)
              ? snippetOf(text, words)
              : null;
          return {
            id: row.id,
            workspace_id: row.workspace_id,
            parent_id: row.parent_id,
            title: row.title,
            icon: row.icon,
            kind: kindOf(row),
            path,
            snippet,
            updated_at: row.updated_at,
          };
        });
    },

    /** @param {string} id @param {Record<string, unknown>} input */
    savePageText(id, input) {
      writable();
      livePage(id);
      if (typeof input.text !== "string")
        throw new ApiError(400, "invalid_text", "text must be a string");
      texts.set(id, input.text.slice(0, 256 << 10));
    },

    // Sharing (the server's sharing.go). The mock user's own role is the
    // dev menu's; the others' are worked out like the server does.

    /** @param {string} id @returns {import("../types.js").Sharing} */
    getSharing(id) {
      return readSharing(page(id));
    },

    /** @param {string} id @param {Record<string, unknown>} input */
    invite(id, input) {
      const row = sharable(id);
      const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        throw new ApiError(400, "invalid_email", "That isn't an email address");
      const role = shareRole(input.role);
      const userId = Object.entries(MOCK_EMAILS).find(([, e]) => e === email)?.[0];
      if (userId) setShare(row, userId, role);
      else {
        const list = invites.get(id) ?? new Map();
        list.set(email, { role, created_at: list.get(email)?.created_at ?? now() });
        invites.set(id, list);
      }
      return readSharing(row);
    },

    /** @param {string} id @param {string} email */
    cancelInvite(id, email) {
      const row = sharable(id);
      if (!invites.get(id)?.delete(email.toLowerCase()))
        throw new ApiError(
          404,
          "invite_not_found",
          "There's no invite for this email on this page",
        );
      return readSharing(row);
    },

    /** @param {string} id @param {string} userId @param {Record<string, unknown>} input */
    setPersonRole(id, userId, input) {
      const row = sharable(id);
      const role = shareRole(input.role);
      if (!readSharing(row).people.some((p) => p.user_id === userId))
        throw new ApiError(
          404,
          "person_not_found",
          "This person has no access to the page to change",
        );
      setShare(row, userId, role);
      return readSharing(row);
    },

    /** @param {string} id @param {string} userId */
    removePerson(id, userId) {
      const row = sharable(id);
      if (userId === MOCK_USER_ID)
        throw new ApiError(400, "own_role", "You can't change your own access");
      if (!shares.get(id)?.delete(userId))
        throw new ApiError(404, "share_not_found", "Nothing was set for this person on this page");
      return readSharing(row);
    },

    /** @param {string} id @param {Record<string, unknown>} input */
    setPublic(id, input) {
      const row = sharable(id);
      if (typeof input.enabled !== "boolean")
        throw new ApiError(400, "invalid_public", "enabled must be true or false");
      if (input.enabled) publicPages.add(id);
      else publicPages.delete(id);
      return readSharing(row);
    },

    /** Nothing is shared with the mock user from elsewhere. @returns {import("../types.js").SharedPage[]} */
    listShared() {
      return [];
    },

    // Files (the server's files.go)

    /** @param {Record<string, unknown>} input @returns {import("../types.js").UploadTicket} */
    createUpload(input) {
      const types = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"];
      if (typeof input.page_id !== "string" || !input.page_id)
        throw new ApiError(400, "invalid_page_id", "page_id is required");
      if (typeof input.content_type !== "string" || !types.includes(input.content_type)) {
        throw new ApiError(
          415,
          "unsupported_type",
          "Only PNG, JPEG, GIF, WebP and AVIF images can be uploaded",
        );
      }
      if (!Number.isInteger(input.size) || /** @type {number} */ (input.size) <= 0)
        throw new ApiError(400, "invalid_size", "size must be the file's size in bytes");
      if (/** @type {number} */ (input.size) > 20 << 20)
        throw new ApiError(413, "file_too_large", "Files can be at most 20 MB");
      writable();
      livePage(input.page_id);
      const id = newId();
      const token = newId();
      files.set(id, {
        page_id: input.page_id,
        name: typeof input.name === "string" && input.name ? input.name.slice(0, 255) : "image",
        content_type: input.content_type,
        size: /** @type {number} */ (input.size),
        token,
        uploaded: false,
      });
      return {
        id,
        upload_url: `/v1/files/${id}/content?token=${token}`,
        method: "PUT",
        headers: { "Content-Type": input.content_type },
        url: `/v1/files/${id}`,
      };
    },

    /**
     * An upload URL's PUT: checks it like the server, and marks it done.
     * @param {string} id @param {string} token @param {string} contentType @param {number} size
     */
    storeUpload(id, token, contentType, size) {
      const file = files.get(id);
      if (!file) throw new ApiError(404, "file_not_found", "File not found");
      if (!file.token || file.token !== token || file.uploaded)
        throw new ApiError(
          403,
          "invalid_upload_token",
          "The upload URL isn't valid (it works once)",
        );
      if (contentType !== file.content_type)
        throw new ApiError(
          400,
          "invalid_type",
          `Content-Type must be the type the upload URL was made for: ${file.content_type}`,
        );
      if (size !== file.size)
        throw new ApiError(
          400,
          "invalid_size",
          `The file must be exactly ${file.size} bytes, as announced`,
        );
      file.uploaded = true;
      file.token = null;
    },

    /** @returns {Workspace[]} */
    listWorkspaces() {
      return [...workspaces.values()];
    },

    /**
     * @param {string} workspaceId
     * @param {string | null} parentId
     * @returns {TreeNode[]}
     */
    tree(workspaceId, parentId) {
      workspace(workspaceId);
      if (parentId !== null) {
        const parent = page(parentId);
        if (parent.workspace_id !== workspaceId)
          throw new ApiError(404, "page_not_found", "Page not found");
      }
      return treeChildren(workspaceId, parentId).map(toNode);
    },

    /**
     * Pages trashed directly, newest first.
     * @param {string} workspaceId
     * @returns {Page[]}
     */
    trash(workspaceId) {
      workspace(workspaceId);
      return [...pages.values()]
        .filter(
          (row) => row.workspace_id === workspaceId && row.archived_at && row.trash_root === row.id,
        )
        .sort((a, b) => ((a.archived_at ?? "") < (b.archived_at ?? "") ? 1 : -1))
        .map(toPage);
    },

    /**
     * Live pages whose title contains `query` (any case): titles starting
     * with it first, then the most recently edited. Like the server's
     * `searchPages`.
     * @param {string} workspaceId @param {string} query @param {number} [limit]
     * @returns {import("../types.js").PageMatch[]}
     */
    searchPages(workspaceId, query, limit = 20) {
      workspace(workspaceId);
      const q = query.toLowerCase();
      const max = limit > 0 && limit <= 50 ? limit : 20;
      return [...pages.values()]
        .filter(
          (row) =>
            row.workspace_id === workspaceId &&
            !row.archived_at &&
            row.title.toLowerCase().includes(q),
        )
        .map((row) => ({ row, prefix: row.title.toLowerCase().startsWith(q) }))
        .sort(
          (a, b) =>
            Number(b.prefix) - Number(a.prefix) ||
            (a.row.updated_at < b.row.updated_at
              ? 1
              : a.row.updated_at > b.row.updated_at
                ? -1
                : a.row.id < b.row.id
                  ? -1
                  : 1),
        )
        .slice(0, max)
        .map(({ row }) => {
          /** @type {string[]} */
          const path = [];
          for (
            let p = row.parent_id ? pages.get(row.parent_id) : undefined;
            p;
            p = p.parent_id ? pages.get(p.parent_id) : undefined
          )
            path.unshift(p.title);
          return { id: row.id, parent_id: row.parent_id, title: row.title, icon: row.icon, path };
        });
    },

    /** @param {string} id @returns {Page} */
    getPage(id) {
      return toPage(page(id));
    },

    /**
     * @param {Record<string, unknown>} input
     * @returns {Page}
     */
    createPage(input) {
      writable();
      validateFields(input);
      const workspaceId = String(input.workspace_id ?? "");
      workspace(workspaceId);
      const parentId = typeof input.parent_id === "string" ? input.parent_id : null;
      if (parentId !== null) {
        const parent = livePage(parentId);
        if (parent.workspace_id !== workspaceId)
          throw new ApiError(400, "invalid_parent", "Parent is in another workspace");
        if (kindOf(parent) === "database") throw databaseParent();
      }
      if ("kind" in input && input.kind !== "page" && input.kind !== "database") {
        throw new ApiError(
          400,
          "invalid_kind",
          'kind must be "page" or "database" (rows are added with POST /v1/databases/{id}/rows)',
        );
      }
      const kind = input.kind === "database" ? "database" : "page";
      const requestedId = typeof input.id === "string" && input.id ? input.id : null;
      const existing = requestedId ? pages.get(requestedId) : undefined;
      if (existing) {
        // A retried create: same page, same answer.
        if (existing.workspace_id === workspaceId && existing.parent_id === parentId)
          return toPage(existing);
        throw new ApiError(409, "id_conflict", "A different page already has this id");
      }
      const afterId =
        "after_id" in input ? /** @type {string | null} */ (input.after_id ?? null) : undefined;
      const position = positionFor(workspaceId, parentId, afterId);
      const id = requestedId ?? newId();
      const timestamp = now();
      /** @type {PageRow} */
      const row = {
        id,
        workspace_id: workspaceId,
        parent_id: parentId,
        title: typeof input.title === "string" ? input.title : "",
        icon: /** @type {string | null} */ (input.icon ?? null),
        cover: /** @type {string | null} */ (input.cover ?? null),
        position,
        archived_at: null,
        trash_root: null,
        created_at: timestamp,
        updated_at: timestamp,
        kind,
        properties: {},
      };
      pages.set(id, row);
      if (kind === "database") initDatabase(id);
      return toPage(row);
    },

    /**
     * @param {string} id
     * @param {Record<string, unknown>} patch
     * @returns {Page}
     */
    updatePage(id, patch) {
      writable();
      validateFields(patch);
      const row = livePage(id);
      if ("properties" in patch) {
        if (kindOf(row) !== "row")
          throw new ApiError(400, "invalid_properties", "Only a database's rows have properties");
        const values = readProperties(patch);
        const db = databaseOf(/** @type {string} */ (row.parent_id));
        const next = { ...(row.properties ?? {}) };
        applyValues(db.properties, next, /** @type {Record<string, unknown>} */ (values));
        row.properties = next;
      }
      if (typeof patch.title === "string") row.title = patch.title;
      if ("icon" in patch) row.icon = /** @type {string | null} */ (patch.icon ?? null);
      if ("cover" in patch) row.cover = /** @type {string | null} */ (patch.cover ?? null);
      touch(id);
      return toPage(row);
    },

    /**
     * Archives the page and its live descendants.
     * @param {string} id
     */
    trashPage(id) {
      writable();
      const row = livePage(id);
      const timestamp = now();
      for (const item of [row, ...descendants(id)]) {
        if (item.archived_at) continue;
        item.archived_at = timestamp;
        item.trash_root = id;
      }
    },

    /**
     * Deletes an archived page and everything under it.
     * @param {string} id
     */
    deleteForever(id) {
      writable();
      const row = page(id);
      if (!row.archived_at)
        throw new ApiError(409, "not_archived", "Move the page to the trash first");
      for (const item of [row, ...descendants(id)]) {
        pages.delete(item.id);
        docs.delete(item.id);
        databases.delete(item.id);
        texts.delete(item.id);
        shares.delete(item.id);
        invites.delete(item.id);
        publicPages.delete(item.id);
      }
    },

    /**
     * @param {string} id
     * @param {Record<string, unknown>} input
     * @returns {Page}
     */
    movePage(id, input) {
      writable();
      const row = livePage(id);
      if (!("parent_id" in input) || !("after_id" in input)) {
        throw new ApiError(
          400,
          "invalid_move",
          "parent_id and after_id are required (null is allowed)",
        );
      }
      const parentId = /** @type {string | null} */ (input.parent_id ?? null);
      const afterId = /** @type {string | null} */ (input.after_id ?? null);
      if (kindOf(row) === "row")
        throw new ApiError(400, "invalid_move", "Rows stay in their database");
      if (parentId !== null) {
        const parent = livePage(parentId);
        if (parent.workspace_id !== row.workspace_id)
          throw new ApiError(400, "invalid_parent", "Parent is in another workspace");
        if (kindOf(parent) === "database") throw databaseParent();
        if (parentId === id || descendants(id).some((item) => item.id === parentId)) {
          throw new ApiError(
            400,
            "invalid_move",
            "A page can't move into itself or its own subpages",
          );
        }
      }
      if (afterId === id) throw new ApiError(400, "invalid_after", "A page can't go after itself");
      row.position = positionFor(row.workspace_id, parentId, afterId, id);
      row.parent_id = parentId;
      touch(id);
      return toPage(row);
    },

    /**
     * Brings back the page and what was trashed together with it under it.
     * A page whose parent is gone or archived comes back at the top level.
     * @param {string} id
     * @returns {Page}
     */
    restorePage(id) {
      writable();
      const row = page(id);
      if (!row.archived_at) return toPage(row);
      const root = row.trash_root;
      for (const item of [row, ...descendants(id)]) {
        if (item.trash_root !== root) continue;
        item.archived_at = null;
        item.trash_root = null;
      }
      const parent = row.parent_id ? pages.get(row.parent_id) : null;
      if (row.parent_id && (!parent || parent.archived_at)) {
        row.parent_id = null;
        row.position = positionFor(row.workspace_id, null, undefined, id);
        // A row without its database is an ordinary page.
        if (kindOf(row) === "row") {
          row.kind = "page";
          row.properties = {};
        }
      }
      touch(id);
      return toPage(row);
    },

    /**
     * The page's document snapshot (base64), or null when it has none yet.
     * Archived pages can be read.
     * @param {string} id
     * @returns {{ snapshot: string | null }}
     */
    getDoc(id) {
      page(id);
      return { snapshot: docs.get(id) ?? null };
    },

    /**
     * Merges an update (base64) into the page's document, like the server
     * (leaf-backend/docstore.go): an update that depends on changes the
     * document doesn't have is refused with 409 `doc_gap`.
     * @param {string} id
     * @param {Record<string, unknown>} input
     * @returns {{ state_vector: string }}
     */
    saveDoc(id, input) {
      writable();
      livePage(id);
      const invalid = new ApiError(
        400,
        "invalid_update",
        "The update isn't a valid document update",
      );
      if (typeof input.update !== "string") throw invalid;
      const stored = docs.get(id);
      const doc = stored
        ? Doc.fromSnapshot(base64ToBytes(stored), { clientId: 1 })
        : new Doc({ clientId: 1 });
      const before = doc.encodeStateVector();
      try {
        doc.applyUpdate(base64ToBytes(input.update));
      } catch {
        throw invalid;
      }
      if (doc.pendingCount > 0) {
        throw new ApiError(
          409,
          "doc_gap",
          "The update depends on changes the server doesn't have; resend from its state vector",
        );
      }
      const after = doc.encodeStateVector();
      if (bytesToBase64(after) !== bytesToBase64(before)) {
        const snapshot = doc.encodeSnapshot();
        if (snapshot.length > maxDocSize)
          throw new ApiError(413, "doc_too_large", "The document is too large");
        docs.set(id, bytesToBase64(snapshot));
        touch(id);
      }
      return { state_vector: bytesToBase64(after) };
    },

    /**
     * Copies the page and its live subtree. The copy goes right after the
     * original and is titled "<title> (copy)".
     * @param {string} id
     * @param {Record<string, unknown>} input `id`: the copy's id.
     * @returns {Page}
     */
    duplicatePage(id, input) {
      writable();
      const source = livePage(id);
      const copyId = typeof input.id === "string" && input.id ? input.id : newId();
      if (pages.has(copyId)) throw new ApiError(409, "id_conflict", "A page already has this id");
      const timestamp = now();
      /**
       * @param {PageRow} from
       * @param {string} newId_
       * @param {string | null} parentId
       * @param {string} position
       * @param {string} title
       */
      const copy = (from, newId_, parentId, position, title) => {
        /** @type {PageRow} */
        const row = {
          ...structuredClone(from),
          id: newId_,
          parent_id: parentId,
          position,
          title,
          created_at: timestamp,
          updated_at: timestamp,
        };
        pages.set(newId_, row);
        const doc = docs.get(from.id);
        if (doc !== undefined) docs.set(newId_, doc);
        const text = texts.get(from.id);
        if (text !== undefined) texts.set(newId_, text);
        const db = databases.get(from.id);
        if (db)
          databases.set(newId_, {
            properties: structuredClone(db.properties),
            views: db.views.map((view) => ({ ...structuredClone(view), id: newId() })),
          });
        for (const child of children(from.workspace_id, from.id))
          copy(child, newId(), newId_, child.position, child.title);
        return row;
      };
      const root = copy(
        source,
        copyId,
        source.parent_id,
        positionFor(source.workspace_id, source.parent_id, source.id),
        `${source.title || "Untitled"} (copy)`,
      );
      return toPage(root);
    },

    /** @param {string} id */
    getDatabase(id) {
      return readDatabase(id);
    },

    /**
     * Dev menu: adds made-up rows (values for the sample database's
     * properties; others stay empty). Returns the database's row count.
     * @param {string} id @param {number} count
     */
    addGeneratedRows(id, count) {
      const { row: dbRow, db } = lockDatabase(id);
      const existing = allRows(id);
      const timestamp = now();
      const known = new Set(db.properties.map((p) => p.id));
      for (const row of makeRoadmapRows(count, {
        start: existing.length,
        after: existing.at(-1)?.position ?? null,
      })) {
        /** @type {Record<string, PropertyValue>} */
        const values = {};
        for (const [key, value] of Object.entries(row.properties)) {
          const property = db.properties.find((p) => p.id === key);
          if (!known.has(key) || !property) continue;
          try {
            const normalized = normalizeValue(property, value, (userId) =>
              members.some((m) => m.id === userId),
            );
            if (normalized !== null) values[key] = normalized;
          } catch {
            // Not a value this database's property takes.
          }
        }
        const rowId = pages.has(row.id) ? newId() : row.id;
        pages.set(rowId, {
          id: rowId,
          workspace_id: dbRow.workspace_id,
          parent_id: id,
          title: row.title,
          icon: null,
          cover: null,
          position: row.position,
          archived_at: null,
          trash_root: null,
          created_at: timestamp,
          updated_at: timestamp,
          kind: "row",
          properties: values,
        });
      }
      return allRows(id).length;
    },

    /** @param {string} workspaceId @returns {Member[]} */
    listMembers(workspaceId) {
      workspace(workspaceId);
      return structuredClone(members);
    },

    /** @param {Record<string, unknown>} input */
    updateProfile(input) {
      for (const [field, max] of /** @type {const} */ ([
        ["name", 200],
        ["avatar_url", 2000],
      ])) {
        const value = input[field];
        if (
          value !== undefined &&
          value !== null &&
          (typeof value !== "string" || value.length > max)
        ) {
          throw new ApiError(
            400,
            `invalid_${field}`,
            `${field} must be null or a string of at most ${max} characters`,
          );
        }
      }
      const me = members.find((m) => m.id === MOCK_USER_ID);
      if (me) {
        if ("name" in input) me.name = /** @type {string | null} */ (input.name ?? null);
        if ("avatar_url" in input)
          me.avatar_url = /** @type {string | null} */ (input.avatar_url ?? null);
      }
      return { id: MOCK_USER_ID, name: me?.name ?? null, avatar_url: me?.avatar_url ?? null };
    },

    /**
     * @param {string} id The database.
     * @param {Record<string, unknown>} input
     * @returns {Row}
     */
    createRow(id, input) {
      const { row: dbRow, db } = lockDatabase(id);
      validateFields(input);
      const requestedId = typeof input.id === "string" && input.id ? input.id : null;
      if (requestedId !== null && !isValidId(requestedId))
        throw new ApiError(400, "invalid_id", "id must be 1–64 letters, digits, '-' or '_'");
      const existing = requestedId ? pages.get(requestedId) : undefined;
      if (existing) {
        if (kindOf(existing) === "row" && existing.parent_id === id) return toRow(existing);
        throw new ApiError(409, "id_conflict", "A different page already has this id");
      }
      /** @type {Record<string, PropertyValue>} */
      const values = {};
      if ("properties" in input) applyValues(db.properties, values, readProperties(input));
      if (
        "after_id" in input &&
        input.after_id !== null &&
        (typeof input.after_id !== "string" || input.after_id === "")
      ) {
        throw new ApiError(400, "invalid_after", "after_id isn't a page among the new siblings");
      }
      const afterId =
        "after_id" in input ? /** @type {string | null} */ (input.after_id ?? null) : undefined;
      const position = positionFor(dbRow.workspace_id, id, afterId);
      const timestamp = now();
      /** @type {PageRow} */
      const row = {
        id: requestedId ?? newId(),
        workspace_id: dbRow.workspace_id,
        parent_id: id,
        title: typeof input.title === "string" ? input.title : "",
        icon: /** @type {string | null} */ (input.icon ?? null),
        cover: null,
        position,
        archived_at: null,
        trash_root: null,
        created_at: timestamp,
        updated_at: timestamp,
        kind: "row",
        properties: values,
      };
      pages.set(row.id, row);
      return toRow(row);
    },

    /**
     * @param {string} id The database.
     * @param {Record<string, unknown>} input `{ filter?, sorts?, offset?, limit? }`
     * @returns {import("../types.js").RowPage}
     */
    queryRows(id, input) {
      databasePage(id);
      const db = databaseOf(id);
      const filter = parseFilter(input.filter);
      const sorts =
        input.sorts === undefined || input.sorts === null
          ? []
          : parseSorts(input.sorts, db.properties);
      for (const field of ["offset", "limit"]) {
        const value = input[field];
        if (
          value !== undefined &&
          value !== null &&
          (!Number.isInteger(value) || /** @type {number} */ (value) < 0)
        ) {
          throw new ApiError(400, "invalid_query", `${field} must be a whole number, 0 or more`);
        }
      }
      const offset = /** @type {number | undefined} */ (input.offset) ?? 0;
      let limit = /** @type {number | undefined} */ (input.limit) ?? 0;
      if (limit <= 0) limit = QUERY_DEFAULT_LIMIT;
      if (limit > QUERY_MAX_LIMIT) limit = QUERY_MAX_LIMIT;
      const group = parseGroup(input.group, db.properties);
      const rows = allRows(id)
        .filter((row) => !row.archived_at)
        .map(toRow);
      return runQuery(rows, db.properties, { filter, sorts, group, offset, limit });
    },

    /**
     * A card moved on a board: its values (its column) and its place in the
     * manual order, together, like the server's moveRow.
     * @param {string} id The database.
     * @param {string} rowId
     * @param {Record<string, unknown>} input `{ after_id?, properties? }`
     * @returns {Row}
     */
    moveRow(id, rowId, input) {
      const { row: dbRow, db } = lockDatabase(id);
      const row = pages.get(rowId);
      if (!row || kindOf(row) !== "row" || row.parent_id !== id)
        throw new ApiError(404, "row_not_found", "The database has no such row");
      if (row.archived_at) throw new ApiError(409, "page_archived", "The page is in the trash");
      if (
        "after_id" in input &&
        input.after_id !== null &&
        (typeof input.after_id !== "string" || input.after_id === "")
      ) {
        throw new ApiError(400, "invalid_after", "after_id isn't a page among the new siblings");
      }
      if (input.after_id === rowId)
        throw new ApiError(400, "invalid_after", "A row can't go after itself");
      const values = { ...(row.properties ?? {}) };
      if ("properties" in input) applyValues(db.properties, values, readProperties(input));
      const position =
        "after_id" in input
          ? positionFor(
              dbRow.workspace_id,
              id,
              /** @type {string | null} */ (input.after_id ?? null),
              rowId,
            )
          : row.position;
      row.properties = values;
      row.position = position;
      touch(rowId);
      return toRow(row);
    },

    /**
     * @param {string} id The database.
     * @param {Record<string, unknown>} input `{ id, name, type, options? }`
     */
    addProperty(id, input) {
      const { db } = lockDatabase(id);
      if (!isValidId(input.id))
        throw invalidProperty("Property ids are 1–64 letters, digits, '-' or '_'");
      const existing = db.properties.find((p) => p.id === input.id);
      if (existing) {
        if (existing.type === input.type) return readDatabase(id);
        throw new ApiError(409, "id_conflict", "The database already has a property with this id");
      }
      if (db.properties.length >= MAX_PROPERTIES)
        throw invalidProperty(`A database has at most ${MAX_PROPERTIES} properties`);
      validatePropertyName(input.name);
      const type = /** @type {Property["type"]} */ (input.type);
      if (!PROPERTY_TYPES.some((t) => t.type === type))
        throw invalidProperty(`Unknown property type ${input.type}`);
      /** @type {Property} */
      const property = {
        id: /** @type {string} */ (input.id),
        name: /** @type {string} */ (input.name),
        type,
      };
      if (isOptionType(type)) {
        if (input.options !== undefined && input.options !== null)
          property.options = validateOptions(type, input.options);
        else property.options = type === "status" ? defaultStatusOptions(newId) : [];
      }
      db.properties.push(property);
      return readDatabase(id);
    },

    /**
     * @param {string} id The database.
     * @param {string} propertyId
     * @param {Record<string, unknown>} input `{ name?, type?, options? }`
     */
    updateProperty(id, propertyId, input) {
      const { db } = lockDatabase(id);
      const property = propertyOf(db, propertyId);
      if ("name" in input) {
        if (typeof input.name !== "string") throw invalidProperty("name must be a string");
        validatePropertyName(input.name);
      }
      if ("type" in input && typeof input.type !== "string")
        throw invalidProperty("type must be a string");
      const type = /** @type {Property["type"] | undefined} */ (input.type);
      const typeChanged = type !== undefined && type !== property.type;
      if (typeChanged) {
        if (!PROPERTY_TYPES.some((t) => t.type === type) && type !== "title")
          throw invalidProperty(`Unknown property type ${type}`);
        if (property.type === "title" || type === "title")
          throw invalidProperty("A property can't change to or from the title type");
      }
      const setOptions = input.options !== undefined && input.options !== null;
      const target = typeChanged ? type : property.type;
      if (setOptions && !isOptionType(target))
        throw invalidProperty("Only select, multi-select and status properties have options");
      if ("name" in input) property.name = /** @type {string} */ (input.name);
      if (!typeChanged && !setOptions) return readDatabase(id);

      const rows = allRows(id);
      let next = property;
      let values = rows.map((row) => ({ id: row.id, value: row.properties?.[propertyId] ?? null }));
      if (typeChanged)
        ({ property: next, values } = changeType(
          property,
          /** @type {Property["type"]} */ (type),
          values,
          newId,
        ));
      if (setOptions) {
        next = { ...next, options: validateOptions(next.type, input.options) };
        values = values.map(({ id: rowId, value }) => ({
          id: rowId,
          value: keepOptions(next, value),
        }));
      }
      db.properties[db.properties.indexOf(property)] = next;
      for (const { id: rowId, value } of values) {
        const row = page(rowId);
        const props = { ...(row.properties ?? {}) };
        if (value === null) delete props[propertyId];
        else props[propertyId] = value;
        row.properties = props;
      }
      // Boards may not be able to group by it any more, or have hidden a removed option.
      updateViews(db, (view) => {
        if (typeChanged) view.filter = pruneFilter(view.filter, propertyId);
        Object.assign(view, fitSchema(withDefaults(view), db.properties));
      });
      return readDatabase(id);
    },

    /** @param {string} id The database. @param {string} propertyId */
    deleteProperty(id, propertyId) {
      const { db } = lockDatabase(id);
      const property = propertyOf(db, propertyId);
      if (property.type === "title") throw invalidProperty("The title property can't be deleted");
      db.properties = db.properties.filter((p) => p.id !== propertyId);
      for (const row of allRows(id)) {
        if (row.properties && propertyId in row.properties) {
          const { [propertyId]: _, ...rest } = row.properties;
          row.properties = rest;
        }
      }
      updateViews(db, (view) => {
        view.filter = pruneFilter(view.filter, propertyId);
        view.sorts = view.sorts.filter((sort) => sort.property_id !== propertyId);
        view.columns = view.columns.filter((column) => column.property_id !== propertyId);
        Object.assign(view, fitSchema(withDefaults(view), db.properties));
      });
      return readDatabase(id);
    },

    /**
     * @param {string} id The database.
     * @param {Record<string, unknown>} input `{ id, name?, type?, filter?, sorts?, columns? }`
     * @returns {View}
     */
    createView(id, input) {
      const { db } = lockDatabase(id);
      if (!isValidId(input.id)) throw invalidView("View ids are 1–64 letters, digits, '-' or '_'");
      const existing = db.views.find((view) => view.id === input.id);
      if (existing) return structuredClone(existing);
      const last = readDatabase(id).views.at(-1)?.position ?? null;
      const view = newView(
        /** @type {string} */ (input.id),
        input.type === "board" ? "Board" : "Table",
        "table",
        keyBetween(last, null),
      );
      const config = { ...input };
      if (config.name === "") delete config.name;
      if (config.type === undefined || config.type === "") delete config.type;
      readViewConfig(view, config, db.properties);
      db.views.push(view);
      return structuredClone(view);
    },

    /**
     * @param {string} id The database.
     * @param {string} viewId
     * @param {Record<string, unknown>} input `{ name?, filter?, sorts?, columns? }`
     * @returns {View}
     */
    updateView(id, viewId, input) {
      const { db } = lockDatabase(id);
      const view = db.views.find((v) => v.id === viewId);
      if (!view) throw new ApiError(404, "view_not_found", "The database has no such view");
      const next = withDefaults(structuredClone(view));
      readViewConfig(next, input, db.properties);
      Object.assign(view, next);
      return structuredClone(view);
    },

    /** @param {string} id The database. @param {string} viewId */
    deleteView(id, viewId) {
      const { db } = lockDatabase(id);
      if (!db.views.some((v) => v.id === viewId))
        throw new ApiError(404, "view_not_found", "The database has no such view");
      if (db.views.length <= 1)
        throw new ApiError(409, "last_view", "A database keeps at least one view");
      db.views = db.views.filter((v) => v.id !== viewId);
    },
  };
}

/** @typedef {ReturnType<typeof createDb>} MockDb */

/**
 * Text around the first of `words` found in `text`, with "…" where it's cut.
 * @param {string} text @param {string[]} words
 */
function snippetOf(text, words) {
  const lower = text.toLowerCase();
  let at = -1;
  let length = 0;
  for (const w of words) {
    const i = lower.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) [at, length] = [i, w.length];
  }
  if (at < 0) return null;
  let start = Math.max(0, at - 60);
  let end = Math.min(text.length, at + length + 120);
  while (start > 0 && start < at && !/\s/.test(text[start - 1])) start++;
  while (end < text.length && end > at + length && !/\s/.test(text[end])) end--;
  return `${start > 0 ? "…" : ""}${text.slice(start, end).split(/\s+/).filter(Boolean).join(" ")}${end < text.length ? "…" : ""}`;
}
