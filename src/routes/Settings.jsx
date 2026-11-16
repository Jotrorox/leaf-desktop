// @ts-check
import { createResource, createSignal, For, Match, Show, Switch } from "solid-js";
import { deleteAccount } from "../api/account.js";
import { ApiError } from "../api/client.js";
import { allowApp, disconnectApp, listConnections } from "../api/connections.js";
import { useBreadcrumbs } from "../app/breadcrumbs.js";
import { openShortcutsDialog } from "../app/ShortcutsDialog.jsx";
import { signOut } from "../auth/clerk.js";
import { CONNECT_PATH, IMPRINT_PATH, PRIVACY_PATH, TERMS_PATH } from "../auth/guard.js";
import { AI_ASSISTANTS } from "../lib/features.js";
import { Link } from "../lib/router/index.js";
import { timeAgo } from "../lib/time.js";
import { OPERATOR } from "../site/operator.js";
import Button from "../ui/Button.jsx";
import ConfirmDialog from "../ui/ConfirmDialog.jsx";
import Dialog from "../ui/Dialog.jsx";
import { IconKeyboard, IconTrash } from "../ui/icons/index.jsx";
import { toast } from "../ui/Toast.jsx";
import styles from "./Stub.module.css";

export default function Settings() {
  useBreadcrumbs(() => [{ label: "Settings" }]);
  const [deleting, setDeleting] = createSignal(false);
  return (
    <>
      <h1 class={styles.title}>Settings</h1>
      <p class={styles.lead}>
        {AI_ASSISTANTS ? "Manage your account and connections." : "Manage your account."}
      </p>
      <div class={styles.actions}>
        <Button onClick={openShortcutsDialog}>
          <IconKeyboard />
          Keyboard shortcuts
        </Button>
      </div>
      <Show when={AI_ASSISTANTS}>
        <section id="connected-apps" class={styles.section} aria-labelledby="settings-connections">
          <h2 id="settings-connections" class={styles.sectionTitle}>
            Connected apps
          </h2>
          <p class={styles.note}>
            AI assistants you connect can read or edit the pages you can access. Disconnecting one
            stops it at once, even with access it was already given, until you allow it again. Also
            remove the connector in the assistant. Signing out doesn't disconnect assistants.
          </p>
          <ConnectedApps />
          <p class={styles.links}>
            <Link href={CONNECT_PATH}>Connection guide</Link>
            <a href={`mailto:${OPERATOR.email}`}>Connection support</a>
          </p>
        </section>
      </Show>
      <section class={styles.section} aria-labelledby="settings-account">
        <h2 id="settings-account" class={styles.sectionTitle}>
          Account
        </h2>
        <p class={styles.note}>
          Deleting your account removes your workspace, everything in it and your sign-in. It can't
          be undone.
        </p>
        <div class={styles.actions}>
          <Button variant="danger" onClick={() => setDeleting(true)}>
            <IconTrash />
            Delete account
          </Button>
        </div>
      </section>
      <section class={styles.section} aria-labelledby="settings-about">
        <h2 id="settings-about" class={styles.sectionTitle}>
          About
        </h2>
        <p class={styles.links}>
          <Link href={TERMS_PATH}>Terms of use</Link>
          <Link href={PRIVACY_PATH}>Privacy policy</Link>
          <Link href={IMPRINT_PATH}>Imprint</Link>
        </p>
      </section>
      <DeleteAccountDialog open={deleting()} onOpenChange={setDeleting} />
    </>
  );
}

/** @param {string[]} scopes */
function access(scopes) {
  if (scopes.includes("leaf:write")) return "Can read and edit";
  if (scopes.includes("leaf:read")) return "Can read";
  return "No leaf access";
}

/**
 * The assistants that used this account (the server learns of an app on its
 * first request), with Disconnect and Allow again.
 */
function ConnectedApps() {
  const [connections, { mutate, refetch }] = createResource(listConnections);
  /** @type {import("solid-js").Signal<import("../api/connections.js").Connection | null>} */
  const [confirming, setConfirming] = createSignal(null);
  const [busy, setBusy] = createSignal("");

  /** @param {import("../api/connections.js").Connection} app @param {boolean} disconnect */
  async function change(app, disconnect) {
    if (busy()) return;
    setBusy(app.client_id);
    try {
      const updated = await (disconnect ? disconnectApp(app.client_id) : allowApp(app.client_id));
      mutate((list) => list?.map((c) => (c.client_id === updated.client_id ? updated : c)));
      toast({
        title: disconnect ? `${label(app)} was disconnected` : `${label(app)} can use leaf again`,
      });
    } catch (err) {
      console.error("Changing a connected app failed:", err);
      toast({
        title: disconnect ? "Couldn't disconnect the app" : "Couldn't allow the app again",
        description: "Check your connection and try again.",
        tone: "danger",
      });
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <Switch>
        <Match when={connections.error}>
          <p class={styles.note}>Couldn't load your connected apps.</p>
          <div class={styles.actions}>
            <Button onClick={() => void refetch()}>Try again</Button>
          </div>
        </Match>
        <Match when={connections.loading && !connections.latest}>
          <p class={styles.note}>Loading connected apps…</p>
        </Match>
        <Match when={connections()?.length === 0}>
          <p class={styles.note}>No assistant has used your account yet.</p>
        </Match>
        <Match when={connections()}>
          {(list) => (
            <ul class={styles.connections}>
              <For each={list()}>
                {(app) => (
                  <li class={styles.connection}>
                    <div class={styles.connectionText}>
                      <span class={styles.connectionName}>{label(app)}</span>
                      <span class={styles.connectionMeta}>
                        {app.disconnected_at
                          ? `Disconnected ${timeAgo(app.disconnected_at)}`
                          : `${access(app.scopes)} · Last used ${timeAgo(app.last_seen)}`}
                      </span>
                      <span class={styles.clientId} title={app.client_id}>
                        {app.client_id}
                      </span>
                    </div>
                    <Show
                      when={app.disconnected_at}
                      fallback={
                        <Button disabled={!!busy()} onClick={() => setConfirming(app)}>
                          Disconnect
                        </Button>
                      }
                    >
                      <Button disabled={!!busy()} onClick={() => void change(app, false)}>
                        {busy() === app.client_id ? "Allowing…" : "Allow again"}
                      </Button>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          )}
        </Match>
      </Switch>
      <ConfirmDialog
        open={!!confirming()}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={`Disconnect ${confirming() ? label(/** @type {any} */ (confirming())) : "this app"}?`}
        description="leaf will refuse all of its requests from now on, including with access it was already given. You can allow it again here later."
        confirmLabel="Disconnect"
        onConfirm={() => {
          const app = confirming();
          if (app) void change(app, true);
        }}
      />
    </>
  );
}

/** @param {import("../api/connections.js").Connection} app */
function label(app) {
  return app.name || "Unnamed app";
}

const CONFIRM_WORD = "delete";

/**
 * Asks before deleting the account, and has the word typed so a stray click
 * or Enter can't do it. Afterwards signs out, which clears this browser's
 * copies too.
 * @param {{ open: boolean, onOpenChange: (open: boolean) => void }} props
 */
function DeleteAccountDialog(props) {
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const confirmed = () => typed().trim().toLowerCase() === CONFIRM_WORD;

  /** @param {boolean} open */
  function setOpen(open) {
    if (busy()) return;
    if (!open) setTyped("");
    props.onOpenChange(open);
  }

  /** @param {SubmitEvent} event */
  async function submit(event) {
    event.preventDefault();
    if (!confirmed() || busy()) return;
    setBusy(true);
    try {
      await deleteAccount();
    } catch (err) {
      setBusy(false);
      const unavailable = err instanceof ApiError && err.code === "account_deletion_unavailable";
      toast({
        title: "Couldn't delete your account",
        description: unavailable
          ? "Deleting accounts isn't available right now. Email us and we'll delete it for you."
          : "Check your connection and try again.",
        tone: "danger",
      });
      return;
    }
    toast({ title: "Your account was deleted" });
    try {
      await signOut();
    } catch (err) {
      console.error("Sign-out after deleting the account failed:", err);
      window.location.assign("/");
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={setOpen}
      title="Delete your account?"
      description="This permanently deletes:"
    >
      <form class={styles.dialogBody} onSubmit={(event) => void submit(event)}>
        <ul class={styles.list}>
          <li>your workspace, with all its pages, databases, files and public links</li>
          <li>your access to pages other people shared with you</li>
          <li>your sign-in and profile</li>
        </ul>
        <p class={styles.note}>
          What you wrote in other people's workspaces stays there. Backups are overwritten within 7
          days.
        </p>
        <label class={styles.field}>
          <span>
            Type <strong>{CONFIRM_WORD}</strong> to confirm
          </span>
          <input
            class={styles.input}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            value={typed()}
            onInput={(event) => setTyped(event.currentTarget.value)}
            disabled={busy()}
          />
        </label>
        <div class={styles.dialogActions}>
          <Button type="button" autofocus onClick={() => setOpen(false)} disabled={busy()}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" disabled={!confirmed() || busy()}>
            {busy() ? "Deleting…" : "Delete account"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
