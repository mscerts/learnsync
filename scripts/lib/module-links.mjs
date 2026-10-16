/**
 * Module links: the links Microsoft puts in the LAST unit of a Learn module
 * ("Summary", "Summary and resources"), mostly curated documentation pages that
 * belong to what the module teaches. Pure logic (no I/O, no network); the run is
 * scripts/lib/module-links-run.mjs and the file format is in DATA_CONTRACT.md.
 *
 * What the last unit looks like (checked on real pages): the content sits in
 * `#unit-inner-section` and ends at a hidden `#next-section` placeholder, the
 * feedback area comes after it. Links hang under an `<h2>` such as "Learn more",
 * "Additional resources", "Learn more with documentation" or "References for this
 * module include"; the headings vary too much to list, so every section counts
 * except the ones that hold prompts or page furniture (SKIP_SECTION). The heading
 * is stored with each link so a consumer can still filter.
 */

import { byCodePoint, canonicalPath, LEARN_HOST } from "./canonical.mjs";
import { classifyRedirect } from "./docs-redirects.mjs";
import { daysBetween, isIsoDate } from "./learn-helpers.mjs";

export const MODULE_LINKS_SCHEMA_VERSION = 1;
export const SCOPES = ["courses", "all"];

/** Sections of the unit that are not resources: Copilot prompts, feedback, quizzes. */
export const SKIP_SECTION = /copilot|feedback|check your knowledge|knowledge check|learning objectives/i;

export const MODULE_LINKS_LIMITS = {
  // Last-resort floor on the number of in-scope modules (the course scope is ~1,400 modules, all ~3,400).
  MIN_SCOPE_MODULES: { courses: 300, all: 3000 },
  // Abort when more than this percentage of unit-page requests failed (at least FAIL_MIN_SAMPLE made).
  MAX_FAIL_PCT: 10,
  FAIL_MIN_SAMPLE: 20,
  // Circuit breaker: stop a dead site after this many requests when more than half failed.
  BREAKER_MIN: 50,
  // Abort when more than this percentage of the pages fetched have no unit content (Learn changed its markup).
  MAX_LAYOUT_FAIL_PCT: 10,
  // Abort when fewer than this percentage of the modules that had links before still have them.
  MIN_KEPT_WITH_LINKS_PCT: 70,
  WITH_LINKS_MIN_PREVIOUS: 50,
  // Most pages one run fetches; the rest waits for the next run.
  MAX_FETCHES: 4000,
  // A full refresh (every in-scope module) at least this often.
  FULL_REFRESH_DAYS: 30,
  // Link cleaning: most live checks one run makes (a first run needs about a thousand).
  MAX_PROBES: 3000,
  // A link a live check confirmed is not checked again for this many days.
  RECHECK_DAYS: 30,
  // Abort when more than this percentage of the live checks were inconclusive (rate limit, outage)
  // or found the page gone (a bad probe or an outage looks like a mass removal); at least FAIL_MIN_SAMPLE checks.
  MAX_PROBE_UNKNOWN_PCT: 20,
  MAX_DROP_PCT: 30,
};

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘" };

/** Tags removed, entities decoded, whitespace collapsed. */
export function decodeText(html) {
  return String(html ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === "#") {
        const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The unit content of a unit page: from `#unit-inner-section` to the hidden
 * `#next-section` placeholder, without scripts and styles. Null when either marker
 * is missing (the page layout changed or the page is not a unit): a missing end
 * marker would pull the feedback area and footer links into the data.
 */
export function unitContent(html) {
  if (typeof html !== "string") return null;
  const start = html.indexOf('id="unit-inner-section"');
  if (start < 0) return null;
  const rest = html.slice(start);
  const end = rest.search(/id="next-section"/);
  if (end < 0) return null;
  return rest.slice(0, end).replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, "");
}

/** The unit content split at its `<h2>` headings: the lead first (section "lead"), then one entry per heading. */
export function splitSections(content) {
  const parts = content.split(/<h2\b[^>]*>/i);
  const sections = [{ section: "lead", html: parts[0] }];
  for (const part of parts.slice(1)) {
    const [head, ...rest] = part.split(/<\/h2>/i);
    sections.push({ section: decodeText(head).slice(0, 80), html: rest.join("</h2>") });
  }
  return sections;
}

const LEARN_OTHER = /^\/(credentials|shows|answers|collections|events|users|contribute|assessments)(\/|$)/;

/** "training" (modules, paths, courses), "learn-other" (credentials, shows, ...) or "docs" for a canonical Learn path. */
export function learnKind(path) {
  if (path === "/training" || path.startsWith("/training/")) return "training";
  if (LEARN_OTHER.test(path)) return "learn-other";
  return "docs";
}

/**
 * One href of a unit page -> { kind, path } (a Learn page) or { kind: "external", url },
 * or null for what is no link worth keeping: anchors, mailto/javascript, the module itself
 * and its own units.
 */
export function classifyLink(href, modulePath) {
  const raw = decodeText(href).trim();
  if (!raw || raw.startsWith("#") || /^(mailto|tel|javascript):/i.test(raw)) return null;
  let url;
  try {
    url = new URL(raw, `https://${LEARN_HOST}/en-us/`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname.toLowerCase() === LEARN_HOST) {
    const path = canonicalPath(`${url.origin}${url.pathname}`);
    if (!path || path === "/") return null;
    if (modulePath && (path === modulePath || path.startsWith(`${modulePath}/`))) return null;
    return { kind: learnKind(path), path };
  }
  url.hash = "";
  return { kind: "external", url: url.href };
}

const LINK_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;

/**
 * All links of a unit page, in page order, first occurrence wins:
 * { unitTitle, links: [{ kind, path | url, text, section }] }, or null when the page has
 * no unit content (see unitContent).
 */
export function extractUnitLinks(html, { modulePath } = {}) {
  const content = unitContent(html);
  if (content === null) return null;
  const unitTitle = decodeText(html.match(/id="module-unit-title"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "").slice(0, 120);
  const seen = new Set();
  const links = [];
  for (const { section, html: part } of splitSections(content)) {
    if (SKIP_SECTION.test(section)) continue;
    for (const match of part.matchAll(LINK_RE)) {
      const href = match[1].match(/\bhref\s*=\s*"([^"]*)"/i)?.[1];
      if (href === undefined) continue;
      const target = classifyLink(href, modulePath);
      if (!target) continue;
      const key = target.path ?? target.url;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ ...target, text: decodeText(match[2]).slice(0, 200), section });
    }
  }
  return { unitTitle, links };
}

/** { path, unitSig, unit, unitTitle, harvestedAt, links } for one harvested module. */
export function buildRecord({ module, unit, extracted, today }) {
  return {
    path: module.path,
    unitSig: module.unitSig,
    unit,
    unitTitle: extracted.unitTitle,
    harvestedAt: today,
    links: extracted.links,
  };
}

/**
 * The module paths in scope. "all": every module of the catalog. "courses": the modules of
 * every learning path (and every module) that an official course lists in its `study_guide`.
 * `courses` is the catalog API's course list, `learningPaths` the `learningPaths` of
 * learn-content.json (`uid`, `modules[]` as canonical paths), `moduleUidToPath` the catalog's
 * module uids. Returns { paths: Set, unknown } where `unknown` counts study_guide entries that
 * resolved to nothing.
 */
export function scopeModulePaths({ scope, catalogModules, courses, learningPaths, moduleUidToPath }) {
  if (scope === "all") return { paths: new Set(catalogModules.map((m) => m.path)), unknown: 0 };
  const pathByUid = new Map((learningPaths ?? []).map((p) => [p.uid, p]));
  const paths = new Set();
  let unknown = 0;
  for (const course of courses ?? []) {
    for (const entry of course.study_guide ?? []) {
      const learningPath = pathByUid.get(entry.uid);
      if (learningPath) {
        for (const modulePath of learningPath.modules ?? []) paths.add(modulePath);
      } else if (moduleUidToPath.has(entry.uid)) {
        paths.add(moduleUidToPath.get(entry.uid));
      } else {
        unknown++;
      }
    }
  }
  return { paths, unknown };
}

/**
 * Which modules to fetch this run. A module is fetched when it is in scope, has unit URLs and
 * a signature, and has no record, a record with another unitSig, or (fullRefresh) always.
 * Order: new modules, then changed ones, then the oldest harvests; at most `maxFetches`.
 * Returns { toFetch: [{ module, unit }], noUnits: [paths], waiting: n }.
 */
export function planHarvest({ catalogModules, scopePaths, previous, fullRefresh, maxFetches }) {
  const known = new Map((previous ?? []).map((record) => [record.path, record]));
  const noUnits = [];
  const candidates = [];
  for (const module of catalogModules) {
    if (!scopePaths.has(module.path)) continue;
    if (!Array.isArray(module.unitUrls) || module.unitUrls.length === 0 || !module.unitSig) {
      noUnits.push(module.path);
      continue;
    }
    const record = known.get(module.path);
    let rank;
    if (!record) rank = 0;
    else if (record.unitSig !== module.unitSig) rank = 1;
    else if (fullRefresh) rank = 2;
    else continue;
    candidates.push({ module, unit: module.unitUrls[module.unitUrls.length - 1], rank, harvestedAt: record?.harvestedAt ?? "" });
  }
  candidates.sort((a, b) => a.rank - b.rank || byCodePoint(a.harvestedAt, b.harvestedAt) || byCodePoint(a.module.path, b.module.path));
  const toFetch = candidates.slice(0, maxFetches).map(({ module, unit }) => ({ module, unit }));
  return { toFetch, noUnits: noUnits.sort(byCodePoint), waiting: candidates.length - toFetch.length };
}

// ---------------------------------------------------------------------------------------------
// Link cleaning. The links are copied from Microsoft's pages as written, and those pages lag the
// documentation: a first harvest had ~28% of the docs links the docs index did not know pointing
// at moved pages. Before a link goes into the cache its target is checked, so the cache holds
// current paths: caches first (the validator), a live probe for what they cannot settle.
//   valid  -> kept as it is
//   moved  -> `path` becomes the destination, the old one is kept as `was`
//   gone, or sent to a landing page or an archive -> the link is dropped
//   inconclusive (rate limit, outage, probe budget) -> kept, marked `unverified: true`, retried next run
// A link a live probe confirmed carries `checked` (the day) and is not probed again for RECHECK_DAYS.
// External links are not checked.
// ---------------------------------------------------------------------------------------------

/** Link kinds whose target is a Learn page, so it can be checked. */
export const CHECKED_KINDS = new Set(["docs", "training", "learn-other"]);

/** The unique canonical Learn paths of the links that can be checked, in code-point order. */
export function learnPaths(records) {
  const paths = new Set();
  for (const record of records) for (const link of record.links) if (CHECKED_KINDS.has(link.kind) && link.path) paths.add(link.path);
  return [...paths].sort(byCodePoint);
}

/**
 * What the caches alone decide about a link target (a validator result: verdict, path, confidence,
 * redirectsTo), or null when only a live probe can: a decision is { action, via, to? }.
 */
export function decideOffline(result) {
  if (!result) return null;
  if (result.verdict === "valid") return { action: "keep", via: "cache" };
  if (result.verdict === "moved" && result.confidence === "high" && result.redirectsTo) {
    return classifyRedirect(result.path, result.redirectsTo) === "moved"
      ? { action: "rewrite", to: result.redirectsTo, via: "cache" }
      : { action: "drop", via: "cache" };
  }
  return null;
}

/** What a live probe (live-probe.mjs `probe()`: verdict ok|broken|moved|unknown, redirectsTo) decides about `path`. */
export function decideProbe(path, outcome) {
  switch (outcome?.verdict) {
    case "ok":
      return { action: "keep", via: "probe" };
    case "moved":
      return outcome.redirectsTo && classifyRedirect(path, outcome.redirectsTo) === "moved"
        ? { action: "rewrite", to: outcome.redirectsTo, via: "probe" }
        : { action: "drop", via: "probe" };
    case "broken":
      return { action: "drop", via: "probe" };
    default:
      return { action: "unverified", via: "probe" };
  }
}

/**
 * Which of `paths` (targets the caches could not settle) get a live probe: not those a probe confirmed
 * within `recheckDays` (they are kept as they are), the never-checked first, then the longest unchecked,
 * at most `maxProbes`. Returns { toProbe, fresh, waiting }.
 */
export function planProbes({ records, paths, today, recheckDays, maxProbes }) {
  const checkedAt = new Map();
  for (const record of records) {
    for (const link of record.links) {
      if (!link.path || !isIsoDate(link.checked) || link.unverified) continue;
      if (!checkedAt.has(link.path) || link.checked > checkedAt.get(link.path)) checkedAt.set(link.path, link.checked);
    }
  }
  const fresh = [];
  const stale = [];
  for (const path of paths) {
    const when = checkedAt.get(path);
    if (when && daysBetween(when, today) <= recheckDays) fresh.push(path);
    else stale.push({ path, when: when ?? "" });
  }
  stale.sort((a, b) => byCodePoint(a.when, b.when) || byCodePoint(a.path, b.path));
  return { toProbe: stale.slice(0, maxProbes).map((s) => s.path), fresh, waiting: stale.slice(maxProbes).map((s) => s.path) };
}

/**
 * Apply per-path decisions to the records. A path with no decision is kept as the caches left it.
 * Returns { records, counts: { kept, rewritten, dropped, unverified } (links), droppedPaths, rewrittenPaths }.
 * A rewritten link keeps its first `was`; links that end up with the same target within a module are
 * merged (first one wins); the key order of a link is fixed so the file stays stable.
 */
export function applyDecisions({ records, decisions, today }) {
  const counts = { kept: 0, rewritten: 0, dropped: 0, unverified: 0 };
  const droppedPaths = new Set();
  const rewrittenPaths = new Set();
  const out = records.map((record) => {
    const seen = new Set();
    const links = [];
    for (const link of record.links) {
      if (!CHECKED_KINDS.has(link.kind)) {
        const key = link.url ?? link.path;
        if (!seen.has(key)) {
          seen.add(key);
          links.push(link);
        }
        continue;
      }
      const decision = decisions.get(link.path) ?? { action: "keep", via: "cache" };
      if (decision.action === "drop") {
        counts.dropped++;
        droppedPaths.add(link.path);
        continue;
      }
      let path = link.path;
      let was = link.was;
      let checked;
      let unverified = false;
      if (decision.action === "rewrite") {
        was = was ?? link.path;
        path = decision.to;
        counts.rewritten++;
        rewrittenPaths.add(link.path);
        if (decision.via === "probe") checked = today;
      } else if (decision.action === "unverified") {
        unverified = true;
        counts.unverified++;
      } else {
        counts.kept++;
        if (decision.via === "probe") checked = today;
        else if (decision.via === "fresh") checked = link.checked;
      }
      if (seen.has(path)) continue;
      seen.add(path);
      links.push({
        kind: decision.action === "rewrite" ? learnKind(path) : link.kind,
        path,
        text: link.text,
        section: link.section,
        ...(was ? { was } : {}),
        ...(checked ? { checked } : {}),
        ...(unverified ? { unverified: true } : {}),
      });
    }
    return { ...record, links };
  });
  return { records: out, counts, droppedPaths: [...droppedPaths].sort(byCodePoint), rewrittenPaths: [...rewrittenPaths].sort(byCodePoint) };
}

/** Counts of a record list: modules, how many have links, links by kind. */
export function summarizeRecords(records) {
  const byKind = { docs: 0, training: 0, "learn-other": 0, external: 0 };
  let withLinks = 0;
  let links = 0;
  for (const record of records) {
    if (record.links.length > 0) withLinks++;
    for (const link of record.links) {
      links++;
      byKind[link.kind] = (byKind[link.kind] ?? 0) + 1;
    }
  }
  return { modules: records.length, withLinks, links, byKind };
}

/**
 * Problems that must stop the run before anything is written (an empty list = go on).
 * `attempted`/`failed`/`layoutFailed` count this run's page requests, `previousWithLinks` and
 * `nextWithLinks` the modules that have at least one link before and after the merge.
 */
export function evaluateFailsafes({
  scope,
  scopeSize,
  attempted,
  failed,
  layoutFailed,
  previousWithLinks,
  nextWithLinks,
  probed = 0,
  probeUnknown = 0,
  probeDropped = 0,
  limits = MODULE_LINKS_LIMITS,
}) {
  const problems = [];
  if (probed >= limits.FAIL_MIN_SAMPLE && (probeUnknown / probed) * 100 > limits.MAX_PROBE_UNKNOWN_PCT) {
    problems.push(`${probeUnknown} of ${probed} live link checks were inconclusive (limit ${limits.MAX_PROBE_UNKNOWN_PCT}%): rate limiting or an outage, the links cannot be cleaned`);
  }
  if (probed >= limits.FAIL_MIN_SAMPLE && (probeDropped / probed) * 100 > limits.MAX_DROP_PCT) {
    problems.push(`${probeDropped} of ${probed} live link checks found the page gone or sent to a landing page (limit ${limits.MAX_DROP_PCT}%): an outage or a bad probe looks like this`);
  }
  const floor = limits.MIN_SCOPE_MODULES[scope];
  if (scopeSize < floor) problems.push(`only ${scopeSize} modules are in scope "${scope}" (floor ${floor}): the course list or the catalog is incomplete`);
  if (attempted >= limits.FAIL_MIN_SAMPLE && (failed / attempted) * 100 > limits.MAX_FAIL_PCT) {
    problems.push(`${failed} of ${attempted} unit pages could not be read (limit ${limits.MAX_FAIL_PCT}%)`);
  }
  const fetchedPages = attempted - failed;
  if (fetchedPages >= limits.FAIL_MIN_SAMPLE && (layoutFailed / fetchedPages) * 100 > limits.MAX_LAYOUT_FAIL_PCT) {
    problems.push(`${layoutFailed} of ${fetchedPages} unit pages have no unit content: Learn probably changed its page markup (limit ${limits.MAX_LAYOUT_FAIL_PCT}%)`);
  }
  if (previousWithLinks >= limits.WITH_LINKS_MIN_PREVIOUS && (nextWithLinks / previousWithLinks) * 100 < limits.MIN_KEPT_WITH_LINKS_PCT) {
    problems.push(`only ${nextWithLinks} modules have links now, ${previousWithLinks} had them before (floor ${limits.MIN_KEPT_WITH_LINKS_PCT}% kept): the link extraction probably stopped working`);
  }
  return problems;
}

/** True when a circuit breaker should stop the run: enough requests made and more than half failed. */
export function breakerTripped({ attempted, failed, limits = MODULE_LINKS_LIMITS }) {
  return attempted >= limits.BREAKER_MIN && failed * 2 > attempted;
}

/**
 * The data file as the run writes it: records sorted by path; `scope`, `lastChecked` and
 * `fullRefreshAt` (the day a full refresh last really ran) are kept at the top.
 */
export function buildFile({ records, scope, lastChecked, fullRefreshAt }) {
  return {
    schemaVersion: MODULE_LINKS_SCHEMA_VERSION,
    lastChecked,
    scope,
    fullRefreshAt: fullRefreshAt ?? null,
    modules: [...records].sort((a, b) => byCodePoint(a.path, b.path)),
  };
}

/** The file without its moving stamp, for "did anything change" comparisons. */
export function stableContent(file) {
  const { lastChecked, ...rest } = file;
  return JSON.stringify(rest);
}

/**
 * The previous file, checked. Returns the parsed file, or null for a missing one.
 * Throws for a file that exists but cannot be used (wrong schemaVersion, no `modules`
 * array, a malformed record): the run must stop rather than overwrite state it cannot read.
 */
export function readPrevious(parsed) {
  if (parsed === null || parsed === undefined) return null;
  if (parsed.schemaVersion !== MODULE_LINKS_SCHEMA_VERSION) {
    throw new Error(`Cannot use data/module-links.json: schemaVersion ${JSON.stringify(parsed.schemaVersion)}, expected ${MODULE_LINKS_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(parsed.modules)) throw new Error("Cannot use data/module-links.json: `modules` is not an array");
  for (const record of parsed.modules) {
    const ok =
      record && typeof record.path === "string" && typeof record.unitSig === "string" && typeof record.unit === "string" &&
      Array.isArray(record.links) && record.links.every((link) => link && typeof link.kind === "string" && (typeof link.path === "string" || typeof link.url === "string"));
    if (!ok) throw new Error(`Cannot use data/module-links.json: malformed record ${JSON.stringify(record?.path ?? record)}`);
  }
  return parsed;
}
