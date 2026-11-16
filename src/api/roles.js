// @ts-check

/**
 * A user's role on a page (`Page.role`, from their workspace membership).
 * The first three can edit; comment and view can only read (comments come
 * later). Mirrors the backend's `canEdit` (store.go).
 * @typedef {"owner" | "full_access" | "edit" | "comment" | "view"} Role
 */

/** @type {readonly Role[]} */
export const ROLES = ["owner", "full_access", "edit", "comment", "view"];

/**
 * Whether a role may change a page. A missing role (a server from before
 * roles) counts as editable; the server has the last word either way.
 * @param {Role | string | undefined} role
 */
export function canEdit(role) {
  return role === undefined || role === "owner" || role === "full_access" || role === "edit";
}
