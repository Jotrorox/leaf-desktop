// @ts-check

/**
 * "just now", "5 minutes ago", "yesterday", "3 weeks ago". Pure apart from
 * the default clock: runs under `node --test`.
 * @param {string} iso An RFC 3339 timestamp.
 * @param {{ now?: number, locale?: string }} [options]
 * @returns {string} Empty for an invalid timestamp.
 */
export function timeAgo(iso, { now = Date.now(), locale } = {}) {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = (time - now) / 1000;
  if (Math.abs(seconds) < 45) return "just now";
  /** @type {[Intl.RelativeTimeFormatUnit, number][]} */
  const units = [
    ["minute", 60],
    ["hour", 3600],
    ["day", 86_400],
    ["week", 604_800],
    ["month", 2_629_800],
    ["year", 31_557_600],
  ];
  let [unit, size] = units[0];
  for (const [name, length] of units) {
    if (Math.abs(seconds) >= length * 0.95) [unit, size] = [name, length];
  }
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(seconds / size),
    unit,
  );
}
