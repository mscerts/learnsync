/**
 * Canonical path form shared by every learnsync file and by the validator.
 * See DATA_CONTRACT.md. Pure: no I/O, no network.
 */

export const LEARN_HOST = "learn.microsoft.com";

/**
 * Full URL or absolute path -> lowercase path without host, locale segment,
 * query, fragment or trailing slash ("/" for the site root). Returns null for
 * non-Learn hosts, relative strings and anything that cannot be parsed.
 */
export function canonicalPath(input) {
  if (typeof input !== "string" || !input) return null;
  let path;
  if (/^https?:\/\//i.test(input)) {
    let url;
    try {
      url = new URL(input);
    } catch {
      return null;
    }
    if (url.hostname.toLowerCase() !== LEARN_HOST) return null;
    path = url.pathname;
  } else if (input.startsWith("/")) {
    path = input.split(/[?#]/)[0];
  } else {
    return null;
  }
  path = path.replace(/^\/[a-z]{2}-[a-z]{2}(?=\/|$)/i, "").replace(/\/+$/, "");
  return (path || "/").toLowerCase();
}

/** "/training/modules/<module>" for a module slug. */
export function modulePath(slug) {
  return `/training/modules/${slug}`;
}

/** Slug text without its leading number: "14-exercise-add" -> "exercise-add". */
export function slugText(slug) {
  return slug.replace(/^\d+[a-z]?-/, "");
}

/** Split a canonical path into its first segment ("azure") or null for "/". */
export function firstSegment(path) {
  return path.split("/")[1] || null;
}

/** True if `path` equals `prefix` or sits under it ("azure" matches "/azure/x", not "/azure-x"). */
export function underPrefix(path, prefix) {
  const p = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return path === p || path.startsWith(`${p}/`);
}

/** Plain code-point comparison (stable across ICU/locale settings). */
export function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
