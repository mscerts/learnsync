/**
 * Docs sidebar groups: the table of contents ("toc.json") that Learn serves for a folder of documentation
 * pages and that is shown as the left sidebar of every page in it. Pages that sit in the same group of the
 * sidebar are about the same topic ("Add users and groups > Groups" holds both "Manage groups" and "Learn
 * about groups"), so a consumer that finds one of them can find the others. Pure logic (no I/O, no
 * network); the run is scripts/lib/docs-toc-run.mjs and the file format is in DATA_CONTRACT.md.
 *
 * What a toc file looks like (checked on real folders): `{ items: [ { toc_title, href?, children?, expanded? } ] }`,
 * a tree. A node with `children` is a group; a node with only an `href` is a page. `href` is relative to the folder
 * of the toc file ("what-is-entra", "./" for the folder's landing page, "../identity/users/" for another
 * folder), an absolute path, or an external URL (not stored). A toc file exists per FOLDER, not per product:
 * /entra/identity/users/toc.json answers 200 while /entra/identity/toc.json answers 404, so the folders to
 * ask are those that hold pages (see directoriesToProbe), and a folder without a toc.json simply has none.
 */

import { createHash } from "node:crypto";
import { byCodePoint, canonicalPath, LEARN_HOST } from "./canonical.mjs";
import { daysBetween, isIsoDate } from "./learn-helpers.mjs";

export const DOCS_TOC_SCHEMA_VERSION = 1;

export const DOCS_TOC_LIMITS = {
  // A folder with fewer pages than this is not asked for a toc (a docs set's toc folder holds many pages).
  MIN_DIR_PAGES: 3,
  // Most folders one run asks for a toc that it has not asked before; the rest waits for the next run.
  MAX_PROBES: 6000,
  // A folder that answered "no toc.json" is asked again after this many days.
  RECHECK_DAYS: 28,
  // Abort when more than this percentage of the requests failed (at least FAIL_MIN_SAMPLE made).
  MAX_FAIL_PCT: 10,
  FAIL_MIN_SAMPLE: 20,
  // Circuit breaker: stop a dead site after this many requests when more than half failed.
  BREAKER_MIN: 50,
  // Abort when more than this percentage of the answers that were HTTP 200 are not a toc (Learn changed the format).
  MAX_FORMAT_FAIL_PCT: 10,
  // Abort when fewer than this percentage of the pages that were in a group before still are.
  MIN_KEPT_PAGES_PCT: 70,
  PAGES_MIN_PREVIOUS: 200,
};

/** A page path from a toc `href`: relative to the toc's folder, absolute path or full URL; null when not Learn. */
export function resolveTocHref(href, tocFolder) {
  if (typeof href !== "string" || href.trim() === "") return null;
  const text = href.trim();
  let path;
  if (/^https?:\/\//i.test(text) || text.startsWith("/")) {
    path = canonicalPath(text);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.startsWith("#")) {
    return null; // mailto:, javascript:, a bare anchor
  } else {
    let url;
    try {
      url = new URL(text, `https://${LEARN_HOST}${tocFolder}/`);
    } catch {
      return null;
    }
    path = canonicalPath(`${url.pathname}`);
  }
  if (!path) return null;
  path = path.replace(/\.(md|yml|yaml|json)$/, "").replace(/\/index$/, "");
  return path === "" ? "/" : path;
}

/**
 * The groups of one toc tree, in the order of the sidebar: `[{ title: [..ancestors, own], landing, pages }]`.
 * `title` is the breadcrumb of group titles; `landing` the page a group's own `href` points to (a group can have
 * one), null otherwise; `pages` the pages that sit DIRECTLY in the group, in sidebar order. Pages at the top
 * level of the toc form the group with the empty title `[]`. Groups without any page or landing are left out.
 * Returns null when `toc` is not a toc tree (no `items` array).
 */
export function parseToc(toc, tocFolder) {
  if (!toc || typeof toc !== "object" || !Array.isArray(toc.items)) return null;
  const groups = [];
  const walk = (items, trail) => {
    const group = { title: trail, landing: null, pages: [] };
    const nested = [];
    groups.push(group);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const path = resolveTocHref(item.href, tocFolder);
      const children = Array.isArray(item.children) ? item.children : null;
      if (children && children.length > 0) {
        nested.push({ item, path, children });
      } else if (path && !group.pages.includes(path)) {
        group.pages.push(path);
      }
    }
    for (const { item, path, children } of nested) {
      const title = typeof item.toc_title === "string" ? item.toc_title.replace(/\s+/g, " ").trim() : "";
      const own = walk(children, [...trail, title]);
      own.landing = path;
    }
    return group;
  };
  walk(toc.items, []);
  return groups.filter((g) => g.pages.length > 0 || g.landing).map((g) => ({ title: g.title, landing: g.landing, pages: g.pages }));
}

/** How many distinct pages a list of groups holds (landing pages included). */
export function countPages(groups) {
  const pages = new Set();
  for (const g of groups) {
    if (g.landing) pages.add(g.landing);
    for (const p of g.pages) pages.add(p);
  }
  return pages.size;
}

/** A short signature of a tree of groups, so a consumer can tell that a toc changed. */
export function signatureOf(groups) {
  return createHash("sha1").update(JSON.stringify(groups)).digest("hex");
}

/** One toc record of the file. */
export function buildTocRecord({ path, groups, since }) {
  return { path, since, sig: signatureOf(groups), pages: countPages(groups), groups };
}

/**
 * The folders that hold pages of the index, with how many: `[{ dir, pages }]`, sorted. `index` is the
 * path -> lastmod Map of data/docs-urls.txt; `families` the first path segments in scope (null = all).
 * A folder is the path of a page without its last segment ("/entra/fundamentals" for
 * "/entra/fundamentals/how-to-manage-groups"); a page directly under the site root has none.
 */
export function directoriesOf(index, { families = null } = {}) {
  const counts = new Map();
  for (const path of index.keys ? index.keys() : index) {
    const parts = path.split("/").filter(Boolean);
    if (parts.length < 2) continue;
    if (families && !families.has(parts[0])) continue;
    const dir = `/${parts.slice(0, -1).join("/")}`;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts].map(([dir, pages]) => ({ dir, pages })).sort((a, b) => byCodePoint(a.dir, b.dir));
}

/**
 * What a run asks for.
 *   refresh  the folders that had a toc: asked again every run (one small file each)
 *   probe    folders never asked (or whose "no toc.json" answer is older than recheckDays), at most maxProbes
 *   waiting  the folders left for the next run
 *   dropped  folders that had a toc or an answer and hold no page of the index any more
 */
export function planProbes({ directories, previousTocs, previousNoToc, today, recheckDays, maxProbes, minDirPages }) {
  const inScope = new Map(directories.map((d) => [d.dir, d.pages]));
  const refresh = [];
  const dropped = [];
  for (const toc of previousTocs) (inScope.has(toc.path) ? refresh : dropped).push(toc.path);
  const known = new Set(previousTocs.map((t) => t.path));
  const candidates = [];
  for (const { dir, pages } of directories) {
    if (known.has(dir) || pages < minDirPages) continue;
    const answered = previousNoToc[dir];
    if (answered && isIsoDate(answered) && daysBetween(answered, today) < recheckDays) continue;
    candidates.push({ dir, answered: answered ?? null });
  }
  // folders never asked first, then the oldest answers
  candidates.sort((a, b) => (b.answered === null) - (a.answered === null) || byCodePoint(a.answered ?? "", b.answered ?? "") || byCodePoint(a.dir, b.dir));
  const probe = candidates.slice(0, maxProbes).map((c) => c.dir);
  for (const dir of Object.keys(previousNoToc)) if (!inScope.has(dir)) dropped.push(dir);
  return { refresh: refresh.sort(byCodePoint), probe: probe.sort(byCodePoint), waiting: Math.max(0, candidates.length - probe.length), dropped: dropped.sort(byCodePoint) };
}

/** The file: tocs and answers sorted by path, nothing derived. */
export function buildFile({ tocs, noToc, scope, lastChecked }) {
  const sortedNoToc = {};
  for (const dir of Object.keys(noToc).sort(byCodePoint)) sortedNoToc[dir] = noToc[dir];
  return {
    schemaVersion: DOCS_TOC_SCHEMA_VERSION,
    lastChecked,
    scope,
    tocs: [...tocs].sort((a, b) => byCodePoint(a.path, b.path)),
    noToc: sortedNoToc,
  };
}

/** A previous file that can be built on, or null (absent, unreadable, another schema). */
export function readPrevious(file) {
  if (!file || file.schemaVersion !== DOCS_TOC_SCHEMA_VERSION || !Array.isArray(file.tocs)) return null;
  const tocs = file.tocs.filter((t) => t && typeof t.path === "string" && Array.isArray(t.groups));
  const noToc = file.noToc && typeof file.noToc === "object" ? file.noToc : {};
  return { ...file, tocs, noToc };
}

/** The content of a file without the timestamp, for "did anything change". */
export function stableContent(file) {
  return JSON.stringify({ ...file, lastChecked: "" });
}

/** Totals of a list of toc records. */
export function summarizeTocs(tocs) {
  let pages = 0;
  let groups = 0;
  const unique = new Set();
  for (const toc of tocs) {
    groups += toc.groups.length;
    for (const g of toc.groups) {
      if (g.landing) unique.add(g.landing);
      for (const p of g.pages) unique.add(p);
    }
    pages += toc.pages ?? 0;
  }
  return { tocs: tocs.length, groups, pages, uniquePages: unique.size };
}

/** Stop a dead site early: more than half of at least BREAKER_MIN requests failed. */
export function breakerTripped({ attempted, failed, limits = DOCS_TOC_LIMITS }) {
  return attempted >= limits.BREAKER_MIN && failed * 2 > attempted;
}

/**
 * Reasons to abort the run (nothing is written): too many requests failed, Learn answered with something that
 * is not a toc too often (the format changed), or far fewer pages are in a group than before.
 */
export function evaluateFailsafes({ attempted, failed, answeredOk, formatFailed, previousPages, nextPages, limits = DOCS_TOC_LIMITS }) {
  const problems = [];
  if (attempted >= limits.FAIL_MIN_SAMPLE && (failed / attempted) * 100 > limits.MAX_FAIL_PCT) {
    problems.push(`${failed} of ${attempted} requests failed (more than ${limits.MAX_FAIL_PCT}%): rate limiting or an outage`);
  }
  if (answeredOk >= limits.FAIL_MIN_SAMPLE && (formatFailed / answeredOk) * 100 > limits.MAX_FORMAT_FAIL_PCT) {
    problems.push(`${formatFailed} of ${answeredOk} answers were HTTP 200 but not a table of contents (more than ${limits.MAX_FORMAT_FAIL_PCT}%): the toc.json format probably changed`);
  }
  if (previousPages >= limits.PAGES_MIN_PREVIOUS && (nextPages / previousPages) * 100 < limits.MIN_KEPT_PAGES_PCT) {
    problems.push(`only ${nextPages} pages are in a sidebar group now, against ${previousPages} before (less than ${limits.MIN_KEPT_PAGES_PCT}%)`);
  }
  return problems;
}

/**
 * The lookup a consumer builds from the file: page -> the groups it is in, and a group's siblings.
 * `lookup.groupsOf(path)` returns `[{ toc, title, landing, pages }]` (a page is usually in one group);
 * `lookup.siblingsOf(path)` the other pages of those groups, in sidebar order, without the page itself.
 */
export function buildLookup(file) {
  const byPage = new Map();
  for (const toc of file?.tocs ?? []) {
    for (const group of toc.groups) {
      const entry = { toc: toc.path, title: group.title, landing: group.landing, pages: group.pages };
      for (const page of group.landing ? [group.landing, ...group.pages] : group.pages) {
        const list = byPage.get(page) ?? [];
        list.push(entry);
        byPage.set(page, list);
      }
    }
  }
  return {
    pages: byPage.size,
    groupsOf: (path) => byPage.get(path) ?? [],
    siblingsOf: (path) => {
      const seen = new Set([path]);
      const out = [];
      for (const g of byPage.get(path) ?? []) {
        for (const p of g.landing ? [g.landing, ...g.pages] : g.pages) {
          if (seen.has(p)) continue;
          seen.add(p);
          out.push(p);
        }
      }
      return out;
    },
  };
}
