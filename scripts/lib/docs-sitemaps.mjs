/**
 * Sitemap pass for the docs sync: turning sitemap XML into scoped rows,
 * choosing which sitemap families to download, and maintaining the family
 * memo (data/docs-sitemap-families.json). Pure: no I/O, no network.
 */

import { canonicalPath, byCodePoint } from "./canonical.mjs";
import { DEFAULT_SCOPES, scopeClass } from "./docs-scope.mjs";
import { normalizeLearnUrl, parseSitemapIndex, parseUrlset, sitemapFamily } from "./sitemap-helpers.mjs";

/**
 * Sitemap index XML -> the child sitemap files for one locale, plus any nested
 * index files that must be read as well.
 */
export function listSitemapChildren(xml, locale = "en-us") {
  const files = [];
  const nested = [];
  for (const child of parseSitemapIndex(xml)) {
    const fam = sitemapFamily(child.loc);
    if (fam) {
      if (fam.locale === locale) files.push({ ...child, ...fam });
    } else if (/index/i.test(child.loc)) {
      nested.push(child.loc);
    }
  }
  return { files, nested };
}

/**
 * <urlset> XML -> rows for every URL under either scope.
 *
 * A row is { url, path, lastmod, family, cls }:
 *   url   the catalog's legacy shape (https://learn.microsoft.com/<path>, no
 *         locale, no query, the sitemap's own letter case)
 *   path  the canonical path (lowercase), the identity used everywhere else
 *   cls   "learn" | "index" (see docs-scope.mjs)
 *
 * `segments` (optional Map) is filled with the first path segment of EVERY url
 * in the file, in or out of scope, so the caller can report product areas
 * that neither scope covers. `queryRows` counts in-scope urls that carried a
 * query string (it is dropped: a query never identifies a different page).
 */
export function rowsFromUrlset(xml, { family, scopes = DEFAULT_SCOPES, segments = null } = {}) {
  const rows = [];
  let total = 0;
  let queryRows = 0;
  for (const { loc, lastmod } of parseUrlset(xml)) {
    total++;
    const path = canonicalPath(loc);
    if (path === null) continue;
    if (segments) {
      const seg = path.split("/")[1] || "";
      segments.set(seg, (segments.get(seg) || 0) + 1);
    }
    const cls = scopeClass(path, scopes);
    if (!cls) continue;
    const norm = normalizeLearnUrl(loc); // null unless it is an en-us learn.microsoft.com page
    if (!norm) continue;
    const q = norm.indexOf("?");
    if (q !== -1) queryRows++;
    rows.push({ url: q === -1 ? norm : norm.slice(0, q), path, lastmod, family, cls });
  }
  return { rows, total, queryRows };
}

/**
 * Collapses rows to one per canonical path (several ?view= monikers of one page
 * and case variants of one spelling land here). Keeps the newest lastmod so a
 * change to any variant still refreshes metadata. Ties keep the spelling in
 * `prefer` (path -> url the catalog already uses) so the spelling is stable,
 * then the code-point smallest url so the choice never depends on file order.
 */
export function dedupeRows(rows, prefer = new Map()) {
  const byPath = new Map();
  for (const r of rows) {
    const cur = byPath.get(r.path);
    if (!cur) {
      byPath.set(r.path, r);
      continue;
    }
    const a = r.lastmod || "";
    const b = cur.lastmod || "";
    if (a > b) byPath.set(r.path, r);
    else if (a === b && r.url !== cur.url) {
      const want = prefer.get(r.path);
      if (want ? r.url === want : byCodePoint(r.url, cur.url) < 0) byPath.set(r.path, r);
    }
  }
  return byPath;
}

const DAY_MS = 86400000;

export function daysBetween(fromDay, toDay) {
  return Math.floor((Date.parse(toDay) - Date.parse(fromDay)) / DAY_MS);
}

/**
 * Which sitemap files to download this run. A family is skipped only when the
 * memo says it holds nothing in scope AND that answer was computed against the
 * current scope AND it is not due for a periodic re-look (new content can
 * appear in a family that used to hold none of it).
 *
 *   full         FULL_DISCOVERY=1: everything
 *   scopeSig     docs-scope.mjs scopeSignature() of the current scopes
 *   recheckDays  re-download "irrelevant" families this old (<= 0 disables)
 *   maxRechecks  at most this many families are re-looked-at per run for age
 *                alone, oldest first, so the families that were all checked on
 *                the same day do not all come due on the same day. A scope
 *                change is never capped: the index must be complete.
 *
 * Reasons: "full discovery", "new family", "relevant", "scope changed",
 * "recheck due".
 */
export function selectSitemapFiles(files, memo, { full = false, scopeSig, today, recheckDays = 28, maxRechecks = Infinity } = {}) {
  const decide = (family) => {
    if (full) return "full discovery";
    const m = memo[family];
    if (!m || typeof m.relevant !== "boolean") return "new family";
    if (m.relevant) return "relevant";
    if (m.scope !== scopeSig) return "scope changed";
    if (recheckDays > 0 && (!m.checked || daysBetween(m.checked, today) >= recheckDays)) return "recheck due";
    return null;
  };
  const verdict = new Map();
  for (const f of files) if (!verdict.has(f.family)) verdict.set(f.family, decide(f.family));

  const due = [...verdict].filter(([, reason]) => reason === "recheck due").map(([family]) => family);
  if (due.length > maxRechecks) {
    due.sort((a, b) => {
      const ca = memo[a]?.checked || "";
      const cb = memo[b]?.checked || "";
      return ca !== cb ? (ca < cb ? -1 : 1) : byCodePoint(a, b);
    });
    for (const family of due.slice(Math.max(0, maxRechecks))) verdict.set(family, null);
  }

  const reasons = {};
  for (const [family, reason] of verdict) if (reason) reasons[family] = reason;
  const selected = files.filter((f) => verdict.get(f.family));
  const skipped = [...verdict].filter(([, reason]) => !reason).map(([family]) => family).sort(byCodePoint);
  return { selected, skipped, reasons };
}

/**
 * New family memo. `outcomes` is a Map<family, { failed, inScope }> for the
 * families downloaded this run (failed = number of files that failed).
 *
 *   downloaded, something in scope   relevant: true
 *   downloaded fully, nothing        relevant: false
 *   downloaded partly (a file failed) and nothing found: unchanged. A failed
 *     file may hold the in-scope URLs, so it must not flip the answer to false.
 *   not downloaded                   unchanged
 *
 * Families that no longer appear in the sitemap index are dropped.
 */
export function updateFamilies(memo, familyNames, outcomes, { scopeSig, today }) {
  const next = {};
  for (const name of [...familyNames].sort(byCodePoint)) {
    const prev = memo[name] || {};
    const o = outcomes.get(name);
    if (o && o.inScope > 0) next[name] = { relevant: true, checked: today, scope: scopeSig };
    else if (o && o.failed === 0) next[name] = { relevant: false, checked: today, scope: scopeSig };
    else next[name] = { ...prev };
  }
  return next;
}
