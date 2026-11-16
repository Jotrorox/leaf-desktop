// @ts-check
import { createMemo, For, Show } from "solid-js";
import { me } from "../auth/me.js";
import { collaborators, initials, jumpToCollaborator } from "../editor/sync/presence.js";
import Tooltip from "../ui/Tooltip.jsx";
import styles from "./Presence.module.css";

/** Avatars shown before the rest become "+N". */
const MAX_SHOWN = 4;

/**
 * Who else has the open page open: one avatar per person (several tabs of
 * one person are one avatar), ringed in their cursor color. Clicking one
 * scrolls to their cursor.
 */
export default function Presence() {
  const people = createMemo(() => {
    const self = me();
    const myId = self.status === "ready" ? self.data.id : null;
    /** @type {Map<string, import("../editor/sync/presence.js").Collaborator & { you: boolean }>} */
    const byUser = new Map();
    for (const c of collaborators()) {
      const known = byUser.get(c.userId);
      // Prefer a session with a cursor, to jump to.
      if (!known || (!known.cursor && c.cursor))
        byUser.set(c.userId, { ...c, you: c.userId === myId });
    }
    return [...byUser.values()];
  });
  const shown = () => people().slice(0, MAX_SHOWN);
  const hidden = () => people().slice(MAX_SHOWN);
  const label = (/** @type {{ name: string, you: boolean }} */ p) =>
    p.you ? `${p.name} (you, in another tab)` : p.name;

  return (
    <Show when={people().length > 0}>
      <div
        class={styles.presence}
        role="group"
        aria-label={`${people().length} ${people().length === 1 ? "person" : "people"} on this page`}
      >
        <For each={shown()}>
          {(person) => (
            <Tooltip content={label(person)} describe={false}>
              <button
                type="button"
                class={styles.avatar}
                style={{ "--avatar-color": person.color }}
                aria-label={person.cursor ? `${label(person)}: go to their cursor` : label(person)}
                onClick={() => jumpToCollaborator(person.session)}
              >
                <Show
                  when={person.image}
                  fallback={<span aria-hidden="true">{initials(person.name)}</span>}
                >
                  {(src) => <img src={src()} alt="" referrerPolicy="no-referrer" />}
                </Show>
              </button>
            </Tooltip>
          )}
        </For>
        <Show when={hidden().length > 0}>
          <Tooltip content={hidden().map(label).join(", ")} describe={false}>
            <span
              class={styles.more}
              tabIndex={0}
              aria-label={`and ${hidden().map(label).join(", ")}`}
            >
              +{hidden().length}
            </span>
          </Tooltip>
        </Show>
      </div>
    </Show>
  );
}
