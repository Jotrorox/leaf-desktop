// @ts-check

import { createSignal, For, Match, Show, Switch } from "solid-js";
import { me } from "../../auth/me.js";
import { displayTitle } from "../../data/pages.js";
import {
  cancelInvite,
  invite,
  publicLink,
  removePerson,
  setPersonRole,
  setPublic,
  useSharing,
} from "../../data/sharing.js";
import { webUrl } from "../../desktop/env.js";
import { initials } from "../../editor/sync/presence.js";
import { cx } from "../../lib/cx.js";
import { Link } from "../../lib/router/index.js";
import Button from "../../ui/Button.jsx";
import { IconCopy, IconGlobe, IconLink, IconLock, IconShare } from "../../ui/icons/index.jsx";
import Popover, { createToggleHandlers } from "../../ui/Popover.jsx";
import { toast } from "../../ui/Toast.jsx";
import { setShareOpen, shareOpen } from "./open.js";
import styles from "./SharePanel.module.css";

/**
 * The top bar's "Share" button and its panel (docs/sharing.md): who has
 * access to the page and where that comes from (the workspace, this page, a
 * page above), inviting by email, changing someone's role on this page and
 * the pages under it, and the public link. People who can't share see the
 * list and the links, but no controls.
 */

/** @typedef {import("../../api/types.js").Sharing} Sharing */
/** @typedef {import("../../api/types.js").SharingPerson} SharingPerson */
/** @typedef {import("../../api/sharing.js").ShareRole} ShareRole */

/** @type {{ value: ShareRole, label: string, description: string }[]} */
const ROLE_OPTIONS = [
  { value: "full_access", label: "Full access", description: "Edit and share with others" },
  { value: "edit", label: "Can edit", description: "Edit, but not share" },
  { value: "comment", label: "Can comment", description: "Read (comments come later)" },
  { value: "view", label: "Can view", description: "Read only" },
];

/** @param {string} role */
export function roleLabel(role) {
  return role === "owner"
    ? "Owner"
    : (ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role);
}

/** @param {{ pageId: string, title: string }} props */
export default function ShareButton(props) {
  /** @type {HTMLButtonElement | undefined} */
  let button;
  const toggle = createToggleHandlers(shareOpen, setShareOpen);
  return (
    <>
      <Button
        ref={(el) => (button = el)}
        variant="ghost"
        class={styles.trigger}
        aria-label="Share"
        aria-expanded={shareOpen()}
        aria-haspopup="dialog"
        {...toggle}
      >
        <IconShare size={16} />
        <span class={styles.triggerLabel}>Share</span>
      </Button>
      <Popover
        open={shareOpen()}
        onOpenChange={setShareOpen}
        anchor={() => button}
        placement="bottom-end"
        role="dialog"
        aria-label={`Share “${displayTitle(props.title)}”`}
        class={styles.panel}
        initialFocus={(panel) =>
          /** @type {HTMLElement | null} */ (
            panel.querySelector("input[type=email]") ?? panel.querySelector("button")
          )
        }
      >
        <Show when={shareOpen()}>
          <ShareContent pageId={props.pageId} />
        </Show>
      </Popover>
    </>
  );
}

/** @param {{ pageId: string }} props */
function ShareContent(props) {
  const query = useSharing(() => props.pageId);
  return (
    <Switch>
      <Match when={query.data()}>{(sharing) => <SharingView sharing={sharing()} />}</Match>
      <Match when={query.error()}>
        <div class={styles.message} role="alert">
          <p>Couldn't load who has access.</p>
          <Button onClick={() => void query.refetch()}>Retry</Button>
        </div>
      </Match>
      <Match when={true}>
        <div class={styles.message} role="status">
          Loading…
        </div>
      </Match>
    </Switch>
  );
}

/** @param {{ sharing: Sharing }} props */
function SharingView(props) {
  const pageId = () => props.sharing.page_id;
  const myId = () => {
    const state = me();
    return state.status === "ready" ? state.data.id : null;
  };
  const [email, setEmail] = createSignal("");
  const [role, setRole] = createSignal(/** @type {ShareRole} */ ("edit"));
  const [busy, setBusy] = createSignal(false);
  const validEmail = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email().trim());

  async function submit(/** @type {SubmitEvent} */ event) {
    event.preventDefault();
    if (!validEmail() || busy()) return;
    setBusy(true);
    const ok = await invite(pageId(), email().trim(), role());
    setBusy(false);
    if (ok) setEmail("");
  }

  async function copy(/** @type {string} */ url, /** @type {string} */ what) {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: `${what} copied` });
    } catch {
      toast({
        title: "Couldn't copy the link",
        description: "Your browser blocked clipboard access.",
        tone: "danger",
      });
    }
  }

  return (
    <div class={styles.content}>
      <Show
        when={props.sharing.can_share}
        fallback={
          <p class={styles.note}>
            Only people with full access can change who has access to this page.
          </p>
        }
      >
        <form class={styles.invite} onSubmit={(event) => void submit(event)}>
          <input
            class={styles.email}
            type="email"
            inputMode="email"
            autocomplete="email"
            placeholder="Email address"
            aria-label="Email address to invite"
            value={email()}
            onInput={(event) => setEmail(event.currentTarget.value)}
          />
          <RoleSelect value={role()} onChange={setRole} label="Role for the invite" />
          <Button type="submit" variant="primary" disabled={!validEmail() || busy()}>
            Invite
          </Button>
        </form>
      </Show>

      <h3 class={styles.heading}>People with access</h3>
      <ul class={styles.people} role="list">
        <For each={props.sharing.people}>
          {(person) => (
            <PersonRow
              person={person}
              you={person.user_id === myId()}
              canShare={props.sharing.can_share}
              workspace={props.sharing.workspace.name}
              pageId={pageId()}
            />
          )}
        </For>
        <For each={props.sharing.invites}>
          {(pending) => (
            <li class={styles.person}>
              <span class={cx(styles.avatar, styles.avatarPending)} aria-hidden="true">
                @
              </span>
              <span class={styles.who}>
                <span class={styles.name}>{pending.email}</span>
                <span class={styles.detail}>
                  <Show when={pending.inherited_from} fallback="Invited · gets access on sign-in">
                    {(from) => <InheritedFrom page={from()} prefix="Invited on" />}
                  </Show>
                </span>
              </span>
              <Show
                when={props.sharing.can_share && pending.source === "page"}
                fallback={<span class={styles.role}>{roleLabel(pending.role)}</span>}
              >
                <RoleSelect
                  value={/** @type {ShareRole} */ (pending.role)}
                  label={`Role for ${pending.email}`}
                  onChange={(next) => void invite(pageId(), pending.email, next)}
                  extra={{
                    label: "Cancel invite",
                    run: () => void cancelInvite(pageId(), pending.email),
                  }}
                />
              </Show>
            </li>
          )}
        </For>
      </ul>

      <div class={styles.public}>
        <span class={styles.publicIcon} aria-hidden="true">
          {props.sharing.public ? <IconGlobe size={18} /> : <IconLock size={18} />}
        </span>
        <span class={styles.who}>
          <span class={styles.name}>
            {props.sharing.public ? "Anyone with the link can view" : "Only people with access"}
          </span>
          <span class={styles.detail}>
            <Show
              when={props.sharing.public_inherited_from}
              fallback={
                props.sharing.public
                  ? "Published to the web, with its subpages"
                  : "Publish to share a read-only link"
              }
            >
              {(from) => <InheritedFrom page={from()} prefix="Published with" />}
            </Show>
          </span>
        </span>
        <Show when={props.sharing.can_share && !props.sharing.public_inherited_from}>
          <label class={styles.switch}>
            <input
              type="checkbox"
              role="switch"
              checked={props.sharing.public}
              aria-label="Public link"
              onChange={(event) => void setPublic(pageId(), event.currentTarget.checked)}
            />
            <span aria-hidden="true" />
          </label>
        </Show>
      </div>
      <Show when={props.sharing.public}>
        <div class={styles.linkRow}>
          <input
            class={styles.linkField}
            readOnly
            value={publicLink(pageId())}
            aria-label="Public link"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button onClick={() => void copy(publicLink(pageId()), "Public link")}>
            <IconCopy size={16} />
            Copy
          </Button>
        </div>
      </Show>

      <div class={styles.footer}>
        <Button
          variant="ghost"
          onClick={() => void copy(webUrl(`/p/${encodeURIComponent(pageId())}`), "Link")}
        >
          <IconLink size={16} />
          Copy link
        </Button>
        <span class={styles.footerNote}>People need access to open it.</span>
      </div>
    </div>
  );
}

/**
 * @param {{ person: SharingPerson, you: boolean, canShare: boolean, workspace: string, pageId: string }} props
 */
function PersonRow(props) {
  const name = () => props.person.name || props.person.email || "Someone";
  const editable = () => props.canShare && !props.you && props.person.role !== "owner";
  return (
    <li class={styles.person}>
      <span class={styles.avatar} aria-hidden="true">
        <Show when={props.person.avatar_url} fallback={initials(name())}>
          {(src) => <img src={src()} alt="" referrerPolicy="no-referrer" />}
        </Show>
      </span>
      <span class={styles.who}>
        <span class={styles.name}>
          {name()}
          <Show when={props.you}> (you)</Show>
        </span>
        <span class={styles.detail}>
          <Switch>
            <Match when={props.person.inherited_from}>
              {(from) => <InheritedFrom page={from()} prefix="Access from" />}
            </Match>
            <Match when={props.person.source === "page"}>
              {props.person.guest ? "Guest · invited to this page" : "Set on this page"}
            </Match>
            <Match when={true}>
              {props.person.role === "owner"
                ? `Owner of ${props.workspace}`
                : `Member of ${props.workspace}`}
            </Match>
          </Switch>
          <Show when={props.person.email && props.person.name}> · {props.person.email}</Show>
        </span>
      </span>
      <Show
        when={editable()}
        fallback={<span class={styles.role}>{roleLabel(props.person.role)}</span>}
      >
        <RoleSelect
          value={/** @type {ShareRole} */ (props.person.role)}
          label={`Role for ${name()}`}
          onChange={(next) => void setPersonRole(props.pageId, props.person.user_id, next)}
          extra={
            props.person.source === "page"
              ? {
                  label: props.person.guest ? "Remove" : "Reset to inherited",
                  run: () => void removePerson(props.pageId, props.person.user_id),
                }
              : undefined
          }
        />
      </Show>
    </li>
  );
}

/** @param {{ page: import("../../api/types.js").PageRef, prefix: string }} props */
function InheritedFrom(props) {
  return (
    <>
      {props.prefix}{" "}
      <Link
        href={`/p/${encodeURIComponent(props.page.id)}`}
        class={styles.inherited}
        onClick={() => setShareOpen(false)}
      >
        {displayTitle(props.page.title)}
      </Link>
    </>
  );
}

/**
 * A native select of roles, with an optional last action ("Remove").
 * @param {{
 *   value: ShareRole,
 *   label: string,
 *   onChange: (role: ShareRole) => void,
 *   extra?: { label: string, run: () => void },
 * }} props
 */
function RoleSelect(props) {
  return (
    <select
      class={styles.select}
      aria-label={props.label}
      value={props.value}
      onChange={(event) => {
        const value = event.currentTarget.value;
        if (value === "__extra") {
          event.currentTarget.value = props.value;
          props.extra?.run();
          return;
        }
        props.onChange(/** @type {ShareRole} */ (value));
      }}
    >
      <For each={ROLE_OPTIONS}>
        {(option) => (
          <option
            value={option.value}
            title={option.description}
            selected={option.value === props.value}
          >
            {option.label}
          </option>
        )}
      </For>
      <Show when={props.extra}>
        {(extra) => (
          <>
            <hr />
            <option value="__extra">{extra().label}</option>
          </>
        )}
      </Show>
    </select>
  );
}
