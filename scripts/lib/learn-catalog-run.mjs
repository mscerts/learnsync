/**
 * Orchestrates one run of the module-catalog sync (data/learn-catalog.json, schema
 * v2). All decisions live in the pure modules (learn-build, learn-hierarchy,
 * learn-failsafe); this file only fetches, writes and reports. Everything it
 * touches from the outside (fetch, sleep, data directory, environment, clock,
 * logger) is injectable, which is how test/learn-catalog-run.test.mjs drives
 * whole runs against a fake API and a temp directory.
 *
 * Order of work (cheapest and most protective first):
 *   1. download taxonomy + modules + units            (3 requests)
 *   2. classify, build records, run the failsafes     (abort BEFORE the expensive part)
 *   3. plan which modules need their unit URLs again  (incremental, keyed on unitSig)
 *   4. hierarchy requests for those modules           (polite pool, circuit breaker)
 *   5. tombstones, assemble, self-validate, write if changed
 *   6. heartbeat: data/status.json is updated even when the data file was unchanged
 */

import { join } from "node:path";
import {
  assembleCatalog,
  buildTaxonomy,
  computeRemovals,
  finalizeModules,
  findRenamedPaths,
  findTombstonePathCollisions,
  sameExceptTimestamp,
  transformModules,
  validateCatalogOutput,
} from "./learn-build.mjs";
import {
  ALLOWED_CATEGORIES,
  CATALOG_BASE,
  CUSTOM_SUBJECTS,
  EXCLUDED_CATEGORIES,
  KNOWN_EMPTY_CATEGORIES,
  LIMITS,
  PRODUCT_SUBJECT_HINTS,
} from "./learn-config.mjs";
import {
  checkHierarchyFailures,
  evaluateCatalogFailsafes,
  previousBaseline,
  recoveredEmptyCategories,
  shouldAbortHierarchyEarly,
} from "./learn-failsafe.mjs";
import { classifyHierarchy, hierarchyUrl, planUnitRefresh, resolveUnitUrls } from "./learn-hierarchy.mjs";
import { DEFAULT_DELAY_MS, fetchJson, request, runPool } from "./learn-http.mjs";
import { dateOfTimestamp, isFullRefreshDue, numberFromEnv, utcDate } from "./learn-helpers.mjs";
import { FailsafeAbort, readJsonIfExists, retryLogger, writeJsonAtomic } from "./learn-io.mjs";
import { contributeLearnStatus } from "./learn-status.mjs";
import { readStatus } from "./status.mjs";

export { FailsafeAbort, readJsonIfExists, writeJsonAtomic };

export async function runCatalogSync(options = {}) {
  const {
    dataDir,
    env = process.env,
    now = new Date(),
    fetchImpl,
    sleepImpl,
    log = console.log,
    warn = console.warn,
    delayMs = DEFAULT_DELAY_MS,
    config = {
      allowedCategories: ALLOWED_CATEGORIES,
      excludedCategories: EXCLUDED_CATEGORIES,
      knownEmptyCategories: KNOWN_EMPTY_CATEGORIES,
      productSubjectHints: PRODUCT_SUBJECT_HINTS,
      customSubjects: CUSTOM_SUBJECTS,
    },
    limits: limitOverrides = {},
    httpOptions = {},
  } = options;
  if (!dataDir) throw new Error("runCatalogSync: dataDir is required");

  const outputFile = join(dataDir, "learn-catalog.json");
  const statusFile = join(dataDir, "status.json");
  const today = utcDate(now);
  const dryRun = env.DRY_RUN === "1";
  const limits = {
    ...LIMITS,
    MAX_MODULE_DROP_PCT: numberFromEnv(env, "MAX_MODULE_DROP_PCT", LIMITS.MAX_MODULE_DROP_PCT, { min: 0, max: 100 }),
    MAX_API_DROP_PCT: numberFromEnv(env, "MAX_API_DROP_PCT", LIMITS.MAX_API_DROP_PCT, { min: 0, max: 100 }),
    ...limitOverrides,
  };
  const http = { ...(fetchImpl ? { fetchImpl } : {}), ...(sleepImpl ? { sleepImpl } : {}), ...httpOptions };
  const sourceApi = `${CATALOG_BASE}?type=modules,units,products,subjects`;

  const previous = readJsonIfExists(outputFile, warn);
  const previousModules = Array.isArray(previous?.modules) ? previous.modules : [];
  const previousByUid = new Map(previousModules.map((m) => [m.uid, m]));

  // 1. downloads ------------------------------------------------------------------
  log("Fetching product taxonomy...");
  const { products } = await fetchJson(`${CATALOG_BASE}?type=products`, http);
  log("Fetching subject taxonomy...");
  const { subjects } = await fetchJson(`${CATALOG_BASE}?type=subjects`, http);
  log("Fetching modules and units (large download, ~12MB)...");
  const { modules: apiModules, units: apiUnits } = await fetchJson(`${CATALOG_BASE}?type=modules,units&locale=en-us`, {
    ...http,
    timeoutMs: 180_000,
  });
  for (const [name, value] of [["products", products], ["subjects", subjects], ["modules", apiModules], ["units", apiUnits]]) {
    if (!Array.isArray(value)) throw new Error(`Catalog API response has no "${name}" array: the schema probably changed`);
  }

  // 2. classify + failsafes -------------------------------------------------------
  const taxonomy = buildTaxonomy({ products, subjects }, config.customSubjects ?? CUSTOM_SUBJECTS);
  const built = transformModules({ apiModules, apiUnits, taxonomy, config });
  const categoryNameByTopId = new Map(config.allowedCategories.map((id) => [id, taxonomy.productNameById.get(id) ?? id]));
  const baseline = previousBaseline(previous, { categoryNameByTopId });
  if (!baseline) warn("  no previous data file: relative failsafes (drop %) are skipped, only the floors apply");

  const problems = evaluateCatalogFailsafes({
    inScopeCount: built.stats.inScope,
    apiTotal: built.stats.apiTotal,
    previous: baseline,
    categoryModuleCounts: built.stats.categoryModuleCounts,
    previousCategoryIds: baseline?.categoryIds ?? [],
    allowedCategories: config.allowedCategories,
    knownEmptyCategories: config.knownEmptyCategories ?? [],
    unitRefs: built.stats.unitRefs,
    missingUnitTitles: built.stats.missingUnitTitles,
    limits,
  });
  if (problems.length) throw new FailsafeAbort(problems);

  const recovered = recoveredEmptyCategories({ knownEmpty: config.knownEmptyCategories ?? [], counts: built.stats.categoryModuleCounts });
  if (recovered.length) warn(`  WARNING: known-empty categories have modules again, remove them from KNOWN_EMPTY_CATEGORIES: ${recovered.join(", ")}`);
  if (built.stats.allowedMissingFromTaxonomy.length) {
    warn(`  WARNING: allowlisted categories missing from the live taxonomy (renamed upstream?): ${built.stats.allowedMissingFromTaxonomy.join(", ")}`);
  }
  if (built.stats.unusedCategoryIds.length) {
    warn(
      `  WARNING: taxonomy drift: top-level products with modules that are in neither ALLOWED_CATEGORIES nor EXCLUDED_CATEGORIES: ${built.stats.unusedCategoryIds
        .map((id) => `${id} (${built.stats.categoryModuleCounts[id]})`)
        .join(", ")}`
    );
  }

  // 3. plan ------------------------------------------------------------------------
  const forced = env.FULL_UNIT_REFRESH === "1";
  const fullRefresh = forced || isFullRefreshDue(previous?.unitUrlsRefreshedAt, today, limits.FULL_REFRESH_DAYS);
  const plan = planUnitRefresh({ records: built.records, meta: built.meta, previousByUid, fullRefresh });
  log(
    fullRefresh
      ? `Full unit URL refresh (${forced ? "FULL_UNIT_REFRESH=1" : `previous refresh ${previous?.unitUrlsRefreshedAt ?? "never"}, older than ${limits.FULL_REFRESH_DAYS} days`}): ${plan.fetchUids.length} hierarchy requests`
      : `Incremental unit URL refresh: ${plan.fetchUids.length} of ${built.records.length} modules need their hierarchy again ${JSON.stringify(plan.reasons)}`
  );

  // 4. hierarchy requests ----------------------------------------------------------
  const fetchResults = new Map();
  const hierarchyRetry = retryLogger(warn, "hierarchy");
  const recordByUid = new Map(built.records.map((r) => [r.uid, r]));
  const state = { completed: 0, failures: 0, aborted: false };
  await runPool(
    plan.fetchUids,
    async (uid) => {
      if (state.aborted) return;
      const result = await request(hierarchyUrl(uid), { ...http, read: "json", captureErrorBody: true, onRetry: hierarchyRetry });
      const classified = classifyHierarchy(result, { modulePath: recordByUid.get(uid).path, catalogUnitUids: built.meta.get(uid).unitUids });
      fetchResults.set(uid, classified);
      state.completed++;
      if (!classified.ok) state.failures++;
      // circuit breaker: with the API clearly unhealthy, stop instead of burning hours of backoff
      if (!state.aborted && shouldAbortHierarchyEarly({ completed: state.completed, failures: state.failures, maxPct: limits.HIERARCHY_EARLY_FAILURE_PCT, earlySample: limits.HIERARCHY_EARLY_SAMPLE })) {
        state.aborted = true;
      }
    },
    { delayMs, sleepImpl, onProgress: (done, total) => log(`  hierarchy: ${done}/${total}`) }
  );
  if (state.aborted) {
    throw new FailsafeAbort([
      `${state.failures} of the first ${state.completed} hierarchy requests failed (early limit ${limits.HIERARCHY_EARLY_FAILURE_PCT}%): the hierarchy API is down or rate limiting; run stopped early`,
    ]);
  }

  const { unitUrlsByUid, notFoundUids, stats: unitStats } = resolveUnitUrls({
    records: built.records,
    meta: built.meta,
    previousByUid,
    plan,
    fetchResults,
  });
  const hierarchyProblems = checkHierarchyFailures({
    requests: unitStats.requests,
    failures: unitStats.failures,
    maxPct: limits.MAX_HIERARCHY_FAILURE_PCT,
    minSample: limits.HIERARCHY_MIN_SAMPLE,
  });
  if (hierarchyProblems.length) throw new FailsafeAbort(hierarchyProblems);
  if (unitStats.failures) {
    warn(`  ${unitStats.failures} hierarchy requests failed ${JSON.stringify(unitStats.failureKinds)}: ${unitStats.carriedForward} kept their previous (same-signature) unitUrls, ${unitStats.nulls} are null`);
    for (const sample of unitStats.failureSamples) warn(`    ${sample.uid}: ${sample.kind}: ${sample.reason}`);
  }

  // 5. tombstones + assembly -------------------------------------------------------
  const statusBefore = readStatus(statusFile);
  const seenDates = [dateOfTimestamp(previous?.lastChecked), dateOfTimestamp(statusBefore.learn?.catalogGeneratedAt)].filter(Boolean).sort();
  const previousSeenDate = seenDates.length ? seenDates[seenDates.length - 1] : null;
  const removals = computeRemovals({
    previousModules,
    previousRemoved: Array.isArray(previous?.removed) ? previous.removed : [],
    apiUids: built.apiUids,
    today,
    previousSeenDate,
  });

  const modules = finalizeModules(built.records, unitUrlsByUid, notFoundUids);
  const output = assembleCatalog({
    now,
    sourceApi,
    categoryFilter: config.allowedCategories,
    modules,
    totalApiModules: built.stats.apiTotal,
    // advances only when a full pass really ran (failures within tolerance carry their previous same-signature value)
    unitUrlsRefreshedAt: fullRefresh ? today : previous?.unitUrlsRefreshedAt ?? null,
    removed: removals.removed,
    outOfScope: built.outOfScope,
  });
  const invalid = validateCatalogOutput(output);
  if (invalid.length) throw new FailsafeAbort(invalid.map((p) => `self-check failed: ${p}`));

  const renamed = findRenamedPaths(previousModules, built.records);
  const collisions = findTombstonePathCollisions(removals.removed, built.records, built.outOfScope);
  if (renamed.length) warn(`  ${renamed.length} modules changed their url slug (same uid), their old path is now in neither set: ${renamed.slice(0, 5).map((r) => `${r.from} -> ${r.to}`).join("; ")}${renamed.length > 5 ? "; ..." : ""}`);
  if (collisions.length) warn(`  ${collisions.length} tombstone paths are served by a different live module now: ${collisions.slice(0, 5).map((c) => c.path).join(", ")}`);

  // 6. write + heartbeat -----------------------------------------------------------
  const unchanged = sameExceptTimestamp(previous, output);
  let wrote = false;
  if (dryRun) {
    log("DRY_RUN=1: not writing the data file or status.json");
  } else if (unchanged) {
    log(`No content changes vs. ${outputFile} -- skipping write (only lastChecked would differ).`);
  } else {
    writeJsonAtomic(outputFile, output);
    wrote = true;
    log(`Wrote ${modules.length} modules to ${outputFile}`);
  }

  const nullUnitUrls = modules.filter((m) => m.unitUrls === null).length;
  const status = {
    modules: modules.length,
    removed: removals.removed.length,
    outOfScope: built.outOfScope.length,
    totalApiModules: built.stats.apiTotal,
    unitUrlsRefreshedAt: output.unitUrlsRefreshedAt,
    unitHierarchyRequests: unitStats.requests,
    unitHierarchyFailures: unitStats.failures,
    unitUrlsNull: nullUnitUrls,
    unitHierarchyNotFound: modules.filter((m) => m.hierarchyNotFound).length,
    unitUrlsCarriedForward: unitStats.carriedForward,
    unusedCategories: built.stats.unusedCategoryIds,
  };
  if (!dryRun) contributeLearnStatus(statusFile, "catalog", status, { now, env });

  log(`  ${built.stats.apiTotal} modules seen total: ${modules.length} in scope, ${built.outOfScope.length} out of scope`);
  log(`  removed (tombstones): ${removals.removed.length} (${removals.newlyRemoved} new this run, ${removals.resurrected} came back)`);
  log(`  unit URLs: ${unitStats.requests} hierarchy requests (${unitStats.fetchedOk} ok, ${unitStats.failures} failed), ${unitStats.reused} reused, ${nullUnitUrls} modules have unitUrls null`);
  if (status.unitHierarchyNotFound) {
    warn(`  ${status.unitHierarchyNotFound} modules are listed by the catalog API but unknown to the hierarchy API (module_id_not_found; their pages redirect away, so they are probably not served): ${modules.filter((m) => m.hierarchyNotFound).map((m) => m.uid).join(", ")}`);
  }
  log(`  ${built.stats.modulesWithHintedSubjects} modules got a subject added via PRODUCT_SUBJECT_HINTS`);
  if (built.stats.missingUnitTitles) {
    warn(`  ${built.stats.missingUnitTitles} unit titles could not be resolved (fell back to uid) in ${built.stats.fallbackModules.length} modules:`);
    for (const fallback of built.stats.fallbackModules.slice(0, 40)) {
      warn(`    ${fallback.uid} (${fallback.unresolved}/${fallback.total} units)  ${recordByUid.get(fallback.uid).path}`);
    }
    if (built.stats.fallbackModules.length > 40) warn(`    ... and ${built.stats.fallbackModules.length - 40} more`);
  }
  if (built.stats.unresolvedProducts) warn(`  ${built.stats.unresolvedProducts} product ids could not be resolved to a category`);

  return { wrote, unchanged, dryRun, output, status, built, plan, unitStats, removals, fullRefresh };
}
