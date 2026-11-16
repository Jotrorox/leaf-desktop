// @ts-check
import { createSignal } from "solid-js";

/**
 * The open page's save state, for the top bar. null when no editable
 * document is open.
 */

/**
 * "saving": changes the server hasn't confirmed yet. "offline": no
 * connection, changes wait locally. "error": the page can't be saved (it
 * went to the trash, or is too large). "view-only": the user may only view
 * (or comment on) the page.
 * @typedef {"loading" | "saved" | "saving" | "offline" | "error" | "view-only"} SaveStatus
 */

const [saveStatus, setSaveStatus] = createSignal(/** @type {SaveStatus | null} */ (null));

export { saveStatus, setSaveStatus };
