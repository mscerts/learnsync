/**
 * Seeding of the change files (data/changes/removed.json and moved.json) with
 * changes that happened BEFORE the Learn sync started recording them. See
 * DATA_CONTRACT.md ("change files") and scripts/seed-changes.mjs (the CLI).
 *
 * Candidates come from sources that are never guessed:
 *
 *   catalog   the tombstones and hierarchyNotFound flags of the CURRENT learn-catalog.json and the
 *             tombstones of learn-content.json (the sync only diffs consecutive runs, so tombstones
 *             that already exist when the change files are introduced would otherwise never be listed)
 *   history   git history of learn-catalog.json (any number of repos/files). One snapshot is read at a
 *             time and reduced to module paths; a module path seen in some snapshot but absent from the
 *             current modules and outOfScope is a candidate whose firstSeen is the date of the first
 *             snapshot that lacks it after its last sighting. That date is an UPPER BOUND: the removal
 *             happened at or before it. Unit slugs are mined the same way, by comparing two consecutive
 *             snapshots at a time with diffUnits (so only snapshots that carry real unitUrls can say anything)
 *   urls      an operator-supplied list of links (for example every Learn link a site uses). Each is
 *             classified by the cache-only validator; broken and unverifiable verdicts of a kind the change
 *             files cover become candidates, but only a LIVE PROBE can record them (evidence "live-probe"):
 *             the cache verdict alone never writes anything for this source
 *
 * Everything funnels into refreshLearnChanges() (probe, classify, apply) from changes.mjs, so the seed
 * obeys the same lifecycle, budget and pacing as the sync. It only ever merges: known paths keep their
 * entries, docs-family entries pass through untouched, and `sources.learn` (the Learn SYNC's freshness
 * stamp) is not advanced, because a seed run proves nothing about whether the sync has run recently.
 *
 * Pure except for the git calls (`git` is injectable), the file reads/writes and the probe it is given.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, byCodePoint } from "./canonical.mjs";
import {
  CHANGES_PROBE_DELAY_MS,
  diffContent,
  diffModules,
  diffUnits,
  loadChanges,
  makeIsLive,
  readChangesLimits,
  refreshLearnChanges,
  writeChanges,
} from "./changes.mjs";
import { LIMITS } from "./learn-config.mjs";
import { dateOfTimestamp, isIsoDate, utcDate } from "./learn-helpers.mjs";
import { rawProbe } from "./live-probe.mjs";
import { loadData, validateUrls } from "./validate.mjs";

export const DEFAULT_HISTORY_FILE = "data/learn-catalog.json";
const GIT_MAX_BUFFER = 512 * 1024 * 1024;
const FILE_NAMES = ["removed", "moved"];
const OUTCOMES = ["gone", "landing", "retired", "unverified", "moved"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isTimestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
const textOrNull = (value) => (typeof value === "string" && value.trim() ? value : null);

/** Canonical path of a link that can be an entry's path (never the site root), else null. */
function entryPath(value) {
  const path = canonicalPath(value);
  return path && path !== "/" ? path : null;
}

/** The module path of a catalog record (`path` in v2, only `url` in v1), canonical. */
const modulePathOf = (mod) => entryPath(typeof mod?.path === "string" ? mod.path : mod?.url);

// ---------------------------------------------------------------------------
// --history <repoDir>[::<fileInRepo>]
// ---------------------------------------------------------------------------

/** "repoDir[::fileInRepo]" -> { repoDir, file }. The file defaults to data/learn-catalog.json and is always written with "/". */
export function parseHistorySpec(spec) {
  if (typeof spec !== "string" || !spec.trim()) throw new Error("--history needs <repoDir>[::<fileInRepo>]");
  const cut = spec.lastIndexOf("::");
  const repoDir = cut === -1 ? spec : spec.slice(0, cut);
  const rawFile = cut === -1 ? "" : spec.slice(cut + 2);
  if (!repoDir.trim()) throw new Error(`--history ${JSON.stringify(spec)}: the repository directory is empty`);
  const file = (rawFile.trim() || DEFAULT_HISTORY_FILE).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
  return { repoDir, file };
}

// ---------------------------------------------------------------------------
// git access (injectable: `git(repoDir, args) -> stdout text`)
// ---------------------------------------------------------------------------

export function defaultGit(repoDir, args) {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function gitFailure(spec, err) {
  const detail = String(err?.stderr || err?.message || err).trim().split("\n")[0];
  return new Error(`cannot read the git history of ${spec.repoDir} (${spec.file}): ${detail}`, { cause: err });
}

/**
 * Commits of every spec that touched its file, merged oldest first (by commit date, then spec order, then
 * git's order): [{ spec, hash, commitIso }]. A directory that is not a repository throws; a spec without a
 * single commit for its file, and a shallow clone, only warn (the usual causes are a wrong path or a depth-1 checkout).
 */
export function listHistory(specs, { git = defaultGit, warn = console.warn } = {}) {
  const found = [];
  specs.forEach((spec, specIndex) => {
    let lines;
    try {
      lines = git(spec.repoDir, ["log", "--date-order", "--reverse", "--format=%H%x09%cI", "--", spec.file]).split("\n").filter(Boolean);
    } catch (err) {
      throw gitFailure(spec, err);
    }
    let shallow = "";
    try {
      shallow = git(spec.repoDir, ["rev-parse", "--is-shallow-repository"]).trim();
    } catch {
      // old git: no way to tell
    }
    if (shallow === "true") warn(`  ${spec.repoDir} is a shallow clone: its history is incomplete, so older removals cannot be found`);
    if (!lines.length) warn(`  no commit of ${spec.repoDir} touches ${spec.file} (wrong path?)`);
    lines.forEach((line, order) => {
      const [hash, commitIso] = line.split("\t");
      if (hash && isTimestamp(commitIso)) found.push({ spec, specIndex, order, hash, commitIso });
    });
  });
  return found
    .sort((a, b) => Date.parse(a.commitIso) - Date.parse(b.commitIso) || a.specIndex - b.specIndex || a.order - b.order)
    .map(({ spec, hash, commitIso }) => ({ spec, hash, commitIso }));
}

// ---------------------------------------------------------------------------
// snapshots: reduce a catalog (v1 or v2) to what the history needs
// ---------------------------------------------------------------------------

/**
 * A learn-catalog.json (v1: only `url`; v2: `path`, `unitUrls`, `outOfScope`) reduced to
 * { lastChecked, modules: [{ uid, title, path, units?, unitUrls?, hierarchyNotFound? }], outOfScope: [path] },
 * or null when it is not a catalog. `fallbackTimestamp` stands in for a missing or invalid lastChecked.
 * Unit data is kept only where real unitUrls exist (v1 has none, so it can say nothing about units).
 */
export function compactSnapshot(raw, fallbackTimestamp = null) {
  if (!isObject(raw) || !Array.isArray(raw.modules)) return null;
  const lastChecked = isTimestamp(raw.lastChecked) ? raw.lastChecked : isTimestamp(fallbackTimestamp) ? fallbackTimestamp : null;
  const modules = [];
  for (const record of raw.modules) {
    const path = modulePathOf(record);
    if (!path) continue;
    const mod = { uid: typeof record.uid === "string" ? record.uid : null, title: textOrNull(record.title), path };
    if (Array.isArray(record.unitUrls)) {
      mod.unitUrls = record.unitUrls;
      mod.units = Array.isArray(record.units) ? record.units : [];
    }
    if (record.hierarchyNotFound === true) mod.hierarchyNotFound = true;
    modules.push(mod);
  }
  const outOfScope = (Array.isArray(raw.outOfScope) ? raw.outOfScope : []).map(entryPath).filter(Boolean);
  return { lastChecked, modules, outOfScope };
}

/**
 * Walks snapshots oldest to newest, keeping ONLY a map of module paths -> last snapshot they appeared in
 * (plus the date of every snapshot), never the snapshots themselves; unit slugs come from comparing each
 * snapshot with its predecessor. Feed it the compact snapshots in chronological order and make the CURRENT
 * catalog the last one: a path that is not in the last snapshot is a candidate.
 *
 *   add(snapshot) -> index          snapshot needs a valid lastChecked
 *   dates                           YYYY-MM-DD of every snapshot added, by index
 *   candidates() -> [{ path, kind, title, parent?, evidence: "history", firstSeen }]
 *       module: firstSeen = date of the snapshot right after the last one that listed it (an upper bound).
 *       unit:   diffUnits(previous, next) between two consecutive snapshots (same trust rules as the
 *               sync); a unit lost, restored and lost again keeps the latest loss.
 *       A candidate says "not in the last snapshot"; whether it is still valid is the caller's isLive check.
 */
export function createHistoryTracker() {
  const dates = [];
  const seen = new Map(); // path -> { last, title }
  const unitLoss = new Map(); // path -> candidate
  let previous = null;
  return {
    dates,
    add(snapshot) {
      const date = dateOfTimestamp(snapshot?.lastChecked);
      if (!date) throw new TypeError("history snapshot without a valid lastChecked");
      const index = dates.length;
      dates.push(date);
      for (const mod of snapshot.modules) seen.set(mod.path, { last: index, title: mod.title ?? seen.get(mod.path)?.title ?? null });
      for (const path of snapshot.outOfScope ?? []) seen.set(path, { last: index, title: seen.get(path)?.title ?? null });
      if (previous) for (const unit of diffUnits(previous, snapshot)) unitLoss.set(unit.path, { ...unit, evidence: "history" });
      previous = snapshot;
      return index;
    },
    candidates() {
      const final = dates.length - 1;
      const found = [];
      for (const [path, record] of seen) {
        if (record.last < final) found.push({ path, kind: "module", title: record.title, evidence: "history", firstSeen: dates[record.last + 1] });
      }
      found.push(...unitLoss.values());
      return found.sort((a, b) => byCodePoint(a.path, b.path));
    },
  };
}

// ---------------------------------------------------------------------------
// --urls <file>
// ---------------------------------------------------------------------------

/** What the change files can say about each validator kind (docs is the docs sync's, "other" has no cache). */
const KIND_BY_VALIDATOR_KIND = Object.freeze({
  module: "module",
  unit: "unit",
  path: "learning-path",
  course: "course",
  exam: "exam",
  "applied-skill": "applied-skill",
  "study-guide": "study-guide",
  certification: "certification",
});

const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));

/**
 * Candidates from a list of links: the cache-only validator classifies every distinct path, and each
 * non-valid verdict of a covered kind becomes a candidate with evidence "live-probe" and firstSeen = `today`.
 * `tier` says how strong the cache evidence is: "broken" (the cache says the path does not exist) or
 * "unverifiable" (the cache cannot know: a live probe is the only way to learn anything). Nothing here is
 * recorded without a probe. Docs links, links the caches do not cover and non-Learn links are counted, not used.
 * Returns { candidates, stats: { given, invalid, nonLearn, duplicates, valid, docs, other, broken, unverifiable } }.
 */
export function urlCandidates(list, data, { today }) {
  const stats = { given: 0, invalid: 0, nonLearn: 0, duplicates: 0, valid: 0, docs: 0, other: 0, broken: 0, unverifiable: 0 };
  const urls = [];
  const paths = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    stats.given++;
    const url = typeof item === "string" ? item : isObject(item) ? item.url : null;
    if (typeof url !== "string" || !url.trim()) {
      stats.invalid++;
      continue;
    }
    const path = canonicalPath(url.trim());
    if (!path) {
      stats.nonLearn++;
      continue;
    }
    if (paths.has(path)) {
      stats.duplicates++;
      continue;
    }
    paths.add(path);
    urls.push(url.trim());
  }
  const candidates = [];
  for (const result of validateUrls(urls, data).results) {
    if (result.verdict === "valid") {
      stats.valid++;
      continue;
    }
    const kind = KIND_BY_VALIDATOR_KIND[result.kind];
    if (!kind) {
      stats[result.kind === "docs" ? "docs" : "other"]++;
      continue;
    }
    const tier = result.verdict === "broken" ? "broken" : "unverifiable";
    stats[tier]++;
    candidates.push({
      path: result.path,
      kind,
      parent: kind === "unit" ? parentOf(result.path) : null,
      title: null,
      evidence: "live-probe",
      firstSeen: today,
      tier,
    });
  }
  return { candidates: candidates.sort((a, b) => byCodePoint(a.path, b.path)), stats };
}

/** The links of a --urls file: a JSON array of URL strings (or objects with a `url` field). */
export function readUrlsFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`cannot read the URL list ${file}: ${err.message}`, { cause: err });
  }
  if (!Array.isArray(parsed)) throw new Error(`the URL list ${file} must be a JSON array of URLs`);
  return parsed;
}

// ---------------------------------------------------------------------------
// the current data
// ---------------------------------------------------------------------------

function readJsonFile(file, what) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    throw new Error(`cannot read ${what} ${file}: ${err.message}`, { cause: err });
  }
}

/**
 * The current learn-catalog.json: required (it is what history is compared with), and refused when it looks
 * truncated, because every module missing from a truncated catalog would read as removed.
 */
function readCurrentCatalog(dataDir, minModules) {
  const file = join(dataDir, "learn-catalog.json");
  if (!existsSync(file)) throw new Error(`${file} is required: the history is compared with the current catalog`);
  const catalog = readJsonFile(file, "the current catalog");
  if (!isObject(catalog) || !Array.isArray(catalog.modules)) throw new Error(`${file} is not a learn catalog (no modules array)`);
  const known = catalog.modules.length + (Array.isArray(catalog.outOfScope) ? catalog.outOfScope.length : 0);
  if (known < minModules) {
    throw new Error(`the current catalog lists only ${known} modules (floor ${minModules}); refusing to treat everything else as removed`);
  }
  return catalog;
}

function readCurrentContent(dataDir, warn) {
  const file = join(dataDir, "learn-content.json");
  if (!existsSync(file)) {
    warn(`  ${file} is missing: content tombstones and the validity of paths/courses/skills are not used`);
    return null;
  }
  try {
    const content = JSON.parse(readFileSync(file, "utf-8"));
    return isObject(content) ? content : null;
  } catch (err) {
    warn(`  could not read ${file} (${err.message}); content is not used`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// candidate assembly and result bookkeeping
// ---------------------------------------------------------------------------

/**
 * Merges the sources into one candidate per path. Priority (the most authoritative evidence wins): the
 * current cache, history modules, history units, urls whose cache verdict is broken, urls the cache cannot judge.
 * A path that is already in the change files, or that the cache says is valid, is not a candidate.
 * Returns { candidates (each with `source` and `tier`), stats }.
 */
export function assembleCandidates({ cache = [], historyModules = [], historyUnits = [], urls = [], knownPaths = new Set(), isLive = () => undefined }) {
  const stats = { catalog: 0, historyModules: 0, historyUnits: 0, urlsBroken: 0, urlsUnverifiable: 0, duplicates: 0, alreadyRecorded: 0, alreadyLive: 0 };
  const chosen = new Map();
  const take = (list, source, statKey, tierOf) => {
    for (const candidate of list) {
      if (knownPaths.has(candidate.path)) stats.alreadyRecorded++;
      else if (chosen.has(candidate.path)) stats.duplicates++;
      else if (isLive(candidate.path) === true) stats.alreadyLive++;
      else {
        chosen.set(candidate.path, { ...candidate, source, tier: tierOf(candidate) });
        stats[statKey(candidate)]++;
      }
    }
  };
  take(cache, "catalog", () => "catalog", () => "main");
  take(historyModules, "history", () => "historyModules", () => "main");
  take(historyUnits, "history", () => "historyUnits", () => "main");
  take(urls.filter((c) => c.tier === "broken"), "urls", () => "urlsBroken", () => "main");
  take(urls.filter((c) => c.tier !== "broken"), "urls", () => "urlsUnverifiable", () => "unverifiable");
  return { candidates: [...chosen.values()].sort((a, b) => byCodePoint(a.path, b.path)), stats };
}

/** path -> { file, outcome } of the Learn-family entries of a change set. */
function learnIndex(changes) {
  const index = new Map();
  for (const file of FILE_NAMES) for (const entry of changes[file].entries) if (entry.family === "learn") index.set(entry.path, { file, outcome: entry.outcome });
  return index;
}

/**
 * Drops the entries of `paths` that a probe round left `unverified` and that did not exist before: the urls
 * source records nothing a live probe has not classified. Returns { changes, dropped: [path] }.
 */
function dropUnconfirmed(changes, paths, knownPaths) {
  const dropped = [];
  const entries = changes.removed.entries.filter((entry) => {
    const drop = entry.outcome === "unverified" && paths.has(entry.path) && !knownPaths.has(entry.path);
    if (drop) dropped.push(entry.path);
    return !drop;
  });
  return { changes: { ...changes, removed: { ...changes.removed, entries } }, dropped };
}

function describeChange(before, after) {
  const was = learnIndex(before);
  const now = learnIndex(after);
  const added = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
  let reclassified = 0;
  let dropped = 0;
  for (const [path, entry] of now) {
    const old = was.get(path);
    if (!old) added[entry.outcome]++;
    else if (old.outcome !== entry.outcome || old.file !== entry.file) reclassified++;
  }
  for (const path of was.keys()) if (!now.has(path)) dropped++;
  return { before: was.size, after: now.size, added, reclassified, dropped };
}

const sameEntries = (a, b) => JSON.stringify(a.entries) === JSON.stringify(b.entries);

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

/**
 * One seeding run. Options:
 *   dataDir        the data directory (learn-catalog.json required, learn-content.json optional, changes/ merged into)
 *   histories      [spec string | { repoDir, file }]   git histories of learn-catalog.json
 *   urls / urlsFile   the operator's link list (an array, or the path of a JSON file)
 *   maxProbes      probe budget (default CHANGES_MAX_PROBES / env CHANGES_MAX_PROBES); noProbe: plan only
 *   dryRun         compute everything, write nothing
 *   probe          async (path) => raw probe result (default live-probe.mjs rawProbe); never called with noProbe
 *   today, now     YYYY-MM-DD and Date (tests); minModules  floor of the current catalog (default LIMITS.MIN_MODULES)
 *   workers, delayMs, sleepImpl, consecutiveTransientLimit   passed to refreshLearnChanges (tests: delayMs 0)
 *   git, log, warn, env   injectable
 * Entries of known paths are never changed except by a probe classifying an `unverified` one; docs-family
 * entries are never touched; nothing is written when nothing changed. Throws (and writes nothing) for a
 * corrupt change file, a missing/truncated current catalog, a history newer than the current catalog or an
 * unreadable git repository. Returns a report (see formatSeedReport).
 */
export async function runSeed(options = {}) {
  const {
    dataDir,
    histories = [],
    urls = null,
    urlsFile = null,
    env = process.env,
    noProbe = false,
    dryRun = false,
    probe = rawProbe,
    now = new Date(),
    minModules = LIMITS.MIN_MODULES,
    workers,
    delayMs = CHANGES_PROBE_DELAY_MS,
    sleepImpl,
    consecutiveTransientLimit,
    git = defaultGit,
    log = console.log,
    warn = console.warn,
  } = options;
  if (!dataDir) throw new Error("runSeed: dataDir is required");
  const today = options.today ?? utcDate(now);
  if (!isIsoDate(today)) throw new TypeError(`runSeed: today must be YYYY-MM-DD, got ${JSON.stringify(today)}`);
  const generatedAt = now.toISOString();
  const budget = noProbe ? 0 : options.maxProbes ?? readChangesLimits(env).maxProbes;
  if (!Number.isInteger(budget) || budget < 0) throw new RangeError(`runSeed: maxProbes must be a non-negative integer, got ${JSON.stringify(budget)}`);
  const specs = histories.map((spec) => (typeof spec === "string" ? parseHistorySpec(spec) : spec));

  // state first: a corrupt change file or a bad catalog fails the run before anything is downloaded or probed
  const previous = loadChanges(dataDir, { warn });
  const catalog = readCurrentCatalog(dataDir, minModules);
  const content = readCurrentContent(dataDir, warn);
  const current = compactSnapshot(catalog, generatedAt);
  const currentDate = dateOfTimestamp(current.lastChecked);
  const isLive = makeIsLive({ catalog, content });
  const ctx = { modulePaths: new Set([...current.modules.map((m) => m.path), ...current.outOfScope]) };

  // 1. the current cache: tombstones the sync would never report (they were already there when the files were introduced)
  const cache = [...diffModules(null, catalog), ...diffContent(null, content)];

  // 2. history: one snapshot at a time
  const tracker = createHistoryTracker();
  const historyReport = specs.map((spec) => ({ repoDir: spec.repoDir, file: spec.file, commits: 0, read: 0, skipped: 0, first: null, last: null }));
  const commits = listHistory(specs, { git, warn });
  for (const { spec, hash, commitIso } of commits) {
    const info = historyReport[specs.indexOf(spec)];
    info.commits++;
    let snapshot;
    try {
      snapshot = compactSnapshot(JSON.parse(git(spec.repoDir, ["show", `${hash}:${spec.file}`])), commitIso);
    } catch (err) {
      warn(`  skipped ${spec.repoDir} ${hash.slice(0, 8)}: ${String(err?.stderr || err?.message || err).trim().split("\n")[0]}`);
    }
    if (!snapshot) {
      info.skipped++;
      continue;
    }
    const date = dateOfTimestamp(snapshot.lastChecked);
    if (date > currentDate) {
      throw new Error(`history snapshot ${hash.slice(0, 8)} of ${spec.repoDir} is dated ${date}, newer than the current catalog (${currentDate}); update ${dataDir} first`);
    }
    tracker.add(snapshot);
    info.read++;
    info.first ??= date;
    info.last = date;
  }
  tracker.add(current);
  const history = tracker.candidates();
  log(`History: ${tracker.dates.length - 1} snapshots read, ${history.length} paths missing from the current catalog.`);

  // 3. the operator's link list
  let urlResult = { candidates: [], stats: null };
  if (urls || urlsFile) {
    urlResult = urlCandidates(urls ?? readUrlsFile(urlsFile), loadData(dataDir), { today });
    log(`URL list: ${urlResult.stats.broken} broken and ${urlResult.stats.unverifiable} unverifiable of ${urlResult.stats.given} links.`);
  }

  // 4. one candidate per path
  const knownPaths = new Set(learnIndex(previous).keys());
  const plan = assembleCandidates({
    cache,
    historyModules: history.filter((c) => c.kind === "module"),
    historyUnits: history.filter((c) => c.kind === "unit"),
    urls: urlResult.candidates,
    knownPaths,
    isLive,
  });
  const urlPaths = new Set(plan.candidates.filter((c) => c.source === "urls").map((c) => c.path));

  // 5. stage, probe within the budget, apply. The strongly evidenced candidates go first so a small budget is
  // never spent on links the cache cannot judge; the urls source records nothing a probe has not classified.
  const probes = { budget, probed: 0, transient: 0, stoppedEarly: false, budgetExhausted: false };
  const unconfirmed = [];
  let changes = previous;
  let remaining = budget;
  let unverifiedLeft = 0;
  let covered = 0;
  let resurrected = 0;
  for (const tier of ["main", "unverifiable"]) {
    const candidates = plan.candidates.filter((c) => c.tier === tier);
    // the main tier always runs: it also works off the `unverified` entries an earlier (for example --no-probe) run left behind
    if (tier === "unverifiable" && !candidates.length) continue;
    if (tier === "unverifiable" && (remaining <= 0 || probes.stoppedEarly)) {
      for (const candidate of candidates) unconfirmed.push(candidate.path);
      probes.budgetExhausted ||= !probes.stoppedEarly;
      continue;
    }
    if (tier === "main" && !noProbe) log(`Probing within a budget of ${remaining} paths (${delayMs} ms between probes per worker, at most 3 workers)...`);
    const refreshed = await refreshLearnChanges({
      previous: changes,
      candidates,
      isLive,
      probe,
      today,
      generatedAt,
      limits: { maxProbes: remaining, reverifyPerRun: 0 },
      workers,
      delayMs,
      ctx,
      sleepImpl,
      consecutiveTransientLimit,
    });
    const filtered = dropUnconfirmed(refreshed.changes, urlPaths, knownPaths);
    changes = filtered.changes;
    unconfirmed.push(...filtered.dropped);
    const { stats } = refreshed;
    remaining -= stats.probed;
    probes.probed += stats.probed;
    probes.transient += stats.transient;
    probes.stoppedEarly ||= stats.stoppedEarly;
    probes.budgetExhausted ||= stats.probeBudgetExhausted;
    unverifiedLeft = stats.unverified - filtered.dropped.length;
    covered += stats.covered;
    resurrected += stats.resurrected;
  }
  if (noProbe) probes.budgetExhausted = false;

  // 6. the freshness stamp of the Learn SYNC is not ours to move; a file whose entries did not change stays byte-identical
  const next = {};
  for (const file of FILE_NAMES) {
    next[file] = sameEntries(previous[file], changes[file])
      ? previous[file]
      : { ...changes[file], sources: { ...changes[file].sources, learn: previous[file].sources.learn } };
  }
  const changed = FILE_NAMES.some((file) => next[file] !== previous[file]);
  let written = null;
  if (changed && !dryRun) written = writeChanges(dataDir, next);

  // candidates that ended up nowhere: a probe found the path live, or a removed module covers it (never "unconfirmed")
  const recorded = learnIndex(changes);
  const waiting = new Set(unconfirmed);
  const dismissed = plan.candidates.filter((c) => !recorded.has(c.path) && !waiting.has(c.path)).length;

  return {
    dataDir,
    dryRun,
    probing: !noProbe,
    today,
    current: {
      modules: catalog.modules.length,
      outOfScope: Array.isArray(catalog.outOfScope) ? catalog.outOfScope.length : 0,
      tombstones: Array.isArray(catalog.removed) ? catalog.removed.length : 0,
      lastChecked: currentDate,
      content: content !== null,
    },
    history: historyReport,
    urls: urlResult.stats,
    candidates: plan.stats,
    plan: plan.candidates.map(({ path, kind, source, tier, evidence, firstSeen }) => ({ path, kind, source, tier, evidence, firstSeen })),
    unconfirmed: unconfirmed.sort(byCodePoint),
    probes,
    entries: { ...describeChange(previous, changes), unverifiedLeft, covered, resurrected, dismissed },
    changed,
    written: written ? Object.values(written) : null,
    complete: !probes.stoppedEarly && !probes.budgetExhausted && unverifiedLeft === 0 && unconfirmed.length === 0,
  };
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const SAMPLE = 20;

/** The report of runSeed() as printable lines. */
export function formatSeedReport(report) {
  const lines = [];
  const mode = [report.dryRun ? "dry run, nothing written" : null, report.probing ? null : "no probes"].filter(Boolean).join(", ");
  lines.push(`Seed of the Learn change files${mode ? ` (${mode})` : ""}`);
  lines.push(`  data: ${report.dataDir}`);
  const c = report.current;
  lines.push(`  current catalog: ${c.modules} modules, ${c.outOfScope} out of scope, ${c.tombstones} tombstones (checked ${c.lastChecked})${c.content ? "" : "; learn-content.json not used"}`);
  if (!report.history.length) lines.push("  history: none given (use --history <repoDir>[::<fileInRepo>] to find modules removed before the sync recorded changes)");
  for (const h of report.history) {
    const span = h.read ? `, ${h.first} to ${h.last}` : "";
    lines.push(`  history ${h.repoDir}::${h.file}: ${h.read} of ${h.commits} snapshots read${span}${h.skipped ? `, ${h.skipped} skipped` : ""}`);
  }
  if (report.urls) {
    const u = report.urls;
    lines.push(`  url list: ${u.given} links, ${u.valid} valid, ${u.broken} broken, ${u.unverifiable} unverifiable, ${u.docs} docs (not covered), ${u.other + u.nonLearn + u.invalid} other/not Learn, ${u.duplicates} duplicates`);
  }
  const k = report.candidates;
  lines.push("Candidates (after de-duplication):");
  lines.push(`  current cache     ${k.catalog}  (tombstones, modules Learn does not serve)`);
  lines.push(`  history modules   ${k.historyModules}  (firstSeen is an upper bound: the first snapshot that lacks the path)`);
  lines.push(`  history units     ${k.historyUnits}`);
  lines.push(`  url list          ${k.urlsBroken} broken in the cache, ${k.urlsUnverifiable} the cache cannot judge (recorded only after a live probe)`);
  lines.push(`  not candidates    ${k.alreadyRecorded} already recorded, ${k.alreadyLive} valid in the cache, ${k.duplicates} duplicates`);
  for (const row of report.plan.slice(0, SAMPLE)) lines.push(`    ${row.source.padEnd(7)} ${row.kind.padEnd(13)} ${row.path}  [${row.evidence}, firstSeen ${row.firstSeen}]`);
  if (report.plan.length > SAMPLE) lines.push(`    ... and ${report.plan.length - SAMPLE} more`);
  const p = report.probes;
  if (report.probing) {
    lines.push(`Probes: ${p.probed} of a budget of ${p.budget}, ${p.transient} transient${p.stoppedEarly ? ", STOPPED EARLY (rate limit storm)" : ""}${p.budgetExhausted ? ", budget exhausted (run again to continue)" : ""}`);
  }
  const e = report.entries;
  const added = OUTCOMES.filter((outcome) => e.added[outcome]).map((outcome) => `${e.added[outcome]} ${outcome}`);
  lines.push(`Entries: ${e.before} before, ${e.after} after; new: ${added.length ? added.join(", ") : "none"}; reclassified ${e.reclassified}; dropped ${e.dropped} (${e.resurrected} live again, ${e.covered} covered by a removed module)`);
  if (e.dismissed) lines.push(`  ${e.dismissed} candidates were not recorded: a live probe found them served on their own path, or a removed module covers them`);
  if (e.unverifiedLeft) lines.push(`  ${e.unverifiedLeft} entries are still unverified${report.probing ? ": run again to probe them" : ": run without --no-probe to classify them"}`);
  if (report.unconfirmed.length) {
    lines.push(`  ${report.unconfirmed.length} url-list links were not recorded (no live probe confirmed them: ${report.probing ? "budget or rate limit" : "probing is off"}):`);
    for (const path of report.unconfirmed.slice(0, SAMPLE)) lines.push(`    ${path}`);
    if (report.unconfirmed.length > SAMPLE) lines.push(`    ... and ${report.unconfirmed.length - SAMPLE} more`);
  }
  if (report.written) lines.push(`Written: ${report.written.join(", ")}`);
  else lines.push(report.dryRun ? `Nothing written (dry run${report.changed ? "; a real run would write the changes above" : "; nothing would change"}).` : "Nothing to write: the change files already say all of this.");
  return lines;
}
