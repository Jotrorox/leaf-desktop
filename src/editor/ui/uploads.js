// @ts-check
import { createSignal } from "solid-js";
import { ApiError } from "../../api/client.js";
import { uploadFile, uploadProblem } from "../../api/files.js";
import { toast } from "../../ui/Toast.jsx";

/**
 * Image uploads in flight, by file id: how far along each is and a local
 * preview, so the image block that points at the file can show the picture
 * and a progress bar before the server has it. (Other people see a
 * placeholder until it has.)
 */

/**
 * @typedef {object} Upload
 * @property {number} loaded
 * @property {number} total
 * @property {string} preview An object URL of the local file.
 * @property {string | null} error Why it failed, once it has.
 * @property {() => void} cancel
 */

const [uploads, setUploads] = createSignal(/** @type {ReadonlyMap<string, Upload>} */ (new Map()));

/** The upload of file `id` in this tab, if any. Reactive. @param {string} id */
export function uploadOf(id) {
  return uploads().get(id) ?? null;
}

/** @param {string} id @param {Partial<Upload> | null} patch */
function update(id, patch) {
  setUploads((current) => {
    const next = new Map(current);
    if (patch === null) next.delete(id);
    else {
      const known = next.get(id);
      if (known) next.set(id, { ...known, ...patch });
    }
    return next;
  });
}

/** @param {unknown} error */
function reasonOf(error) {
  if (error instanceof ApiError)
    return error.status === 0 ? "Can't reach the server." : error.message;
  return "Something went wrong.";
}

/**
 * Uploads image files for a page, one after the other. Each gets its block
 * (via `place`) as soon as the server has given the file an id; the block
 * shows the upload's progress.
 * @param {File[]} files
 * @param {{ pageId: string, place: (fileId: string, previous: string | null) => string | null }} options
 *   `place` puts an image block for the file after the previous one (null:
 *   the first) and returns the block's id.
 */
export async function uploadImages(files, { pageId, place }) {
  /** @type {string | null} */
  let previous = null;
  for (const file of files) {
    const problem = uploadProblem(file);
    if (problem) {
      toast({
        title: `Couldn't upload ${file.name || "the image"}`,
        description: problem,
        tone: "danger",
      });
      continue;
    }
    const block = await uploadOne(file, pageId, (fileId) => place(fileId, previous));
    if (block) previous = block;
  }
}

/**
 * @param {File} file @param {string} pageId @param {(fileId: string) => string | null} place
 * @returns {Promise<string | null>} The block placed, once the upload has started.
 */
function uploadOne(file, pageId, place) {
  return new Promise((resolve) => {
    const controller = new AbortController();
    /** @type {string | null} */
    let id = null;
    let placed = false;
    const run = () =>
      uploadFile(file, {
        pageId,
        signal: controller.signal,
        onTicket: (ticket) => {
          if (id === null) {
            id = ticket.id;
            setUploads((current) =>
              new Map(current).set(ticket.id, {
                loaded: 0,
                total: file.size,
                preview: URL.createObjectURL(file),
                error: null,
                cancel: () => controller.abort(),
              }),
            );
            const block = place(ticket.id);
            placed = true;
            resolve(block);
          }
        },
        onProgress: (loaded, total) => id && update(id, { loaded, total }),
      });
    run()
      .then(() => {
        if (!id) return;
        const done = uploads().get(id);
        update(id, null);
        // Keep the preview a moment, while the server's copy loads.
        if (done) setTimeout(() => URL.revokeObjectURL(done.preview), 60_000);
      })
      .catch((error) => {
        if (!placed) resolve(null);
        if (error instanceof DOMException && error.name === "AbortError") {
          if (id) update(id, { error: "Upload canceled." });
          return;
        }
        const reason = reasonOf(error);
        if (id) update(id, { error: reason });
        toast({
          title: `Couldn't upload ${file.name || "the image"}`,
          description: reason,
          tone: "danger",
        });
      });
  });
}
