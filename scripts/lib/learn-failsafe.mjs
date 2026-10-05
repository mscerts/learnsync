/**
 * Failsafes: a bad run (truncated API response, taxonomy change, rate-limit
 * storm) must never replace good data. Every check is a pure function that
 * returns a list of human-readable problems ([] = fine); the runners print them
 * and abort WITHOUT writing any file when the list is not empty.
 */

import { byCodePoint } from "./canonical.mjs";

const pct = (n) => `${Math.round(n * 100) / 100}%`;

/** Percentage by which `current` is below `previous` (0 when it grew or previous is 0). */
export function dropPercent(previous, current) {
  if (!(previous > 0)) return 0;
  return Math.max(0, ((previous - current) / previous) * 100);
}

/** Last-resort floor on the in-scope module count. */
export function checkMinModules(count, min) {
  return count < min ? [`only ${count} in-scope modules (floor ${min}): the catalog API response or its schema probably changed`] : [];
}

/** In-scope module count dropped more than maxDropPct vs the previous file. */
export function checkModuleDrop(previousCount, newCount, maxDropPct) {
  const drop = dropPercent(previousCount, newCount);
  return drop > maxDropPct
    ? [`in-scope modules fell from ${previousCount} to ${newCount} (-${pct(drop)}, limit ${maxDropPct}%)`]
    : [];
}

/** RAW API module count (every category) dropped more than maxDropPct vs the previous run: a truncated response. */
export function checkApiDrop(previousTotal, newTotal, maxDropPct) {
  const drop = dropPercent(previousTotal, newTotal);
  return drop > maxDropPct
    ? [`the API returned ${newTotal} modules vs ${previousTotal} last run (-${pct(drop)}, limit ${maxDropPct}%): response probably truncated`]
    : [];
}

/**
 * Every allowlisted category must still have modules. Ids in `knownEmpty` have
 * none upstream today and are exempt, EXCEPT when the previous data file had
 * modules in them (`previousCategoryIds`): losing those is never normal.
 * counts: { [topLevelId]: moduleCount } over all API modules.
 */
export function checkCategoryCoverage({ allowed, knownEmpty = [], counts, previousCategoryIds = [] }) {
  const exempt = new Set(knownEmpty);
  const hadModules = new Set(previousCategoryIds);
  const problems = [];
  for (const id of [...allowed].sort(byCodePoint)) {
    if ((counts[id] ?? 0) > 0) continue;
    if (hadModules.has(id)) problems.push(`allowlisted category "${id}" had modules in the previous data and has none now`);
    else if (!exempt.has(id)) problems.push(`allowlisted category "${id}" has zero modules (not listed in KNOWN_EMPTY_CATEGORIES)`);
  }
  return problems;
}

/** Known-empty categories that have modules again: not an abort, a hint to prune the list. */
export function recoveredEmptyCategories({ knownEmpty = [], counts }) {
  return [...knownEmpty].filter((id) => (counts[id] ?? 0) > 0).sort(byCodePoint);
}

/** Too many unit-title references unresolved: the catalog `units` array was probably truncated. */
export function checkUnitFallback({ missing, total, maxPct }) {
  if (!(total > 0)) return [];
  const share = (missing / total) * 100;
  return share > maxPct
    ? [`${missing} of ${total} unit titles (${pct(share)}) fell back to a uid, limit ${maxPct}%: the catalog units list is probably truncated`]
    : [];
}

/**
 * Hierarchy requests: abort when more than maxPct failed, but only for samples of
 * at least minSample requests (see LIMITS.HIERARCHY_MIN_SAMPLE for why).
 */
export function checkHierarchyFailures({ requests, failures, maxPct, minSample }) {
  if (requests < minSample || requests === 0) return [];
  const share = (failures / requests) * 100;
  return share > maxPct
    ? [`${failures} of ${requests} hierarchy requests failed (${pct(share)}, limit ${maxPct}%): the hierarchy API is unhealthy or rate limiting`]
    : [];
}

/**
 * Circuit breaker for the hierarchy pool: once at least earlySample requests have
 * completed and more than maxPct of them failed, keep going is pointless (every
 * failing request already burned its full retry/backoff budget), so stop early.
 */
export function shouldAbortHierarchyEarly({ completed, failures, maxPct, earlySample }) {
  return completed >= earlySample && (failures / completed) * 100 > maxPct;
}

/** Catalog-stage failsafes in one call (everything that can be decided before any hierarchy request). */
export function evaluateCatalogFailsafes({
  inScopeCount,
  apiTotal,
  previous,
  categoryModuleCounts,
  previousCategoryIds,
  allowedCategories,
  knownEmptyCategories,
  unitRefs,
  missingUnitTitles,
  limits,
}) {
  return [
    ...checkMinModules(inScopeCount, limits.MIN_MODULES),
    ...checkModuleDrop(previous?.inScopeCount ?? 0, inScopeCount, limits.MAX_MODULE_DROP_PCT),
    ...checkApiDrop(previous?.apiTotal ?? 0, apiTotal, limits.MAX_API_DROP_PCT),
    ...checkCategoryCoverage({
      allowed: allowedCategories,
      knownEmpty: knownEmptyCategories,
      counts: categoryModuleCounts,
      previousCategoryIds,
    }),
    ...checkUnitFallback({ missing: missingUnitTitles, total: unitRefs, maxPct: limits.MAX_UNIT_FALLBACK_PCT }),
  ];
}

/**
 * What the previous data file tells the failsafes: in-scope count, the raw API
 * total (stored since schema v2; for an older file the best lower bound is
 * in-scope + outOfScope) and which allowlisted category ids had modules.
 */
export function previousBaseline(previous, { categoryNameByTopId }) {
  if (!previous || !Array.isArray(previous.modules)) return null;
  const idByName = new Map([...categoryNameByTopId].map(([id, name]) => [name, id]));
  const ids = new Set();
  for (const mod of previous.modules) {
    for (const name of mod.categories ?? []) if (idByName.has(name)) ids.add(idByName.get(name));
  }
  return {
    inScopeCount: previous.modules.length,
    apiTotal: Number.isFinite(previous.totalApiModules)
      ? previous.totalApiModules
      : previous.modules.length + (Array.isArray(previous.outOfScope) ? previous.outOfScope.length : 0),
    categoryIds: [...ids].sort(byCodePoint),
  };
}

// ---------------------------------------------------------------------------
// content sync
// ---------------------------------------------------------------------------

/**
 * Per-list failsafe for data/learn-content.json: a list that shrinks by more than
 * maxDropPct, or that falls below its last-resort floor, aborts the content write.
 * previous / current: { [listName]: count }. `previous` may be null (first run).
 */
export function checkContentCounts({ previous, current, maxDropPct, floors = {} }) {
  const problems = [];
  for (const name of Object.keys(current).sort(byCodePoint)) {
    const count = current[name];
    if (name in floors && count < floors[name]) problems.push(`${name}: only ${count} entries (floor ${floors[name]}): the catalog API response probably changed`);
    const before = previous?.[name];
    if (typeof before === "number") {
      const drop = dropPercent(before, count);
      if (drop > maxDropPct) problems.push(`${name} fell from ${before} to ${count} (-${pct(drop)}, limit ${maxDropPct}%)`);
    }
  }
  return problems;
}

/** Too many learning-path module references unresolved: the module list used to resolve them is incomplete. */
export function checkUnresolvedModules({ unresolved, total, maxPct }) {
  if (!(total > 0)) return [];
  const share = (unresolved / total) * 100;
  return share > maxPct
    ? [`${unresolved} of ${total} learning-path module references (${pct(share)}) did not resolve to a module, limit ${maxPct}%`]
    : [];
}

/**
 * Study guide / applied-skill page probes: abort when more than maxPct of them
 * ended transient (429/5xx/timeout), only for samples of at least minSample.
 * A transient probe never changes a verdict (the previous value is kept), but a
 * run where most probes failed proves nothing and must not look like a success.
 */
export function checkProbeFailures({ label, probes, transient, maxPct, minSample }) {
  if (probes < minSample || probes === 0) return [];
  const share = (transient / probes) * 100;
  return share > maxPct
    ? [`${transient} of ${probes} ${label} probes were transient failures (${pct(share)}, limit ${maxPct}%): Learn is rate limiting or unhealthy`]
    : [];
}

/**
 * Applied-skill codes are scraped from the skill pages (aka.ms/APL<nnnn>-StudyGuide
 * anchor). If the pages stop carrying the anchor, code extraction silently yields
 * nothing and every study guide would be dropped: abort when fewer than
 * minSharePct percent of the skills that had a code last time still have one.
 */
export function checkAppliedSkillCodeCoverage({ previousWithCode, currentWithCode, minSharePct }) {
  if (!(previousWithCode > 0)) return [];
  const share = (currentWithCode / previousWithCode) * 100;
  return share < minSharePct
    ? [`only ${currentWithCode} of the ${previousWithCode} applied skills that had a study guide code still expose one (${pct(share)}, minimum ${minSharePct}%): the skill page layout probably changed`]
    : [];
}
