// @ts-check
import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
import { fileRef } from "../../api/files.js";
import { takeTitleFocus } from "../../app/new-page.js";
import { renamePage, setTitleDraft, updatePage } from "../../data/pages.js";
import { cx } from "../../lib/cx.js";
import Button from "../../ui/Button.jsx";
import EmojiPicker from "../../ui/EmojiPicker.jsx";
import { IconImage, IconSmile } from "../../ui/icons/index.jsx";
import { IconGlyph } from "../../ui/PageIcon.jsx";
import { createToggleHandlers } from "../../ui/Popover.jsx";
import CoverPicker from "./CoverPicker.jsx";
import { coverBackground } from "./covers.js";
import styles from "./PageHeader.module.css";
import { chooseImage, uploadPageImage } from "./upload.js";

/** @typedef {import("../../api/types.js").Page} Page */

/** How long typing pauses before the title is saved. */
const TITLE_SAVE_DELAY = 500;

/**
 * The top of a page: cover band, icon, and title. "Add icon" and "Add
 * cover" appear on hover (and on keyboard focus). Every change is
 * optimistic; a failed save rolls back and shows a toast.
 *
 * @param {{
 *   page: Page,
 *   readOnly?: boolean,
 *   onTitleExit?: () => void,
 *   focusRef?: (focus: () => void) => void,
 * }} props `onTitleExit`: Enter or ↓ at the end of the title (the editor takes
 *   the caret). `focusRef` receives a function that puts the caret at the
 *   title's end.
 */
export default function PageHeader(props) {
  const [iconOpen, setIconOpen] = createSignal(false);
  const [coverOpen, setCoverOpen] = createSignal(false);
  const iconToggle = createToggleHandlers(iconOpen, setIconOpen);
  const coverToggle = createToggleHandlers(coverOpen, setCoverOpen);
  /** @type {HTMLElement | undefined} */
  let iconAnchor;
  /** @type {HTMLElement | undefined} */
  let iconButton;
  /** @type {HTMLElement | undefined} */
  let coverAnchor;
  /** @type {HTMLElement | undefined} */
  let coverButton;
  /** @type {HTMLTextAreaElement | undefined} */
  let titleField;

  const cover = () => coverBackground(props.page.cover);
  /** An icon or cover upload in progress: which, and how far (0–1). */
  const [uploading, setUploading] = createSignal(
    /** @type {{ what: "icon" | "cover", progress: number } | null} */ (null),
  );
  /** @param {"icon" | "cover"} what */
  async function upload(what) {
    const file = await chooseImage();
    if (!file) return;
    setUploading({ what, progress: 0 });
    const id = await uploadPageImage(props.page.id, file, (progress) =>
      setUploading({ what, progress }),
    );
    setUploading(null);
    if (id) update({ [what]: fileRef(id) });
  }
  const update = (/** @type {import("../../api/types.js").UpdatePageInput} */ patch) =>
    void updatePage(props.page.workspace_id, props.page.id, patch);

  /**
   * Click handlers for a picker trigger that also remember which button
   * opened it (icon pickers open from the icon or from "Add icon").
   * @param {ReturnType<typeof createToggleHandlers>} toggle
   * @param {(el: HTMLElement) => void} setAnchor
   */
  const triggerHandlers = (toggle, setAnchor) => ({
    onPointerDown: (/** @type {PointerEvent & { currentTarget: HTMLElement }} */ event) => {
      setAnchor(event.currentTarget);
      toggle.onPointerDown();
    },
    onClick: (/** @type {MouseEvent & { currentTarget: HTMLElement }} */ event) => {
      setAnchor(event.currentTarget);
      toggle.onClick(event);
    },
  });
  const iconTrigger = triggerHandlers(iconToggle, (el) => (iconAnchor = el));
  const coverTrigger = triggerHandlers(coverToggle, (el) => (coverAnchor = el));

  // After picking, the "Add …" button that opened a picker is gone: focus what replaced it.
  const iconFocusTarget = () =>
    iconButton?.isConnected ? iconButton : iconAnchor?.isConnected ? iconAnchor : titleField;
  const coverFocusTarget = () =>
    coverButton?.isConnected ? coverButton : coverAnchor?.isConnected ? coverAnchor : titleField;

  return (
    <header
      class={cx(styles.header, cover() && styles.withCover, props.page.icon && styles.withIcon)}
    >
      <Show when={cover()}>
        {(background) => (
          <div class={styles.cover} style={{ background: background() }}>
            <Show when={!props.readOnly}>
              <div class={styles.coverActions}>
                <Show when={uploading()?.what === "cover"}>
                  <span class={styles.uploading} role="status">
                    Uploading… {Math.round((uploading()?.progress ?? 0) * 100)}%
                  </span>
                </Show>
                <Button
                  ref={(el) => (coverButton = el)}
                  class={styles.coverButton}
                  aria-expanded={coverOpen()}
                  aria-haspopup="dialog"
                  {...coverTrigger}
                >
                  Change cover
                </Button>
              </div>
            </Show>
          </div>
        )}
      </Show>

      <div class={styles.inner}>
        <Show when={props.page.icon}>
          {(icon) => (
            <Show
              when={!props.readOnly}
              fallback={
                <span class={styles.icon}>
                  <IconGlyph icon={icon()} />
                </span>
              }
            >
              <button
                ref={(el) => (iconButton = el)}
                type="button"
                class={styles.icon}
                aria-label="Change icon"
                aria-expanded={iconOpen()}
                aria-haspopup="dialog"
                {...iconTrigger}
              >
                <IconGlyph icon={icon()} />
              </button>
            </Show>
          )}
        </Show>

        <Show when={!props.readOnly && (!props.page.icon || !cover())}>
          <div class={styles.controls}>
            <Show when={!props.page.icon}>
              <Button
                variant="ghost"
                class={styles.control}
                aria-expanded={iconOpen()}
                aria-haspopup="dialog"
                {...iconTrigger}
              >
                <IconSmile size={16} />
                Add icon
              </Button>
            </Show>
            <Show when={!cover()}>
              <Button
                variant="ghost"
                class={styles.control}
                aria-expanded={coverOpen()}
                aria-haspopup="dialog"
                {...coverTrigger}
              >
                <IconImage size={16} />
                Add cover
              </Button>
            </Show>
          </div>
        </Show>

        <Show when={uploading()?.what === "icon" || (uploading()?.what === "cover" && !cover())}>
          <p class={styles.uploading} role="status">
            Uploading {uploading()?.what}… {Math.round((uploading()?.progress ?? 0) * 100)}%
          </p>
        </Show>

        <h1 class={styles.title}>
          <TitleField
            page={props.page}
            readOnly={props.readOnly}
            onExit={() => props.onTitleExit?.()}
            ref={(el) => {
              titleField = el;
              props.focusRef?.(() => {
                el.focus();
                el.setSelectionRange(el.value.length, el.value.length);
              });
            }}
          />
        </h1>
      </div>

      <Show when={!props.readOnly}>
        <EmojiPicker
          open={iconOpen()}
          onOpenChange={setIconOpen}
          anchor={() => iconAnchor}
          focusOnClose={iconFocusTarget}
          current={props.page.icon}
          onSelect={(emoji) => update({ icon: emoji })}
          onRemove={() => update({ icon: null })}
          onUpload={() => void upload("icon")}
        />
        <CoverPicker
          open={coverOpen()}
          onOpenChange={setCoverOpen}
          anchor={() => coverAnchor}
          focusOnClose={coverFocusTarget}
          current={props.page.cover}
          onSelect={(value) => update({ cover: value })}
          onUpload={() => void upload("cover")}
        />
      </Show>
    </header>
  );
}

/**
 * The title: a borderless, auto-growing text field. Each keystroke shows
 * the new title everywhere at once (a draft in the cache, so the sidebar and
 * breadcrumbs follow); it's saved with a debounced PATCH, and right away on
 * blur, Enter, or leaving the page. Line breaks become spaces.
 *
 * @param {{ page: Page, readOnly?: boolean, onExit: () => void, ref: (el: HTMLTextAreaElement) => void }} props
 */
function TitleField(props) {
  /** @type {HTMLTextAreaElement | undefined} */
  let field;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  // Typed but not saved yet. While true, changes from the cache don't overwrite the field.
  let dirty = false;
  const workspaceId = props.page.workspace_id;
  const id = props.page.id;
  const [value, setValue] = createSignal(props.page.title);

  // Renames from elsewhere (the sidebar) and rollbacks show up here, unless the user is typing.
  createEffect(
    on(
      () => props.page.title,
      (title) => {
        if (!dirty) setValue(title);
      },
    ),
  );

  function save() {
    clearTimeout(timer);
    if (!dirty) return;
    dirty = false;
    void renamePage(workspaceId, id, value());
  }

  function autosize() {
    if (!field) return;
    field.style.height = "auto";
    field.style.height = `${field.scrollHeight}px`;
  }

  createEffect(on(value, () => queueMicrotask(autosize)));

  onMount(() => {
    if (!field) return;
    autosize();
    const observer = new ResizeObserver(autosize);
    observer.observe(field);
    if (takeTitleFocus(id)) field.focus();
    onCleanup(() => observer.disconnect());
  });

  // Leaving the page (or the app) saves what's typed.
  onCleanup(save);

  return (
    <textarea
      ref={(el) => {
        field = el;
        props.ref(el);
      }}
      class={styles.titleField}
      rows="1"
      value={value()}
      placeholder="Untitled"
      aria-label="Page title"
      maxLength={2000}
      spellcheck={false}
      readOnly={props.readOnly}
      onInput={(event) => {
        const el = event.currentTarget;
        const text = el.value.replace(/\r?\n/g, " ");
        if (text !== el.value) el.value = text;
        dirty = true;
        setValue(text);
        setTitleDraft(workspaceId, id, text);
        clearTimeout(timer);
        timer = setTimeout(save, TITLE_SAVE_DELAY);
      }}
      onKeyDown={(event) => {
        if (event.isComposing) return;
        const el = event.currentTarget;
        const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
        if (event.key === "Enter" || (event.key === "ArrowDown" && atEnd)) {
          event.preventDefault();
          save();
          props.onExit();
        }
      }}
      onBlur={save}
    />
  );
}
