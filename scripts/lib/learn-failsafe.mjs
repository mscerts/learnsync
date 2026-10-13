/**
 * Failsafes: a bad run (truncated API response, taxonomy change, rate-limit
 * storm) must never replace good data. Every check is a pure function that
 * returns a list of human-readable problems ([] = fine); the runners print them
 * and abort WITHOUT writing any file when the list is not empty.
 */

import { byCodePoint } from "./canonical.mjs";
import { listSome } from "./learn-helpers.mjs";

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
 * Every allowlisted category must still have modules.
 *
 * Classification of an allowlisted id whose module count is zero (counts: { [topLevelId]: moduleCount }
 * over ALL API modules):
 *  - `knownEmpty` ids have none upstream today and are exempt, unless the previous data had modules in
 *    them (`previousCategoryIds`): that is the "emptied" case below.
 *  - EMPTIED: the previous data had modules in it and it has none now. Normally a truncation signal and
 *    a problem. It is ACCEPTED (listed in `emptied`, not in `problems`) only when ALL of these hold:
 *      1. nothing else in the run looks unhealthy: `otherProblems` (module-count floor, in-scope drop, raw
 *         API drop, unit-title fallback) is empty;
 *      2. at most `maxEmptied` categories emptied in this run (0 switches the exception off);
 *      3. every module the previous data had in that category (`previousModulesByCategory[id]`) is absent
 *         from the whole API response now (`apiUids`), i.e. it becomes a tombstone this run. A module that
 *         is still served but no longer carries the category was re-tagged: a taxonomy change, never accepted.
 *    Without `previousModulesByCategory` and `apiUids` nothing is accepted (strict behaviour).
 *  - STILL EMPTY: zero modules now and in the previous data, but the id was already in the previous
 *    file's allowlist (`previousAllowed`, its `categoryFilter`). That is a category an earlier run
 *    accepted as emptied: tolerated, listed in `stillEmpty` (a `knownEmpty` id is exempt before this rule
 *    applies, so it is never listed). Without `previousAllowed` (first run, a file that predates
 *    `categoryFilter`) it falls through to the next rule.
 *  - Anything else with zero modules is a problem: an id newly added to the allowlist that has no modules
 *    is almost certainly a typo or a renamed product.
 *
 * Returns { problems, emptied: [{ id, modules }], stillEmpty: [id] } (all sorted by code point).
 */
export function classifyCategoryCoverage({
  allowed,
  knownEmpty = [],
  counts,
  previousCategoryIds = [],
  previousAllowed = null,
  previousModulesByCategory = null,
  apiUids = null,
  maxEmptied = 0,
  otherProblems = [],
}) {
  const exempt = new Set(knownEmpty);
  const hadModules = new Set(previousCategoryIds);
  const wasAllowed = Array.isArray(previousAllowed) ? new Set(previousAllowed) : null;
  const problems = [];
  const stillEmpty = [];
  const candidates = [];
  for (const id of [...allowed].sort(byCodePoint)) {
    if ((counts[id] ?? 0) > 0) continue;
    if (hadModules.has(id)) candidates.push(id);
    else if (exempt.has(id)) continue;
    else if (wasAllowed?.has(id)) stillEmpty.push(id);
    else problems.push(`allowlisted category "${id}" has zero modules (not listed in KNOWN_EMPTY_CATEGORIES)`);
  }

  const emptied = [];
  for (const id of candidates) {
    const modules = previousModulesByCategory?.[id];
    const reasons = [];
    if (!(maxEmptied > 0)) {
      reasons.push("accepting an emptied category is switched off (MAX_EMPTIED_CATEGORIES=0)");
    } else {
      if (otherProblems.length) {
        reasons.push(`the rest of the run does not look healthy (${otherProblems.length} other failsafe problem${otherProblems.length === 1 ? "" : "s"}): a truncated or reshaped response is likely`);
      }
      if (candidates.length > maxEmptied) reasons.push(`${candidates.length} allowlisted categories emptied in one run (limit ${maxEmptied}): ${candidates.join(", ")}`);
      if (!apiUids || !Array.isArray(modules) || !modules.length) {
        reasons.push("its previous modules cannot be accounted for (no per-module data)");
      } else {
        const stillServed = modules.filter((uid) => apiUids.has(uid));
        if (stillServed.length) {
          reasons.push(
            modules.length === 1
              ? `its only previous module is still in the API, re-tagged rather than removed: ${stillServed[0]}`
              : `${stillServed.length} of its ${modules.length} previous modules are still in the API, re-tagged rather than removed: ${listSome(stillServed)}`
          );
        }
      }
    }
    if (reasons.length) problems.push(`allowlisted category "${id}" had modules in the previous data and has none now (${reasons.join("; ")})`);
    else emptied.push({ id, modules: [...modules] });
  }
  return { problems, emptied, stillEmpty };
}

/** Problems only: the strict reading (nothing is accepted unless the caller passes the accounting data and a limit). */
export function checkCategoryCoverage(args) {
  return classifyCategoryCoverage(args).problems;
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

/**
 * Catalog-stage failsafes in one call (everything that can be decided before any hierarchy request).
 * Returns { problems, emptied, stillEmpty }: `problems` aborts the run when not empty; `emptied` lists
 * the allowlisted categories that lost their last modules and were ACCEPTED (see classifyCategoryCoverage),
 * `stillEmpty` the ones that were already empty and allowlisted in the previous file. The category
 * exception is only judged "healthy" against the OTHER failsafes of this same call, so a truncated
 * response that also empties a small category still aborts.
 *
 * `apiUids` (Set of every module uid the raw API returned) and `previous.modulesByCategory` /
 * `previous.allowedIds` (from previousBaseline) enable the exception; without them it is off.
 */
export function assessCatalogFailsafes({
  inScopeCount,
  apiTotal,
  previous,
  categoryModuleCounts,
  previousCategoryIds = previous?.categoryIds ?? [],
  allowedCategories,
  knownEmptyCategories,
  unitRefs,
  missingUnitTitles,
  limits,
  apiUids = null,
}) {
  const floor = checkMinModules(inScopeCount, limits.MIN_MODULES);
  const moduleDrop = checkModuleDrop(previous?.inScopeCount ?? 0, inScopeCount, limits.MAX_MODULE_DROP_PCT);
  const apiDrop = checkApiDrop(previous?.apiTotal ?? 0, apiTotal, limits.MAX_API_DROP_PCT);
  const unitFallback = checkUnitFallback({ missing: missingUnitTitles, total: unitRefs, maxPct: limits.MAX_UNIT_FALLBACK_PCT });
  const categories = classifyCategoryCoverage({
    allowed: allowedCategories,
    knownEmpty: knownEmptyCategories,
    counts: categoryModuleCounts,
    previousCategoryIds,
    previousAllowed: previous?.allowedIds ?? null,
    previousModulesByCategory: previous?.modulesByCategory ?? null,
    apiUids,
    maxEmptied: limits.MAX_EMPTIED_CATEGORIES ?? 0,
    otherProblems: [...floor, ...moduleDrop, ...apiDrop, ...unitFallback],
  });
  return {
    problems: [...floor, ...moduleDrop, ...apiDrop, ...categories.problems, ...unitFallback],
    emptied: categories.emptied,
    stillEmpty: categories.stillEmpty,
  };
}

/** The problems of assessCatalogFailsafes alone (the strict reading unless `apiUids` and a baseline with module data are passed). */
export function evaluateCatalogFailsafes(input) {
  return assessCatalogFailsafes(input).problems;
}

/**
 * What the previous data file tells the failsafes: in-scope count, the raw API
 * total (stored since schema v2; for an older file the best lower bound is
 * in-scope + outOfScope), which allowlisted category ids had modules, which
 * module uids each of those categories held (`modulesByCategory`, for the
 * "every module of an emptied category was removed" accounting) and the allowlist
 * the file was written with (`allowedIds`, null for a file without `categoryFilter`).
 */
export function previousBaseline(previous, { categoryNameByTopId }) {
  if (!previous || !Array.isArray(previous.modules)) return null;
  const idByName = new Map([...categoryNameByTopId].map(([id, name]) => [name, id]));
  const ids = new Set();
  const uidsById = new Map();
  for (const mod of previous.modules) {
    for (const name of mod.categories ?? []) {
      if (!idByName.has(name)) continue;
      const id = idByName.get(name);
      ids.add(id);
      if (typeof mod.uid !== "string") continue;
      if (!uidsById.has(id)) uidsById.set(id, []);
      uidsById.get(id).push(mod.uid);
    }
  }
  return {
    inScopeCount: previous.modules.length,
    apiTotal: Number.isFinite(previous.totalApiModules)
      ? previous.totalApiModules
      : previous.modules.length + (Array.isArray(previous.outOfScope) ? previous.outOfScope.length : 0),
    categoryIds: [...ids].sort(byCodePoint),
    allowedIds: Array.isArray(previous.categoryFilter) ? previous.categoryFilter.filter((id) => typeof id === "string").sort(byCodePoint) : null,
    modulesByCategory: Object.fromEntries([...uidsById].sort((a, b) => byCodePoint(a[0], b[0])).map(([id, uids]) => [id, uids.sort(byCodePoint)])),
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
