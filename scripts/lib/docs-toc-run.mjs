/**
 * The docs sidebar run: ask the folders of the docs index for their table of contents (`<folder>/toc.json`)
 * and keep the groups in data/docs-toc.json. Thin I/O around the pure logic in docs-toc.mjs; every dependency is
 * injectable so the tests need no network. Rules and format: DATA_CONTRACT.md.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LEARN_HOST } from "./canonical.mjs";
import {
  DOCS_TOC_LIMITS,
  breakerTripped,
  buildFile,
  buildTocRecord,
  directoriesOf,
  evaluateFailsafes,
  parseToc,
  planProbes,
  readPrevious,
  stableContent,
  summarizeTocs,
} from "./docs-toc.mjs";
import { parseIndex } from "./docs-index.mjs";
import { FailsafeAbort, readJsonIfExists, retryLogger, writeJsonAtomic } from "./learn-io.mjs";
import { numberFromEnv, utcDate } from "./learn-helpers.mjs";
import { request, runPool, sleep } from "./learn-http.mjs";
import { updateStatus } from "./status.mjs";

const LEARN_PAGES = `https://${LEARN_HOST}/en-us`;
// toc.json is a small static file, like the catalog's JSON: the same pause as the other JSON requests.
export const DEFAULT_TOC_DELAY_MS = 500;
const CHUNK = 100;

/** The first path segments (families) the run covers: DOCS_TOC_FAMILIES, else every relevant family of the sitemap pass. */
export function familiesInScope({ env, familiesFile }) {
  const wanted = (env.DOCS_TOC_FAMILIES ?? "")
    .split(",")
    .map((f) => f.trim().toLowerCase().replace(/^\//, ""))
    .filter(Boolean);
  if (wanted.length > 0) return { families: new Set(wanted), scope: wanted.slice().sort().join(",") };
  const relevant = Object.entries(familiesFile ?? {})
    .filter(([, v]) => v && v.relevant === true)
    .map(([k]) => k);
  // without the families file every family of the index is in scope
  return relevant.length > 0 ? { families: new Set(relevant), scope: "relevant" } : { families: null, scope: "all" };
}

export async function runDocsTocSync(options = {}) {
  const {
    dataDir,
    env = process.env,
    now = new Date(),
    fetchImpl,
    sleepImpl = sleep,
    log = console.log,
    warn = console.warn,
    delayMs = numberFromEnv(env, "DOCS_TOC_DELAY_MS", DEFAULT_TOC_DELAY_MS, { min: 0, max: 60_000 }),
    httpOptions = {},
    limits: limitOverrides = {},
  } = options;
  if (!dataDir) throw new Error("runDocsTocSync: dataDir is required");

  const outputFile = join(dataDir, "docs-toc.json");
  const indexFile = join(dataDir, "docs-urls.txt");
  const familiesFile = join(dataDir, "docs-sitemap-families.json");
  const statusFile = join(dataDir, "status.json");
  const today = utcDate(now);
  const dryRun = env.DRY_RUN === "1";

  const limits = {
    ...DOCS_TOC_LIMITS,
    MIN_DIR_PAGES: numberFromEnv(env, "DOCS_TOC_MIN_DIR_PAGES", DOCS_TOC_LIMITS.MIN_DIR_PAGES, { min: 1, max: 1000 }),
    MAX_PROBES: numberFromEnv(env, "DOCS_TOC_MAX_PROBES", DOCS_TOC_LIMITS.MAX_PROBES, { min: 0, max: 100_000 }),
    RECHECK_DAYS: numberFromEnv(env, "DOCS_TOC_RECHECK_DAYS", DOCS_TOC_LIMITS.RECHECK_DAYS, { min: 1, max: 3650 }),
    MAX_FAIL_PCT: numberFromEnv(env, "DOCS_TOC_MAX_FAIL_PCT", DOCS_TOC_LIMITS.MAX_FAIL_PCT, { min: 0, max: 100 }),
    ...limitOverrides,
  };
  const http = { ...(fetchImpl ? { fetchImpl } : {}), sleepImpl };

  // 0. inputs: the docs index is the list of folders; without it there is nothing to ask ---------------
  if (!existsSync(indexFile)) throw new Error("data/docs-urls.txt is missing: run the docs catalog sync first");
  const index = parseIndex(readFileSync(indexFile, "utf-8"));
  if (index.size === 0) throw new Error("data/docs-urls.txt is empty: run the docs catalog sync first");
  const { families, scope } = familiesInScope({ env, familiesFile: readJsonIfExists(familiesFile, warn) });
  const previous = readPrevious(readJsonIfExists(outputFile, warn));
  const previousTocs = previous?.scope === scope ? previous.tocs : [];
  const previousNoToc = previous?.scope === scope ? previous.noToc : {};

  // 1. plan ---------------------------------------------------------------------------------------------
  const directories = directoriesOf(index, { families });
  const plan = planProbes({
    directories,
    previousTocs,
    previousNoToc,
    today,
    recheckDays: limits.RECHECK_DAYS,
    maxProbes: limits.MAX_PROBES,
    minDirPages: limits.MIN_DIR_PAGES,
  });
  const todo = [...new Set([...plan.refresh, ...plan.probe])].sort();
  log(`Scope "${scope}": ${directories.length} folders hold pages; ${plan.refresh.length} known tocs to refresh, ${plan.probe.length} folders to ask, ${plan.waiting} waiting for the next run.`);

  // 2. ask ----------------------------------------------------------------------------------------------
  const fetched = new Map(); // dir -> groups
  const none = new Set(); // dir answered "no toc.json"
  const failedDirs = new Set();
  let attempted = 0;
  let failed = 0;
  let answeredOk = 0;
  let formatFailed = 0;
  let broke = false;
  const onRetry = retryLogger(warn, "toc");
  for (let from = 0; from < todo.length && !broke; from += CHUNK) {
    const chunk = todo.slice(from, from + CHUNK);
    const results = await runPool(
      chunk,
      async (dir) => {
        const result = await request(`${LEARN_PAGES}${dir}/toc.json`, { ...http, ...httpOptions, read: "json", onRetry });
        return { dir, result };
      },
      { delayMs, sleepImpl },
    );
    for (const { dir, result } of results) {
      attempted++;
      if (result.outcome === "ok") {
        answeredOk++;
        const groups = parseToc(result.body, dir);
        if (groups === null) {
          formatFailed++;
          failedDirs.add(dir);
          warn(`  ${dir}/toc.json answered 200 but is not a table of contents`);
        } else fetched.set(dir, groups);
      } else if (result.outcome === "notFound") {
        none.add(dir);
      } else {
        failed++;
        failedDirs.add(dir);
        warn(`  could not read ${dir}/toc.json (${result.error ?? result.outcome})`);
      }
    }
    log(`  ${attempted} of ${todo.length} folders asked`);
    if (breakerTripped({ attempted, failed: failed + formatFailed, limits })) broke = true;
  }

  // 3. merge: an answer replaces the old record; a folder that failed keeps what it had --------------------
  const tocs = new Map();
  for (const toc of previousTocs) {
    if (plan.dropped.includes(toc.path)) continue;
    if (none.has(toc.path)) continue; // a folder that had a toc and now answers 404: the toc is gone
    tocs.set(toc.path, toc);
  }
  for (const [dir, groups] of fetched) {
    const old = previousTocs.find((t) => t.path === dir);
    const record = buildTocRecord({ path: dir, groups, since: today });
    // an unchanged toc keeps its `since` day, so a week without a change is not a diff of thousands of lines
    tocs.set(dir, old && old.sig === record.sig ? old : record);
  }
  const noToc = {};
  for (const [dir, day] of Object.entries(previousNoToc)) if (!plan.dropped.includes(dir) && !tocs.has(dir)) noToc[dir] = day;
  for (const dir of none) {
    // an answered folder that had no toc keeps its first day only if nothing is due: it was asked today
    noToc[dir] = today;
    tocs.delete(dir);
  }
  const merged = [...tocs.values()];

  // 4. failsafes ----------------------------------------------------------------------------------------------
  const before = summarizeTocs(previousTocs);
  const after = summarizeTocs(merged);
  const problems = evaluateFailsafes({
    attempted,
    failed,
    answeredOk,
    formatFailed,
    previousPages: before.uniquePages,
    nextPages: after.uniquePages,
    limits,
  });
  if (broke) problems.push(`the circuit breaker stopped the run after ${attempted} requests: more than half failed`);
  if (problems.length > 0) throw new FailsafeAbort(problems);

  // 5. write --------------------------------------------------------------------------------------------------
  const next = buildFile({ tocs: merged, noToc, scope, lastChecked: now.toISOString() });
  const unchanged = previous !== null && previous.scope === scope && stableContent(next) === stableContent(buildFile({ tocs: previousTocs, noToc: previousNoToc, scope, lastChecked: "" }));
  const summary = { scope, ...after, noToc: Object.keys(noToc).length, asked: attempted, failed: failed + formatFailed, waiting: plan.waiting, written: false };
  log(`${after.tocs} tocs, ${after.groups} groups, ${after.uniquePages} pages in a group; ${Object.keys(noToc).length} folders without a toc; ${attempted} asked, ${summary.failed} failed.`);
  if (dryRun) {
    log("DRY_RUN=1: nothing written.");
    return summary;
  }
  if (unchanged) {
    log("data/docs-toc.json is unchanged.");
  } else {
    writeJsonAtomic(outputFile, next);
    summary.written = true;
    log("Wrote data/docs-toc.json.");
  }
  updateStatus(
    statusFile,
    "docsToc",
    {
      scope,
      tocs: after.tocs,
      groups: after.groups,
      pages: after.uniquePages,
      noToc: summary.noToc,
      asked: attempted,
      failed: summary.failed,
      waiting: plan.waiting,
    },
    { now, env },
  );
  return summary;
}
