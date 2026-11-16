// @ts-check
import { request } from "./transport.js";

/**
 * Connected apps: the AI assistants that used the user's account through
 * OAuth (leaf-mcp), and disconnecting them. A disconnected app's requests
 * are refused by the server (`403 app_disconnected`), whatever its token's
 * age, until it's allowed again. Session-only routes: apps can't call them.
 */

/**
 * @typedef {object} Connection
 * @property {string} client_id The OAuth client id: a URL for clients with a metadata document, random otherwise.
 * @property {string} name The client id's host when it's a URL, "" otherwise.
 * @property {string[]} scopes What its latest token allowed (`leaf:read`, `leaf:write`, …).
 * @property {string} first_seen
 * @property {string} last_seen To about a minute.
 * @property {string | null} disconnected_at
 */

/** `GET /v1/me/connections`: connected apps first, most recently used first. @returns {Promise<Connection[]>} */
export function listConnections() {
  return request("GET", "/v1/me/connections");
}

/** Stops an app at once. Idempotent. @param {string} clientId @returns {Promise<Connection>} */
export function disconnectApp(clientId) {
  return request("POST", "/v1/me/connections/disconnect", { body: { client_id: clientId } });
}

/** Lets a disconnected app in again. Idempotent. @param {string} clientId @returns {Promise<Connection>} */
export function allowApp(clientId) {
  return request("POST", "/v1/me/connections/allow", { body: { client_id: clientId } });
}
