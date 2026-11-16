// @ts-check
import { request } from "./transport.js";

/**
 * Deletes the signed-in user's account: the workspaces they own with
 * everything in them, their memberships and shares elsewhere, their
 * uploaded files there, and their sign-in account at Clerk. What they wrote
 * in other people's workspaces stays there. `DELETE /v1/me`; the server
 * answers `503 account_deletion_unavailable` when it can't delete sign-in
 * accounts. Safe to retry.
 * @returns {Promise<void>}
 */
export async function deleteAccount() {
  await request("DELETE", "/v1/me");
}
