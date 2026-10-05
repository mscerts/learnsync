/**
 * Failsafes for the docs sync: pure checks that decide "this run's output is
 * implausible, do not overwrite good data". Each returns { ok, ... } with a
 * human-readable `message` when it fails; the caller aborts without writing.
 */

import { findAliasDuplicates, findDuplicateUrls } from "./docs-helpers.mjs";

export const INDEX_SANITY_RATIO = 0.85;
export const CATALOG_MIN_ABSOLUTE = 20000;
export const CATALOG_MIN_RATIO = 0.6;
export const DUPLICATE_URL_FAIL_THRESHOLD = 50;
// First run with no data/docs-urls.txt: the baseline is the previous catalog's
// unique Learn pages. That set still holds pages removed since, so it only
// gets the legacy 50% rule that the original script used.
export const BOOTSTRAP_INDEX_RATIO = 0.5;

/**
 * The new index must hold at least `ratio` of the previous index. Both counts
 * are over the CURRENT scope (the caller removes previous entries that fell
 * out of scope first), so intentionally narrowing a scope does not trip it.
 * With no previous baseline (first run) there is nothing to compare against.
 */
export function checkIndexSanity({ newCount, previousCount, ratio = INDEX_SANITY_RATIO }) {
  if (!previousCount) return { ok: true, minimum: 0, newCount, previousCount };
  const minimum = Math.ceil(previousCount * ratio);
  const ok = newCount >= minimum;
  return {
    ok,
    minimum,
    newCount,
    previousCount,
    message: ok
      ? undefined
      : `the sitemaps yielded ${newCount} in-scope URLs vs ${previousCount} in last run's index (minimum ${minimum} = ${Math.round(ratio * 100)}%). ` +
        "That looks like a sitemap outage or a format change, not real removals. " +
        "If you narrowed a scope on purpose, delete data/docs-urls.txt and run again.",
  };
}

/**
 * What the new sitemap pass is compared against: last run's index (85%), or,
 * when there is no index yet, the previous catalog's unique Learn paths (50%).
 * `inScope` restricts both to the CURRENT scope, so narrowing a scope on purpose
 * does not look like a sitemap outage.
 */
export function indexSanityBaseline({ previousIndex, catalogPaths, inScope = () => true }) {
  let fromIndex = 0;
  for (const path of previousIndex.keys()) if (inScope(path)) fromIndex++;
  if (fromIndex > 0) return { count: fromIndex, ratio: INDEX_SANITY_RATIO, source: "previous index" };
  const fromCatalog = new Set();
  for (const path of catalogPaths) if (inScope(path)) fromCatalog.add(path);
  return { count: fromCatalog.size, ratio: BOOTSTRAP_INDEX_RATIO, source: "previous catalog" };
}

/** max(20000, 60% of the previous catalog size). */
export function catalogFloor(previousCount, { absolute = CATALOG_MIN_ABSOLUTE, ratio = CATALOG_MIN_RATIO } = {}) {
  return Math.max(absolute, Math.ceil((previousCount || 0) * ratio));
}

export function checkCatalogSize({ newCount, previousCount, absolute, ratio }) {
  const minimum = catalogFloor(previousCount, { absolute, ratio });
  const ok = newCount >= minimum;
  return {
    ok,
    minimum,
    newCount,
    previousCount,
    message: ok ? undefined : `only ${newCount} catalog records, expected at least ${minimum} (previous run: ${previousCount}).`,
  };
}

/**
 * Whole-catalog duplicate audit: exact duplicate URLs and case-insensitive
 * aliases (the same page spelled two ways). More than `threshold` of either
 * kind means a systemic merge bug and the run aborts.
 */
export function auditDuplicates(entries, { threshold = DUPLICATE_URL_FAIL_THRESHOLD } = {}) {
  const exact = findDuplicateUrls(entries);
  const aliases = findAliasDuplicates(entries);
  const ok = exact.length <= threshold && aliases.length <= threshold;
  return {
    ok,
    exact,
    aliases,
    message: ok ? undefined : `duplicate audit: ${exact.length} exact and ${aliases.length} case-variant duplicate URL groups (threshold ${threshold}).`,
  };
}

/**
 * Drops all but the first entry of every duplicate/alias group (first wins).
 * Used only after auditDuplicates() passed, as a last line of defence.
 */
export function dropDuplicates(entries, keyOf) {
  const seen = new Set();
  return entries.filter((e) => {
    const k = keyOf(e);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
