/**
 * Pure transformation logic for data/learn-catalog.json (schema v2, see
 * DATA_CONTRACT.md): taxonomy resolution, category scoping, record building,
 * unit signatures, tombstones, output assembly and self-validation. No I/O, no
 * network: scripts/lib/learn-catalog-run.mjs wires it to the real API.
 */

import { createHash } from "node:crypto";
import { byCodePoint, canonicalPath, underPrefix } from "./canonical.mjs";
import { flattenTaxonomy, isIsoDate, normalizeUrl } from "./learn-helpers.mjs";

export const CATALOG_SCHEMA_VERSION = 2;

/** Product/subject taxonomies -> lookup maps (custom subject ids are merged in, never overriding official ones). */
export function buildTaxonomy({ products, subjects }, customSubjects = {}) {
  const { nameById: productNameById, topIdById: productTopIdById } = flattenTaxonomy(products);
  const { nameById: subjectNameById } = flattenTaxonomy(subjects);
  for (const [id, name] of Object.entries(customSubjects)) {
    if (!subjectNameById.has(id)) subjectNameById.set(id, name);
  }
  return { productNameById, productTopIdById, subjectNameById, topLevelProductIds: products.map((p) => p.id) };
}

/**
 * Signature of everything the catalog API says about a module's units: the
 * module's last_modified plus each unit's `uid:last_modified`, in module order
 * (a reorder, add or removal therefore changes it). sha1 hex.
 */
export function computeUnitSig(lastModified, unitUids, unitByUid) {
  const hash = createHash("sha1");
  hash.update(String(lastModified ?? ""));
  for (const uid of unitUids) hash.update(`\n${uid}:${unitByUid.get(uid)?.last_modified ?? ""}`);
  return hash.digest("hex");
}

/**
 * Raw API modules -> in-scope records (everything except `unitUrls`), the list
 * of out-of-scope module paths and the statistics the failsafes and the status
 * file need.
 *
 * config: { allowedCategories, excludedCategories?, productSubjectHints? }
 * Throws on API anomalies that would make the output ambiguous (duplicate uid,
 * a module url that is not a Learn url).
 */
export function transformModules({ apiModules, apiUnits, taxonomy, config }) {
  const allowed = new Set(config.allowedCategories);
  const excluded = new Set(config.excludedCategories ?? []);
  const hints = config.productSubjectHints ?? {};
  const unitByUid = new Map(apiUnits.map((unit) => [unit.uid, unit]));
  const categoryNameByTopId = new Map(config.allowedCategories.map((id) => [id, taxonomy.productNameById.get(id) ?? id]));

  const records = [];
  const meta = new Map();
  const outOfScopePaths = new Set();
  const apiUids = new Set();
  const categoryModuleCounts = new Map();
  const fallbackModules = [];
  const stats = {
    apiTotal: apiModules.length,
    inScope: 0,
    unresolvedProducts: 0,
    noProductModules: 0,
    modulesWithHintedSubjects: 0,
    unitRefs: 0,
    missingUnitTitles: 0,
  };

  for (const mod of apiModules) {
    if (apiUids.has(mod.uid)) throw new Error(`Catalog API returned module uid ${mod.uid} more than once`);
    apiUids.add(mod.uid);
    const path = canonicalPath(mod.url);
    if (!path) throw new Error(`Module ${mod.uid} has no usable Learn url (${JSON.stringify(mod.url)})`);

    const topIds = new Set();
    const productNames = new Set();
    const hintedSubjectIds = new Set();
    if (!(mod.products ?? []).length) stats.noProductModules++;
    for (const productId of mod.products ?? []) {
      const topId = taxonomy.productTopIdById.get(productId);
      if (topId) topIds.add(topId);
      else stats.unresolvedProducts++;
      productNames.add(taxonomy.productNameById.get(productId) ?? productId);
      for (const subjectId of hints[productId] ?? []) hintedSubjectIds.add(subjectId);
    }
    for (const topId of topIds) categoryModuleCounts.set(topId, (categoryModuleCounts.get(topId) ?? 0) + 1);

    if (![...topIds].some((id) => allowed.has(id))) {
      outOfScopePaths.add(path);
      continue;
    }

    const unitUids = mod.units ?? [];
    let unresolvedUnits = 0;
    const unitTitles = unitUids.map((uid) => {
      stats.unitRefs++;
      const title = unitByUid.get(uid)?.title;
      if (!title) {
        stats.missingUnitTitles++;
        unresolvedUnits++;
        return uid;
      }
      return title;
    });
    if (unresolvedUnits) fallbackModules.push({ uid: mod.uid, unresolved: unresolvedUnits, total: unitUids.length });

    const subjectIds = new Set(mod.subjects ?? []);
    let hintAdded = false;
    for (const id of hintedSubjectIds) {
      if (!subjectIds.has(id)) hintAdded = true;
      subjectIds.add(id);
    }
    if (hintAdded) stats.modulesWithHintedSubjects++;

    records.push({
      uid: mod.uid,
      title: mod.title,
      url: normalizeUrl(mod.url),
      path,
      categories: [...topIds].filter((id) => allowed.has(id)).map((id) => categoryNameByTopId.get(id)).sort(byCodePoint),
      products: [...productNames].sort(byCodePoint),
      subjects: [...subjectIds].map((id) => taxonomy.subjectNameById.get(id) ?? id).sort(byCodePoint),
      units: unitTitles,
      lastModified: mod.last_modified ?? null,
      unitSig: computeUnitSig(mod.last_modified, unitUids, unitByUid),
    });
    meta.set(mod.uid, { unitUids: [...unitUids], firstUnitPath: canonicalPath(mod.firstUnitUrl) });
  }

  records.sort((a, b) => byCodePoint(a.uid, b.uid));
  fallbackModules.sort((a, b) => byCodePoint(a.uid, b.uid));
  stats.inScope = records.length;

  const topLevel = new Set(taxonomy.topLevelProductIds);
  return {
    records,
    meta,
    outOfScope: [...outOfScopePaths].sort(byCodePoint),
    apiUids,
    stats: {
      ...stats,
      outOfScope: outOfScopePaths.size,
      fallbackModules,
      categoryModuleCounts: Object.fromEntries([...categoryModuleCounts].sort((a, b) => byCodePoint(a[0], b[0]))),
      // top-level products that carry modules but are in neither list: taxonomy drift
      unusedCategoryIds: taxonomy.topLevelProductIds
        .filter((id) => (categoryModuleCounts.get(id) ?? 0) > 0 && !allowed.has(id) && !excluded.has(id))
        .sort(byCodePoint),
      // allowlisted ids the live taxonomy no longer has (renamed/removed upstream)
      allowedMissingFromTaxonomy: config.allowedCategories.filter((id) => !topLevel.has(id)).sort(byCodePoint),
    },
  };
}

/**
 * Tombstones. A module is REMOVED when its uid was in the previous `modules` and
 * is absent from the whole raw API response now (a module that merely left the
 * allowlist is still in `apiUids`, so it becomes outOfScope, never removed).
 * Previous tombstones are carried forward untouched and dropped only when the
 * uid is back in the API. `previousSeenDate` is the last date the previous
 * modules were known to exist (the previous run, not necessarily the last write).
 */
export function computeRemovals({ previousModules = [], previousRemoved = [], apiUids, today, previousSeenDate = null }) {
  const removed = new Map();
  let resurrected = 0;
  for (const tomb of previousRemoved) {
    if (!tomb || typeof tomb.uid !== "string") continue;
    if (apiUids.has(tomb.uid)) {
      resurrected++;
      continue;
    }
    removed.set(tomb.uid, {
      uid: tomb.uid,
      path: tomb.path ?? null,
      title: tomb.title ?? null,
      lastSeen: tomb.lastSeen ?? null,
      removedOn: tomb.removedOn ?? null,
    });
  }
  let newlyRemoved = 0;
  for (const mod of previousModules) {
    if (!mod || typeof mod.uid !== "string" || apiUids.has(mod.uid) || removed.has(mod.uid)) continue;
    removed.set(mod.uid, {
      uid: mod.uid,
      path: mod.path ?? canonicalPath(mod.url),
      title: mod.title ?? null,
      lastSeen: previousSeenDate,
      removedOn: today,
    });
    newlyRemoved++;
  }
  return { removed: [...removed.values()].sort((a, b) => byCodePoint(a.uid, b.uid)), newlyRemoved, resurrected };
}

/** Modules whose uid is unchanged but whose canonical path differs from the previous record (slug renamed upstream). */
export function findRenamedPaths(previousModules, records) {
  const previousPathByUid = new Map();
  for (const mod of previousModules ?? []) {
    const path = mod.path ?? canonicalPath(mod.url);
    if (mod?.uid && path) previousPathByUid.set(mod.uid, path);
  }
  const renamed = [];
  for (const record of records) {
    const before = previousPathByUid.get(record.uid);
    if (before && before !== record.path) renamed.push({ uid: record.uid, from: before, to: record.path });
  }
  return renamed;
}

/** Tombstone paths that a live module (in or out of scope) now occupies: the validator must not call those broken. */
export function findTombstonePathCollisions(removed, records, outOfScope) {
  const live = new Set([...records.map((r) => r.path), ...outOfScope]);
  return removed.filter((tomb) => tomb.path && live.has(tomb.path)).map((tomb) => ({ uid: tomb.uid, path: tomb.path }));
}

/**
 * Base records + resolved unitUrls -> final module records in contract key order.
 *
 * `hierarchyNotFound: true` is an ADDITIVE optional field (see report): the
 * catalog API lists the module but the hierarchy API definitively answers
 * module_id_not_found. Verified live on 2026-10-05 for the four such modules: their
 * module page and first unit url redirect to a learning-path page, i.e. the module
 * is NOT served although the catalog still lists it. It is only ever emitted
 * together with `unitUrls: null`, and omitted otherwise.
 */
export function finalizeModules(records, unitUrlsByUid, notFoundUids = new Set()) {
  return records.map((r) => {
    const out = {
      uid: r.uid,
      title: r.title,
      url: r.url,
      path: r.path,
      categories: r.categories,
      products: r.products,
      subjects: r.subjects,
      units: r.units,
      unitUrls: unitUrlsByUid.get(r.uid) ?? null,
      lastModified: r.lastModified,
      unitSig: r.unitSig,
    };
    if (notFoundUids.has(r.uid) && out.unitUrls === null) out.hierarchyNotFound = true;
    return out;
  });
}

export function assembleCatalog({ now, sourceApi, categoryFilter, modules, totalApiModules, unitUrlsRefreshedAt, removed, outOfScope }) {
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    lastChecked: now.toISOString(),
    sourceApi,
    categoryFilter,
    totalModules: modules.length,
    totalApiModules,
    unitUrlsRefreshedAt,
    modules,
    removed,
    outOfScope,
  };
}

/** Everything but the run timestamp: what the "skip the write when nothing changed" comparison looks at. */
export function withoutTimestamp(output) {
  const { lastChecked, ...rest } = output;
  return rest;
}

export function sameExceptTimestamp(previous, next) {
  if (!previous || typeof previous !== "object") return false;
  return JSON.stringify(withoutTimestamp(previous)) === JSON.stringify(withoutTimestamp(next));
}

const SHA1_HEX = /^[0-9a-f]{40}$/;

/**
 * A module path is "/training/modules/<slug>" for all but a handful of modules
 * that the catalog API publishes under another training area (verified
 * 2026-10-05: "/training/saas/<slug>", "/training/azure-databases/postgresql/<slug>",
 * "/training/research/<slug>"). The cache records them faithfully; only the shape
 * "/training/<area>/.../<slug>" is required here.
 */
export function isModulePath(path) {
  return typeof path === "string" && /^\/training\/[^/]+\/[^/]+(\/[^/]+)*$/.test(path) && !/^\/training\/(paths|courses)\//.test(path);
}

function isSortedUnique(values) {
  for (let i = 1; i < values.length; i++) if (byCodePoint(values[i - 1], values[i]) >= 0) return false;
  return true;
}

/**
 * Self-check of a finished catalog against DATA_CONTRACT.md. Returns a list of
 * problems (empty when valid). The sync runs it before writing, so a bug can
 * never produce a file the validator would mis-read; the tests and the manual
 * verification reuse it.
 */
export function validateCatalogOutput(output, { maxProblems = 50 } = {}) {
  const problems = [];
  const add = (message) => {
    if (problems.length < maxProblems) problems.push(message);
  };
  if (!output || typeof output !== "object") return ["output is not an object"];
  if (output.schemaVersion !== CATALOG_SCHEMA_VERSION) add(`schemaVersion is ${output.schemaVersion}, expected ${CATALOG_SCHEMA_VERSION}`);
  if (!Array.isArray(output.modules)) return [...problems, "modules is not an array"];
  if (!Array.isArray(output.removed)) add("removed is not an array");
  if (!Array.isArray(output.outOfScope)) add("outOfScope is not an array");
  if (output.unitUrlsRefreshedAt !== null && !isIsoDate(output.unitUrlsRefreshedAt)) add(`unitUrlsRefreshedAt is not a date or null: ${output.unitUrlsRefreshedAt}`);
  if (output.totalModules !== output.modules.length) add(`totalModules ${output.totalModules} != modules.length ${output.modules.length}`);

  const uids = output.modules.map((m) => m.uid);
  if (!isSortedUnique(uids)) add("modules are not sorted by uid (code point) or contain duplicate uids");
  const paths = new Set();
  for (const mod of output.modules) {
    const where = `module ${mod.uid}`;
    if (typeof mod.title !== "string" || !mod.title) add(`${where}: missing title`);
    if (typeof mod.url !== "string" || !mod.url) add(`${where}: missing url`);
    if (!mod.path || canonicalPath(mod.path) !== mod.path || !isModulePath(mod.path)) add(`${where}: path ${mod.path} is not a canonical module path`);
    if (paths.has(mod.path)) add(`${where}: duplicate path ${mod.path}`);
    paths.add(mod.path);
    if (!Array.isArray(mod.units) || mod.units.some((u) => typeof u !== "string")) add(`${where}: units is not an array of strings`);
    if (!Array.isArray(mod.categories) || !mod.categories.length) add(`${where}: no categories`);
    if (!SHA1_HEX.test(mod.unitSig ?? "")) add(`${where}: unitSig is not sha1 hex`);
    if (mod.lastModified !== null && typeof mod.lastModified !== "string") add(`${where}: lastModified is neither a string nor null`);
    if ("hierarchyNotFound" in mod && (mod.hierarchyNotFound !== true || mod.unitUrls !== null)) add(`${where}: hierarchyNotFound must be true and only appear with unitUrls null`);
    if (mod.unitUrls !== null) {
      if (!Array.isArray(mod.unitUrls)) add(`${where}: unitUrls is neither null nor an array`);
      else {
        if (mod.unitUrls.length !== mod.units?.length) add(`${where}: ${mod.unitUrls.length} unitUrls but ${mod.units?.length} units`);
        if (new Set(mod.unitUrls).size !== mod.unitUrls.length) add(`${where}: duplicate unitUrls`);
        for (const url of mod.unitUrls) {
          if (canonicalPath(url) !== url || !underPrefix(url, mod.path) || url === mod.path) add(`${where}: unit url ${url} is not canonical or not under ${mod.path}`);
        }
      }
    }
  }
  if (Array.isArray(output.removed)) {
    if (!isSortedUnique(output.removed.map((t) => t.uid))) add("removed is not sorted by uid or contains duplicates");
    for (const tomb of output.removed) {
      if (!tomb.uid || !tomb.path || canonicalPath(tomb.path) !== tomb.path) add(`tombstone ${tomb.uid}: bad path ${tomb.path}`);
      if (typeof tomb.title !== "string") add(`tombstone ${tomb.uid}: bad title`);
      if (!isIsoDate(tomb.removedOn)) add(`tombstone ${tomb.uid}: bad removedOn ${tomb.removedOn}`);
      if (tomb.lastSeen !== null && !isIsoDate(tomb.lastSeen)) add(`tombstone ${tomb.uid}: bad lastSeen ${tomb.lastSeen}`);
      if (uids.includes(tomb.uid)) add(`tombstone ${tomb.uid} is also a live module`);
    }
  }
  if (Array.isArray(output.outOfScope)) {
    if (!isSortedUnique(output.outOfScope)) add("outOfScope is not sorted or contains duplicates");
    for (const path of output.outOfScope) {
      if (canonicalPath(path) !== path || !isModulePath(path)) add(`outOfScope entry ${path} is not a canonical module path`);
      if (paths.has(path)) add(`outOfScope entry ${path} is also an in-scope module`);
    }
  }
  return problems;
}
