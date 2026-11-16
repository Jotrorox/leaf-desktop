// @ts-check
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import Button from "./Button.jsx";
import IconButton from "./IconButton.jsx";
import { IconClose } from "./icons/index.jsx";
import styles from "./Toast.module.css";

/**
 * @typedef {object} ToastOptions
 * @property {string} title
 * @property {string} [description]
 * @property {"neutral" | "danger"} [tone]
 * @property {number} [duration] ms on screen. 0 or Infinity: stays until dismissed. Default 5000.
 * @property {{ label: string, onClick: () => void }} [action] One button; clicking it also dismisses the toast.
 */

/** @typedef {ToastOptions & { id: number }} ToastItem */

const DEFAULT_DURATION = 5000;
/** How many show at once. The rest wait in order and appear as slots free up. */
const MAX_VISIBLE = 3;

const [toasts, setToasts] = createSignal(/** @type {ToastItem[]} */ ([]));
let nextId = 1;

/**
 * Queues a toast.
 * @param {ToastOptions} options
 * @returns {number} id, for `dismissToast`.
 */
export function toast(options) {
  const id = nextId++;
  setToasts((list) => [...list, { ...options, id }]);
  return id;
}

/** @param {number} id */
export function dismissToast(id) {
  setToasts((list) => list.filter((item) => item.id !== id));
}

/**
 * Renders the toast queue. Mount once, near the app root. Timers pause while
 * the pointer or focus is on a toast, and while the tab is hidden, so nobody
 * loses a message mid-read. New toasts are announced politely.
 */
export function Toaster() {
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  const [hidden, setHidden] = createSignal(document.hidden);
  const paused = () => hovered() || focused() || hidden();

  onMount(() => {
    const onVisibility = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
  });

  return (
    <section class={styles.region} aria-label="Notifications">
      <ol
        class={styles.list}
        aria-live="polite"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onFocusIn={() => setFocused(true)}
        onFocusOut={(event) => {
          if (
            !(
              event.relatedTarget instanceof Node &&
              event.currentTarget.contains(event.relatedTarget)
            )
          ) {
            setFocused(false);
          }
        }}
      >
        <For each={toasts().slice(0, MAX_VISIBLE)}>
          {(item) => <Toast item={item} paused={paused()} />}
        </For>
      </ol>
    </section>
  );
}

/** @param {{ item: ToastItem, paused: boolean }} props */
function Toast(props) {
  const duration = props.item.duration ?? DEFAULT_DURATION;
  const sticky = !(duration > 0) || duration === Infinity;
  let remaining = duration;

  createEffect(() => {
    if (sticky || props.paused) return;
    const started = Date.now();
    const timer = setTimeout(() => dismissToast(props.item.id), remaining);
    onCleanup(() => {
      clearTimeout(timer);
      remaining = Math.max(0, remaining - (Date.now() - started));
    });
  });

  return (
    <li class={styles.toast} data-tone={props.item.tone ?? "neutral"}>
      <div class={styles.text}>
        <p class={styles.title}>{props.item.title}</p>
        <Show when={props.item.description}>
          <p class={styles.description}>{props.item.description}</p>
        </Show>
      </div>
      <Show when={props.item.action}>
        {(action) => (
          <Button
            variant="ghost"
            class={styles.action}
            onClick={() => {
              action().onClick();
              dismissToast(props.item.id);
            }}
          >
            {action().label}
          </Button>
        )}
      </Show>
      <IconButton
        label="Dismiss"
        size="small"
        tooltip={false}
        onClick={() => dismissToast(props.item.id)}
      >
        <IconClose size={16} />
      </IconButton>
    </li>
  );
}
