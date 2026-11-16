// @ts-check
import { request } from "./transport.js";

/**
 * Who has access to a page (docs/sharing.md). Every change answers the
 * page's sharing as it is afterwards.
 */

/** @typedef {import("./types.js").Sharing} Sharing */
/** @typedef {"full_access" | "edit" | "comment" | "view"} ShareRole */

/** @param {string} id */
const enc = (id) => encodeURIComponent(id);

/**
 * `GET /v1/pages/:id/sharing`
 * @param {string} pageId
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<Sharing>}
 */
export function getSharing(pageId, { signal } = {}) {
  return request("GET", `/v1/pages/${enc(pageId)}/sharing`, { signal });
}

/**
 * Gives an email a role on the page: its user's, if they've signed in
 * before, or else a pending invite.
 * `POST /v1/pages/:id/sharing/invites { email, role }`
 * @param {string} pageId @param {string} email @param {ShareRole} role
 * @returns {Promise<Sharing>}
 */
export function invite(pageId, email, role) {
  return request("POST", `/v1/pages/${enc(pageId)}/sharing/invites`, { body: { email, role } });
}

/**
 * `DELETE /v1/pages/:id/sharing/invites/:email`
 * @param {string} pageId @param {string} email
 * @returns {Promise<Sharing>}
 */
export function cancelInvite(pageId, email) {
  return request("DELETE", `/v1/pages/${enc(pageId)}/sharing/invites/${enc(email)}`);
}

/**
 * Sets someone's role on the page (and the pages under it).
 * `PUT /v1/pages/:id/sharing/people/:userId { role }`
 * @param {string} pageId @param {string} userId @param {ShareRole} role
 * @returns {Promise<Sharing>}
 */
export function setPersonRole(pageId, userId, role) {
  return request("PUT", `/v1/pages/${enc(pageId)}/sharing/people/${enc(userId)}`, {
    body: { role },
  });
}

/**
 * Removes what was set for someone on the page: a member goes back to their
 * inherited role, a guest invited here loses access.
 * `DELETE /v1/pages/:id/sharing/people/:userId`
 * @param {string} pageId @param {string} userId
 * @returns {Promise<Sharing>}
 */
export function removePerson(pageId, userId) {
  return request("DELETE", `/v1/pages/${enc(pageId)}/sharing/people/${enc(userId)}`);
}

/**
 * Turns the page's public link on or off.
 * `PUT /v1/pages/:id/sharing/public { enabled }`
 * @param {string} pageId @param {boolean} enabled
 * @returns {Promise<Sharing>}
 */
export function setPublic(pageId, enabled) {
  return request("PUT", `/v1/pages/${enc(pageId)}/sharing/public`, { body: { enabled } });
}

/**
 * Pages shared with the user outside their workspaces.
 * `GET /v1/shared`
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<import("./types.js").SharedPage[]>}
 */
export function listShared({ signal } = {}) {
  return request("GET", "/v1/shared", { signal });
}
