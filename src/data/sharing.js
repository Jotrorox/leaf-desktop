// @ts-check

import { ApiError } from "../api/client.js";
import * as api from "../api/sharing.js";
import { webUrl } from "../desktop/env.js";
import { createQuery, invalidate, mutate, queryClient } from "../lib/query/index.js";
import { toast } from "../ui/Toast.jsx";
import { keys as pageKeys } from "./pages.js";

/**
 * Sharing (docs/sharing.md): who has access to a page, and pages shared
 * with the user.
 *
 * Cache layout:
 * - `["sharing", pageId]`: Sharing
 * - `["shared"]`: SharedPage[]
 *
 * Changes aren't optimistic (the server works out inherited roles); each
 * answers the page's whole sharing, which replaces the cached one. Since a
 * change on a page can change what its subpages show, the other cached
 * sharings are refetched.
 */

/** @typedef {import("../api/types.js").Sharing} Sharing */
/** @typedef {import("../api/sharing.js").ShareRole} ShareRole */

export const sharingKeys = {
  all: () => ["sharing"],
  /** @param {string} pageId */
  page: (pageId) => ["sharing", pageId],
  shared: () => ["shared"],
};

/** @param {{ key: import("../lib/query/key.js").QueryKey, signal: AbortSignal }} context */
function fetchSharing({ key, signal }) {
  return api.getSharing(/** @type {string} */ (key[1]), { signal });
}

/** @param {{ signal: AbortSignal }} context */
function fetchShared({ signal }) {
  return api.listShared({ signal });
}

/** A page's sharing, while `pageId()` is set. @param {() => string | null | undefined} pageId */
export function useSharing(pageId) {
  return createQuery(
    () => {
      const id = pageId();
      return id ? sharingKeys.page(id) : null;
    },
    fetchSharing,
    { staleTime: 10_000 },
  );
}

/** Pages shared with the user outside their workspaces (the sidebar's "Shared"). */
export function useShared() {
  return createQuery(sharingKeys.shared(), fetchShared, { staleTime: 60_000 });
}

/**
 * Runs a sharing change and puts its answer in the cache. Resolves to
 * whether it worked; a failure shows a toast.
 * @param {string} pageId
 * @param {string} what For the error toast: "Couldn't <what>".
 * @param {() => Promise<Sharing>} run
 */
async function change(pageId, what, run) {
  try {
    const sharing = await run();
    mutate(sharingKeys.page(pageId), sharing);
    // Subpages' (and ancestors') cached sharings may show this change.
    for (const key of queryClient.keys(sharingKeys.all())) {
      if (key[1] !== pageId) void invalidate(key);
    }
    // Your own role can't change, but the page's might show a new state.
    void invalidate(pageKeys.page(pageId));
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    let reason = "Something went wrong.";
    if (error instanceof ApiError)
      reason =
        error.status === 0
          ? "Can't reach the server."
          : /[.!?]$/.test(error.message)
            ? error.message
            : `${error.message}.`;
    toast({ title: `Couldn't ${what}`, description: reason, tone: "danger", duration: 8000 });
    return false;
  }
}

/**
 * @param {string} pageId @param {string} email @param {ShareRole} role
 */
export async function invite(pageId, email, role) {
  const ok = await change(pageId, "invite them", () => api.invite(pageId, email, role));
  if (ok) {
    const sharing = /** @type {Sharing | undefined} */ (
      queryClient.getData(sharingKeys.page(pageId))
    );
    const pending = sharing?.invites.some((i) => i.email === email.trim().toLowerCase());
    toast({
      title: pending ? "Invite saved" : "Shared",
      description: pending
        ? `${email.trim()} gets access when they sign in to leaf with that email.`
        : `${email.trim()} can open the page now.`,
    });
  }
  return ok;
}

/** @param {string} pageId @param {string} email */
export function cancelInvite(pageId, email) {
  return change(pageId, "cancel the invite", () => api.cancelInvite(pageId, email));
}

/** @param {string} pageId @param {string} userId @param {ShareRole} role */
export function setPersonRole(pageId, userId, role) {
  return change(pageId, "change their access", () => api.setPersonRole(pageId, userId, role));
}

/** @param {string} pageId @param {string} userId */
export function removePerson(pageId, userId) {
  return change(pageId, "remove their access", () => api.removePerson(pageId, userId));
}

/** @param {string} pageId @param {boolean} enabled */
export function setPublic(pageId, enabled) {
  return change(pageId, enabled ? "publish the page" : "turn off the public link", () =>
    api.setPublic(pageId, enabled),
  );
}

/** The public link to a page (`/s/:id`, readable without signing in). @param {string} pageId */
export function publicLink(pageId) {
  return webUrl(`/s/${encodeURIComponent(pageId)}`);
}
