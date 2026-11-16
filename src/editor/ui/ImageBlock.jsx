// @ts-check
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js";
import { fileUrl } from "../../api/files.js";
import { IconImage } from "../../ui/icons/index.jsx";
import { IMAGE_MIN_WIDTH, safeImageSrc } from "../blocks/schema.js";
import styles from "./ImageBlock.module.css";
import { uploadOf } from "./uploads.js";

/** @typedef {import("../editor.js").EditorController} EditorController */

/** How often (ms) and how many times a picture that isn't there yet is tried again. */
const RETRY_EVERY = 2000;
const RETRIES = 30;

/**
 * An image block: an uploaded file (`file`) or a web image (`src`),
 * centered, at its `width` (px, at most the column's) with handles on both
 * sides to resize it, and a caption under it. While this tab uploads the
 * file, it shows the local copy and a progress bar; someone else's upload
 * shows a placeholder until the server has it.
 *
 * Embedded (`data-embed`): the editor leaves its input alone.
 * @param {{ ed: EditorController, id: string, attrs: Record<string, unknown> }} props
 */
export default function ImageBlock(props) {
  const ed = props.ed;
  const fileId = () => (typeof props.attrs.file === "string" ? props.attrs.file : null);
  const upload = () => {
    const id = fileId();
    return id ? uploadOf(id) : null;
  };
  const [failures, setFailures] = createSignal(0);
  const [attempt, setAttempt] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  // A memo: progress updates mustn't count as a new picture.
  const src = createMemo(() => {
    const local = upload();
    if (local) return local.preview;
    const id = fileId();
    if (id) {
      const url = fileUrl(id);
      return url && attempt() > 0
        ? `${url}${url.includes("?") ? "&" : "?"}retry=${attempt()}`
        : url;
    }
    return safeImageSrc(props.attrs.src);
  });
  createEffect(on(src, () => setLoaded(false), { defer: true }));

  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  onCleanup(() => clearTimeout(retryTimer));
  function onError() {
    // An uploaded file may not be there yet (someone is still uploading it).
    if (!fileId() || upload()) return setFailures(RETRIES);
    const n = failures() + 1;
    setFailures(n);
    if (n < RETRIES) retryTimer = setTimeout(() => setAttempt((a) => a + 1), RETRY_EVERY);
  }

  // Width: what's stored, or what's being dragged.
  const [dragWidth, setDragWidth] = createSignal(/** @type {number | null} */ (null));
  const width = () =>
    dragWidth() ?? (typeof props.attrs.width === "number" ? props.attrs.width : null);
  /** @type {HTMLDivElement | undefined} */
  let frame;

  /**
   * @param {PointerEvent & { currentTarget: HTMLElement }} event
   * @param {-1 | 1} side
   */
  function startResize(event, side) {
    if (ed.readOnly || event.button !== 0 || !frame) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = frame.getBoundingClientRect().width;
    const max = frame.parentElement?.getBoundingClientRect().width ?? startWidth;
    /** @param {PointerEvent} e */
    const move = (e) => {
      // Centered: each side moves by the drag, so the width changes by twice it.
      const next = startWidth + side * (e.clientX - startX) * 2;
      setDragWidth(Math.round(Math.max(IMAGE_MIN_WIDTH, Math.min(max, next))));
    };
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      const final = dragWidth();
      setDragWidth(null);
      if (final !== null && final !== props.attrs.width) ed.setBlockAttr(props.id, "width", final);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  /** @param {KeyboardEvent} event @param {-1 | 1} side */
  function keyResize(event, side) {
    if (ed.readOnly || (event.key !== "ArrowLeft" && event.key !== "ArrowRight") || !frame) return;
    event.preventDefault();
    const step = (event.shiftKey ? 64 : 16) * (event.key === "ArrowRight" ? side : -side);
    const max = frame.parentElement?.getBoundingClientRect().width ?? Infinity;
    const next = Math.round(
      Math.max(IMAGE_MIN_WIDTH, Math.min(max, frame.getBoundingClientRect().width + step)),
    );
    ed.setBlockAttr(props.id, "width", next);
  }

  const caption = () => (typeof props.attrs.caption === "string" ? props.attrs.caption : "");
  const progress = () => {
    const u = upload();
    return u && !u.error ? Math.min(1, u.total > 0 ? u.loaded / u.total : 0) : null;
  };

  return (
    <figure class={styles.figure}>
      <div ref={frame} class={styles.frame} style={{ width: width() ? `${width()}px` : undefined }}>
        <Show
          when={src() && failures() < RETRIES ? src() : null}
          fallback={
            <div
              class={styles.placeholder}
              role="img"
              aria-label={upload()?.error ?? "Image not available"}
            >
              <IconImage size={24} />
              <span>
                {upload()?.error ?? (fileId() ? "This image couldn't be loaded." : "No image")}
              </span>
            </div>
          }
        >
          {(url) => (
            <>
              <Show when={!loaded()}>
                <div class={styles.placeholder} aria-hidden="true">
                  <IconImage size={24} />
                  <span>{failures() > 0 ? "Waiting for the upload…" : "Loading image…"}</span>
                </div>
              </Show>
              <img
                class={styles.image}
                classList={{ [styles.hidden]: !loaded() }}
                src={url()}
                alt={caption()}
                draggable={false}
                decoding="async"
                onLoad={() => {
                  setLoaded(true);
                  setFailures(0);
                }}
                onError={onError}
              />
            </>
          )}
        </Show>
        <Show when={progress() !== null}>
          <div
            class={styles.progress}
            role="progressbar"
            aria-label="Uploading"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round((progress() ?? 0) * 100)}
          >
            <span style={{ width: `${(progress() ?? 0) * 100}%` }} />
          </div>
        </Show>
        <Show when={upload()?.error === null && progress() !== null}>
          <button type="button" class={styles.cancel} onClick={() => upload()?.cancel()}>
            Cancel
          </button>
        </Show>
        <Show when={!ed.readOnly}>
          <span
            class={styles.handle}
            data-side="left"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize image"
            tabIndex={0}
            onPointerDown={(event) => startResize(event, -1)}
            onKeyDown={(event) => keyResize(event, -1)}
          />
          <span
            class={styles.handle}
            data-side="right"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize image"
            tabIndex={0}
            onPointerDown={(event) => startResize(event, 1)}
            onKeyDown={(event) => keyResize(event, 1)}
          />
        </Show>
      </div>
      <Show
        when={!ed.readOnly}
        fallback={
          <Show when={caption()}>
            <figcaption class={styles.caption}>{caption()}</figcaption>
          </Show>
        }
      >
        <input
          class={styles.captionInput}
          type="text"
          value={caption()}
          placeholder="Add a caption…"
          aria-label="Image caption"
          maxLength={500}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          onBlur={(event) => {
            const value = event.currentTarget.value.trim();
            if (value !== caption()) ed.setBlockAttr(props.id, "caption", value || null);
          }}
        />
      </Show>
    </figure>
  );
}
