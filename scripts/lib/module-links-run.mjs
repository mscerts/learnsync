/**
 * The module-links run: harvest the links of the last unit of every in-scope Learn module into
 * data/module-links.json. Thin I/O around the pure logic in module-links.mjs; every dependency
 * is injectable so the tests need no network. Rules and format: DATA_CONTRACT.md.
 */

import { join } from "node:path";
import { CATALOG_BASE } from "./learn-config.mjs";
import { numberFromEnv, isFullRefreshDue, utcDate } from "./learn-helpers.mjs";
import { FailsafeAbort, readJsonIfExists, retryLogger, writeJsonAtomic } from "./learn-io.mjs";
import { fetchJson, request, runPool, sleep } from "./learn-http.mjs";
import { cleanRecords } from "./module-links-clean.mjs";
import { loadData, validateUrls } from "./validate.mjs";
import {
  MODULE_LINKS_LIMITS,
  SCOPES,
  breakerTripped,
  buildFile,
  buildRecord,
  evaluateFailsafes,
  extractUnitLinks,
  planHarvest,
  readPrevious,
  scopeModulePaths,
  stableContent,
  summarizeRecords,
} from "./module-links.mjs";
import { updateStatus } from "./status.mjs";

const LEARN_PAGES = "https://learn.microsoft.com/en-us";
// Unit pages are HTML and heavier on Learn's edge than the JSON APIs: one second per worker, like the
// study-guide probes (a real 429 appeared at 500 ms there).
export const DEFAULT_PAGE_DELAY_MS = 1000;
const CHUNK = 50;

export async function runModuleLinksSync(options = {}) {
  const {
    dataDir,
    env = process.env,
    now = new Date(),
    fetchImpl,
    sleepImpl = sleep,
    log = console.log,
    warn = console.warn,
    delayMs = numberFromEnv(env, "MODULE_LINKS_DELAY_MS", DEFAULT_PAGE_DELAY_MS, { min: 0, max: 60_000 }),
    httpOptions = {},
    limits: limitOverrides = {},
    // link cleaning: (paths) => Map(path -> validator result) and async (path) => live probe outcome;
    // by default the validator over the loaded caches and live-probe.mjs `probe`
    validateImpl,
    probeImpl,
  } = options;
  if (!dataDir) throw new Error("runModuleLinksSync: dataDir is required");

  const outputFile = join(dataDir, "module-links.json");
  const catalogFile = join(dataDir, "learn-catalog.json");
  const contentFile = join(dataDir, "learn-content.json");
  const statusFile = join(dataDir, "status.json");
  const today = utcDate(now);
  const dryRun = env.DRY_RUN === "1";

  const scope = (env.MODULE_LINKS_SCOPE || "courses").trim();
  if (!SCOPES.includes(scope)) throw new Error(`Invalid MODULE_LINKS_SCOPE=${JSON.stringify(scope)} (expected ${SCOPES.join(" or ")})`);
  const limits = {
    ...MODULE_LINKS_LIMITS,
    MAX_FAIL_PCT: numberFromEnv(env, "MODULE_LINKS_MAX_FAIL_PCT", MODULE_LINKS_LIMITS.MAX_FAIL_PCT, { min: 0, max: 100 }),
    MAX_FETCHES: numberFromEnv(env, "MODULE_LINKS_MAX_FETCHES", MODULE_LINKS_LIMITS.MAX_FETCHES, { min: 1, max: 100_000 }),
    FULL_REFRESH_DAYS: numberFromEnv(env, "MODULE_LINKS_FULL_REFRESH_DAYS", MODULE_LINKS_LIMITS.FULL_REFRESH_DAYS, { min: 1, max: 3650 }),
    MAX_PROBES: numberFromEnv(env, "MODULE_LINKS_MAX_PROBES", MODULE_LINKS_LIMITS.MAX_PROBES, { min: 0, max: 100_000 }),
    RECHECK_DAYS: numberFromEnv(env, "MODULE_LINKS_RECHECK_DAYS", MODULE_LINKS_LIMITS.RECHECK_DAYS, { min: 1, max: 3650 }),
    ...limitOverrides,
  };
  const http = { ...(fetchImpl ? { fetchImpl } : {}), sleepImpl };

  // 0. inputs: a previous file that cannot be used stops the run before any download -----------------
  const previousFile = readPrevious(readJsonIfExists(outputFile, warn));
  const catalog = readJsonIfExists(catalogFile, warn);
  if (!Array.isArray(catalog?.modules)) throw new Error("data/learn-catalog.json is missing or has no modules: run the Learn catalog sync first");
  const catalogModules = catalog.modules;

  // 1. scope ------------------------------------------------------------------------------------------
  let scopePaths;
  if (scope === "all") {
    scopePaths = scopeModulePaths({ scope, catalogModules }).paths;
  } else {
    const content = readJsonIfExists(contentFile, warn);
    if (!Array.isArray(content?.learningPaths)) throw new Error("data/learn-content.json is missing or has no learningPaths: run the Learn content sync first");
    log("Fetching the course list...");
    const body = await fetchJson(`${CATALOG_BASE}?type=courses&locale=en-us`, http);
    if (!Array.isArray(body?.courses)) throw new Error('Catalog API response has no "courses" array: the schema probably changed');
    const moduleUidToPath = new Map(catalogModules.filter((m) => m.uid && m.path).map((m) => [m.uid, m.path]));
    const resolved = scopeModulePaths({ scope, catalogModules, courses: body.courses, learningPaths: content.learningPaths, moduleUidToPath });
    if (resolved.unknown > 0) warn(`  WARNING: ${resolved.unknown} course study_guide entries resolved to no learning path or module`);
    scopePaths = resolved.paths;
  }
  const catalogPaths = new Set(catalogModules.map((m) => m.path));
  for (const path of [...scopePaths]) if (!catalogPaths.has(path)) scopePaths.delete(path);
  log(`Scope "${scope}": ${scopePaths.size} modules.`);

  // 2. plan -------------------------------------------------------------------------------------------
  const previousRecords = previousFile?.modules ?? [];
  const fullRefresh = env.FULL_REFRESH === "1" || (previousFile !== null && isFullRefreshDue(previousFile.fullRefreshAt, today, limits.FULL_REFRESH_DAYS));
  const plan = planHarvest({ catalogModules, scopePaths, previous: previousRecords, fullRefresh, maxFetches: limits.MAX_FETCHES });
  log(`${plan.toFetch.length} unit pages to fetch${fullRefresh ? " (full refresh)" : ""}; ${plan.noUnits.length} modules without unit URLs; ${plan.waiting} waiting for the next run.`);

  // 3. fetch ------------------------------------------------------------------------------------------
  const fetched = new Map();
  const failedPaths = new Set();
  let attempted = 0;
  let failed = 0;
  let layoutFailed = 0;
  let broke = false;
  const onRetry = retryLogger(warn, "unit page");
  for (let from = 0; from < plan.toFetch.length && !broke; from += CHUNK) {
    const chunk = plan.toFetch.slice(from, from + CHUNK);
    const results = await runPool(
      chunk,
      async ({ module, unit }) => {
        const result = await request(`${LEARN_PAGES}${unit}`, { ...http, ...httpOptions, read: "text", onRetry });
        if (result.outcome !== "ok") return { module, unit, error: result.error ?? result.outcome };
        const extracted = extractUnitLinks(result.body, { modulePath: module.path });
        return extracted ? { module, unit, extracted } : { module, unit, layout: true };
      },
      { delayMs, sleepImpl },
    );
    for (const item of results) {
      attempted++;
      if (item.error) {
        failed++;
        failedPaths.add(item.module.path);
        warn(`  could not read ${item.unit} (${item.error})`);
      } else if (item.layout) {
        layoutFailed++;
        failedPaths.add(item.module.path);
        warn(`  no unit content in ${item.unit}`);
      } else {
        fetched.set(item.module.path, buildRecord({ module: item.module, unit: item.unit, extracted: item.extracted, today }));
      }
    }
    log(`  ${attempted} of ${plan.toFetch.length} pages done`);
    if (breakerTripped({ attempted, failed: failed + layoutFailed, limits })) broke = true;
  }

  // 4. merge: fetched records replace old ones; a failed module keeps its old record only if its signature is unchanged ---
  const sigByPath = new Map(catalogModules.map((m) => [m.path, m.unitSig]));
  const records = new Map();
  for (const record of previousRecords) {
    if (!scopePaths.has(record.path) || !catalogPaths.has(record.path)) continue;
    if (failedPaths.has(record.path) && record.unitSig !== sigByPath.get(record.path)) continue;
    records.set(record.path, record);
  }
  for (const [path, record] of fetched) records.set(path, record);
  const harvested = [...records.values()];

  // 4b. clean the links: current paths only (caches first, a live probe for what they cannot settle) -----------
  const validate =
    validateImpl ??
    ((() => {
      const data = loadData(dataDir, { warn });
      return (paths) => new Map(validateUrls(paths.map((p) => `https://learn.microsoft.com${p}`), data).results.map((r) => [r.path, r]));
    })());
  const cleaning = await cleanRecords({
    records: harvested,
    validate,
    probeImpl,
    today,
    maxProbes: limits.MAX_PROBES,
    recheckDays: limits.RECHECK_DAYS,
    delayMs,
    breakerMin: limits.BREAKER_MIN,
    sleepImpl,
    log,
  });
  const merged = cleaning.records;
  const cleanStats = cleaning.stats;
  log(`Link cleaning: ${cleanStats.links.rewritten} links rewritten to their current path, ${cleanStats.links.dropped} dropped (gone), ${cleanStats.links.unverified} unverified.`);

  // 5. failsafes ----------------------------------------------------------------------------------------
  const before = summarizeRecords(previousRecords.filter((r) => scopePaths.has(r.path)));
  const after = summarizeRecords(merged);
  const problems = evaluateFailsafes({
    scope,
    scopeSize: scopePaths.size,
    attempted,
    failed, // read failures only; layout failures are judged separately
    layoutFailed,
    previousWithLinks: before.withLinks,
    nextWithLinks: after.withLinks,
    probed: cleanStats.probed,
    probeUnknown: cleanStats.probeUnknown,
    probeDropped: cleanStats.probeDropped,
    limits,
  });
  if (broke) problems.push(`the circuit breaker stopped the run after ${attempted} pages: more than half failed`);
  if (cleaning.broke) problems.push(`the circuit breaker stopped the live link checks after ${cleanStats.probed} checks: more than half were inconclusive`);
  if (problems.length > 0) throw new FailsafeAbort(problems);

  // 6. write ----------------------------------------------------------------------------------------------
  const fullPass = (fullRefresh || previousFile === null) && plan.waiting === 0 && failedPaths.size === 0;
  const fullRefreshAt = fullPass ? today : (previousFile?.fullRefreshAt ?? null);
  const next = buildFile({ records: merged, scope, lastChecked: now.toISOString(), fullRefreshAt });
  const unchanged = previousFile !== null && previousFile.scope === scope && stableContent(next) === stableContent(buildFile({ records: previousRecords, scope: previousFile.scope, lastChecked: "", fullRefreshAt: previousFile.fullRefreshAt }));
  const summary = {
    scope,
    ...after,
    fetched: fetched.size,
    failed: failed + layoutFailed,
    layoutFailed,
    noUnits: plan.noUnits.length,
    waiting: plan.waiting,
    fullRefreshAt,
    probed: cleanStats.probed,
    rewritten: cleanStats.links.rewritten,
    dropped: cleanStats.links.dropped,
    unverified: cleanStats.links.unverified,
    written: false,
  };
  log(`${after.modules} modules, ${after.withLinks} with links, ${after.links} links (${Object.entries(after.byKind).map(([k, v]) => `${k} ${v}`).join(", ")}); ${fetched.size} fetched, ${summary.failed} failed.`);
  if (dryRun) {
    log("DRY_RUN=1: nothing written.");
    return summary;
  }
  if (unchanged) {
    log("data/module-links.json is unchanged.");
  } else {
    writeJsonAtomic(outputFile, next);
    summary.written = true;
    log("Wrote data/module-links.json.");
  }
  updateStatus(
    statusFile,
    "moduleLinks",
    {
      scope,
      modules: after.modules,
      withLinks: after.withLinks,
      links: after.links,
      fetched: fetched.size,
      failed: summary.failed,
      noUnits: plan.noUnits.length,
      waiting: plan.waiting,
      fullRefreshAt,
      probed: summary.probed,
      rewritten: summary.rewritten,
      dropped: summary.dropped,
      unverified: summary.unverified,
    },
    { now, env },
  );
  return summary;
}
