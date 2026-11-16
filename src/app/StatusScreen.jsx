// @ts-check
import { Show } from "solid-js";
import LogoMark from "../ui/LogoMark.jsx";
import styles from "./StatusScreen.module.css";

/**
 * Full-window screen shown instead of the shell while auth or `/v1/me` is
 * loading, or when either failed. Errors get a title, an explanation and
 * actions (retry, sign out), so there's never a blank page.
 *
 * @param {{
 *   title?: string,
 *   message?: string,
 *   detail?: string,
 *   tone?: "loading" | "error",
 *   children?: import("solid-js").JSX.Element,
 * }} props `children` are the action buttons.
 */
export default function StatusScreen(props) {
  const loading = () => (props.tone ?? "loading") === "loading";
  return (
    <div class={styles.screen}>
      <div class={styles.card}>
        <LogoMark size={28} class={styles.logo} data-loading={loading() || undefined} />
        <div class={styles.text} role={loading() ? "status" : "alert"}>
          <Show when={props.title} fallback={<p class="visually-hidden">Loading…</p>}>
            <h1 class={styles.title}>{props.title}</h1>
          </Show>
          <Show when={props.message}>
            <p class={styles.message}>{props.message}</p>
          </Show>
          <Show when={props.detail}>
            <p class={styles.detail}>{props.detail}</p>
          </Show>
        </div>
        <Show when={props.children}>
          <div class={styles.actions}>{props.children}</div>
        </Show>
      </div>
    </div>
  );
}
