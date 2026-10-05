/**
 * data/docs-urls.txt: the complete URL index. See DATA_CONTRACT.md.
 *
 * One line per page, `<canonical path>\t<lastmod or ->`, sorted by code point,
 * LF line endings, trailing newline. Pure: no I/O.
 */

import { byCodePoint } from "./canonical.mjs";

/** Map<canonical path, lastmod | null> -> file text. */
export function serializeIndex(index) {
  const paths = [...index.keys()].sort(byCodePoint);
  let out = "";
  for (const p of paths) {
    if (!p.startsWith("/") || /[\t\r\n]/.test(p)) throw new Error(`invalid index path: ${JSON.stringify(p)}`);
    const lastmod = index.get(p);
    out += `${p}\t${lastmod ? String(lastmod).replace(/[\t\r\n]/g, " ").trim() || "-" : "-"}\n`;
  }
  return out;
}

/**
 * File text -> Map<canonical path, lastmod | null>. Strict: a malformed line
 * means the file is corrupt, and silently half-reading it would shrink the
 * baseline the failsafes compare against, so this throws instead.
 */
export function parseIndex(text) {
  const index = new Map();
  if (!text) return index;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line) continue;
    const tab = line.indexOf("\t");
    const path = tab === -1 ? line : line.slice(0, tab);
    const lastmod = tab === -1 ? "-" : line.slice(tab + 1);
    if (!path.startsWith("/") || path !== path.toLowerCase()) {
      throw new Error(`docs-urls.txt line ${i + 1} is not a canonical path: ${JSON.stringify(line.slice(0, 120))}`);
    }
    if (index.has(path)) throw new Error(`docs-urls.txt line ${i + 1} repeats ${path}`);
    index.set(path, lastmod === "-" || lastmod === "" ? null : lastmod);
  }
  return index;
}

/** Latest lastmod (YYYY-MM-DD prefix) among rows/index values, or null. */
export function maxLastmod(values) {
  let max = null;
  for (const v of values) {
    if (!v) continue;
    const day = String(v).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (max === null || day > max) max = day;
  }
  return max;
}
