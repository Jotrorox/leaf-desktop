// @ts-check
import { ApiError } from "../client.js";
import { MOCK_USER_ID } from "./db.js";

/**
 * The mock backend's request handling: routes `(method, path, body)` to the
 * db like the real server would, with simulated latency (abortable, like
 * fetch) and, when asked, a failing write every Nth time so optimistic
 * rollback can be exercised. Requests and responses go through JSON, so
 * nothing is shared by reference with the caller. Pure apart from timers:
 * runs under `node --test`.
 */

/** @typedef {import("./db.js").MockDb} MockDb */
/** @typedef {import("../client.js").HttpMethod} HttpMethod */
/** @typedef {import("../client.js").RequestOptions} RequestOptions */

/**
 * @typedef {object} MockConfig
 * @property {number} latency Average delay per request in ms; each request takes 50–150% of it.
 * @property {number} failEvery Every Nth write (POST, PATCH, DELETE) fails with a 500 before changing anything. 0: never.
 * @property {boolean} [offline] Every request fails as if the network were down (and live sync drops).
 * @property {import("../roles.js").Role} [role] Your role on every page ("owner" by default): view and comment make pages read-only.
 */

/** @type {MockConfig} */
export const DEFAULT_MOCK_CONFIG = { latency: 300, failEvery: 0, offline: false };

const ME = { id: MOCK_USER_ID, name: "Mock User", email: "mock@leaf.test", avatar_url: null };

/**
 * Connected apps the mock starts with (`GET /v1/me/connections`): one with a
 * client id metadata document, one dynamically registered. Not persisted.
 * @returns {import("../connections.js").Connection[]}
 */
function seedConnections() {
  return [
    {
      client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      name: "claude.ai",
      scopes: ["offline_access", "leaf:read", "leaf:write"],
      first_seen: "2026-10-20T09:12:00.000Z",
      last_seen: "2026-10-22T08:40:00.000Z",
      disconnected_at: null,
    },
    {
      client_id: "Hq3vX9mT2kLp8sRw",
      name: "",
      scopes: ["offline_access", "leaf:read"],
      first_seen: "2026-10-18T14:03:00.000Z",
      last_seen: "2026-10-19T16:27:00.000Z",
      disconnected_at: null,
    },
  ];
}

/**
 * @param {{
 *   db: () => MockDb,
 *   config?: () => MockConfig,
 *   random?: () => number,
 *   onWrite?: () => void,
 *   onFile?: (id: string, file: Blob) => void,
 * }} options `db` and `config` are read per request, so they can be swapped
 *   (reset) and changed (from the dev menu) at any time. `onWrite` runs after
 *   every successful write (to persist). `onFile` gets an upload's bytes.
 */
export function createMockServer({
  db,
  config = () => DEFAULT_MOCK_CONFIG,
  random = Math.random,
  onWrite,
  onFile,
}) {
  let writes = 0;
  const connections = seedConnections();

  /**
   * @template [T=unknown]
   * @param {HttpMethod} method
   * @param {string} path
   * @param {RequestOptions} [options]
   * @returns {Promise<T>}
   */
  async function request(method, path, { body, signal } = {}) {
    const { latency, failEvery, offline } = config();
    await delay(latency > 0 ? latency * (0.5 + random()) : 0, signal);
    if (offline)
      throw new ApiError(0, "network_error", "Can't reach the server (mock API is offline)");
    const write = method !== "GET";
    if (write && failEvery > 0 && ++writes % failEvery === 0) {
      const which = failEvery === 1 ? "every write" : `every ${ordinal(failEvery)} write`;
      throw new ApiError(500, "mock_failure", `Simulated server error (mock API: ${which} fails)`);
    }
    const input = body === undefined ? {} : JSON.parse(JSON.stringify(body));
    const result = route(db(), method, new URL(path, "http://mock.invalid"), input, connections);
    if (write) onWrite?.();
    return result === undefined ? /** @type {T} */ (undefined) : JSON.parse(JSON.stringify(result));
  }

  /**
   * An upload URL's PUT, with progress over the simulated latency (a few
   * times a request's, as if the bytes took a while).
   * @param {string} path
   * @param {Blob} file
   * @param {import("../files.js").PutOptions} options
   */
  async function putFile(path, file, { headers, onProgress, signal }) {
    const { latency, offline } = config();
    const url = new URL(path, "http://mock.invalid");
    const [, , id, action] = url.pathname.split("/").filter(Boolean);
    if (action !== "content" || !id)
      throw new ApiError(404, "not_found", `No route for PUT ${url.pathname}`);
    const steps = 10;
    for (let step = 1; step <= steps; step++) {
      await delay(latency > 0 ? (latency * 3 * (0.5 + random())) / steps : 0, signal);
      if (offline)
        throw new ApiError(
          0,
          "network_error",
          "Couldn't reach the server to upload (mock API is offline)",
        );
      onProgress?.(Math.round((file.size * step) / steps), file.size);
    }
    db().storeUpload(
      id,
      url.searchParams.get("token") ?? "",
      headers["Content-Type"] ?? "",
      file.size,
    );
    onFile?.(id, file);
    onWrite?.();
  }

  return {
    request,
    putFile,
    /** Resets the write counter, so "every Nth" counts from now. */
    resetWriteCount() {
      writes = 0;
    },
  };
}

/**
 * @param {MockDb} db
 * @param {HttpMethod} method
 * @param {URL} url
 * @param {Record<string, unknown>} body
 * @param {import("../connections.js").Connection[]} connections
 */
function route(db, method, url, body, connections) {
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [version, resource, id, action, extra] = parts;
  /** @param {HttpMethod[]} allowed */
  const only = (...allowed) => {
    if (!allowed.includes(method))
      throw new ApiError(405, "method_not_allowed", `${method} isn't allowed on ${url.pathname}`);
  };

  if (version === "v1" && resource === "me" && parts.length === 2) {
    only("GET", "PATCH", "DELETE");
    // Deleting the account: the mock keeps its data (reset it from the dev menu).
    if (method === "DELETE") return null;
    return method === "GET" ? ME : db.updateProfile(body);
  }

  if (version === "v1" && resource === "me" && id === "connections") {
    if (parts.length === 3) {
      only("GET");
      return [...connections].sort(
        (a, b) =>
          Number(!!a.disconnected_at) - Number(!!b.disconnected_at) ||
          (a.last_seen < b.last_seen ? 1 : -1),
      );
    }
    if (parts.length === 4 && (action === "disconnect" || action === "allow")) {
      only("POST");
      if (typeof body.client_id !== "string" || !body.client_id.trim()) {
        throw new ApiError(
          400,
          "invalid_client_id",
          "client_id must be a connected app's client id",
        );
      }
      const found = connections.find((c) => c.client_id === body.client_id);
      if (!found)
        throw new ApiError(404, "connection_not_found", "No connected app with this client id");
      found.disconnected_at =
        action === "allow" ? null : (found.disconnected_at ?? new Date().toISOString());
      return found;
    }
  }

  if (version === "v1" && resource === "search" && parts.length === 2) {
    only("GET");
    return db.search(
      url.searchParams.get("query") ?? "",
      Number(url.searchParams.get("limit") ?? 0),
    );
  }
  if (version === "v1" && resource === "shared" && parts.length === 2) {
    only("GET");
    return db.listShared();
  }
  if (version === "v1" && resource === "files" && id === "upload-url" && parts.length === 3) {
    only("POST");
    return db.createUpload(body);
  }
  if (version === "v1" && resource === "pages" && id && action === "sharing") {
    if (!extra) {
      only("GET");
      return db.getSharing(id);
    }
    if (extra === "public" && parts.length === 5) {
      only("PUT");
      return db.setPublic(id, body);
    }
    if (extra === "invites" && parts.length === 5) {
      only("POST");
      return db.invite(id, body);
    }
    if (extra === "invites" && parts.length === 6) {
      only("DELETE");
      return db.cancelInvite(id, parts[5]);
    }
    if (extra === "people" && parts.length === 6) {
      only("PUT", "DELETE");
      return method === "PUT"
        ? db.setPersonRole(id, parts[5], body)
        : db.removePerson(id, parts[5]);
    }
  }

  if (version === "v1" && resource === "workspaces" && !extra) {
    if (!id) {
      only("GET");
      return db.listWorkspaces();
    }
    if (action === "tree") {
      only("GET");
      return db.tree(id, url.searchParams.get("parent_id") || null);
    }
    if (action === "trash") {
      only("GET");
      return db.trash(id);
    }
    if (action === "pages") {
      only("GET");
      return db.searchPages(
        id,
        url.searchParams.get("query") ?? "",
        Number(url.searchParams.get("limit") ?? 0),
      );
    }
    if (action === "members") {
      only("GET");
      return db.listMembers(id);
    }
  }

  if (
    version === "v1" &&
    resource === "databases" &&
    id &&
    action === "rows" &&
    extra &&
    parts[5] === "move" &&
    parts.length === 6
  ) {
    only("POST");
    return db.moveRow(id, extra, body);
  }

  if (version === "v1" && resource === "databases" && id && parts.length <= 5) {
    if (!action) {
      only("GET");
      return db.getDatabase(id);
    }
    if (action === "rows" && !extra) {
      only("POST");
      return db.createRow(id, body);
    }
    if (action === "query" && !extra) {
      only("POST");
      return db.queryRows(id, body);
    }
    if (action === "properties") {
      if (!extra) {
        only("POST");
        return db.addProperty(id, body);
      }
      only("PATCH", "DELETE");
      return method === "PATCH" ? db.updateProperty(id, extra, body) : db.deleteProperty(id, extra);
    }
    if (action === "views") {
      if (!extra) {
        only("POST");
        return db.createView(id, body);
      }
      only("PATCH", "DELETE");
      if (method === "PATCH") return db.updateView(id, extra, body);
      db.deleteView(id, extra);
      return undefined;
    }
  }

  if (version === "v1" && resource === "pages" && !extra) {
    if (!id) {
      only("POST");
      return db.createPage(body);
    }
    if (!action) {
      only("GET", "PATCH", "DELETE");
      if (method === "GET") return db.getPage(id);
      if (method === "PATCH") return db.updatePage(id, body);
      if (url.searchParams.get("permanent") === "true") db.deleteForever(id);
      else db.trashPage(id);
      return undefined;
    }
    if (action === "text") {
      only("PUT");
      db.savePageText(id, body);
      return undefined;
    }
    if (action === "doc") {
      only("GET", "POST");
      return method === "GET" ? db.getDoc(id) : db.saveDoc(id, body);
    }
    only("POST");
    if (action === "move") return db.movePage(id, body);
    if (action === "restore") return db.restorePage(id);
    if (action === "duplicate") return db.duplicatePage(id, body);
  }

  throw new ApiError(404, "not_found", `No route for ${method} ${url.pathname}`);
}

/**
 * Resolves after `ms`, or rejects with an AbortError when `signal` aborts first.
 * @param {number} ms
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void>}
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
    if (signal?.aborted) return abort();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** @param {number} n */
function ordinal(n) {
  const suffix =
    n % 10 === 2 && n % 100 !== 12
      ? "nd"
      : n % 10 === 3 && n % 100 !== 13
        ? "rd"
        : n % 10 === 1 && n % 100 !== 11
          ? "st"
          : "th";
  return `${n}${suffix}`;
}
