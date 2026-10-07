import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ChangesFileError, loadChanges, normalizeChangeFile, writeChanges } from "../scripts/lib/changes.mjs";
import {
  DEFAULT_HISTORY_FILE,
  assembleCandidates,
  compactSnapshot,
  createHistoryTracker,
  formatSeedReport,
  listHistory,
  parseHistorySpec,
  runSeed,
  urlCandidates,
} from "../scripts/lib/seed-changes.mjs";
import { loadData } from "../scripts/lib/validate.mjs";
import { parseArgs } from "../scripts/seed-changes.mjs";

const TODAY = "2026-10-06";
const NOW = new Date("2026-10-06T08:00:00.000Z");
const OLD_STAMP = "2026-09-29T08:00:00.000Z";
const CLI = fileURLToPath(new URL("../scripts/seed-changes.mjs", import.meta.url));
const HUB_FILE = "src/data_files/learn-catalog.json";

// ---------------------------------------------------------------------------
// fixtures: catalogs (v1 and v2 shapes), a temp git history, a data directory, probe answers
// ---------------------------------------------------------------------------

const modUrl = (slug) => `https://learn.microsoft.com/training/modules/${slug}/?WT.mc_id=studentamb_165290`;
/** v1 record: only `url`, no `path`, no unitUrls. */
const v1 = (slug) => ({ uid: `learn.${slug}`, title: `Title ${slug}`, url: modUrl(slug), categories: [], products: [], subjects: [], units: ["Unit"] });
/** v2 record: canonical `path`, real `unitUrls` (or null). */
const v2 = (slug, unitSlugs = null, unitTitles = null) => ({
  uid: `learn.${slug}`,
  title: `Title ${slug}`,
  url: modUrl(slug),
  path: `/training/modules/${slug}`,
  units: unitTitles ?? (unitSlugs ?? []).map((u) => `Unit ${u}`),
  unitUrls: unitSlugs ? unitSlugs.map((u) => `/training/modules/${slug}/${u}`) : null,
});
const catalogV1 = (lastChecked, modules) => ({ lastChecked, sourceApi: "x", totalModules: modules.length, modules });
const catalogV2 = (lastChecked, modules, over = {}) => ({ schemaVersion: 2, lastChecked, totalModules: modules.length, modules, removed: [], outOfScope: [], ...over });

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "seed-repo-"));
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
  return dir;
}
/** Commit `content` (an object or raw text) at `file` with the given commit date; null deletes the file. */
function commitFile(repo, file, content, iso) {
  const env = { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  const run = (...args) => {
    const r = spawnSync("git", args, { cwd: repo, encoding: "utf-8", env });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  };
  if (content === null) run("rm", "-q", file);
  else {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
    run("add", file);
  }
  run("commit", "-q", "-m", `snapshot ${iso}`);
}

// The timeline both repos share (the old hub repo and the extracted one), interleaved by date:
//   S1 2026-01-05 hub   a b c r d        S3 2026-03-02 hub   a d r e
//   S2 2026-02-02 sync  a b d            S4 2026-04-06 sync  a(v2 units) e      current 2026-10-05: a(02-old -> 02-new) e f
const CURRENT = catalogV2("2026-10-05T19:04:00.000Z", [v2("a", ["01-intro", "02-new", "03-quiz"]), v2("e"), v2("f")]);
let repos = null;
function fixtureRepos() {
  if (repos) return repos;
  const hub = makeRepo();
  const sync = makeRepo();
  commitFile(hub, HUB_FILE, catalogV1("2026-01-05T06:00:00.000Z", [v1("a"), v1("b"), v1("c"), v1("r"), v1("d")]), "2026-01-05T06:30:00Z");
  commitFile(sync, DEFAULT_HISTORY_FILE, catalogV1("2026-02-02T06:00:00.000Z", [v1("a"), v1("b"), v1("d")]), "2026-02-02T06:30:00Z");
  commitFile(hub, HUB_FILE, catalogV1("2026-03-02T06:00:00.000Z", [v1("a"), v1("d"), v1("r"), v1("e")]), "2026-03-02T06:30:00Z");
  commitFile(
    sync,
    DEFAULT_HISTORY_FILE,
    catalogV2("2026-04-06T06:00:00.000Z", [v2("a", ["01-intro", "02-old", "03-quiz"], ["Intro", "Old", "Quiz"]), v2("e")]),
    "2026-04-06T06:30:00Z"
  );
  repos = { hub, sync, specs: [`${hub}::${HUB_FILE}`, sync] };
  return repos;
}

const E = (path, over = {}) => ({
  path,
  kind: "module",
  family: "learn",
  outcome: "gone",
  to: null,
  title: null,
  parent: null,
  firstSeen: "2026-09-01",
  lastVerified: "2026-09-01",
  evidence: "tombstone",
  status: 404,
  ...over,
});
const changesOf = (removed = [], moved = []) => ({
  removed: normalizeChangeFile({ generatedAt: OLD_STAMP, sources: { learn: OLD_STAMP, docs: "2026-09-29T09:00:00.000Z" }, entries: removed }, "removed"),
  moved: normalizeChangeFile({ generatedAt: OLD_STAMP, sources: { learn: OLD_STAMP, docs: "2026-09-29T09:00:00.000Z" }, entries: moved }, "moved"),
});

function makeData({ catalog = CURRENT, content = null, changes = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "seed-data-"));
  writeFileSync(join(dir, "learn-catalog.json"), JSON.stringify(catalog));
  if (content) writeFileSync(join(dir, "learn-content.json"), JSON.stringify(content));
  if (changes) writeChanges(dir, changes);
  return dir;
}
const CONTENT = {
  schemaVersion: 1,
  lastChecked: "2026-10-05T19:00:00.000Z",
  learningPaths: [{ uid: "p", title: "P", path: "/training/paths/p" }],
  courses: [],
  certifications: [],
  exams: [],
  appliedSkills: [],
  studyGuides: [],
  removed: [],
};

const served = (finalPath, { first = 200, title = "A page" } = {}) => ({
  status: 200,
  firstStatus: first,
  finalUrl: `https://learn.microsoft.com/en-us${finalPath}/`,
  title,
  hops: [],
  offsite: false,
  error: null,
});
const NOT_FOUND = { status: 404, firstStatus: 404, finalUrl: "https://learn.microsoft.com/en-us/x/", title: "404", hops: [], offsite: false, error: null };
const BLOCKED = { status: null, firstStatus: null, finalUrl: null, title: "", hops: [], offsite: false, error: "no response after retries" };
const stubProbe = (byPath, calls = []) => async (path) => {
  calls.push(path);
  return byPath[path] ?? BLOCKED;
};
/** What a live Learn would answer for the history fixture. */
const HISTORY_ANSWERS = {
  "/training/modules/c": NOT_FOUND,
  "/training/modules/b": served("/training/modules/e", { first: 301 }),
  "/training/modules/d": served("/training/paths/p", { first: 301 }),
  "/training/modules/r": served("/training/modules/r"),
  "/training/modules/a/02-old": served("/training/modules/a/02-new", { first: 301 }),
};

function run(dataDir, over = {}) {
  const { specs } = fixtureRepos();
  return runSeed({
    dataDir,
    histories: specs,
    now: NOW,
    today: TODAY,
    minModules: 1,
    delayMs: 0,
    sleepImpl: async () => {},
    workers: 1,
    log: () => {},
    warn: () => {},
    ...over,
  });
}
const byPath = (file) => Object.fromEntries(file.entries.map((e) => [e.path, e]));
const paths = (file) => file.entries.map((e) => e.path);
const bytes = (dir, name) => readFileSync(join(dir, "changes", name), "utf-8");

// ---------------------------------------------------------------------------
// --history spec
// ---------------------------------------------------------------------------

test("parseHistorySpec: the file defaults to data/learn-catalog.json and Windows paths survive", () => {
  assert.deepEqual(parseHistorySpec("../hub"), { repoDir: "../hub", file: "data/learn-catalog.json" });
  assert.deepEqual(parseHistorySpec("../hub::src/data_files/learn-catalog.json"), { repoDir: "../hub", file: "src/data_files/learn-catalog.json" });
  assert.deepEqual(parseHistorySpec("C:\\work\\hub::src\\data_files\\learn-catalog.json"), { repoDir: "C:\\work\\hub", file: "src/data_files/learn-catalog.json" });
  assert.deepEqual(parseHistorySpec("C:\\work\\hub::./data/x.json"), { repoDir: "C:\\work\\hub", file: "data/x.json" });
  assert.deepEqual(parseHistorySpec("repo::"), { repoDir: "repo", file: DEFAULT_HISTORY_FILE });
  for (const bad of ["", "   ", "::file.json", undefined, 5]) assert.throws(() => parseHistorySpec(bad), /--history/);
});

// ---------------------------------------------------------------------------
// snapshots and the tracker
// ---------------------------------------------------------------------------

test("compactSnapshot reads v1 (url only) and v2, keeps unit data only where real unitUrls exist, and rejects non-catalogs", () => {
  const old = compactSnapshot(catalogV1("2026-01-05T06:00:00.000Z", [v1("a")]));
  assert.deepEqual(old, { lastChecked: "2026-01-05T06:00:00.000Z", modules: [{ uid: "learn.a", title: "Title a", path: "/training/modules/a" }], outOfScope: [] });
  const current = compactSnapshot(
    catalogV2("2026-04-06T06:00:00.000Z", [v2("a", ["01-x"]), v2("e"), { ...v2("h"), hierarchyNotFound: true }], { outOfScope: ["/training/modules/Out"] })
  );
  assert.deepEqual(current.modules[0].unitUrls, ["/training/modules/a/01-x"]);
  assert.deepEqual(current.modules[0].units, ["Unit 01-x"]);
  assert.equal("unitUrls" in current.modules[1], false);
  assert.equal(current.modules[2].hierarchyNotFound, true);
  assert.deepEqual(current.outOfScope, ["/training/modules/out"]);
  // a saas module keeps its real path; an unusable record is skipped
  const odd = compactSnapshot({ modules: [{ uid: "s", url: "https://learn.microsoft.com/training/saas/x/" }, { uid: "z" }, null] }, "2026-02-02T00:00:00Z");
  assert.deepEqual(odd.modules.map((m) => m.path), ["/training/saas/x"]);
  assert.equal(odd.lastChecked, "2026-02-02T00:00:00Z");
  assert.equal(compactSnapshot({ modules: [] }).lastChecked, null);
  for (const bad of [null, [], "x", {}, { modules: "no" }]) assert.equal(compactSnapshot(bad), null);
});

test("history tracker: firstSeen is the first snapshot that lacks the path after its last sighting", () => {
  const tracker = createHistoryTracker();
  const snap = (date, slugs, extra = {}) => ({ lastChecked: `${date}T06:00:00.000Z`, modules: slugs.map((s) => ({ uid: s, title: `T ${s}`, path: `/training/modules/${s}` })), outOfScope: [], ...extra });
  tracker.add(snap("2026-01-05", ["a", "b", "c", "r"]));
  tracker.add(snap("2026-02-02", ["a", "b"]));
  tracker.add(snap("2026-03-02", ["a", "r", "e"]));
  tracker.add(snap("2026-04-06", ["a", "e"], { outOfScope: ["/training/modules/b", "/training/modules/x"] })); // b and x exist, outside the cached categories
  tracker.add(snap("2026-10-05", ["a", "e"], { outOfScope: ["/training/modules/b"] })); // the current catalog is the last snapshot
  const found = tracker.candidates();
  assert.deepEqual(
    found.map((c) => [c.path, c.firstSeen]),
    [
      ["/training/modules/c", "2026-02-02"],
      ["/training/modules/r", "2026-04-06"], // came back in S3, gone in S4: the LAST loss counts
      ["/training/modules/x", "2026-10-05"], // out of scope in S4 (so it existed), in nothing now; b is still out of scope
    ]
  );
  assert.ok(found.every((c) => c.kind === "module" && c.evidence === "history"));
  assert.equal(found[0].title, "T c");
  assert.equal(found[2].title, null, "an out-of-scope path carries no title");
  assert.deepEqual(tracker.dates, ["2026-01-05", "2026-02-02", "2026-03-02", "2026-04-06", "2026-10-05"]);
  assert.throws(() => tracker.add({ lastChecked: null, modules: [] }), /lastChecked/);
});

test("history tracker: a path that is in the last snapshot is never a candidate, and a lone snapshot yields nothing", () => {
  const tracker = createHistoryTracker();
  tracker.add({ lastChecked: "2026-10-05T00:00:00Z", modules: [{ uid: "a", title: null, path: "/training/modules/a" }], outOfScope: [] });
  assert.deepEqual(tracker.candidates(), []);
});

test("history tracker: units come from consecutive snapshots with the sync's trust rules", () => {
  const tracker = createHistoryTracker();
  const mod = (slug, units) => ({ uid: slug, title: slug, path: `/training/modules/${slug}`, unitUrls: units.map((u) => `/training/modules/${slug}/${u}`), units: units.map((u) => `T ${u}`) });
  const snap = (date, modules) => ({ lastChecked: `${date}T06:00:00.000Z`, modules, outOfScope: [] });
  tracker.add(snap("2026-01-05", [mod("a", ["01-x", "02-y", "03-z"]), mod("big", ["1", "2", "3", "4"]), mod("flip", ["1", "2"])]));
  // `big` came back with less than half of its units (a truncated hierarchy): no evidence; `flip` loses 2 ...
  tracker.add(snap("2026-02-02", [mod("a", ["01-x", "02-y2", "03-z"]), mod("big", ["1"]), mod("flip", ["1"])]));
  // ... which returns, then goes away again
  tracker.add(snap("2026-03-02", [mod("a", ["01-x", "02-y2", "03-z"]), mod("big", ["1"]), mod("flip", ["1", "2"])]));
  tracker.add(snap("2026-04-06", [mod("a", ["01-x", "02-y2", "03-z"]), mod("big", ["1"]), mod("flip", ["1"])]));
  const units = tracker.candidates().filter((c) => c.kind === "unit");
  assert.deepEqual(
    units.map((c) => [c.path, c.parent, c.title, c.firstSeen, c.evidence]),
    [
      ["/training/modules/a/02-y", "/training/modules/a", "T 02-y", "2026-02-02", "history"],
      ["/training/modules/flip/2", "/training/modules/flip", "T 2", "2026-04-06", "history"],
    ]
  );
});

// ---------------------------------------------------------------------------
// git: a real temp repository
// ---------------------------------------------------------------------------

test("listHistory merges the commits of several repos and files oldest first", () => {
  const { specs } = fixtureRepos();
  const found = listHistory(specs.map(parseHistorySpec), { warn: () => {} });
  assert.deepEqual(
    found.map((c) => [c.spec.file, c.commitIso.slice(0, 10)]),
    [
      [HUB_FILE, "2026-01-05"],
      [DEFAULT_HISTORY_FILE, "2026-02-02"],
      [HUB_FILE, "2026-03-02"],
      [DEFAULT_HISTORY_FILE, "2026-04-06"],
    ]
  );
});

test("listHistory: a directory that is not a repository throws, a wrong path and a shallow clone only warn", () => {
  const notRepo = mkdtempSync(join(tmpdir(), "seed-nogit-"));
  assert.throws(() => listHistory([parseHistorySpec(notRepo)]), /cannot read the git history/);
  const warnings = [];
  const { sync } = fixtureRepos();
  assert.deepEqual(listHistory([parseHistorySpec(`${sync}::data/nope.json`)], { warn: (m) => warnings.push(m) }), []);
  assert.match(warnings.join("\n"), /wrong path/);
  const git2 = (dir, args) => (args[0] === "log" ? `${"a".repeat(40)}\t2026-01-01T00:00:00Z\n` : "true\n");
  warnings.length = 0;
  assert.equal(listHistory([parseHistorySpec("x")], { git: git2, warn: (m) => warnings.push(m) }).length, 1);
  assert.match(warnings.join("\n"), /shallow clone/);
});

// ---------------------------------------------------------------------------
// the URL list
// ---------------------------------------------------------------------------

const URL_LIST = [
  "https://learn.microsoft.com/en-us/training/modules/ghost?WT.mc_id=x", // module nobody has: broken
  "https://learn.microsoft.com/training/modules/ghost/", // duplicate of the above
  "https://learn.microsoft.com/training/modules/a/09-nothere", // unit not in the real unitUrls: broken
  "https://learn.microsoft.com/training/modules/a/01-intro", // valid
  "/training/modules/a", // valid, given as a path
  "https://learn.microsoft.com/credentials/certifications/exams/az-104", // the cache cannot know
  "https://learn.microsoft.com/credentials/certifications/resources/study-guides/az-104", // the cache cannot know
  "https://learn.microsoft.com/training/paths/p", // valid
  "https://learn.microsoft.com/training/paths/gone-path", // broken
  "https://learn.microsoft.com/azure/key-vault/overview", // docs: the docs sync's, not ours
  "https://learn.microsoft.com/shows/azure-friday", // no cache covers it
  "https://example.com/x",
  { url: "https://learn.microsoft.com/training/courses/ghost-course" },
  { nope: 1 },
  "",
];

test("urlCandidates: broken and unverifiable verdicts of covered kinds become live-probe candidates; the rest is only counted", () => {
  const dir = makeData({ content: CONTENT });
  const { candidates, stats } = urlCandidates(URL_LIST, loadData(dir), { today: TODAY });
  assert.deepEqual(
    candidates.map((c) => [c.path, c.kind, c.tier, c.parent]),
    [
      ["/credentials/certifications/exams/az-104", "exam", "unverifiable", null],
      ["/credentials/certifications/resources/study-guides/az-104", "study-guide", "unverifiable", null],
      ["/training/courses/ghost-course", "course", "broken", null],
      ["/training/modules/a/09-nothere", "unit", "broken", "/training/modules/a"],
      ["/training/modules/ghost", "module", "broken", null],
      ["/training/paths/gone-path", "learning-path", "broken", null],
    ]
  );
  assert.ok(candidates.every((c) => c.evidence === "live-probe" && c.firstSeen === TODAY && c.title === null));
  assert.deepEqual(stats, { given: 15, invalid: 2, nonLearn: 1, duplicates: 1, valid: 3, docs: 1, other: 1, broken: 4, unverifiable: 2 });
});

test("assembleCandidates: one candidate per path, the most authoritative source wins, known and valid paths are not candidates", () => {
  const c = (path, evidence, extra = {}) => ({ path, kind: "module", title: null, evidence, firstSeen: "2026-01-01", ...extra });
  const { candidates, stats } = assembleCandidates({
    cache: [c("/training/modules/t", "tombstone")],
    historyModules: [c("/training/modules/t", "history"), c("/training/modules/h", "history"), c("/training/modules/known", "history"), c("/training/modules/live", "history")],
    historyUnits: [c("/training/modules/h/1", "history", { kind: "unit" })],
    urls: [c("/training/modules/h", "live-probe", { tier: "broken" }), c("/training/modules/u1", "live-probe", { tier: "broken" }), c("/training/modules/u2", "live-probe", { tier: "unverifiable" })],
    knownPaths: new Set(["/training/modules/known"]),
    isLive: (path) => (path === "/training/modules/live" ? true : undefined),
  });
  assert.deepEqual(
    candidates.map((x) => [x.path, x.source, x.evidence, x.tier]),
    [
      ["/training/modules/h", "history", "history", "main"],
      ["/training/modules/h/1", "history", "history", "main"],
      ["/training/modules/t", "catalog", "tombstone", "main"],
      ["/training/modules/u1", "urls", "live-probe", "main"],
      ["/training/modules/u2", "urls", "live-probe", "unverifiable"],
    ]
  );
  assert.deepEqual(stats, { catalog: 1, historyModules: 1, historyUnits: 1, urlsBroken: 1, urlsUnverifiable: 1, duplicates: 2, alreadyRecorded: 1, alreadyLive: 1 });
});

// ---------------------------------------------------------------------------
// runSeed: history, end to end
// ---------------------------------------------------------------------------

test("runSeed mines the history of two repos and records what live probes classify", async () => {
  const dir = makeData({ content: CONTENT });
  const calls = [];
  const report = await run(dir, { probe: stubProbe(HISTORY_ANSWERS, calls) });

  // oldest firstSeen is probed first: c (02-02), b (03-02), d and r (04-06, by path), then the unit (10-05)
  assert.deepEqual(calls, ["/training/modules/c", "/training/modules/b", "/training/modules/d", "/training/modules/r", "/training/modules/a/02-old"]);
  assert.deepEqual(report.candidates, { catalog: 0, historyModules: 4, historyUnits: 1, urlsBroken: 0, urlsUnverifiable: 0, duplicates: 0, alreadyRecorded: 0, alreadyLive: 0 });
  assert.deepEqual(report.history.map((h) => [h.file, h.commits, h.read, h.skipped, h.first, h.last]), [
    [HUB_FILE, 2, 2, 0, "2026-01-05", "2026-03-02"],
    [DEFAULT_HISTORY_FILE, 2, 2, 0, "2026-02-02", "2026-04-06"],
  ]);

  const { removed, moved } = loadChanges(dir);
  assert.deepEqual(removed.entries.map((e) => [e.path, e.outcome, e.to, e.status, e.firstSeen, e.lastVerified, e.evidence, e.title]), [
    ["/training/modules/c", "gone", null, 404, "2026-02-02", TODAY, "history", "Title c"],
    ["/training/modules/d", "landing", "/training/paths/p", 301, "2026-04-06", TODAY, "history", "Title d"],
  ]);
  assert.deepEqual(moved.entries.map((e) => [e.path, e.kind, e.to, e.parent, e.firstSeen, e.title]), [
    ["/training/modules/a/02-old", "unit", "/training/modules/a/02-new", "/training/modules/a", "2026-10-05", "Old"],
    ["/training/modules/b", "module", "/training/modules/e", null, "2026-03-02", "Title b"],
  ]);
  // r is served on its own path: not removed at all
  assert.equal(paths(removed).concat(paths(moved)).includes("/training/modules/r"), false);
  assert.equal(report.entries.dismissed, 1);
  assert.deepEqual(report.entries.added, { gone: 1, landing: 1, retired: 0, unverified: 0, moved: 2 });
  assert.equal(report.probes.probed, 5);
  assert.equal(report.complete, true);
  assert.equal(report.changed, true);
  assert.equal(report.written.length, 2);
  // the Learn sync's stamp is not ours to set; the files were written now
  assert.equal(removed.sources.learn, null);
  assert.equal(removed.generatedAt, NOW.toISOString());
});

test("runSeed is re-runnable: a second run changes nothing and rewrites nothing", async () => {
  const dir = makeData({ content: CONTENT });
  await run(dir, { probe: stubProbe(HISTORY_ANSWERS) });
  const before = { removed: bytes(dir, "removed.json"), moved: bytes(dir, "moved.json") };
  const calls = [];
  const report = await run(dir, { probe: stubProbe(HISTORY_ANSWERS, calls), now: new Date("2026-10-07T08:00:00.000Z"), today: "2026-10-07" });
  // verified entries are not re-probed; only r (a candidate a probe found live, which no file remembers) is asked again
  assert.deepEqual(calls, ["/training/modules/r"]);
  assert.equal(report.changed, false);
  assert.equal(report.written, null);
  assert.equal(bytes(dir, "removed.json"), before.removed);
  assert.equal(bytes(dir, "moved.json"), before.moved);
  // the dismissed candidate (r, live) is simply a candidate again each run; the known ones are counted as recorded
  assert.equal(report.candidates.alreadyRecorded, 4);
});

test("runSeed with a small budget leaves the rest unverified and a re-run works it off, oldest first", async () => {
  const dir = makeData({ content: CONTENT });
  const first = [];
  const r1 = await run(dir, { probe: stubProbe(HISTORY_ANSWERS, first), maxProbes: 2 });
  assert.deepEqual(first, ["/training/modules/c", "/training/modules/b"]);
  assert.equal(r1.probes.budgetExhausted, true);
  assert.equal(r1.complete, false);
  assert.equal(r1.entries.unverifiedLeft, 3);
  let set = loadChanges(dir);
  assert.deepEqual(byPath(set.removed)["/training/modules/d"].outcome, "unverified");
  assert.equal(byPath(set.removed)["/training/modules/d"].lastVerified, null);
  assert.deepEqual(paths(set.moved), ["/training/modules/b"]);

  const second = [];
  const r2 = await run(dir, { probe: stubProbe(HISTORY_ANSWERS, second), maxProbes: 10 });
  assert.deepEqual(second, ["/training/modules/d", "/training/modules/r", "/training/modules/a/02-old"], "only the unverified entries are probed");
  assert.equal(r2.complete, true);
  set = loadChanges(dir);
  assert.deepEqual(paths(set.removed), ["/training/modules/c", "/training/modules/d"]);
  assert.deepEqual(paths(set.moved), ["/training/modules/a/02-old", "/training/modules/b"]);
});

test("runSeed --no-probe plans only: candidates are written unverified, and a later run with probes classifies them", async () => {
  const dir = makeData({ content: CONTENT });
  const calls = [];
  const r1 = await run(dir, { noProbe: true, probe: stubProbe(HISTORY_ANSWERS, calls) });
  assert.deepEqual(calls, []);
  assert.equal(r1.probing, false);
  assert.equal(r1.probes.budgetExhausted, false);
  const planned = loadChanges(dir);
  assert.deepEqual(planned.moved.entries, []);
  assert.deepEqual(planned.removed.entries.map((e) => [e.path, e.outcome, e.evidence, e.lastVerified]), [
    ["/training/modules/a/02-old", "unverified", "history", null],
    ["/training/modules/b", "unverified", "history", null],
    ["/training/modules/c", "unverified", "history", null],
    ["/training/modules/d", "unverified", "history", null],
    ["/training/modules/r", "unverified", "history", null],
  ]);
  assert.match(formatSeedReport(r1).join("\n"), /no probes/);

  // the main tier also works off what an earlier run left unverified even when there is no new candidate
  const r2 = await run(dir, { probe: stubProbe(HISTORY_ANSWERS, calls) });
  assert.equal(r2.candidates.alreadyRecorded, 5);
  const done = loadChanges(dir);
  assert.deepEqual(paths(done.removed), ["/training/modules/c", "/training/modules/d"]);
  assert.deepEqual(paths(done.moved), ["/training/modules/a/02-old", "/training/modules/b"]);
});

test("runSeed --dry-run computes the plan and the counts but writes nothing, not even the directory", async () => {
  const dir = makeData({ content: CONTENT });
  const calls = [];
  const report = await run(dir, { dryRun: true, probe: stubProbe(HISTORY_ANSWERS, calls) });
  assert.equal(calls.length, 5, "a dry run still probes unless --no-probe is given");
  assert.equal(report.changed, true);
  assert.equal(report.written, null);
  assert.equal(existsSync(join(dir, "changes")), false);
  assert.deepEqual(report.entries.added, { gone: 1, landing: 1, retired: 0, unverified: 0, moved: 2 });
  assert.equal(report.plan.length, 5);
  assert.match(formatSeedReport(report).join("\n"), /dry run, nothing written/);
});

test("runSeed merges: known entries stay as they are, docs entries and the docs stamp are untouched, sources.learn does not move", async () => {
  const docs = { path: "/azure/old", kind: "docs", family: "docs", evidence: "docs-redirect", outcome: "moved", to: "/azure/new", status: 301, lastVerified: "2026-10-01", firstSeen: "2026-09-20" };
  const verified = E("/training/modules/c", { firstSeen: "2026-12-31", lastVerified: "2026-10-05", evidence: "tombstone", title: "Fresher title", outcome: "landing", to: "/training/paths/p", status: 301 });
  const dir = makeData({ content: CONTENT, changes: changesOf([verified], [docs]) });
  const before = loadChanges(dir);
  const calls = [];
  await run(dir, { probe: stubProbe(HISTORY_ANSWERS, calls) });
  assert.ok(!calls.includes("/training/modules/c"), "a verified entry is neither re-probed nor overwritten");
  const after = loadChanges(dir);
  assert.deepEqual(byPath(after.removed)["/training/modules/c"], before.removed.entries[0]);
  assert.deepEqual(after.moved.entries.find((e) => e.family === "docs"), before.moved.entries[0]);
  assert.equal(after.removed.sources.docs, before.removed.sources.docs);
  assert.equal(after.removed.sources.learn, OLD_STAMP, "a seed run says nothing about when the Learn sync last ran");
  assert.equal(after.moved.sources.learn, OLD_STAMP);
  assert.equal(after.removed.generatedAt, NOW.toISOString());
});

test("runSeed leaves a file byte-identical when only the other one changes", async () => {
  // everything the history finds is moved: removed.json must not be touched
  const dir = makeData({ content: CONTENT, changes: changesOf([E("/training/modules/zzz")], []) });
  const answers = {
    ...HISTORY_ANSWERS,
    "/training/modules/c": served("/training/modules/e", { first: 301 }),
    "/training/modules/d": served("/training/modules/e", { first: 301 }),
  };
  const removedBefore = bytes(dir, "removed.json");
  await run(dir, { probe: stubProbe(answers) });
  assert.equal(bytes(dir, "removed.json"), removedBefore);
  const { moved } = loadChanges(dir);
  assert.deepEqual(paths(moved), ["/training/modules/a/02-old", "/training/modules/b", "/training/modules/c", "/training/modules/d"], "r is live");
  assert.equal(moved.generatedAt, NOW.toISOString());
});

test("runSeed skips snapshots it cannot use (invalid JSON, deleted file) and says so", async () => {
  const repo = makeRepo();
  const file = DEFAULT_HISTORY_FILE;
  commitFile(repo, file, catalogV1("2026-01-05T06:00:00.000Z", [v1("a"), v1("y")]), "2026-01-05T06:30:00Z");
  commitFile(repo, file, "this is not json {", "2026-01-06T06:30:00Z");
  commitFile(repo, file, catalogV1("2026-01-07T06:00:00.000Z", [v1("a")]), "2026-01-07T06:30:00Z");
  commitFile(repo, file, null, "2026-01-08T06:30:00Z");
  const warnings = [];
  const dir = makeData({ catalog: catalogV2("2026-10-05T19:04:00.000Z", [v2("a")]) });
  const report = await run(dir, { histories: [repo], noProbe: true, warn: (m) => warnings.push(m) });
  assert.deepEqual(report.history.map((h) => [h.commits, h.read, h.skipped]), [[4, 2, 2]]);
  assert.equal(warnings.filter((m) => /skipped/.test(m)).length, 2);
  // y was last seen in the first snapshot; the first USABLE snapshot without it is the third
  assert.deepEqual(loadChanges(dir).removed.entries.map((e) => [e.path, e.firstSeen]), [["/training/modules/y", "2026-01-07"]]);
});

// ---------------------------------------------------------------------------
// runSeed: the current cache and the URL list
// ---------------------------------------------------------------------------

test("runSeed records the tombstones that already exist in the current files, and drops one a probe finds live", async () => {
  const tomb = (slug, removedOn) => ({ uid: `learn.${slug}`, path: `/training/modules/${slug}`, title: `Title ${slug}`, lastSeen: "2026-09-01", removedOn });
  const catalog = catalogV2("2026-10-05T19:04:00.000Z", [v2("a")], { removed: [tomb("t1", "2026-09-20"), tomb("still-served", "2026-10-05")] });
  const content = { ...CONTENT, removed: [{ type: "course", uid: "c1", path: "/training/courses/old", title: "Old", lastSeen: "2026-09-01", removedOn: "2026-09-21" }] };
  const dir = makeData({ catalog, content });
  const answers = {
    "/training/modules/t1": NOT_FOUND,
    "/training/modules/still-served": served("/training/modules/still-served"),
    "/training/courses/old": served("/training/browse", { first: 301 }),
  };
  const report = await run(dir, { histories: [], probe: stubProbe(answers) });
  assert.equal(report.candidates.catalog, 3);
  assert.equal(report.current.tombstones, 2);
  const { removed } = loadChanges(dir);
  assert.deepEqual(removed.entries.map((e) => [e.path, e.kind, e.outcome, e.evidence, e.firstSeen, e.to]), [
    ["/training/courses/old", "course", "landing", "tombstone", "2026-09-21", "/training/browse"],
    ["/training/modules/t1", "module", "gone", "tombstone", "2026-09-20", null],
  ]);
  assert.equal(report.entries.dismissed, 1);
});

test("runSeed with a URL list: only a live probe records a link, and the strongest evidence is probed first", async () => {
  const dir = makeData({ content: CONTENT });
  const answers = {
    "/training/modules/ghost": NOT_FOUND,
    "/training/modules/a/09-nothere": served("/training/modules/a/01-intro", { first: 301 }),
    "/training/paths/gone-path": NOT_FOUND,
    "/training/courses/ghost-course": NOT_FOUND,
    "/credentials/certifications/exams/az-104": served("/credentials/certifications/azure-administrator", { first: 301 }), // healthy: a current exam
    "/credentials/certifications/resources/study-guides/az-104": NOT_FOUND,
  };
  const calls = [];
  const report = await run(dir, { histories: [], urls: URL_LIST, probe: stubProbe(answers, calls) });
  assert.deepEqual(report.urls, { given: 15, invalid: 2, nonLearn: 1, duplicates: 1, valid: 3, docs: 1, other: 1, broken: 4, unverifiable: 2 });
  assert.deepEqual(
    calls,
    ["/training/courses/ghost-course", "/training/modules/a/09-nothere", "/training/modules/ghost", "/training/paths/gone-path", "/credentials/certifications/exams/az-104", "/credentials/certifications/resources/study-guides/az-104"],
    "cache-broken links first, then the ones only a probe can judge"
  );
  const { removed, moved } = loadChanges(dir);
  assert.deepEqual(removed.entries.map((e) => [e.path, e.kind, e.outcome, e.evidence, e.firstSeen, e.lastVerified]), [
    ["/credentials/certifications/resources/study-guides/az-104", "study-guide", "gone", "live-probe", TODAY, TODAY],
    ["/training/courses/ghost-course", "course", "gone", "live-probe", TODAY, TODAY],
    ["/training/modules/ghost", "module", "gone", "live-probe", TODAY, TODAY],
    ["/training/paths/gone-path", "learning-path", "gone", "live-probe", TODAY, TODAY],
  ]);
  assert.deepEqual(moved.entries.map((e) => [e.path, e.to, e.parent]), [["/training/modules/a/09-nothere", "/training/modules/a/01-intro", "/training/modules/a"]]);
  // the healthy exam link is not recorded anywhere
  assert.equal(report.entries.dismissed, 1);
  assert.deepEqual(report.unconfirmed, []);
});

test("runSeed with a URL list: a transient probe, an exhausted budget and --no-probe record nothing for the url source", async () => {
  const urls = ["/training/modules/ghost", "/credentials/certifications/exams/az-104"];
  // a transient answer is never a classification
  let dir = makeData({ content: CONTENT });
  let report = await run(dir, { histories: [], urls, probe: stubProbe({}) });
  assert.deepEqual(report.unconfirmed, ["/credentials/certifications/exams/az-104", "/training/modules/ghost"]);
  assert.equal(existsSync(join(dir, "changes")), false, "nothing was confirmed, so nothing is written");
  assert.equal(report.complete, false);

  // budget 1: the cache-broken link takes it, the unverifiable one is not even probed
  dir = makeData({ content: CONTENT });
  const calls = [];
  report = await run(dir, { histories: [], urls, maxProbes: 1, probe: stubProbe({ "/training/modules/ghost": NOT_FOUND }, calls) });
  assert.deepEqual(calls, ["/training/modules/ghost"]);
  assert.deepEqual(report.unconfirmed, ["/credentials/certifications/exams/az-104"]);
  assert.equal(report.probes.budgetExhausted, true);
  assert.deepEqual(paths(loadChanges(dir).removed), ["/training/modules/ghost"]);

  // no probes: a cache verdict alone is not recorded for this source
  dir = makeData({ content: CONTENT });
  report = await run(dir, { histories: [], urls, noProbe: true, probe: stubProbe({}, calls) });
  assert.equal(existsSync(join(dir, "changes")), false);
  assert.deepEqual(report.unconfirmed, ["/credentials/certifications/exams/az-104", "/training/modules/ghost"]);
  assert.match(formatSeedReport(report).join("\n"), /were not recorded \(no live probe confirmed them: probing is off\)/);
});

test("runSeed: the units of a module that is itself a candidate are covered by it once it is classified, not listed twice", async () => {
  const urls = ["/training/modules/c/01-intro"]; // c is a history candidate; its unit is broken in the cache, too

  // a probe classifies the module: it covers the unit, which is never probed (it waited for the module's result)
  let dir = makeData({ content: CONTENT });
  const calls = [];
  let report = await run(dir, { urls, probe: stubProbe({ "/training/modules/c": NOT_FOUND }, calls) });
  const { removed } = loadChanges(dir);
  assert.ok(paths(removed).includes("/training/modules/c"));
  assert.equal(removed.entries.find((e) => e.path === "/training/modules/c").outcome, "gone");
  assert.ok(!paths(removed).includes("/training/modules/c/01-intro"));
  assert.ok(!calls.includes("/training/modules/c/01-intro"));
  assert.equal(report.entries.covered, 1);
  assert.ok(!report.unconfirmed.includes("/training/modules/c/01-intro"));

  // no probe: the module is written `unverified` and covers NOTHING yet (it may be false), so the url source's unit link
  // is simply one more link no probe confirmed: reported as such, recorded nowhere, listed once
  dir = makeData({ content: CONTENT });
  report = await run(dir, { urls, noProbe: true });
  const planned = loadChanges(dir).removed;
  assert.equal(planned.entries.find((e) => e.path === "/training/modules/c").outcome, "unverified");
  assert.ok(!paths(planned).includes("/training/modules/c/01-intro"));
  assert.equal(report.entries.covered, 0);
  assert.ok(report.unconfirmed.includes("/training/modules/c/01-intro"));
});

// ---------------------------------------------------------------------------
// runSeed: refusing bad input (nothing may be written)
// ---------------------------------------------------------------------------

test("runSeed fails before touching anything on a corrupt change file, a missing or truncated catalog, a newer history or a non-repo", async () => {
  // corrupt change file
  let dir = makeData({ content: CONTENT });
  mkdirSync(join(dir, "changes"));
  writeFileSync(join(dir, "changes", "removed.json"), "{ nope");
  let calls = 0;
  await assert.rejects(run(dir, { probe: async () => (calls++, BLOCKED) }), ChangesFileError);
  assert.equal(calls, 0);
  assert.equal(readFileSync(join(dir, "changes", "removed.json"), "utf-8"), "{ nope");

  // no current catalog
  dir = mkdtempSync(join(tmpdir(), "seed-empty-"));
  await assert.rejects(run(dir), /learn-catalog\.json is required/);

  // a truncated current catalog would turn every missing module into a removal
  dir = makeData({ catalog: catalogV2("2026-10-05T19:04:00.000Z", [v2("a")]) });
  await assert.rejects(run(dir, { minModules: 3000 }), /lists only 1 modules \(floor 3000\)/);
  assert.equal(existsSync(join(dir, "changes")), false);

  // a history that is newer than the data directory means the data is stale
  dir = makeData({ catalog: catalogV2("2026-02-01T00:00:00.000Z", [v2("a")]) });
  await assert.rejects(run(dir), /newer than the current catalog \(2026-02-01\)/);
  assert.equal(existsSync(join(dir, "changes")), false);

  // not a repository
  dir = makeData();
  await assert.rejects(run(dir, { histories: [mkdtempSync(join(tmpdir(), "seed-nogit-"))] }), /cannot read the git history/);
  assert.equal(existsSync(join(dir, "changes")), false);
});

test("runSeed validates its options", async () => {
  const dir = makeData();
  await assert.rejects(runSeed({}), /dataDir is required/);
  await assert.rejects(run(dir, { today: "yesterday" }), /today must be YYYY-MM-DD/);
  await assert.rejects(run(dir, { maxProbes: -1 }), /maxProbes/);
  await assert.rejects(run(dir, { histories: [], urlsFile: join(dir, "missing.json") }), /cannot read the URL list/);
  writeFileSync(join(dir, "urls.json"), '{"a":1}');
  await assert.rejects(run(dir, { histories: [], urlsFile: join(dir, "urls.json") }), /must be a JSON array/);
});

test("runSeed reads the URL list from a file", async () => {
  const dir = makeData({ content: CONTENT });
  writeFileSync(join(dir, "urls.json"), JSON.stringify(["https://learn.microsoft.com/training/modules/ghost"]));
  const report = await run(dir, { histories: [], urlsFile: join(dir, "urls.json"), probe: stubProbe({ "/training/modules/ghost": NOT_FOUND }) });
  assert.deepEqual(paths(loadChanges(dir).removed), ["/training/modules/ghost"]);
  assert.equal(report.urls.given, 1);
});

// ---------------------------------------------------------------------------
// the CLI
// ---------------------------------------------------------------------------

test("seed-changes CLI: parseArgs", () => {
  const opts = parseArgs(["--data", "d", "--history", "r1", "--history", "r2::x/y.json", "--urls", "u.json", "--max-probes", "7", "--no-probe", "--dry-run", "--today", "2026-10-06", "--min-modules", "1"]);
  assert.deepEqual(opts, {
    data: "d",
    histories: [{ repoDir: "r1", file: "data/learn-catalog.json" }, { repoDir: "r2", file: "x/y.json" }],
    urls: "u.json",
    maxProbes: 7,
    noProbe: true,
    dryRun: true,
    today: "2026-10-06",
    minModules: 1,
  });
  const defaults = parseArgs([]);
  assert.equal(defaults.maxProbes, null);
  assert.equal(defaults.noProbe, false);
  assert.equal(defaults.minModules, 3000);
  assert.deepEqual(defaults.histories, []);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--history"]), /needs a value/);
  assert.throws(() => parseArgs(["--max-probes", "-1"]), /non-negative integer/);
  assert.throws(() => parseArgs(["--max-probes", "1.5"]), /non-negative integer/);
  assert.throws(() => parseArgs(["--today", "06.10.2026"]), /YYYY-MM-DD/);
});

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf-8" });

test("seed-changes CLI: --dry-run --no-probe prints the plan and writes nothing; --no-probe alone writes the unverified plan", () => {
  const { hub, sync } = fixtureRepos();
  const dir = makeData({ content: CONTENT });
  const common = ["--data", dir, "--history", `${hub}::${HUB_FILE}`, "--history", sync, "--no-probe", "--min-modules", "1", "--today", TODAY];
  const dry = cli(...common, "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /dry run, nothing written, no probes/);
  assert.match(dry.stdout, /history modules {3}4/);
  assert.match(dry.stdout, /history units {5}1/);
  assert.match(dry.stdout, /\/training\/modules\/c {2}\[history, firstSeen 2026-02-02\]/);
  assert.match(dry.stdout, /Nothing written \(dry run; a real run would write the changes above\)/);
  assert.equal(existsSync(join(dir, "changes")), false);

  const real = cli(...common);
  assert.equal(real.status, 0, real.stderr);
  assert.match(real.stdout, /Written: .*removed\.json/);
  assert.equal(loadChanges(dir).removed.entries.length, 5);
  // run again: nothing to do
  const again = cli(...common);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Nothing to write/);
});

test("seed-changes CLI: errors exit 1 with the message on stderr", () => {
  const unknown = cli("--nope");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown argument: --nope/);
  const empty = mkdtempSync(join(tmpdir(), "seed-empty-"));
  const missing = cli("--data", empty);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /learn-catalog\.json is required/);
  assert.equal(existsSync(join(empty, "changes")), false);
});

test("formatSeedReport prints every section for a probed run", async () => {
  const dir = makeData({ content: CONTENT });
  const report = await run(dir, { probe: stubProbe(HISTORY_ANSWERS), urls: ["/training/modules/ghost"] });
  const text = formatSeedReport(report).join("\n");
  for (const part of [/Seed of the Learn change files/, /current catalog: 3 modules/, /history .*2 of 2 snapshots read, 2026-01-05 to 2026-03-02/, /url list: 1 links/, /Candidates \(after de-duplication\)/, /history modules {3}4/, /Probes: \d+ of a budget of 300/, /Entries: 0 before, 4 after; new: 1 gone, 1 landing, 2 moved/, /1 candidates were not recorded/, /url-list links were not recorded/, /Written: /]) {
    assert.match(text, part);
  }
});
