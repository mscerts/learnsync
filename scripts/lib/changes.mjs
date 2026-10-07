/**
 * The change files: data/changes/removed.json and data/changes/moved.json.
 * See DATA_CONTRACT.md ("change files"). They list every link learnsync KNOWS has
 * changed, so a consumer reads two small files instead of the multi-MB caches.
 *
 * Everything here is pure except loadChanges()/writeChanges() (small file I/O) and
 * refreshLearnChanges() (it calls the probe function it is given; the tests inject
 * a stub, the Learn sync injects live-probe.mjs `rawProbe`).
 *
 * In memory a change set is { removed, moved }: each is the file's own shape
 * { schemaVersion, generatedAt, sources: { learn, docs }, entries: [...] }.
 *
 *   detectors     diffModules / diffUnits / diffContent   catalogs -> candidates
 *   classifier    classifyLearnProbe                      raw probe -> live|gone|landing|moved|transient
 *   lifecycle     applyChanges, verificationQueue, refreshLearnChanges
 *   docs family   docsChanges, replaceFamily
 *   consumers     indexChanges, lookupChange, changesSince, summarizeChanges
 *
 * Nothing is ever guessed: a candidate comes from an authoritative cache diff, a
 * classification from a live probe, and a candidate nobody has probed yet is
 * recorded as `unverified` (it still counts as removed, a consumer may live-confirm).
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { byCodePoint, canonicalPath } from "./canonical.mjs";
import { normalizeLedger } from "./docs-redirects.mjs";
import { dateOfTimestamp, isIsoDate, numberFromEnv } from "./learn-helpers.mjs";
import { MAX_CONCURRENCY, sleep } from "./learn-http.mjs";
import { writeJsonAtomic } from "./learn-io.mjs";
import { classifyPath } from "./validate.mjs";

// ---------------------------------------------------------------------------
// vocabulary and limits
// ---------------------------------------------------------------------------

export const CHANGES_SCHEMA_VERSION = 1;
export const CHANGES_DIR = "changes";
export const CHANGES_FILES = Object.freeze({ removed: "removed.json", moved: "moved.json" });

export const CHANGE_KINDS = Object.freeze(["module", "unit", "learning-path", "course", "certification", "exam", "applied-skill", "study-guide", "docs"]);
export const CHANGE_FAMILIES = Object.freeze(["learn", "docs"]);
export const REMOVED_OUTCOMES = Object.freeze(["gone", "landing", "retired", "unverified"]);
export const MOVED_OUTCOMES = Object.freeze(["moved"]);
/** `rename` (a module or content item kept its uid but changed its path) is an addition to the contract's list, see DATA_CONTRACT.md. */
export const CHANGE_EVIDENCE = Object.freeze(["tombstone", "unit-diff", "hierarchy-not-found", "rename", "quarantine", "docs-redirect", "live-probe", "history"]);

/** Defaults of the two probe budgets (env CHANGES_MAX_PROBES / CHANGES_REVERIFY_PER_RUN, read by readChangesLimits). */
export const CHANGES_MAX_PROBES = 300;
export const CHANGES_REVERIFY_PER_RUN = 100;
/** Learn answers HTTP 429 above ~3 concurrent requests; real 429s occurred at 500 ms, so the default pace is 1000 ms. */
export const CHANGES_MAX_WORKERS = MAX_CONCURRENCY;
export const CHANGES_MIN_DELAY_MS = 500;
export const CHANGES_PROBE_DELAY_MS = 1000;
/** This many transient probes in a row stop the run's probing (a rate limit storm proves nothing). 0 = never stop. */
export const CHANGES_CONSECUTIVE_TRANSIENT_LIMIT = 40;
/** Probe rounds per run: a round may reveal new work (the units of a module that turned out to be merely moved). */
export const CHANGES_MAX_ROUNDS = 3;
/** lookupChange() follows a moved destination at most this many times. */
export const CHANGES_LOOKUP_MAX_HOPS = 5;

/**
 * Limits from an environment-like object. Unset or empty = the default; a value
 * that is set but not a non-negative integer THROWS, like every other threshold
 * (see numberFromEnv in learn-helpers.mjs): a typo must not silently change a budget.
 */
export function readChangesLimits(env = process.env) {
  const integer = (name, fallback) => {
    const value = numberFromEnv(env, name, fallback, { min: 0, max: 1_000_000 });
    if (!Number.isInteger(value)) throw new Error(`Invalid ${name}=${JSON.stringify(env[name])} (expected a non-negative integer)`);
    return value;
  };
  return {
    maxProbes: integer("CHANGES_MAX_PROBES", CHANGES_MAX_PROBES),
    reverifyPerRun: integer("CHANGES_REVERIFY_PER_RUN", CHANGES_REVERIFY_PER_RUN),
  };
}

/** Thrown by loadChanges() for a file that exists but cannot be trusted: a sync must fail loudly instead of overwriting it. */
export class ChangesFileError extends Error {
  constructor(file, reason, options) {
    super(`Cannot use change file ${file}: ${reason}`, options);
    this.name = "ChangesFileError";
    this.file = file;
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const FILE_NAMES = ["removed", "moved"];
const familyOfKind = (kind) => (kind === "docs" ? "docs" : "learn");
const LEARN_KINDS = CHANGE_KINDS.filter((kind) => familyOfKind(kind) === "learn");
const isTimestamp = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
const textOrNull = (value) => (typeof value === "string" && value.trim() ? value : null);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Canonical path of a link that can be an entry's `path`/`parent`: never the site root. */
function entryPath(value) {
  const path = canonicalPath(value);
  return path && path !== "/" ? path : null;
}

/** Parent path ("/a/b/c" -> "/a/b"), null for a top-level path. */
function parentPath(path) {
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : null;
}

function hasAncestorIn(path, set) {
  for (let ancestor = parentPath(path); ancestor; ancestor = parentPath(ancestor)) if (set.has(ancestor)) return true;
  return false;
}

function emptyChangeFile() {
  return { schemaVersion: CHANGES_SCHEMA_VERSION, generatedAt: null, sources: { learn: null, docs: null }, entries: [] };
}

/** A change set with nothing recorded (the state before the first run). */
export function emptyChanges() {
  return { removed: emptyChangeFile(), moved: emptyChangeFile() };
}

const ENTRY_KEYS = ["path", "kind", "family", "outcome", "to", "title", "parent", "firstSeen", "lastVerified", "evidence", "status"];

/**
 * One entry of `removed.json` (file "removed") or `moved.json` (file "moved") in
 * canonical form and contract key order, or null when the row is malformed
 * (`onDrop(reason, row)` is told why). Unknown fields of a valid row are kept
 * (sorted after the known ones) so a newer writer's data survives a round trip.
 */
export function normalizeChangeEntry(raw, file, onDrop = () => {}) {
  if (!FILE_NAMES.includes(file)) throw new TypeError(`normalizeChangeEntry: file must be "removed" or "moved", got ${JSON.stringify(file)}`);
  const drop = (reason) => {
    onDrop(reason, raw);
    return null;
  };
  if (!isObject(raw)) return drop("not an object");
  const path = entryPath(raw.path);
  if (!path) return drop(`bad path ${JSON.stringify(raw.path)}`);
  if (!CHANGE_KINDS.includes(raw.kind)) return drop(`unknown kind ${JSON.stringify(raw.kind)}`);
  const family = raw.family === undefined || raw.family === null ? familyOfKind(raw.kind) : raw.family;
  if (family !== familyOfKind(raw.kind)) return drop(`family ${JSON.stringify(raw.family)} does not fit kind ${raw.kind}`);
  const allowed = file === "moved" ? MOVED_OUTCOMES : REMOVED_OUTCOMES;
  if (!allowed.includes(raw.outcome)) return drop(`outcome ${JSON.stringify(raw.outcome)} does not belong in ${file}.json`);
  if (!isIsoDate(raw.firstSeen)) return drop(`bad firstSeen ${JSON.stringify(raw.firstSeen)}`);
  if (!CHANGE_EVIDENCE.includes(raw.evidence)) return drop(`unknown evidence ${JSON.stringify(raw.evidence)}`);
  // `to`: a Learn path, or null (off-site / not applicable). A destination that is not a Learn URL reads as off-site.
  const to = typeof raw.to === "string" ? canonicalPath(raw.to) : null;
  if (to === path) return drop("to equals path");
  const entry = {
    path,
    kind: raw.kind,
    family,
    outcome: raw.outcome,
    to,
    title: textOrNull(raw.title),
    parent: entryPath(raw.parent),
    firstSeen: raw.firstSeen,
    lastVerified: isIsoDate(raw.lastVerified) ? raw.lastVerified : null,
    evidence: raw.evidence,
    status: Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599 ? raw.status : null,
  };
  for (const key of Object.keys(raw).filter((k) => !ENTRY_KEYS.includes(k)).sort(byCodePoint)) entry[key] = raw[key];
  return entry;
}

/** The entry to keep when two claim the same path: the more recently verified, then the older firstSeen; firstSeen is the older of both. */
function preferEntry(a, b) {
  const [av, bv] = [a.lastVerified ?? "", b.lastVerified ?? ""];
  let winner;
  if (av !== bv) winner = av > bv ? a : b;
  else if (a.firstSeen !== b.firstSeen) winner = a.firstSeen < b.firstSeen ? a : b;
  else winner = byCodePoint(JSON.stringify(a), JSON.stringify(b)) <= 0 ? a : b;
  return { ...winner, firstSeen: a.firstSeen < b.firstSeen ? a.firstSeen : b.firstSeen };
}

/**
 * A whole change file in canonical form: malformed rows dropped, paths canonical,
 * enums validated, one entry per path, sorted by path (code point). `file` is
 * "removed" or "moved" (it decides which outcomes are allowed). Never throws for
 * bad content (loadChanges() is what rejects a corrupt or unsupported file).
 */
export function normalizeChangeFile(raw, file, { onDrop = () => {} } = {}) {
  if (!FILE_NAMES.includes(file)) throw new TypeError(`normalizeChangeFile: file must be "removed" or "moved", got ${JSON.stringify(file)}`);
  const source = isObject(raw) ? raw : {};
  const byPath = new Map();
  for (const row of Array.isArray(source.entries) ? source.entries : []) {
    const entry = normalizeChangeEntry(row, file, onDrop);
    if (!entry) continue;
    const old = byPath.get(entry.path);
    byPath.set(entry.path, old ? preferEntry(old, entry) : entry);
  }
  const sources = isObject(source.sources) ? source.sources : {};
  return {
    schemaVersion: CHANGES_SCHEMA_VERSION,
    generatedAt: isTimestamp(source.generatedAt) ? source.generatedAt : null,
    sources: { learn: isTimestamp(sources.learn) ? sources.learn : null, docs: isTimestamp(sources.docs) ? sources.docs : null },
    entries: [...byPath.values()].sort((a, b) => byCodePoint(a.path, b.path)),
  };
}

/** Like normalizeChangeFile() but a dropped row is a bug of the caller, so it throws (used on everything this module produces). */
function strictFile(raw, file) {
  const dropped = [];
  const out = normalizeChangeFile(raw, file, { onDrop: (reason, row) => dropped.push(`${reason}: ${JSON.stringify(row)?.slice(0, 120)}`) });
  if (dropped.length) throw new Error(`refusing to build ${file}.json: ${dropped.length} invalid entries (${dropped.slice(0, 3).join("; ")})`);
  return out;
}

function normalizeSet(changes) {
  return { removed: normalizeChangeFile(changes?.removed, "removed"), moved: normalizeChangeFile(changes?.moved, "moved") };
}

// ---------------------------------------------------------------------------
// file I/O
// ---------------------------------------------------------------------------

/**
 * Reads data/changes/removed.json and moved.json. A missing file is an empty one.
 * A file that is not valid JSON, is not an object with an `entries` array, or has
 * a schemaVersion other than CHANGES_SCHEMA_VERSION THROWS ChangesFileError: the
 * sync must stop rather than overwrite state it cannot read. Malformed rows inside
 * an otherwise valid file are dropped (`warn` says which). A path listed in both
 * files keeps the more recently verified entry (removed wins a tie).
 */
export function loadChanges(dataDir, { warn = console.warn } = {}) {
  const out = {};
  for (const file of FILE_NAMES) {
    const location = join(dataDir, CHANGES_DIR, CHANGES_FILES[file]);
    if (!existsSync(location)) {
      out[file] = emptyChangeFile();
      continue;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync(location, "utf-8"));
    } catch (err) {
      throw new ChangesFileError(location, `not valid JSON (${err.message})`, { cause: err });
    }
    if (!isObject(raw)) throw new ChangesFileError(location, "the top level is not an object");
    if (raw.schemaVersion !== CHANGES_SCHEMA_VERSION) {
      throw new ChangesFileError(location, `unsupported schemaVersion ${JSON.stringify(raw.schemaVersion)} (this code reads ${CHANGES_SCHEMA_VERSION})`);
    }
    if (!Array.isArray(raw.entries)) throw new ChangesFileError(location, "`entries` is not an array");
    out[file] = normalizeChangeFile(raw, file, {
      onDrop: (reason, row) => warn(`  ${location}: dropped a malformed row (${reason}): ${JSON.stringify(row)?.slice(0, 120)}`),
    });
  }
  // a path in both files is a corrupt state; keep one claim
  const moved = new Map(out.moved.entries.map((e) => [e.path, e]));
  for (const entry of out.removed.entries) {
    const other = moved.get(entry.path);
    if (!other) continue;
    warn(`  change files list ${entry.path} twice (removed and moved); keeping the more recently verified one`);
    const keepRemoved = (entry.lastVerified ?? "") >= (other.lastVerified ?? "");
    if (keepRemoved) out.moved.entries = out.moved.entries.filter((e) => e.path !== entry.path);
    else out.removed.entries = out.removed.entries.filter((e) => e.path !== entry.path);
  }
  return out;
}

/**
 * Writes both files (creating data/changes/): normalized, sorted, JSON.stringify(x, null, 2)
 * plus a newline, via a temp file and rename. Throws if `changes` holds a malformed
 * entry (a bug of the caller, never silently dropped). Returns { removed, moved }: the paths written.
 */
export function writeChanges(dataDir, changes) {
  const dir = join(dataDir, CHANGES_DIR);
  mkdirSync(dir, { recursive: true });
  const written = {};
  for (const file of FILE_NAMES) {
    written[file] = join(dir, CHANGES_FILES[file]);
    writeJsonAtomic(written[file], strictFile(changes?.[file], file));
  }
  return written;
}

// ---------------------------------------------------------------------------
// detectors: catalogs -> candidates { path, kind, parent?, title?, evidence, firstSeen }
// ---------------------------------------------------------------------------

const EVIDENCE_PRIORITY = ["tombstone", "hierarchy-not-found", "unit-diff", "rename", "live-probe", "quarantine", "docs-redirect", "history"];

function sortCandidates(list) {
  return list.sort((a, b) => byCodePoint(a.path, b.path) || byCodePoint(a.kind, b.kind) || EVIDENCE_PRIORITY.indexOf(a.evidence) - EVIDENCE_PRIORITY.indexOf(b.evidence));
}

/** First candidate per path wins (callers add the most authoritative evidence first). */
function collector() {
  const byPath = new Map();
  return {
    add(candidate) {
      if (candidate.path && !byPath.has(candidate.path)) byPath.set(candidate.path, candidate);
    },
    done: () => sortCandidates([...byPath.values()]),
  };
}

const modulePathOf = (mod) => entryPath(mod?.path ?? canonicalPath(mod?.url ?? ""));

/**
 * Module-level candidates from two consecutive learn-catalog.json files.
 *   tombstone             a `removed` entry of the new catalog whose uid was not tombstoned before
 *   hierarchy-not-found   every module the new catalog flags `hierarchyNotFound` (listed by the
 *                         catalog API but not served; re-emitted every run, a known path is a no-op)
 *   rename                a module with the same uid in both catalogs whose path changed: the OLD path
 * A missing previous catalog is fine (first run: every current tombstone is new).
 * firstSeen is the tombstone's removedOn, else the new catalog's lastChecked date.
 */
export function diffModules(previousCatalog, nextCatalog) {
  if (!isObject(nextCatalog)) return [];
  const date = dateOfTimestamp(nextCatalog.lastChecked);
  const found = collector();
  const knownTombs = new Set((Array.isArray(previousCatalog?.removed) ? previousCatalog.removed : []).map((t) => t?.uid));
  for (const tomb of Array.isArray(nextCatalog.removed) ? nextCatalog.removed : []) {
    if (!tomb || typeof tomb.uid !== "string" || knownTombs.has(tomb.uid)) continue;
    found.add({
      path: entryPath(tomb.path),
      kind: "module",
      title: textOrNull(tomb.title),
      evidence: "tombstone",
      firstSeen: isIsoDate(tomb.removedOn) ? tomb.removedOn : date,
    });
  }
  const modules = Array.isArray(nextCatalog.modules) ? nextCatalog.modules : [];
  for (const mod of modules) {
    if (mod?.hierarchyNotFound !== true) continue;
    found.add({ path: modulePathOf(mod), kind: "module", title: textOrNull(mod.title), evidence: "hierarchy-not-found", firstSeen: date });
  }
  const before = new Map();
  for (const mod of Array.isArray(previousCatalog?.modules) ? previousCatalog.modules : []) {
    const path = modulePathOf(mod);
    if (typeof mod?.uid === "string" && path) before.set(mod.uid, { path, title: textOrNull(mod.title) });
  }
  for (const mod of modules) {
    const old = typeof mod?.uid === "string" ? before.get(mod.uid) : null;
    const now = modulePathOf(mod);
    if (old && now && old.path !== now) found.add({ path: old.path, kind: "module", title: old.title, evidence: "rename", firstSeen: date });
  }
  return found.done();
}

/** True when two unitUrls lists can be compared: both real non-empty lists of paths, the new one not shorter than half of the old. */
function unitListsTrusted(oldUrls, newUrls) {
  const real = (list) => Array.isArray(list) && list.length > 0 && list.every((url) => entryPath(url));
  return real(oldUrls) && real(newUrls) && newUrls.length * 2 >= oldUrls.length;
}

/**
 * Unit candidates: for a module present in BOTH catalogs (same canonical path),
 * with unitUrls that are non-null and non-empty on both sides and a new list not
 * shorter than half of the old one (anything less is a truncated or failed
 * hierarchy, never evidence), every old unit path absent from the new list.
 * A module whose path changed is not compared (diffModules reports the rename and
 * lookupChange covers its units). Evidence "unit-diff"; `parent` is the module path.
 */
export function diffUnits(previousCatalog, nextCatalog) {
  if (!isObject(previousCatalog) || !isObject(nextCatalog)) return [];
  const date = dateOfTimestamp(nextCatalog.lastChecked);
  const current = new Map();
  for (const mod of Array.isArray(nextCatalog.modules) ? nextCatalog.modules : []) {
    const path = modulePathOf(mod);
    if (path && mod.hierarchyNotFound !== true) current.set(path, mod);
  }
  const found = collector();
  for (const mod of Array.isArray(previousCatalog.modules) ? previousCatalog.modules : []) {
    const path = modulePathOf(mod);
    const now = path ? current.get(path) : null;
    if (!now || !unitListsTrusted(mod.unitUrls, now.unitUrls)) continue;
    const alive = new Set(now.unitUrls.map(entryPath));
    mod.unitUrls.forEach((url, index) => {
      const unit = entryPath(url);
      if (unit && !alive.has(unit)) {
        found.add({ path: unit, kind: "unit", parent: path, title: textOrNull(mod.units?.[index]), evidence: "unit-diff", firstSeen: date });
      }
    });
  }
  return found.done();
}

export const CONTENT_KIND_BY_TYPE = Object.freeze({
  learningPath: "learning-path",
  course: "course",
  certification: "certification",
  exam: "exam",
  appliedSkill: "applied-skill",
});
const CONTENT_LISTS = [
  { list: "learningPaths", kind: "learning-path" },
  { list: "courses", kind: "course" },
  { list: "certifications", kind: "certification" },
  { list: "exams", kind: "exam" },
  { list: "appliedSkills", kind: "applied-skill" },
];

/**
 * Candidates from two consecutive learn-content.json files.
 *   tombstone    a `removed` entry (type + uid) that was not tombstoned before, with its content kind
 *   rename       an item with the same uid in both files whose path changed: the OLD path
 *   study guide  an exam or applied skill whose `studyGuide` went from a path to null. The sync keeps the
 *                previous value on a transient failure, so only a definitive probe (404/410, or a redirect
 *                elsewhere) can produce this: a transient failure yields NO candidate. Evidence "live-probe".
 *                An exam that left the list takes no study guide candidate (nothing proves the page is gone).
 */
export function diffContent(previousContent, nextContent) {
  if (!isObject(nextContent)) return [];
  const date = dateOfTimestamp(nextContent.lastChecked);
  const found = collector();
  const key = (type, uid) => `${type}\u0000${uid}`;
  const knownTombs = new Set((Array.isArray(previousContent?.removed) ? previousContent.removed : []).map((t) => key(t?.type, t?.uid)));
  for (const tomb of Array.isArray(nextContent.removed) ? nextContent.removed : []) {
    const kind = CONTENT_KIND_BY_TYPE[tomb?.type];
    if (!kind || typeof tomb.uid !== "string" || knownTombs.has(key(tomb.type, tomb.uid))) continue;
    found.add({
      path: entryPath(tomb.path),
      kind,
      title: textOrNull(tomb.title),
      evidence: "tombstone",
      firstSeen: isIsoDate(tomb.removedOn) ? tomb.removedOn : date,
    });
  }
  const unverified = new Set(Array.isArray(nextContent.unverifiedStudyGuides) ? nextContent.unverifiedStudyGuides : []);
  const liveGuides = new Set((Array.isArray(nextContent.studyGuides) ? nextContent.studyGuides : []).map((g) => g?.path));
  for (const { list, kind } of CONTENT_LISTS) {
    const before = new Map((Array.isArray(previousContent?.[list]) ? previousContent[list] : []).map((rec) => [rec?.uid, rec]));
    for (const rec of Array.isArray(nextContent[list]) ? nextContent[list] : []) {
      const old = before.get(rec?.uid);
      if (!old) continue;
      const [was, now] = [entryPath(old.path), entryPath(rec.path)];
      if (was && now && was !== now) found.add({ path: was, kind, title: textOrNull(old.title), evidence: "rename", firstSeen: date });
      const guide = entryPath(old.studyGuide);
      if ((kind === "exam" || kind === "applied-skill") && guide && rec.studyGuide === null && !unverified.has(guide) && !liveGuides.has(guide)) {
        found.add({ path: guide, kind: "study-guide", title: null, evidence: "live-probe", firstSeen: date });
      }
    }
  }
  return found.done();
}

// ---------------------------------------------------------------------------
// authoritative validity from the caches (resurrection, "is the destination still there")
// ---------------------------------------------------------------------------

/**
 * `isLive(path)` over a freshly built catalog and content file, for applyChanges()
 * and verificationQueue(). Returns true (the cache says the path is valid), false
 * (the cache says it does not exist: a module in neither `modules` nor `outOfScope`,
 * a unit missing from a module's real unitUrls, a learning path, course or applied
 * skill that is not listed, a module `hierarchyNotFound`) or undefined (the cache
 * cannot know: unitUrls null, an exam, certification or study guide that is not
 * listed, any docs page). Same rules as the validator (DATA_CONTRACT.md), with one
 * deliberate difference: a module that is listed and not flagged but whose unitUrls
 * is null (its hierarchy request failed without the API's own `module_id_not_found`,
 * so nothing proves Learn serves it) is `undefined`, not true. The validator may call
 * such a module valid (it has to answer something); here "true" DELETES a recorded
 * entry, and one unreadable hierarchy answer must not erase what a probe confirmed.
 * The entry stays until the hierarchy answers (unitUrls known) or a probe finds it live.
 */
export function makeIsLive({ catalog = null, content = null } = {}) {
  const modules = new Map();
  const units = new Set();
  for (const mod of Array.isArray(catalog?.modules) ? catalog.modules : []) {
    const path = modulePathOf(mod);
    if (!path) continue;
    modules.set(path, mod);
    if (Array.isArray(mod.unitUrls) && mod.hierarchyNotFound !== true) for (const url of mod.unitUrls) units.add(entryPath(url));
  }
  const outOfScope = new Set((Array.isArray(catalog?.outOfScope) ? catalog.outOfScope : []).map(entryPath));
  const sets = {};
  for (const [list, name] of [["learningPaths", "path"], ["courses", "course"], ["certifications", "certification"], ["exams", "exam"], ["appliedSkills", "applied-skill"]]) {
    sets[name] = new Set((Array.isArray(content?.[list]) ? content[list] : []).map((rec) => entryPath(rec?.path)));
  }
  sets["study-guide"] = new Set((Array.isArray(content?.studyGuides) ? content.studyGuides : []).map((g) => entryPath(g?.path)));

  return function isLive(input) {
    const path = entryPath(input);
    if (!path) return undefined;
    if (catalog) {
      const mod = modules.get(path);
      if (mod) {
        if (mod.hierarchyNotFound === true) return false;
        return Array.isArray(mod.unitUrls) ? true : undefined;
      }
      if (outOfScope.has(path)) return true;
      if (units.has(path)) return true;
      const parent = parentPath(path);
      const owner = parent ? modules.get(parent) : null;
      if (owner) {
        if (owner.hierarchyNotFound === true) return false;
        return Array.isArray(owner.unitUrls) ? false : undefined;
      }
      if (parent && outOfScope.has(parent)) return undefined;
      if (/^\/training\/modules\/[^/]+(\/[^/]+)?$/.test(path)) return false; // modules + outOfScope is complete
    }
    if (!content) return undefined;
    // exact membership first: a few listed paths have an unusual shape (/training/paths/x/x)
    if (Object.values(sets).some((set) => set.has(path))) return true;
    const { kind } = classifyPath(path);
    // only these three lists are complete; an exam, certification or study guide that is not listed proves nothing
    return kind === "path" || kind === "course" || kind === "applied-skill" ? false : undefined;
  };
}

// ---------------------------------------------------------------------------
// probe classification for Learn kinds
// ---------------------------------------------------------------------------

const STUDY_GUIDE_PATH = /^\/credentials\/(?:certifications|applied-skills)\/resources\/study-guides\/[^/]+$/;

/** What a canonical path looks like, given the module paths the catalog knows (a few live outside /training/modules/). */
function shapeOf(path, modulePaths) {
  if (modulePaths?.has(path)) return "module";
  const parent = parentPath(path);
  if (parent && modulePaths?.has(parent)) return "unit";
  if (/^\/training\/modules\/[^/]+$/.test(path)) return "module";
  if (/^\/training\/modules\/[^/]+\/[^/]+$/.test(path)) return "unit";
  if (/^\/training\/paths\/[^/]+$/.test(path)) return "learning-path";
  if (/^\/training\/courses\/[^/]+$/.test(path)) return "course";
  if (STUDY_GUIDE_PATH.test(path)) return "study-guide";
  if (/^\/credentials\/certifications\/exams\/[^/]+$/.test(path)) return "exam";
  if (/^\/credentials\/certifications\/(?!exams$|resources$|browse$)[^/]+$/.test(path)) return "certification";
  if (/^\/credentials\/applied-skills\/(?!resources$|browse$)[^/]+$/.test(path)) return "applied-skill";
  return "other";
}

/**
 * Raw probe result (live-probe.mjs `rawProbe`) -> what the change files record.
 *
 *   kind   a learn kind of CHANGE_KINDS (not "docs")
 *   path   canonical path that was requested
 *   raw    { status, firstStatus, finalUrl, title, offsite?, error? }
 *   ctx    { modulePaths?: Set|Array } module paths of the catalog (modules + outOfScope), so modules
 *          published outside /training/modules/ (saas, research, azure-databases) are recognised
 *
 * Returns { outcome, to, status }:
 *   live       the requested path itself is served (or an exam URL that redirects to its certification
 *              page: that is how a healthy exam link behaves): the entry is resurrected
 *   gone       HTTP 404/410, a soft 404 title, or a study guide that redirects (it does not exist)
 *   landing    served, but NOT the same kind of page: Browse all training, a docs page, a learning path
 *              for a module, a module root for a unit, any other hub, an off-site URL (to null)
 *   moved      served, and the destination is the SAME kind of page: module -> module (or one of its
 *              own units), unit -> unit-shaped path, learning path -> learning path, course -> course,
 *              certification -> certification, applied skill -> applied skill, exam -> exam
 *   transient  no usable answer (network error, timeout, 429, 5xx, any other status, unreadable URL):
 *              never changes anything
 * `status` is the status of the FIRST hop (null when unknown), `to` the canonical destination for
 * moved/landing and null otherwise.
 */
export function classifyLearnProbe(kind, path, raw, ctx = {}) {
  if (!LEARN_KINDS.includes(kind)) throw new TypeError(`classifyLearnProbe: unsupported kind ${JSON.stringify(kind)} (docs pages are classified by the docs sync)`);
  const first = Number.isInteger(raw?.firstStatus) ? raw.firstStatus : Number.isInteger(raw?.status) ? raw.status : null;
  const transient = { outcome: "transient", to: null, status: first };
  if (!isObject(raw) || raw.error || raw.status === null || raw.status === undefined) return transient;
  if (raw.offsite) return { outcome: "landing", to: null, status: first };
  if (raw.status === 404 || raw.status === 410) return { outcome: "gone", to: null, status: first };
  if (raw.status !== 200) return transient;
  if (/^404\b|content not found/i.test(raw.title ?? "")) return { outcome: "gone", to: null, status: first };
  const finalPath = canonicalPath(raw.finalUrl ?? "");
  if (!finalPath) return transient;
  if (finalPath === path) return { outcome: "live", to: null, status: first };

  const modulePaths = ctx.modulePaths instanceof Set ? ctx.modulePaths : new Set(ctx.modulePaths ?? []);
  const shape = shapeOf(finalPath, modulePaths);
  const moved = { outcome: "moved", to: finalPath, status: first };
  const landing = { outcome: "landing", to: finalPath, status: first };
  switch (kind) {
    case "study-guide":
      return { outcome: "gone", to: null, status: first };
    case "exam":
      if (shape === "certification") return { outcome: "live", to: null, status: first };
      return shape === "exam" ? moved : landing;
    case "module":
      return shape === "module" || finalPath.startsWith(`${path}/`) ? moved : landing;
    case "unit":
    case "learning-path":
    case "course":
    case "certification":
    case "applied-skill":
      return shape === kind ? moved : landing;
    default:
      return landing;
  }
}

// ---------------------------------------------------------------------------
// lifecycle
// ---------------------------------------------------------------------------

const CLASSIFIED = new Set(["gone", "landing", "retired", "moved"]);
/** A module entry with one of these outcomes covers (replaces) the entries of its units; `unverified` and `moved` do not. */
const COVERING_OUTCOMES = new Set(["gone", "landing", "retired"]);

/** results as a Map, from a Map, a { path: result } object or an array of { path, ...result }. */
function toResultMap(results) {
  if (results instanceof Map) return results;
  if (Array.isArray(results)) return new Map(results.filter((r) => r?.path).map((r) => [entryPath(r.path), r]));
  if (isObject(results)) return new Map(Object.entries(results).map(([path, r]) => [entryPath(path), r]));
  return new Map();
}

/** Valid candidates for `family`, deduplicated by path (the most authoritative evidence first), sorted. */
function cleanCandidates(candidates, family) {
  const found = collector();
  const valid = [];
  for (const raw of Array.isArray(candidates) ? candidates : []) {
    const path = entryPath(raw?.path);
    if (!path || !CHANGE_KINDS.includes(raw.kind) || familyOfKind(raw.kind) !== family || !CHANGE_EVIDENCE.includes(raw.evidence)) continue;
    valid.push({
      path,
      kind: raw.kind,
      parent: entryPath(raw.parent),
      title: textOrNull(raw.title),
      evidence: raw.evidence,
      firstSeen: isIsoDate(raw.firstSeen) ? raw.firstSeen : null,
    });
  }
  for (const candidate of sortCandidates(valid)) found.add(candidate);
  return found.done();
}

function withResult(entry, result, today) {
  const to = result.outcome === "gone" ? null : textOrNull(result.to) ? canonicalPath(result.to) : null;
  return {
    ...entry,
    outcome: result.outcome,
    to,
    status: Number.isInteger(result.status) ? result.status : null,
    lastVerified: today,
  };
}

function assertRunInput({ today, generatedAt, family }, who) {
  if (!isIsoDate(today)) throw new TypeError(`${who}: today must be YYYY-MM-DD, got ${JSON.stringify(today)}`);
  if (!isTimestamp(generatedAt)) throw new TypeError(`${who}: generatedAt must be an ISO timestamp, got ${JSON.stringify(generatedAt)}`);
  if (!CHANGE_FAMILIES.includes(family)) throw new TypeError(`${who}: family must be "learn" or "docs", got ${JSON.stringify(family)}`);
}

function assembleSet(base, entries, family, generatedAt) {
  const out = {};
  for (const file of FILE_NAMES) {
    out[file] = strictFile({ generatedAt, sources: { ...base[file].sources, [family]: generatedAt }, entries: entries[file] }, file);
  }
  return out;
}

/**
 * applyChanges() plus what it dropped: { changes, resurrected: [path], covered: [path] }
 * (`covered` = unit entries dropped because their module has a CLASSIFIED removed entry: gone, landing or
 * retired; an `unverified` module entry does not cover its units, see step 4).
 */
export function applyChangesDetailed(input = {}) {
  const { previous, candidates = [], results = new Map(), isLive = () => undefined, today, generatedAt, family = "learn" } = input;
  assertRunInput({ today, generatedAt, family }, "applyChanges");
  const base = normalizeSet(previous);
  const resultOf = toResultMap(results);
  const liveNow = (path) => isLive(path) === true || resultOf.get(path)?.outcome === "live";

  // entries of the OTHER family pass through untouched; ours are worked on by path
  const foreign = { removed: [], moved: [] };
  const mine = new Map();
  for (const file of FILE_NAMES) {
    for (const entry of base[file].entries) {
      if (entry.family !== family) foreign[file].push(entry);
      else mine.set(entry.path, mine.has(entry.path) ? preferEntry(mine.get(entry.path), entry) : entry);
    }
  }

  // 3. resurrect: the path is valid again (cache, or a live probe found it served on its own path)
  const resurrected = [];
  for (const path of [...mine.keys()]) {
    if (liveNow(path)) {
      mine.delete(path);
      resurrected.push(path);
    }
  }

  // 1. upsert candidates; a candidate nobody has classified yet is `unverified`
  for (const candidate of cleanCandidates(candidates, family)) {
    if (liveNow(candidate.path)) continue;
    const existing = mine.get(candidate.path);
    if (existing) {
      mine.set(candidate.path, { ...existing, title: existing.title ?? candidate.title, parent: existing.parent ?? candidate.parent });
      continue;
    }
    mine.set(candidate.path, {
      path: candidate.path,
      kind: candidate.kind,
      family,
      outcome: "unverified",
      to: null,
      title: candidate.title,
      parent: candidate.parent,
      firstSeen: candidate.firstSeen ?? today,
      lastVerified: null,
      evidence: candidate.evidence,
      status: null,
    });
  }

  // 2. live probe results: new classifications and re-verifications alike (a transient result changes nothing)
  for (const [path, entry] of mine) {
    const result = resultOf.get(path);
    if (result && CLASSIFIED.has(result.outcome)) mine.set(path, withResult(entry, result, today));
  }

  // 4. collapse: the units of a module whose removal is CLASSIFIED are covered by its entry. An `unverified` module entry
  //    covers nothing yet: it may be false (an API flap), and units dropped under it would never be re-derived (the unit
  //    detector only compares modules both catalogs have), so they stay until a probe or the caches settle the module.
  const removedModules = new Set([...mine.values()].filter((e) => e.kind === "module" && COVERING_OUTCOMES.has(e.outcome)).map((e) => e.path));
  const covered = [];
  for (const entry of [...mine.values()]) {
    if (entry.kind === "unit" && hasAncestorIn(entry.path, removedModules)) {
      mine.delete(entry.path);
      covered.push(entry.path);
    }
  }

  // an entry lives in the file of its outcome (it moves when the outcome changes)
  const entries = { removed: [...foreign.removed], moved: [...foreign.moved] };
  for (const entry of mine.values()) entries[entry.outcome === "moved" ? "moved" : "removed"].push(entry);
  return { changes: assembleSet(base, entries, family, generatedAt), resurrected: resurrected.sort(byCodePoint), covered: covered.sort(byCodePoint) };
}

/**
 * The next change set of one family (default "learn"). Pure, deterministic, idempotent
 * (applying the same input to its own output changes nothing).
 *
 *   previous    { removed, moved } as loaded (entries of the other family pass through untouched)
 *   candidates  detector output; a path that is already known is an upsert (firstSeen, evidence and
 *               title are kept), a new path with no result or a transient one becomes `unverified`
 *   results     Map<path, { outcome, to, status }> (classifyLearnProbe output; a plain object or an
 *               array of { path, ... } works too). gone/landing/retired/moved set the entry's outcome,
 *               to, status and lastVerified = today (the entry moves between the files when needed);
 *               transient changes nothing; live resurrects
 *   isLive      (path) => true | false | undefined. `true` resurrects an entry and suppresses a candidate
 *               (a tombstone path that a different live module occupies); anything else is "no opinion here"
 *   today       YYYY-MM-DD, generatedAt  ISO timestamp (file.generatedAt and sources[family])
 *
 * Steps (DATA_CONTRACT.md): resurrect, upsert, apply results, collapse the units of a classified removed module.
 * A moved entry whose destination was removed or moved again is NOT rewritten here; verificationQueue()
 * puts it in the next probe round and the new result carries the final destination.
 */
export function applyChanges(input) {
  return applyChangesDetailed(input).changes;
}

/**
 * Which entries of the learn family to live-probe, in the contract's priority order:
 *   1. `unverified` entries (oldest firstSeen first)
 *   2. `moved` entries whose destination was itself removed or moved again (a ledger entry, or a module
 *      entry covering it), or that `isLive(to) === false` says no longer exists
 *   3. everything else by oldest lastVerified (never verified first), at most `reverifyLimit`,
 *      skipping entries already verified `today`
 * `exclude` (Set of paths) leaves out what a probe round already handled. At most `limit` entries.
 * The unit entries of a module whose own entry is still `unverified` wait (in no tier, rotation included):
 * the module's result decides whether they are covered by it (a probe of each would be wasted) or stand
 * on their own (a later round probes them), and an excluded (already probed) module still counts as pending.
 * Returns { queue: [{ path, kind, reason: "unverified" | "collapse" | "reverify" }], truncated, wanted }
 * where `wanted` is how many the rules asked for and `truncated` whether `limit` cut that short.
 */
export function planVerification(changes, { today = null, limit = CHANGES_MAX_PROBES, reverifyLimit = CHANGES_REVERIFY_PER_RUN, isLive = null, exclude = null } = {}) {
  const set = normalizeSet(changes);
  const all = [...set.removed.entries, ...set.moved.entries];
  const pendingModules = new Set(all.filter((e) => e.family === "learn" && e.kind === "module" && e.outcome === "unverified").map((e) => e.path));
  const waiting = (e) => e.kind === "unit" && pendingModules.size > 0 && hasAncestorIn(e.path, pendingModules);
  const mine = all.filter((e) => e.family === "learn" && !exclude?.has(e.path) && !waiting(e));
  const index = indexChanges(set);

  const unverified = mine.filter((e) => e.outcome === "unverified").sort((a, b) => byCodePoint(a.firstSeen, b.firstSeen) || byCodePoint(a.path, b.path));
  const taken = new Set(unverified.map((e) => e.path));
  const collapse = mine
    .filter((e) => e.outcome === "moved" && e.to && !taken.has(e.path) && (lookupChange(e.to, index) !== null || (typeof isLive === "function" && isLive(e.to) === false)))
    .sort((a, b) => byCodePoint(a.path, b.path));
  for (const entry of collapse) taken.add(entry.path);
  const rest = mine
    .filter((e) => !taken.has(e.path) && (today === null || e.lastVerified !== today))
    .sort((a, b) => byCodePoint(a.lastVerified ?? "", b.lastVerified ?? "") || byCodePoint(a.path, b.path))
    .slice(0, Math.max(0, reverifyLimit));

  const wanted = [
    ...unverified.map((e) => ({ path: e.path, kind: e.kind, reason: "unverified" })),
    ...collapse.map((e) => ({ path: e.path, kind: e.kind, reason: "collapse" })),
    ...rest.map((e) => ({ path: e.path, kind: e.kind, reason: "reverify" })),
  ];
  const cap = Math.max(0, limit);
  return { queue: wanted.slice(0, cap), truncated: wanted.length > cap, wanted: wanted.length };
}

/** planVerification().queue: the probes to run, in priority order. */
export function verificationQueue(changes, options = {}) {
  return planVerification(changes, options).queue;
}

/** Runs the queue through `probe` with at most `workers` workers (never above 3) and `delayMs` per worker between probes. */
async function runProbeQueue(queue, { probe, ctx, workers, delayMs, sleepImpl, consecutiveTransientLimit, results }) {
  const state = { next: 0, consecutive: 0, stopped: false, probed: 0, transient: 0 };
  async function worker() {
    for (;;) {
      if (state.stopped) return;
      const item = queue[state.next++];
      if (!item) return;
      let raw;
      try {
        raw = await probe(item.path);
      } catch (err) {
        raw = { status: null, error: String(err?.message || err) };
      }
      const verdict = classifyLearnProbe(item.kind, item.path, raw, ctx);
      results.set(item.path, verdict);
      state.probed++;
      if (verdict.outcome === "transient") {
        state.transient++;
        state.consecutive++;
        // "stopped" means probes were left unstarted: a storm that ends with the last probe stopped nothing
        if (consecutiveTransientLimit > 0 && state.consecutive >= consecutiveTransientLimit && state.next < queue.length) state.stopped = true;
      } else {
        state.consecutive = 0;
      }
      if (!state.stopped && state.next < queue.length) await sleepImpl(delayMs);
    }
  }
  const count = Math.max(1, Math.min(workers, MAX_CONCURRENCY, queue.length));
  await Promise.all(Array.from({ length: count }, worker));
  return state;
}

/**
 * One Learn run's worth of change tracking: stage the candidates, live-probe the
 * verification queue (budget `limits.maxProbes`), apply the results. Rounds repeat
 * (up to CHANGES_MAX_ROUNDS) while a result created new work, for example the units
 * of a module that turned out to be moved rather than removed.
 *
 *   previous, candidates, isLive, today, generatedAt   as applyChanges()
 *   probe        async (path) => raw probe result (live-probe.mjs `rawProbe`); classified here with
 *                classifyLearnProbe(kind, path, raw, ctx). A probe that throws counts as transient.
 *   limits       { maxProbes, reverifyPerRun } (defaults CHANGES_MAX_PROBES / CHANGES_REVERIFY_PER_RUN;
 *                see readChangesLimits)
 *   workers      at most 3 (clamped); delayMs  pause per worker between probes (default 1000 ms; the
 *                contract's floor is 500 ms, tests pass 0); sleepImpl injectable
 *   ctx          { modulePaths } for classifyLearnProbe
 *   consecutiveTransientLimit  stop probing after this many transient results in a row (0 = never)
 *
 * Returns { changes, stats: { newRemoved, newMoved, resurrected, unverified, probed, probeBudgetExhausted,
 * transient, stoppedEarly, covered } }. newRemoved/newMoved count learn entries that are in that file now
 * and were not before (an entry that switched files counts in the new one); unverified is the number of
 * unverified learn entries left; probeBudgetExhausted is true when the rules wanted more probes than the
 * budget allowed. Learn entries only: the docs family is replaced by replaceFamily().
 */
export async function refreshLearnChanges(input = {}) {
  const {
    previous,
    candidates = [],
    isLive = () => undefined,
    probe,
    today,
    generatedAt,
    limits = {},
    workers = CHANGES_MAX_WORKERS,
    delayMs = CHANGES_PROBE_DELAY_MS,
    ctx = {},
    sleepImpl = sleep,
    consecutiveTransientLimit = CHANGES_CONSECUTIVE_TRANSIENT_LIMIT,
    maxRounds = CHANGES_MAX_ROUNDS,
  } = input;
  assertRunInput({ today, generatedAt, family: "learn" }, "refreshLearnChanges");
  const maxProbes = Number.isInteger(limits.maxProbes) ? limits.maxProbes : CHANGES_MAX_PROBES;
  const reverifyPerRun = Number.isInteger(limits.reverifyPerRun) ? limits.reverifyPerRun : CHANGES_REVERIFY_PER_RUN;

  const base = normalizeSet(previous);
  const results = new Map();
  const probedPaths = new Set();
  const apply = () => applyChangesDetailed({ previous: base, candidates, results, isLive, today, generatedAt, family: "learn" });
  let detail = apply();
  let probed = 0;
  let transient = 0;
  let stoppedEarly = false;
  let exhausted = false;

  for (let round = 0; round < maxRounds && !stoppedEarly; round++) {
    const plan = planVerification(detail.changes, {
      today,
      limit: maxProbes - probed,
      reverifyLimit: round === 0 ? reverifyPerRun : 0,
      isLive,
      exclude: probedPaths,
    });
    if (plan.truncated) exhausted = true;
    if (!plan.queue.length) break;
    if (typeof probe !== "function") throw new TypeError("refreshLearnChanges: probe must be a function when there is something to probe");
    const state = await runProbeQueue(plan.queue, { probe, ctx, workers, delayMs, sleepImpl, consecutiveTransientLimit, results });
    for (const item of plan.queue) if (results.has(item.path)) probedPaths.add(item.path);
    probed += state.probed;
    transient += state.transient;
    if (state.stopped) stoppedEarly = true;
    detail = apply();
  }

  const mineOf = (changes, file) => changes[file].entries.filter((e) => e.family === "learn");
  const before = { removed: new Set(mineOf(base, "removed").map((e) => e.path)), moved: new Set(mineOf(base, "moved").map((e) => e.path)) };
  const after = { removed: mineOf(detail.changes, "removed"), moved: mineOf(detail.changes, "moved") };
  return {
    changes: detail.changes,
    stats: {
      newRemoved: after.removed.filter((e) => !before.removed.has(e.path)).length,
      newMoved: after.moved.filter((e) => !before.moved.has(e.path)).length,
      resurrected: detail.resurrected.length,
      unverified: after.removed.filter((e) => e.outcome === "unverified").length,
      probed,
      probeBudgetExhausted: exhausted,
      transient,
      stoppedEarly,
      covered: detail.covered.length,
    },
  };
}

// ---------------------------------------------------------------------------
// docs family
// ---------------------------------------------------------------------------

/**
 * The docs family's entries, derived from the sync's own ledgers (no probing here):
 *   redirects  docs-redirects.json rows { from, to, kind, status, firstSeen, lastSeen }
 *              moved -> outcome moved; landing / retired -> that outcome with `to`; evidence "docs-redirect",
 *              lastVerified = lastSeen
 *   invalid    docs-catalog-invalid.json rows { url, title, status, firstDetected, lastChecked }
 *              -> outcome gone, evidence "quarantine", lastVerified = lastChecked
 * One entry per path (when both ledgers hold a path, the more recently verified wins, removed wins a tie).
 * Returns entries sorted by path; hand them to replaceFamily(changes, "docs", entries, generatedAt).
 */
export function docsChanges({ redirects = [], invalid = [], today } = {}) {
  if (!isIsoDate(today)) throw new TypeError(`docsChanges: today must be YYYY-MM-DD, got ${JSON.stringify(today)}`);
  const byPath = new Map();
  const put = (entry) => {
    const old = byPath.get(entry.path);
    if (!old) return byPath.set(entry.path, entry);
    const [ov, nv] = [old.lastVerified ?? "", entry.lastVerified ?? ""];
    const winner = ov !== nv ? (ov > nv ? old : entry) : old.outcome !== "moved" ? old : entry;
    byPath.set(entry.path, { ...winner, firstSeen: old.firstSeen < entry.firstSeen ? old.firstSeen : entry.firstSeen });
  };
  for (const row of normalizeLedger(redirects)) {
    put({
      path: row.from,
      kind: "docs",
      family: "docs",
      outcome: row.kind,
      to: row.to,
      title: null,
      parent: null,
      firstSeen: isIsoDate(row.firstSeen) ? row.firstSeen : today,
      lastVerified: isIsoDate(row.lastSeen) ? row.lastSeen : null,
      evidence: "docs-redirect",
      status: row.status,
    });
  }
  for (const row of Array.isArray(invalid) ? invalid : []) {
    const path = isObject(row) ? entryPath(row.url ?? row.path) : null;
    if (!path) continue;
    put({
      path,
      kind: "docs",
      family: "docs",
      outcome: "gone",
      to: null,
      title: textOrNull(row.title),
      parent: null,
      firstSeen: isIsoDate(row.firstDetected) ? row.firstDetected : today,
      lastVerified: isIsoDate(row.lastChecked) ? row.lastChecked : null,
      evidence: "quarantine",
      status: Number.isInteger(row.status) ? row.status : null,
    });
  }
  return [...byPath.values()].sort((a, b) => byCodePoint(a.path, b.path));
}

/**
 * Replaces every entry of `family` with `entries` (each routed to the file of its outcome) and stamps
 * sources[family] and generatedAt with `generatedAt`. The other family's entries are untouched.
 * Entries of a different family, or malformed ones, throw: that is a bug of the caller.
 */
export function replaceFamily(changes, family, entries, generatedAt) {
  assertRunInput({ today: "2000-01-01", generatedAt, family }, "replaceFamily");
  const base = normalizeSet(changes);
  const next = { removed: [], moved: [] };
  for (const file of FILE_NAMES) next[file] = base[file].entries.filter((e) => e.family !== family);
  const fresh = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!isObject(entry) || (entry.family ?? familyOfKind(entry.kind)) !== family) {
      throw new TypeError(`replaceFamily: entry ${JSON.stringify(entry)?.slice(0, 100)} does not belong to family ${family}`);
    }
    const file = entry.outcome === "moved" ? "moved" : "removed";
    const clean = normalizeChangeEntry(entry, file);
    if (!clean) throw new TypeError(`replaceFamily: malformed entry ${JSON.stringify(entry)?.slice(0, 100)}`);
    const old = fresh.get(clean.path);
    fresh.set(clean.path, old ? preferEntry(old, clean) : clean);
  }
  for (const entry of fresh.values()) next[entry.outcome === "moved" ? "moved" : "removed"].push(entry);
  return assembleSet(base, next, family, generatedAt);
}

// ---------------------------------------------------------------------------
// consumers
// ---------------------------------------------------------------------------

/** Lookup structure over a change set: exact path -> { file, entry }, plus the module entries for ancestor lookups. */
export function indexChanges(changes) {
  const set = normalizeSet(changes);
  const byPath = new Map();
  const modules = new Map();
  for (const file of FILE_NAMES) {
    for (const entry of set[file].entries) {
      const hit = { file, entry };
      const old = byPath.get(entry.path);
      if (!old || (entry.lastVerified ?? "") > (old.entry.lastVerified ?? "")) byPath.set(entry.path, hit);
      if (entry.kind === "module") modules.set(entry.path, byPath.get(entry.path));
    }
  }
  return { byPath, modules, generatedAt: set.removed.generatedAt ?? set.moved.generatedAt, sources: set.removed.sources };
}

function resolveOne(path, index) {
  const exact = index.byPath.get(path);
  if (exact) return { ...exact, match: "exact", remainder: "" };
  for (let ancestor = parentPath(path); ancestor; ancestor = parentPath(ancestor)) {
    const hit = index.modules.get(ancestor);
    if (hit) return { ...hit, match: "ancestor", remainder: path.slice(ancestor.length) };
  }
  return null;
}

/**
 * What the change files say about one link (a canonical path or a Learn URL), or null when no change
 * is recorded (which is NOT "valid", see DATA_CONTRACT.md).
 *
 * Rules: an exact match wins; otherwise an ancestor entry of kind "module" covers the path (a unit of a
 * removed module is removed, a unit of a moved module probably moved to the same remainder under `to`,
 * reported with confidence "low"); docs and every other kind never inherit. A moved destination is
 * followed through the ledger, at most 5 hops, cycle safe; a chain that ends in a removed entry means
 * the link counts as removed.
 *
 * Returns { state: "removed" | "moved", outcome, confidence: "high" | "low", match: "exact" | "ancestor",
 * entry, final, to, chain, cycle, truncated, reason }
 *   outcome   outcome of the entry that decided the state (`final`); for a removed state gone, landing,
 *             retired or unverified; "moved" for a moved state
 *   entry     the entry the path matched first; final  the entry that decided (the same unless a moved
 *             destination was followed)
 *   to        moved: the destination after following the ledger (null = off-site); removed: the landing
 *             page of an exact match, else null
 *   chain     [path, destination, destination, ...] as followed
 *   confidence "low" for an inherited move, an unverified entry, a cycle and a truncated chain
 */
export function lookupChange(input, index) {
  const path = entryPath(input);
  if (!path || !index?.byPath) return null;
  let current = resolveOne(path, index);
  if (!current) return null;
  const first = current;
  const chain = [path];
  const seen = new Set([path]);
  let confidence = "high";
  let hops = 0;
  for (;;) {
    const { file, entry, match, remainder } = current;
    if (entry.outcome === "unverified" || (match === "ancestor" && file === "moved")) confidence = "low";
    const result = (state, extra) => ({
      state,
      outcome: entry.outcome,
      confidence,
      match: first.match,
      entry: first.entry,
      final: entry,
      chain,
      cycle: false,
      truncated: false,
      ...extra,
    });
    if (file === "removed") {
      const destination = chain[chain.length - 1];
      const owner = match === "ancestor" ? ` (its module ${entry.path})` : "";
      const reason = hops ? `moved to ${destination}, which was removed${owner}` : match === "ancestor" ? `its module ${entry.path} was removed` : `${path} was removed`;
      return result("removed", { to: match === "exact" ? entry.to : null, reason: `${reason} [${entry.outcome}]` });
    }
    if (!entry.to) return result("moved", { to: null, reason: `${entry.path} moved off-site` });
    const destination = `${entry.to}${remainder}`;
    if (seen.has(destination)) {
      return result("moved", { to: destination, confidence: "low", cycle: true, reason: `redirect cycle through ${destination}` });
    }
    if (hops >= CHANGES_LOOKUP_MAX_HOPS) {
      return result("moved", { to: chain[chain.length - 1], confidence: "low", truncated: true, reason: `more than ${CHANGES_LOOKUP_MAX_HOPS} redirects, stopped at ${chain[chain.length - 1]}` });
    }
    hops++;
    chain.push(destination);
    seen.add(destination);
    const next = resolveOne(destination, index);
    if (!next) {
      const inherited = match === "ancestor" ? ` (its module ${entry.path} moved to ${entry.to})` : "";
      return result("moved", { to: destination, reason: `moved to ${destination}${inherited}` });
    }
    current = next;
  }
}

/**
 * Every entry (both files, as plain entries) first seen on or after `since` (YYYY-MM-DD), oldest first,
 * then by path. For an automation that asks "what changed since I last looked".
 */
export function changesSince(changes, since) {
  if (!isIsoDate(since)) throw new RangeError(`changesSince: since must be YYYY-MM-DD, got ${JSON.stringify(since)}`);
  const set = normalizeSet(changes);
  return [...set.removed.entries, ...set.moved.entries]
    .filter((entry) => entry.firstSeen >= since)
    .sort((a, b) => byCodePoint(a.firstSeen, b.firstSeen) || byCodePoint(a.path, b.path));
}

/**
 * Counts of a change set: { generatedAt, sources, total, files: { removed, moved },
 * byOutcome: { gone, landing, retired, unverified, moved }, byKind: { <kind>: { removed, moved } },
 * byFamily: { learn: { removed, moved }, docs: { removed, moved } } }. Every key is always present.
 */
export function summarizeChanges(changes) {
  const set = normalizeSet(changes);
  const pair = () => ({ removed: 0, moved: 0 });
  const summary = {
    generatedAt: set.removed.generatedAt ?? set.moved.generatedAt,
    sources: { ...set.removed.sources },
    total: 0,
    files: pair(),
    byOutcome: Object.fromEntries([...REMOVED_OUTCOMES, ...MOVED_OUTCOMES].map((outcome) => [outcome, 0])),
    byKind: Object.fromEntries(CHANGE_KINDS.map((kind) => [kind, pair()])),
    byFamily: Object.fromEntries(CHANGE_FAMILIES.map((family) => [family, pair()])),
  };
  for (const file of FILE_NAMES) {
    for (const entry of set[file].entries) {
      summary.total++;
      summary.files[file]++;
      summary.byOutcome[entry.outcome]++;
      summary.byKind[entry.kind][file]++;
      summary.byFamily[entry.family][file]++;
    }
  }
  return summary;
}
