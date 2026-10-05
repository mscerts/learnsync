/**
 * One run of the docs sync, with every side effect injected (HTTP client, git
 * source, clock, logging) so the whole pipeline is tested end to end against a
 * fake Learn and a temp directory. scripts/docs-catalog-sync.mjs is the thin
 * wrapper that supplies the real ones.
 *
 *   read data/  ->  sitemaps (both scopes)  ->  index sanity failsafe  ->  plan
 *     ->  DRY_RUN stops here
 *     ->  network phases (quarantine, missing, fetch, verify) under a deadline
 *     ->  git sources  ->  reconcile  ->  duplicate/size failsafes  ->  write
 *     ->  quarantine report  ->  status.json
 *
 * A failsafe abort writes NOTHING (not even status.json: an aborted run did not
 * finish, so the previous heartbeat must keep aging). Every run that gets past
 * the failsafes writes status.json, even when no data file changed.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { byCodePoint, canonicalPath } from "./canonical.mjs";
import { QUARANTINE_SURGE_THRESHOLD, readConfig } from "./docs-config.mjs";
import { createDeadline } from "./docs-budget.mjs";
import { aliasKey, buildQuarantineReport } from "./docs-helpers.mjs";
import { auditDuplicates, checkCatalogSize, checkIndexSanity, dropDuplicates, indexSanityBaseline } from "./docs-failsafes.mjs";
import { parseIndex, serializeIndex } from "./docs-index.mjs";
import { runPhases } from "./docs-phases.mjs";
import { plan as makePlan, reconcile } from "./docs-reconcile.mjs";
import { normalizeLedger } from "./docs-redirects.mjs";
import { DEFAULT_SCOPES, includePrefixOf, scopeClass } from "./docs-scope.mjs";
import { collectSitemaps } from "./docs-sitemap-pass.mjs";
import { updateStatus } from "./status.mjs";

export const DATA_FILES = {
  catalog: "docs-catalog.json",
  invalid: "docs-catalog-invalid.json",
  families: "docs-sitemap-families.json",
  index: "docs-urls.txt",
  redirects: "docs-redirects.json",
  status: "status.json",
};

// ---------------------------------------------------------------------------------------
// files
// ---------------------------------------------------------------------------------------

/** Missing file -> fallback. Present but unreadable/corrupt -> throw: never treat damage as "empty". */
function readJsonStrict(file, fallback, shape) {
  if (!existsSync(file)) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${err.message}); refusing to continue with damaged data`);
  }
  const ok = shape === "array" ? Array.isArray(parsed) : parsed && typeof parsed === "object" && !Array.isArray(parsed);
  if (!ok) throw new Error(`${file} does not hold the expected ${shape}`);
  return parsed;
}

/** Write via a temp file + rename so a crash never leaves a half-written data file. */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function writeIfChanged(file, text) {
  if (existsSync(file)) {
    try {
      if (readFileSync(file, "utf-8") === text) return false;
    } catch {
      // unreadable: rewrite
    }
  }
  writeAtomic(file, text);
  return true;
}

export function loadPrevious(dataDir) {
  const f = (name) => join(dataDir, DATA_FILES[name]);
  const catalog = readJsonStrict(f("catalog"), [], "array");
  const invalid = readJsonStrict(f("invalid"), [], "array");
  const families = readJsonStrict(f("families"), {}, "object");
  const ledger = normalizeLedger(readJsonStrict(f("redirects"), [], "array"));
  const previousIndex = existsSync(f("index")) ? parseIndex(readFileSync(f("index"), "utf-8")) : new Map();
  return { catalog, invalid, families, ledger, previousIndex };
}

// ---------------------------------------------------------------------------------------
// reporting helpers
// ---------------------------------------------------------------------------------------

function countByPrefix(rows, scopes) {
  const out = { learn: new Map(), index: new Map() };
  for (const path of rows.keys()) {
    const hit = includePrefixOf(path, scopes);
    if (!hit) continue;
    out[hit.cls].set(hit.prefix, (out[hit.cls].get(hit.prefix) || 0) + 1);
  }
  return out;
}

/** Top-level segments that appear in the downloaded sitemaps but belong to neither scope. */
export function unscopedSegments(segments, scopes = DEFAULT_SCOPES, limit = 60) {
  return [...segments]
    .filter(([seg]) => seg && scopeClass(`/${seg}/x`, scopes) === null && scopeClass(`/${seg}`, scopes) === null)
    .sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))
    .slice(0, limit);
}

function printPlan(log, p) {
  const s = p.stats;
  log("\nPlan:");
  log(`  sitemap URLs:          ${s.rows} (${s.learnRows} learn scope, ${s.indexOnlyRows} index only)`);
  log(`  kept unchanged:        ${s.kept - s.bootstrapped}`);
  log(`  bootstrapped lastmod:  ${s.bootstrapped}  (old git-built records, adopted without refetch)`);
  log(`  respelled to sitemap:  ${s.respelled}  (case-variant records folded into the sitemap's spelling)`);
  log(`  alias records folded:  ${s.aliasesFolded}`);
  log(`  changed pages:         ${s.changed} (fetching ${p.fetch.items.filter((i) => i.kind === "changed").length}, ${p.fetch.deferredChanged.length} deferred by the cap)`);
  log(`  new pages:             ${s.new} (fetching ${p.fetch.items.filter((i) => i.kind === "new").length}, ${p.fetch.deferredNew.length} deferred by the cap, ${s.knownRedirectSkipped} skipped: known redirect)`);
  log(`  verification pass:     ${s.verifyPlanned} record(s)`);
  log(`  fell out of sitemaps:  ${s.missingCandidates} (probing ${p.missing.items.length}, ${p.missing.deferred.length} deferred${p.sitemapOk ? "" : `, ${p.missing.carried.length} carried unchecked`})`);
  log(`  quarantine re-checks:  ${s.quarantineRechecks} of ${p.invalidByKey.size}`);
  log(`  untitled records:      ${s.untitledRecords}`);
}

// ---------------------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------------------

/**
 * @param {object} o
 * @param {string} o.dataDir
 * @param {object} o.client      docs-http client
 * @param {Function} [o.git]     async ({ previous, skip, log }) => { records, failed } for non-Learn sources
 * @returns {Promise<{ exitCode: number, aborted?: string, summary?: object, written?: object }>}
 */
export async function runDocsSync({
  dataDir,
  client,
  git = null,
  env = process.env,
  config = null,
  scopes = DEFAULT_SCOPES,
  log = console.log,
  warn = console.error,
  now = () => new Date(),
  sleep,
  sitemapDelayMs,
  catalogMinAbsolute,
}) {
  const cfg = config || readConfig(env);
  const today = now().toISOString().slice(0, 10);
  const file = (name) => join(dataDir, DATA_FILES[name]);
  const abort = (message) => {
    warn(`\nAborting: ${message}`);
    return { exitCode: 1, aborted: message };
  };

  let prev;
  try {
    prev = loadPrevious(dataDir);
  } catch (err) {
    return abort(err.message);
  }
  const { catalog, invalid, families: previousFamilies, ledger, previousIndex } = prev;

  // --- Learn: sitemaps ------------------------------------------------------------------
  log("\nLearn sitemaps:");
  const catalogPrefer = new Map();
  for (const rec of catalog) {
    const path = typeof rec.url === "string" ? canonicalPath(rec.url) : null;
    if (path && !catalogPrefer.has(path)) catalogPrefer.set(path, rec.url);
  }
  let sm;
  try {
    sm = await collectSitemaps({
      client,
      memo: previousFamilies,
      scopes,
      today,
      full: cfg.fullDiscovery,
      prefer: catalogPrefer,
      log,
      sleep,
      ...(sitemapDelayMs === undefined ? {} : { delayMs: sitemapDelayMs }),
    });
  } catch (err) {
    return abort(`could not read the sitemap index: ${err.message}`);
  }
  const sitemapFailures = sm.failures.length;
  const sitemapOk = sitemapFailures === 0;
  log(`  ${sm.rows.size} in-scope page URL(s) after normalization/dedupe` + (sm.queryRows ? ` (${sm.queryRows} carried a query string, dropped)` : ""));
  if (!sitemapOk) {
    warn(`  ${sitemapFailures} sitemap file(s) failed -- removal detection is DISABLED and the index is NOT rewritten this run:`);
    for (const f of sm.failures.slice(0, 10)) warn(`    ${f}`);
  }

  // --- failsafe: is the sitemap pass plausible? ---------------------------------------
  // Skipped when a file failed: the count is known to be incomplete for that reason, and
  // such a run is already harmless (no removal detection, the index file is kept).
  if (sitemapOk) {
    const baseline = indexSanityBaseline({
      previousIndex,
      catalogPaths: [...catalogPrefer.keys()],
      inScope: (path) => scopeClass(path, scopes) !== null,
    });
    const sanity = checkIndexSanity({ newCount: sm.rows.size, previousCount: baseline.count, ratio: baseline.ratio });
    if (!sanity.ok) return abort(`${sanity.message} (baseline: ${baseline.source})`);
  }

  // --- plan -------------------------------------------------------------------------
  const p = makePlan({ today, caps: cfg.caps, previousIndex, catalog, invalid, ledger, rows: sm.rows, sitemapOk, scopes });
  printPlan(log, p);
  const perPrefix = countByPrefix(sm.rows, scopes);
  for (const [cls, label] of [["learn", "LEARN_SCOPE (index + metadata)"], ["index", "INDEX_ONLY_SCOPE (index only)"]]) {
    log(`  URLs per ${label} prefix:`);
    for (const [prefix, count] of [...perPrefix[cls]].sort((a, b) => b[1] - a[1] || byCodePoint(a[0], b[0]))) log(`    ${prefix.padEnd(36)} ${count}`);
  }

  if (cfg.dryRun) {
    const estimate = serializeIndex(new Map([...sm.rows].map(([path, row]) => [path, row.lastmod ?? null])));
    log(`\n  index file if written now: ${sm.rows.size} line(s), ${(Buffer.byteLength(estimate) / 1024 / 1024).toFixed(2)} MB`);
    const unscoped = unscopedSegments(sm.segments, scopes);
    if (unscoped.length) {
      log("  top-level areas in the downloaded sitemap files that neither scope covers (by URL count):");
      for (const [seg, count] of unscoped) log(`    /${seg.padEnd(34)} ${count}`);
    }
    log("\nDRY_RUN=1 -- nothing fetched or written.");
    return { exitCode: 0, dryRun: true, summary: { rows: sm.rows.size, perPrefix, stats: p.stats, unscoped } };
  }

  // --- network phases ---------------------------------------------------------------
  const deadline = createDeadline(cfg.maxRuntimeMinutes, () => now().getTime());
  const ph = await runPhases({
    plan: p,
    client,
    deadline,
    breakerLimit: cfg.consecutiveTransientLimit,
    concurrency: cfg.concurrency,
    delayMs: cfg.delayMs,
    sleep,
    log,
  });

  // --- git sources (docs.github.com): not on Learn, not affected by the repo retirement ---
  let gitRecords = p.git;
  let gitFailed = false;
  if (git) {
    const g = await git({ previous: p.git, skip: cfg.skipGitSources, log });
    gitRecords = g.records;
    gitFailed = Boolean(g.failed);
  }

  // --- reconcile --------------------------------------------------------------------
  const out = reconcile({ plan: p, results: ph.results, gitRecords, previousIndex, scopes, sitemapFailures, degraded: ph.degraded });
  const r = out.stats;

  // --- failsafes on the result ------------------------------------------------------
  const audit = auditDuplicates(out.catalog);
  let entries = out.catalog;
  if (audit.exact.length || audit.aliases.length) {
    warn(`\nWARNING: ${audit.exact.length} duplicate and ${audit.aliases.length} case-variant URL group(s); keeping the first of each.`);
    for (const { url } of audit.exact.slice(0, 5)) warn(`  ${url}`);
    for (const { urls } of audit.aliases.slice(0, 5)) warn(`  ${urls.join("  ~  ")}`);
  }
  if (!audit.ok) return abort(`${audit.message} -- systemic merge bug, nothing written.`);
  if (audit.exact.length || audit.aliases.length) entries = dropDuplicates(entries, (e) => aliasKey(e.url));
  const size = checkCatalogSize({ newCount: entries.length, previousCount: catalog.length, ...(catalogMinAbsolute === undefined ? {} : { absolute: catalogMinAbsolute }) });
  if (!size.ok) return abort(`${size.message} Nothing written.`);

  // --- write ------------------------------------------------------------------------
  const written = {};
  written.catalog = writeIfChanged(file("catalog"), JSON.stringify(entries));
  written.invalid = writeIfChanged(file("invalid"), JSON.stringify(out.invalid, null, 2));
  written.redirects = writeIfChanged(file("redirects"), JSON.stringify(out.ledger, null, 2) + "\n");
  written.index = out.indexWritten ? writeIfChanged(file("index"), serializeIndex(out.index)) : false;
  written.families = writeIfChanged(file("families"), JSON.stringify(sm.families, null, 2) + "\n");
  const status = { ...out.status, catalogRecords: entries.length };
  updateStatus(file("status"), "docs", status, { now: now(), env });

  log(`\nWrote ${dataDir}`);
  log(
    `  catalog ${entries.length} record(s)${written.catalog ? "" : " (unchanged)"}, index ${out.indexWritten ? `${out.index.size} URL(s)${written.index ? "" : " (unchanged)"}` : `NOT rewritten (kept ${previousIndex.size})`}, ` +
      `${out.invalid.length} quarantined, ${out.ledger.length} redirect(s) in the ledger`
  );
  log(
    `  fetched ${r.fetched} (noindex ${r.noindex}, untitled dropped ${r.untitledDropped}, moved ${r.movedOnFetch}, quarantined ${r.quarantinedOnFetch}, transient ${r.fetchTransient}); ` +
      `verified ${r.verified} (quarantined ${r.quarantinedOnVerify}, moved ${r.movedOnVerify}, transient ${r.verifyTransient}); ` +
      `missing probes: live ${r.missingLive}, moved ${r.missingMoved}, gone ${r.quarantinedOnMissing}, transient ${r.missingTransient}; released ${r.released}`
  );
  log(
    `  status: pendingNew ${status.pendingNew}, deferredChanged ${status.deferredChanged}, deferredMissing ${status.deferredMissing}, ` +
      `sitemapFailures ${status.sitemapFailures}, complete ${status.complete}; requests ${JSON.stringify(client.stats || {})}`
  );
  if (r.untitledAfter) log(`  ${r.untitledAfter} Learn record(s) still have no title (pages whose <title> is only the site suffix).`);

  if (out.newlyQuarantined.length) {
    const reportFile = cfg.reportFile || join(tmpdir(), "docs-catalog-quarantine-report.md");
    writeFileSync(reportFile, buildQuarantineReport(out.newlyQuarantined, { surgeThreshold: QUARANTINE_SURGE_THRESHOLD }));
    log(`Wrote ${reportFile} (${out.newlyQuarantined.length} newly quarantined URL(s))`);
    if (cfg.githubOutput) appendFileSync(cfg.githubOutput, `new_quarantine_count=${out.newlyQuarantined.length}\n`);
  }

  const failures = [];
  if (!sitemapOk) failures.push(`${sitemapFailures} sitemap file(s) failed`);
  if (gitFailed) failures.push("a git source failed (previous entries carried forward)");
  for (const [phase, why] of Object.entries(ph.stops)) if (why === "breaker") failures.push(`the ${phase} phase hit the rate-limit circuit breaker`);
  if (Object.values(ph.stops).includes("deadline")) log(`  wall-clock budget (${cfg.maxRuntimeMinutes} min) exhausted; remaining work is deferred to the next run.`);
  if (failures.length) warn(`\nRun DEGRADED (exit 1 after writing): ${failures.join("; ")}.`);

  return { exitCode: failures.length ? 1 : 0, summary: { status, stats: r, plan: p.stats, stops: ph.stops }, written };
}
