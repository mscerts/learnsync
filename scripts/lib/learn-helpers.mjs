/**
 * Pure helper functions for scripts/learn-catalog-sync.mjs, extracted so they
 * can be unit-tested with node:test (see test/learn-helpers.test.mjs) without
 * running the full sync. No I/O, no network — keep it that way.
 */

// Flattens a two-level catalog taxonomy (products or subjects) into lookup maps.
export function flattenTaxonomy(entries) {
  const nameById = new Map();
  const topIdById = new Map();
  for (const top of entries) {
    nameById.set(top.id, top.name);
    topIdById.set(top.id, top.id);
    for (const child of top.children ?? []) {
      nameById.set(child.id, child.name);
      topIdById.set(child.id, top.id);
    }
  }
  return { nameById, topIdById };
}

export function normalizeUrl(url) {
  if (!url) return url;
  return url.replace("/en-us/", "/").replace(/([?&])WT\.mc_id=[^&]*/, "$1WT.mc_id=studentamb_165290");
}

/** UTC calendar date (YYYY-MM-DD) of a Date. */
export function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

/** True for a real calendar date in YYYY-MM-DD form. */
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

/** Whole days from `fromDate` to `toDate` (both YYYY-MM-DD); negative when `toDate` is earlier. */
export function daysBetween(fromDate, toDate) {
  return Math.round((Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86_400_000);
}

/** The date part of an ISO timestamp, or null when it is not a valid timestamp. */
export function dateOfTimestamp(value) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

/**
 * Reads a numeric threshold from an environment-like object. An unset or empty
 * variable yields `fallback`; a set but invalid one THROWS (a typo in a failsafe
 * threshold must not silently fall back to the default).
 */
export function numberFromEnv(env, name, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}=${JSON.stringify(raw)} (expected a number between ${min} and ${max})`);
  }
  return value;
}

/** True when the previous full unit refresh is missing, malformed or older than `maxAgeDays`. */
export function isFullRefreshDue(previousRefreshedAt, today, maxAgeDays) {
  if (!isIsoDate(previousRefreshedAt)) return true;
  return daysBetween(previousRefreshedAt, today) > maxAgeDays;
}
