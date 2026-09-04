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
