// @ts-check

/**
 * Path matching for the router. Pure: no DOM, no Solid, so it runs under `node --test`.
 *
 * Patterns are absolute paths made of static segments and `:name` params, e.g.
 * `/p/:pageId`. A trailing slash on either side is ignored, static segments
 * match case-sensitively, params never match an empty segment, and param
 * values are URI-decoded.
 */

/** @typedef {Record<string, string>} Params */
/** @typedef {{ param: false, value: string } | { param: true, name: string }} Segment */

const PARAM_NAME = /^[A-Za-z_$][\w$]*$/;

/** @type {Map<string, Segment[]>} */
const compiled = new Map();

/**
 * Parses a pattern into segments, caching the result. Throws on malformed patterns.
 * @param {string} pattern
 * @returns {Segment[]}
 */
export function compilePath(pattern) {
  const cached = compiled.get(pattern);
  if (cached) return cached;
  if (!pattern.startsWith("/")) throw new Error(`Route pattern must start with "/": ${pattern}`);

  /** @type {Set<string>} */
  const names = new Set();
  const segments = splitPath(pattern).map((part) => {
    if (!part.startsWith(":")) return /** @type {Segment} */ ({ param: false, value: part });
    const name = part.slice(1);
    if (!PARAM_NAME.test(name)) throw new Error(`Invalid param name "${name}" in ${pattern}`);
    if (names.has(name)) throw new Error(`Duplicate param "${name}" in ${pattern}`);
    names.add(name);
    return /** @type {Segment} */ ({ param: true, name });
  });
  compiled.set(pattern, segments);
  return segments;
}

/**
 * Matches `pathname` against `pattern`.
 * @param {string} pattern e.g. `/p/:pageId`
 * @param {string} pathname e.g. `/p/abc123`, as found in `location.pathname` (still percent-encoded)
 * @returns {Params | null} The params, or null when the path doesn't match.
 */
export function matchPath(pattern, pathname) {
  const segments = compilePath(pattern);
  const parts = splitPath(pathname);
  if (parts.length !== segments.length) return null;

  /** @type {Params} */
  const params = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (!segment.param) {
      if (part !== /** @type {{ value: string }} */ (segment).value) return null;
      continue;
    }
    if (part === "") return null;
    try {
      params[segment.name] = decodeURIComponent(part);
    } catch {
      return null; // Malformed percent-encoding: treat as not found.
    }
  }
  return params;
}

/**
 * Finds the first pattern that matches. Order matters: list more specific patterns first.
 * @param {readonly string[]} patterns
 * @param {string} pathname
 * @returns {{ index: number, params: Params } | null}
 */
export function matchRoutes(patterns, pathname) {
  for (let index = 0; index < patterns.length; index++) {
    const params = matchPath(patterns[index], pathname);
    if (params) return { index, params };
  }
  return null;
}

/**
 * Splits on "/" after dropping one leading and one trailing slash, so "/" is
 * `[]` and "/a/" is `["a"]`, while "/a//b" keeps its empty middle segment.
 * @param {string} path
 */
function splitPath(path) {
  const trimmed = path.replace(/^\//, "").replace(/\/$/, "");
  return trimmed === "" ? [] : trimmed.split("/");
}
