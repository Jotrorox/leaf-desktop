// @ts-check
import { ApiError } from "../../api/client.js";
import { IMAGE_TYPES, uploadFile } from "../../api/files.js";
import { toast } from "../../ui/Toast.jsx";

/**
 * Picking and uploading one image for a page's cover or icon.
 */

/**
 * Opens the file chooser for one image. Resolves to null when nothing is
 * picked (browsers that report a cancel) or never (those that don't: the
 * caller only acts on a file).
 * @returns {Promise<File | null>}
 */
export function chooseImage() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = IMAGE_TYPES.join(",");
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/**
 * Uploads an image for a page; null (and a toast) when it fails.
 * @param {string} pageId
 * @param {File} file
 * @param {(fraction: number) => void} [onProgress]
 * @returns {Promise<string | null>} The file's id.
 */
export async function uploadPageImage(pageId, file, onProgress) {
  try {
    const { id } = await uploadFile(file, {
      pageId,
      onProgress: (loaded, total) => onProgress?.(total > 0 ? loaded / total : 0),
    });
    return id;
  } catch (error) {
    const reason =
      error instanceof ApiError
        ? error.status === 0
          ? "Can't reach the server."
          : error.message
        : "Something went wrong.";
    toast({ title: "Couldn't upload the image", description: reason, tone: "danger" });
    return null;
  }
}
