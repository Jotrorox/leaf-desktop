// @ts-check

/**
 * Bytes ⇄ standard base64 (with padding), for binary payloads inside JSON.
 * Pure: `btoa`/`atob` exist in browsers and Node.
 */

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  let binary = "";
  // In chunks, so huge arrays don't overflow the argument list.
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
