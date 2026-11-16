// @ts-check
import { createMemo, createSignal, Show } from "solid-js";
import { session, signOut } from "../auth/clerk.js";
import { me } from "../auth/me.js";
import { navigate } from "../lib/router/index.js";
import { IconHelp, IconSettings, IconSignOut, IconTrash } from "../ui/icons/index.jsx";
import Menu, { MenuGroup, MenuItem, MenuSeparator } from "../ui/Menu.jsx";
import { toast } from "../ui/Toast.jsx";
import { openShortcutsDialog } from "./ShortcutsDialog.jsx";
import { setThemePreference, themePreference } from "./theme.js";
import styles from "./UserMenu.module.css";

/**
 * The signed-in user, from `/v1/me` with Clerk's profile filling the gaps
 * until the backend returns everything.
 */
function currentUser() {
  const s = session();
  const clerkUser = s.status === "signedIn" ? s.user : null;
  const state = me();
  const data = state.status === "ready" ? state.data : null;
  const email = data?.email || clerkUser?.email || "";
  return {
    name: data?.name || clerkUser?.name || email || "Account",
    email,
    imageUrl: data?.avatar_url || clerkUser?.imageUrl || null,
  };
}

/** Sidebar footer button: avatar and name; opens navigation, account and theme options. */
export default function UserMenu() {
  const user = createMemo(currentUser);

  async function onSignOut() {
    try {
      await signOut();
    } catch (err) {
      console.error("Sign-out failed:", err);
      toast({
        title: "Couldn't sign out",
        description: "Check your connection and try again.",
        tone: "danger",
      });
    }
  }

  return (
    <Menu
      label="Account"
      placement="top-start"
      class={styles.menu}
      trigger={(triggerProps) => (
        <button type="button" class={styles.trigger} {...triggerProps}>
          <Avatar name={user().name} imageUrl={user().imageUrl} />
          <span class={styles.text}>
            <span class={styles.name}>{user().name}</span>
            <Show when={user().email && user().email !== user().name}>
              <span class={styles.email}>{user().email}</span>
            </Show>
          </span>
        </button>
      )}
    >
      <MenuItem icon={<IconSettings />} onSelect={() => navigate("/settings")}>
        Settings
      </MenuItem>
      <MenuItem icon={<IconTrash />} onSelect={() => navigate("/trash")}>
        Trash
      </MenuItem>
      <MenuItem icon={<IconHelp />} shortcut="?" onSelect={openShortcutsDialog}>
        Help
      </MenuItem>
      <MenuSeparator />
      <MenuGroup label="Theme">
        <MenuItem
          checked={themePreference() === "system"}
          onSelect={() => setThemePreference("system")}
        >
          System theme
        </MenuItem>
        <MenuItem
          checked={themePreference() === "light"}
          onSelect={() => setThemePreference("light")}
        >
          Light theme
        </MenuItem>
        <MenuItem
          checked={themePreference() === "dark"}
          onSelect={() => setThemePreference("dark")}
        >
          Dark theme
        </MenuItem>
      </MenuGroup>
      <MenuSeparator />
      <MenuItem icon={<IconSignOut />} onSelect={onSignOut}>
        Sign out
      </MenuItem>
    </Menu>
  );
}

/**
 * The user's picture, or their initials when there's none (or it fails to load).
 * @param {{ name: string, imageUrl: string | null }} props
 */
export function Avatar(props) {
  const [failed, setFailed] = createSignal(/** @type {string | null} */ (null));
  const initials = () =>
    props.name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join("") || "?";

  return (
    <Show
      when={props.imageUrl && props.imageUrl !== failed() ? props.imageUrl : null}
      fallback={
        <span class={styles.avatar} aria-hidden="true">
          {initials()}
        </span>
      }
    >
      {(src) => (
        <img
          class={styles.avatar}
          src={src()}
          alt=""
          width="24"
          height="24"
          referrerpolicy="no-referrer"
          onError={() => setFailed(src())}
        />
      )}
    </Show>
  );
}
