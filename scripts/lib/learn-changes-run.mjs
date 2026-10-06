/**
 * The change-file stage of the two Learn syncs (data/changes/removed.json and
 * moved.json, see DATA_CONTRACT.md). scripts/lib/changes.mjs holds the pure
 * lifecycle; this file is the glue both run modules share, so the catalog run and
 * the content run treat the files identically:
 *
 *   openChanges      at the START of a run: read the previous change files and the
 *                    CHANGES_* limits. A corrupt file or a typo in a limit throws here,
 *                    before any download, so a bad file can never be overwritten.
 *   refreshChanges   AFTER the failsafes passed: stage the detector candidates, resurrect
 *                    from the new data, live-probe the verification queue, log one line.
 *                    Returns the next change set; it writes nothing.
 *   changesCounters  the numbers the run adds to status.json.
 *
 * The run modules write the files themselves, in the same write stage as their own
 * data file and BEFORE it: if the process dies between the two writes the next run
 * derives the same candidates from the old data again, and applying them to a ledger
 * that already holds them changes nothing. The other order would lose the diff for
 * good (detectors only see what changed since the previous data file).
 *
 * Both runs read-modify-write the same two files (catalog first, then content), and
 * each run keeps the entries of every kind it did not produce candidates for. The
 * probe is injectable (tests pass a stub, the real runs use live-probe.mjs `rawProbe`
 * with the run's own fetch/sleep); a probe that throws or answers 429 only leaves an
 * entry `unverified`, it never fails the sync.
 */

import { canonicalPath } from "./canonical.mjs";
import { CHANGES_PROBE_DELAY_MS, loadChanges, makeIsLive, readChangesLimits, refreshLearnChanges, summarizeChanges } from "./changes.mjs";
import { utcDate } from "./learn-helpers.mjs";
import { rawProbe } from "./live-probe.mjs";

/** More new candidates than this in one run are logged as suspicious (Learn restructured, or the API changed shape). Never aborts. */
export const CHANGES_CANDIDATE_WARN = 500;

/** The previous change files and the probe budgets, read before anything is downloaded. Throws ChangesFileError / Invalid CHANGES_*. */
export function openChanges({ dataDir, env = process.env, warn = console.warn }) {
  return { previous: loadChanges(dataDir, { warn }), limits: readChangesLimits(env) };
}

/** Canonical paths of every module the catalog knows (in scope and out of scope), for classifyLearnProbe. */
export function modulePathsOf(catalog) {
  const paths = new Set();
  for (const mod of Array.isArray(catalog?.modules) ? catalog.modules : []) {
    const path = canonicalPath(mod?.path ?? "");
    if (path) paths.add(path);
  }
  for (const entry of Array.isArray(catalog?.outOfScope) ? catalog.outOfScope : []) {
    const path = canonicalPath(entry ?? "");
    if (path) paths.add(path);
  }
  return paths;
}

/**
 * One run's change tracking. Returns { changes, stats, counters } and writes nothing.
 *
 *   previous, limits   from openChanges()
 *   candidates         detector output (diffModules + diffUnits, or diffContent)
 *   catalog, content   the freshly built file of this run and the other one read from disk (null when
 *                      absent): together they decide resurrection and which paths the caches can vouch for
 *   now                the run's clock; its date is `today`, its timestamp is sources.learn
 *   probe              async (path) => raw probe result; default rawProbe over fetchImpl/sleepImpl
 *   delayMs, workers   probe pace (default 1000 ms per worker, at most 3 workers)
 */
export async function refreshChanges({ previous, candidates = [], catalog = null, content = null, now, limits, probe, fetchImpl, sleepImpl, delayMs = CHANGES_PROBE_DELAY_MS, workers, label = "changes", log = console.log, warn = console.warn }) {
  if (candidates.length > CHANGES_CANDIDATE_WARN) {
    warn(`  WARNING: ${candidates.length} new ${label} candidates in one run (more than ${CHANGES_CANDIDATE_WARN}): Learn restructured a lot at once, or an API changed shape; the probe budget (${limits.maxProbes} per run) works through them over several runs`);
  }
  const rawProbeOptions = { ...(fetchImpl ? { fetchImpl } : {}), ...(sleepImpl ? { sleepImpl } : {}) };
  const result = await refreshLearnChanges({
    previous,
    candidates,
    isLive: makeIsLive({ catalog, content }),
    probe: probe ?? ((path) => rawProbe(path, rawProbeOptions)),
    today: utcDate(now),
    generatedAt: now.toISOString(),
    limits,
    delayMs,
    workers,
    ctx: { modulePaths: modulePathsOf(catalog) },
    sleepImpl,
  });
  const counters = changesCounters(result.changes, result.stats);
  log(
    `  change files (${label}): ${counters.removed} removed (${counters.unverified} unverified), ${counters.moved} moved; this run ${counters.newRemoved} new removed, ${counters.newMoved} new moved, ${counters.resurrected} resurrected, ${counters.probed} probed (${result.stats.transient} transient)`
  );
  if (result.stats.stoppedEarly) warn("  change probes stopped early after a run of transient answers (rate limit or outage); the entries that were not probed stay as they were and are retried next run");
  if (result.stats.probeBudgetExhausted) warn(`  the verification queue is longer than the probe budget (${limits.maxProbes}); the rest waits for the next run`);
  return { changes: result.changes, stats: result.stats, counters };
}

/**
 * The counters a run reports in status.json (each part under its own key, `catalogChanges` / `contentChanges`):
 * removed and moved are the Learn-family entries now in each file, unverified the removed ones no probe has
 * classified yet, the rest what this run did.
 */
export function changesCounters(changes, stats) {
  const learn = summarizeChanges(changes).byFamily.learn;
  return {
    removed: learn.removed,
    moved: learn.moved,
    unverified: stats.unverified,
    newRemoved: stats.newRemoved,
    newMoved: stats.newMoved,
    resurrected: stats.resurrected,
    probed: stats.probed,
  };
}
