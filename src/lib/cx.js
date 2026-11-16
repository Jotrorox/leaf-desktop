// @ts-check

/**
 * Joins the truthy class names.
 * @param {...(string | false | null | undefined)} names
 */
export function cx(...names) {
  return names.filter(Boolean).join(" ");
}
