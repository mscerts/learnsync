/**
 * Logic of scripts/check-changes.mjs: ask the change files (data/changes/removed.json and
 * moved.json, see DATA_CONTRACT.md) about links, or list what changed recently. Reads only
 * those two files and data/status.json (for freshness), never the multi-MB caches.
 *
 * Everything here is pure except readStatusFile(); the CLI wires in the clock, stdin and the
 * files. The one rule every consumer must keep in mind is in NONE_MEANS: a link without an
 * entry reads "none", which says "no change is recorded", NOT "valid".
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath } from "./canonical.mjs";
import { changesSince, lookupChange, summarizeChanges } from "./changes.mjs";
import { isIsoDate } from "./learn-helpers.mjs";
import { readStatus } from "./status.mjs";
import { describeChange, ledgerStamps } from "./validate.mjs";

export const DEFAULT_STALE_DAYS = 10;

/** Printed in every links report: the honest reading of the "none" status. */
export const NONE_MEANS =
  'status "none" means NO CHANGE IS RECORDED for that link. It does not mean the link is valid: a link that was never in a learnsync cache, or that broke before learnsync recorded changes, also reads none. Use scripts/validate-urls.mjs (and --confirm-live) for a verdict.';

const SINCE_NOTE = "These are the changes learnsync recorded since that date. A link that is not listed has no recorded change; that is not a statement that it is valid.";
const NO_CHANGE = "no change recorded (this is not a validity verdict)";
const DAY_MS = 86_400_000;
const FAMILY_LABEL = { learn: "Learn", docs: "docs" };

/** A mistake of the caller (bad flag, bad input): the CLI prints it and exits 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * The links of a parsed JSON input: an array of strings, or of objects with a string `url` (or `path`).
 * Throws UsageError for anything else, naming the offending index.
 */
export function parseLinks(parsed) {
  if (!Array.isArray(parsed)) throw new UsageError("the input must be a JSON array of URLs or paths");
  return parsed.map((item, i) => {
    if (typeof item === "string") return item;
    const url = item && typeof item === "object" ? (item.url ?? item.path) : undefined;
    if (typeof url === "string") return url;
    throw new UsageError(`input item ${i} is not a string or an object with a string "url" or "path"`);
  });
}

/** `data/status.json` as an object, or null when the file does not exist (a damaged file reads as {}, see status.mjs). */
export function readStatusFile(dataDir) {
  const file = join(dataDir, "status.json");
  return existsSync(file) ? readStatus(file) : null;
}

const none = (url, path, reason) => ({
  url,
  path,
  status: "none",
  outcome: null,
  to: null,
  via: null,
  confidence: null,
  firstSeen: null,
  lastVerified: null,
  reason,
});

/**
 * One row per link, in input order: what the change files say about it.
 *   hit   { url, path, status: "removed" | "moved", outcome, to, via, confidence, firstSeen, lastVerified,
 *           kind, title, evidence, httpStatus, matched, decidedBy, chain, cycle, truncated, reason }
 *         (describeChange in validate.mjs defines every field; the entry that decided supplies
 *         outcome, firstSeen, lastVerified and evidence)
 *   none  { url, path, status: "none", outcome: null, to: null, ..., reason }: nothing recorded, NOT "valid"
 * `ledger` is loadChangeLedger()'s result; without an index every link reads none.
 */
export function checkLinks(links, ledger) {
  return links.map((url) => {
    const path = canonicalPath(url);
    if (!path) return none(url, null, "not a learn.microsoft.com URL or absolute path");
    const hit = ledger?.index ? lookupChange(path, ledger.index) : null;
    return hit ? { url, path, ...describeChange(hit) } : none(url, path, NO_CHANGE);
  });
}

/**
 * The changelog view: every entry first seen on or after `since` (YYYY-MM-DD), oldest first, then by path.
 * Same vocabulary as the link rows (`status` is removed or moved, `httpStatus` the probe's first-hop status).
 */
export function changelog(ledger, since) {
  return changesSince(ledger?.changes ?? null, since).map((entry) => ({
    path: entry.path,
    status: entry.outcome === "moved" ? "moved" : "removed",
    outcome: entry.outcome,
    to: entry.to,
    kind: entry.kind,
    family: entry.family,
    title: entry.title,
    parent: entry.parent,
    firstSeen: entry.firstSeen,
    lastVerified: entry.lastVerified,
    evidence: entry.evidence,
    httpStatus: entry.status,
  }));
}

function ageHours(iso, now) {
  const time = Date.parse(iso ?? "");
  return Number.isNaN(time) ? null : Math.round(((now - time) / 3_600_000) * 10) / 10;
}

/**
 * How far an answer from the change files can be trusted, judged from the files themselves.
 *   missingFiles, error, generatedAt   as in ledgerStamps()
 *   sources.<family>   { stamp, ageDays, stale }: when learnsync last refreshed that family's entries. A null stamp or
 *                      one older than staleDays is stale, because "no change recorded" only means something if a sync
 *                      diffed recently
 *   heartbeat          data/status.json: when each sync last finished (ages only: a weekly sync is normally days old)
 *   entries            how many entries each file holds
 *   stale              some family is stale or a change file is missing
 * `ledger` is loadChangeLedger()'s result, `status` the parsed data/status.json or null, `now` epoch milliseconds.
 */
export function changesFreshness({ ledger, status = null, now = Date.now(), staleDays = DEFAULT_STALE_DAYS }) {
  const stamps = ledgerStamps(ledger) ?? { missingFiles: [], error: null, generatedAt: null, sources: { learn: null, docs: null } };
  const sources = {};
  for (const family of ["learn", "docs"]) {
    const stamp = stamps.sources[family];
    const exactDays = stamp === null ? null : (now - Date.parse(stamp)) / DAY_MS;
    // the limit is judged on the exact age; the rounded one is for display
    sources[family] = { stamp, ageDays: exactDays === null ? null : Math.round(exactDays * 10) / 10, stale: stamp === null || exactDays > staleDays };
  }
  return {
    missingFiles: stamps.missingFiles,
    error: stamps.error,
    generatedAt: stamps.generatedAt,
    sources,
    heartbeat: {
      found: status !== null,
      learnGeneratedAt: status?.learn?.generatedAt ?? null,
      learnAgeHours: ageHours(status?.learn?.generatedAt, now),
      docsGeneratedAt: status?.docs?.generatedAt ?? null,
      docsAgeHours: ageHours(status?.docs?.generatedAt, now),
      docsComplete: status?.docs?.complete ?? null,
    },
    entries: ledger?.changes ? summarizeChanges(ledger.changes).files : { removed: 0, moved: 0 },
    staleAfterDays: staleDays,
    stale: sources.learn.stale || sources.docs.stale || stamps.missingFiles.length > 0,
  };
}

/** Human-readable cautions for a freshness block (empty when the change files are present and fresh). */
export function freshnessWarnings(freshness) {
  const warnings = [];
  if (freshness.missingFiles.length) {
    const effect = freshness.missingFiles.length === 2 ? "every link reads none" : "its entries are absent";
    warnings.push(`change file(s) missing under data/changes/: ${freshness.missingFiles.join(", ")} (the first learnsync run or scripts/seed-changes.mjs creates them), so ${effect}`);
  }
  const noFiles = freshness.missingFiles.length >= 2; // the missing-files line already says everything about the stamps
  for (const family of ["learn", "docs"]) {
    const { stamp, ageDays, stale } = freshness.sources[family];
    if (!stale || noFiles) continue;
    const label = FAMILY_LABEL[family];
    warnings.push(
      stamp === null
        ? `the change files carry no ${label} refresh stamp (sources.${family} is null): the ${label} sync has not refreshed them yet, so "none" says nothing about ${label} links`
        : `the ${label} entries were last refreshed ${stamp.slice(0, 10)} (${Math.floor(ageDays)} days ago, limit ${freshness.staleAfterDays}), so "none" is not reliable for ${label} links`
    );
  }
  if (!freshness.heartbeat.found) warnings.push("data/status.json is missing, so the heartbeat of the syncs could not be read");
  if (freshness.heartbeat.docsComplete === false) {
    warnings.push("the docs index was incomplete in the latest run (a sitemap file failed or work was deferred), so recent docs changes may be missing");
  }
  return warnings;
}

/**
 * The whole report for a run.
 *   links mode   { generatedAt, dataDir, note, freshness, warnings, summary, results }
 *                results = the "removed" and "moved" rows, plus the "none" rows when `all`;
 *                summary counts every input link, listed or not (notLearn = no canonical Learn path)
 *   since mode   { generatedAt, dataDir, note, freshness, warnings, since, summary, changes }
 *
 * `since` (YYYY-MM-DD) selects the changelog view and wins over `links`. `ledger` is loadChangeLedger()'s
 * result (a run with a ledger error never gets here), `status` the parsed data/status.json or null,
 * `now` epoch milliseconds, `notes` extra warning lines (what the reader said while loading the files).
 * Throws UsageError for a bad `since`.
 */
export function buildReport({ dataDir, ledger, status = null, links = [], since = null, all = false, now = Date.now(), staleDays = DEFAULT_STALE_DAYS, notes = [] }) {
  if (since !== null && !isIsoDate(since)) throw new UsageError(`--since must be a date like 2026-09-01, got ${JSON.stringify(since)}`);
  const freshness = changesFreshness({ ledger, status, now, staleDays });
  const head = { generatedAt: new Date(now).toISOString(), dataDir, note: NONE_MEANS, freshness, warnings: [...freshnessWarnings(freshness), ...notes] };
  if (since !== null) {
    const changes = changelog(ledger, since);
    const removed = changes.filter((change) => change.status === "removed").length;
    return { ...head, note: SINCE_NOTE, since, summary: { total: changes.length, removed, moved: changes.length - removed }, changes };
  }
  const rows = checkLinks(links, ledger);
  const count = (state) => rows.filter((row) => row.status === state).length;
  const summary = { total: rows.length, removed: count("removed"), moved: count("moved"), none: count("none"), notLearn: rows.filter((row) => row.path === null).length };
  return { ...head, summary, results: all ? rows : rows.filter((row) => row.status !== "none") };
}
