import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANGES_MAX_PROBES,
  CHANGES_REVERIFY_PER_RUN,
  CHANGE_EVIDENCE,
  ChangesFileError,
  applyChanges,
  applyChangesDetailed,
  changesSince,
  classifyLearnProbe,
  diffContent,
  diffModules,
  diffUnits,
  docsChanges,
  emptyChanges,
  indexChanges,
  loadChanges,
  lookupChange,
  makeIsLive,
  normalizeChangeFile,
  planVerification,
  readChangesLimits,
  refreshLearnChanges,
  replaceFamily,
  summarizeChanges,
  verificationQueue,
  writeChanges,
} from "../scripts/lib/changes.mjs";
import { BROWSER_UA, probe, rawProbe } from "../scripts/lib/live-probe.mjs";

const TODAY = "2026-10-06";
const NOW = "2026-10-06T08:00:00.000Z";
const OLD_STAMP = "2026-09-29T08:00:00.000Z";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const mod = (slug, unitSlugs = null, extra = {}) => ({
  uid: `learn.${slug}`,
  title: `Title ${slug}`,
  path: `/training/modules/${slug}`,
  units: unitSlugs ? unitSlugs.map((u) => `Unit ${u}`) : ["A"],
  unitUrls: unitSlugs ? unitSlugs.map((u) => `/training/modules/${slug}/${u}`) : null,
  ...extra,
});
const catalog = (modules, { removed = [], outOfScope = [], lastChecked = "2026-10-06T07:00:00.000Z" } = {}) => ({
  schemaVersion: 2,
  lastChecked,
  modules,
  removed,
  outOfScope,
});
const tomb = (slug, removedOn = "2026-10-05") => ({ uid: `learn.${slug}`, path: `/training/modules/${slug}`, title: `Title ${slug}`, lastSeen: "2026-09-28", removedOn });

const content = (over = {}) => ({
  schemaVersion: 1,
  lastChecked: "2026-10-06T07:00:00.000Z",
  learningPaths: [],
  courses: [],
  certifications: [],
  exams: [],
  appliedSkills: [],
  studyGuides: [],
  unverifiedStudyGuides: [],
  removed: [],
  ...over,
});
const guidePath = (code) => `/credentials/certifications/resources/study-guides/${code}`;
const exam = (code, studyGuide = null) => ({ uid: `exam.${code}`, code, title: `Exam ${code}`, path: `/credentials/certifications/exams/${code}`, studyGuide });

/** A complete, valid entry; `over` changes fields. */
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
const docsEntry = (path, over = {}) => E(path, { kind: "docs", family: "docs", evidence: "quarantine", ...over });
const changesOf = (removed = [], moved = []) => ({
  removed: normalizeChangeFile({ generatedAt: OLD_STAMP, sources: { learn: OLD_STAMP, docs: "2026-09-29T09:00:00.000Z" }, entries: removed }, "removed"),
  moved: normalizeChangeFile({ generatedAt: OLD_STAMP, sources: { learn: OLD_STAMP, docs: "2026-09-29T09:00:00.000Z" }, entries: moved }, "moved"),
});
const all = (changes) => [...changes.removed.entries, ...changes.moved.entries];
const find = (changes, path) => all(changes).find((e) => e.path === path);
const pathsOf = (file) => file.entries.map((e) => e.path);
const cand = (path, over = {}) => ({ path, kind: "module", title: null, evidence: "tombstone", firstSeen: "2026-10-05", ...over });
const unitCand = (path, parent) => cand(path, { kind: "unit", parent, evidence: "unit-diff" });
const R = (outcome, to = null, status = 200) => ({ outcome, to, status });
const apply = (over) => applyChanges({ today: TODAY, generatedAt: NOW, isLive: () => undefined, ...over });

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

// ---------------------------------------------------------------------------
// limits and the file model
// ---------------------------------------------------------------------------

test("readChangesLimits: defaults, environment overrides, and typos throw", () => {
  assert.equal(CHANGES_MAX_PROBES, 300);
  assert.equal(CHANGES_REVERIFY_PER_RUN, 100);
  assert.deepEqual(readChangesLimits({}), { maxProbes: 300, reverifyPerRun: 100 });
  assert.deepEqual(readChangesLimits({ CHANGES_MAX_PROBES: "", CHANGES_REVERIFY_PER_RUN: "  " }), { maxProbes: 300, reverifyPerRun: 100 });
  assert.deepEqual(readChangesLimits({ CHANGES_MAX_PROBES: "50", CHANGES_REVERIFY_PER_RUN: "0" }), { maxProbes: 50, reverifyPerRun: 0 });
  for (const bad of ["abc", "-1", "1.5", "1e9"]) {
    assert.throws(() => readChangesLimits({ CHANGES_MAX_PROBES: bad }), /CHANGES_MAX_PROBES/, bad);
    assert.throws(() => readChangesLimits({ CHANGES_REVERIFY_PER_RUN: bad }), /CHANGES_REVERIFY_PER_RUN/, bad);
  }
});

test("emptyChanges has the file shape and is never shared", () => {
  const a = emptyChanges();
  assert.deepEqual(a.removed, { schemaVersion: 1, generatedAt: null, sources: { learn: null, docs: null }, entries: [] });
  assert.deepEqual(a.moved, a.removed);
  a.removed.entries.push(1);
  assert.deepEqual(emptyChanges().removed.entries, []);
});

test("normalizeChangeFile drops garbage, canonicalizes, validates enums, dedupes and sorts", () => {
  const dropped = [];
  const good = E("/training/modules/good", { title: "Good", extra: "kept", zzz: 1 });
  const file = normalizeChangeFile(
    {
      schemaVersion: 1,
      generatedAt: OLD_STAMP,
      sources: { learn: OLD_STAMP, docs: "not a date" },
      entries: [
        null,
        "a string",
        42,
        E("https://example.com/x"), // not a Learn host
        E("/"),
        E("relative/path"),
        E("/training/modules/bad-kind", { kind: "page" }),
        E("/training/modules/bad-outcome", { outcome: "moved" }), // belongs to moved.json
        E("/training/modules/bad-outcome2", { outcome: "exploded" }),
        E("/training/modules/bad-date", { firstSeen: "2026-13-01" }),
        E("/training/modules/no-date", { firstSeen: undefined }),
        E("/training/modules/bad-evidence", { evidence: "vibes" }),
        E("/training/modules/wrong-family", { family: "docs" }),
        E("/training/modules/self", { to: "/training/modules/self" }),
        // canonicalized: locale, case, trailing slash, query
        E("https://learn.microsoft.com/en-us/Training/Modules/UPPER/?WT.mc_id=x", { title: "  ", status: 99, lastVerified: "garbage", to: "https://example.com/off", parent: "/" }),
        good,
        // duplicate of `good`: the more recently verified claim wins, firstSeen is the older of both
        E("/training/modules/good", { title: "Good newer", firstSeen: "2026-09-15", lastVerified: "2026-10-01" }),
      ],
    },
    "removed",
    { onDrop: (reason) => dropped.push(reason) }
  );
  assert.equal(dropped.length, 14);
  assert.equal(file.schemaVersion, 1);
  assert.equal(file.generatedAt, OLD_STAMP);
  assert.deepEqual(file.sources, { learn: OLD_STAMP, docs: null });
  assert.deepEqual(pathsOf(file), ["/training/modules/good", "/training/modules/upper"]);
  const [kept, upper] = file.entries;
  assert.equal(kept.title, "Good newer");
  assert.equal(kept.firstSeen, "2026-09-01");
  assert.equal(kept.lastVerified, "2026-10-01");
  assert.equal(kept.extra, undefined); // the newer duplicate won and it has no extra field
  assert.deepEqual(upper, {
    path: "/training/modules/upper",
    kind: "module",
    family: "learn",
    outcome: "gone",
    to: null, // an off-site destination reads as null
    title: null, // blank title
    parent: null, // the site root is no module
    firstSeen: "2026-09-01",
    lastVerified: null,
    evidence: "tombstone",
    status: null,
  });
});

test("normalizeChangeFile: contract key order, unknown fields survive, family is derived, sort is by code point", () => {
  const file = normalizeChangeFile(
    {
      entries: [
        { path: "/training/modules/b", kind: "module", outcome: "gone", firstSeen: "2026-09-01", evidence: "tombstone", future: { a: 1 }, alpha: true },
        { path: "/azure/docs-page", kind: "docs", outcome: "landing", to: "/azure", firstSeen: "2026-09-01", evidence: "docs-redirect" },
        { path: "/training/modules/a/b", kind: "unit", parent: "/training/modules/a", outcome: "unverified", firstSeen: "2026-09-01", evidence: "unit-diff" },
        { path: "/training/modules/a-b", kind: "module", outcome: "unverified", firstSeen: "2026-09-01", evidence: "tombstone" },
      ],
    },
    "removed"
  );
  assert.deepEqual(Object.keys(file), ["schemaVersion", "generatedAt", "sources", "entries"]);
  assert.deepEqual(pathsOf(file), ["/azure/docs-page", "/training/modules/a-b", "/training/modules/a/b", "/training/modules/b"]);
  const b = file.entries[3];
  assert.deepEqual(Object.keys(b), ["path", "kind", "family", "outcome", "to", "title", "parent", "firstSeen", "lastVerified", "evidence", "status", "alpha", "future"]);
  assert.equal(b.family, "learn");
  assert.equal(file.entries[0].family, "docs");
  assert.deepEqual(file.entries[0].to, "/azure");
  // garbage in, empty file out (never throws)
  for (const raw of [null, undefined, [], "x", 3, { entries: "nope" }]) {
    assert.deepEqual(normalizeChangeFile(raw, "moved").entries, []);
  }
  assert.throws(() => normalizeChangeFile({}, "other"), TypeError);
  // moved.json only takes `moved`
  assert.equal(normalizeChangeFile({ entries: [E("/training/modules/x", { outcome: "moved", to: "/training/modules/y" })] }, "moved").entries.length, 1);
  assert.equal(normalizeChangeFile({ entries: [E("/training/modules/x", { outcome: "gone" })] }, "moved").entries.length, 0);
});

test("loadChanges and writeChanges: missing files are empty, round trip is byte-stable", () => {
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  assert.deepEqual(loadChanges(dir), emptyChanges());
  const changes = changesOf(
    [E("/training/modules/b", { outcome: "unverified", status: null, lastVerified: null }), docsEntry("/azure/gone")],
    [E("/training/modules/a", { outcome: "moved", to: "/training/modules/a2", status: 301 })]
  );
  const written = writeChanges(dir, changes);
  assert.ok(written.removed.endsWith("removed.json") && written.moved.endsWith("moved.json"));
  assert.deepEqual(readdirSync(join(dir, "changes")).sort(), ["moved.json", "removed.json"]); // no .tmp left behind
  const text = readFileSync(written.removed, "utf-8");
  assert.equal(text, JSON.stringify(changes.removed, null, 2) + "\n");
  assert.deepEqual(loadChanges(dir), changes);
  writeChanges(dir, loadChanges(dir));
  assert.equal(readFileSync(written.removed, "utf-8"), text);
  // an entry with a bad outcome for its file is a bug of the caller: refuse to write
  const broken = { removed: { entries: [E("/training/modules/x", { outcome: "moved", to: "/y" })] }, moved: emptyChanges().moved };
  assert.throws(() => writeChanges(dir, broken), /refusing to build removed\.json/);
  assert.equal(readFileSync(written.removed, "utf-8"), text); // untouched
});

test("loadChanges: a corrupt or unsupported file throws ChangesFileError instead of being overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  mkdirSync(join(dir, "changes"));
  const file = join(dir, "changes", "removed.json");
  const expectBad = (text, pattern) => {
    writeFileSync(file, text);
    assert.throws(
      () => loadChanges(dir, { warn: () => {} }),
      (err) => err instanceof ChangesFileError && err.name === "ChangesFileError" && err.file === file && pattern.test(err.reason)
    );
  };
  expectBad("{ not json", /not valid JSON/);
  expectBad("[]", /not an object/);
  expectBad("null", /not an object/);
  expectBad(JSON.stringify({ entries: [] }), /schemaVersion/);
  expectBad(JSON.stringify({ schemaVersion: 2, entries: [] }), /unsupported schemaVersion 2/);
  expectBad(JSON.stringify({ schemaVersion: 1 }), /entries/);
  expectBad(JSON.stringify({ schemaVersion: 1, entries: {} }), /entries/);
  // moved.json is checked too
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, entries: [] }));
  writeFileSync(join(dir, "changes", "moved.json"), "oops");
  assert.throws(() => loadChanges(dir, { warn: () => {} }), ChangesFileError);
});

test("loadChanges: malformed rows are dropped with a warning; a path in both files keeps one claim", () => {
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  mkdirSync(join(dir, "changes"));
  writeFileSync(
    join(dir, "changes", "removed.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: OLD_STAMP,
      sources: { learn: OLD_STAMP, docs: null },
      entries: [E("/training/modules/ok"), { garbage: true }, E("/training/modules/both", { lastVerified: "2026-09-10" }), E("/training/modules/both2", { lastVerified: "2026-09-10" })],
    })
  );
  writeFileSync(
    join(dir, "changes", "moved.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        E("/training/modules/both", { outcome: "moved", to: "/training/modules/new", lastVerified: "2026-10-01" }),
        E("/training/modules/both2", { outcome: "moved", to: "/training/modules/new2", lastVerified: "2026-09-10" }),
      ],
    })
  );
  const warnings = [];
  const loaded = loadChanges(dir, { warn: (m) => warnings.push(m) });
  assert.deepEqual(pathsOf(loaded.removed), ["/training/modules/both2", "/training/modules/ok"]); // tie: removed wins
  assert.deepEqual(pathsOf(loaded.moved), ["/training/modules/both"]); // newer verification wins
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /dropped a malformed row/);
});

// ---------------------------------------------------------------------------
// detectors
// ---------------------------------------------------------------------------

test("diffModules: new tombstones, hierarchyNotFound modules and renamed paths", () => {
  const previous = catalog([mod("a"), mod("b"), mod("c")], { removed: [tomb("old1")], lastChecked: "2026-09-29T07:00:00.000Z" });
  const next = catalog([mod("a"), mod("hnf", null, { hierarchyNotFound: true }), mod("c", null, { path: "/training/modules/c-renamed" })], {
    removed: [tomb("old1"), tomb("b")],
  });
  assert.deepEqual(diffModules(previous, next), [
    { path: "/training/modules/b", kind: "module", title: "Title b", evidence: "tombstone", firstSeen: "2026-10-05" },
    { path: "/training/modules/c", kind: "module", title: "Title c", evidence: "rename", firstSeen: "2026-10-06" },
    { path: "/training/modules/hnf", kind: "module", title: "Title hnf", evidence: "hierarchy-not-found", firstSeen: "2026-10-06" },
  ]);
  // first run: no previous catalog, every current tombstone is new, nothing can be a rename
  assert.deepEqual(
    diffModules(null, next).map((c) => [c.path, c.evidence]),
    [
      ["/training/modules/b", "tombstone"],
      ["/training/modules/hnf", "hierarchy-not-found"],
      ["/training/modules/old1", "tombstone"],
    ]
  );
  // nothing to compare against
  assert.deepEqual(diffModules(previous, null), []);
  assert.deepEqual(diffModules(previous, undefined), []);
  // an unchanged catalog has no candidates
  assert.deepEqual(diffModules(previous, previous), []);
});

test("diffModules: a tombstone with a bad path is skipped, the strongest evidence wins a path", () => {
  const next = catalog([mod("hnf", null, { hierarchyNotFound: true })], {
    removed: [{ uid: "learn.x", path: null, title: "x", removedOn: "2026-10-05" }, { uid: "learn.hnf", path: "/training/modules/hnf", title: "t", removedOn: "2026-10-04" }],
  });
  const found = diffModules(null, next);
  assert.deepEqual(found.map((c) => [c.path, c.evidence, c.firstSeen]), [["/training/modules/hnf", "tombstone", "2026-10-04"]]);
});

test("diffUnits: a renumbered unit list yields the old paths that are gone", () => {
  const previous = catalog([mod("m", ["01-intro", "05-exercise", "06-summary"])], { lastChecked: "2026-09-29T07:00:00.000Z" });
  const next = catalog([mod("m", ["01-intro", "04-exercise", "05-summary"])]);
  assert.deepEqual(diffUnits(previous, next), [
    { path: "/training/modules/m/05-exercise", kind: "unit", parent: "/training/modules/m", title: "Unit 05-exercise", evidence: "unit-diff", firstSeen: "2026-10-06" },
    { path: "/training/modules/m/06-summary", kind: "unit", parent: "/training/modules/m", title: "Unit 06-summary", evidence: "unit-diff", firstSeen: "2026-10-06" },
  ]);
  // a slug that merely moved position is still there
  assert.deepEqual(diffUnits(previous, catalog([mod("m", ["06-summary", "05-exercise", "01-intro"])])), []);
  assert.deepEqual(diffUnits(previous, previous), []);
});

test("diffUnits: truncated, empty, null or one-sided hierarchies never generate candidates", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `${String(i + 1).padStart(2, "0")}-u`);
  const previous = catalog([mod("m", ten)]);
  // new list shorter than half of the old: not evidence
  assert.deepEqual(diffUnits(previous, catalog([mod("m", ten.slice(0, 4))])), []);
  // exactly half is trusted: the five missing paths are reported
  assert.equal(diffUnits(previous, catalog([mod("m", ten.slice(0, 5))])).length, 5);
  assert.equal(diffUnits(previous, catalog([mod("m", ten.slice(0, 6))])).length, 4);
  // null / empty on either side
  assert.deepEqual(diffUnits(previous, catalog([mod("m", null)])), []);
  assert.deepEqual(diffUnits(previous, catalog([mod("m", [])])), []);
  assert.deepEqual(diffUnits(catalog([mod("m", null)]), catalog([mod("m", ["01-u"])])), []);
  assert.deepEqual(diffUnits(catalog([mod("m", [])]), catalog([mod("m", ["01-u"])])), []);
  // flagged hierarchyNotFound in the new catalog
  assert.deepEqual(diffUnits(previous, catalog([mod("m", ten.slice(0, 9), { hierarchyNotFound: true })])), []);
  // a module in only one catalog (removed, added or renamed) is not compared
  assert.deepEqual(diffUnits(previous, catalog([])), []);
  assert.deepEqual(diffUnits(previous, catalog([mod("other", ten)])), []);
  assert.deepEqual(diffUnits(previous, catalog([mod("m", ten.slice(0, 9), { path: "/training/modules/m-renamed" })])), []);
  assert.deepEqual(diffUnits(null, previous), []);
  assert.deepEqual(diffUnits(previous, null), []);
  // garbage in the list makes the whole module untrusted
  assert.deepEqual(diffUnits(previous, catalog([mod("m", ten.slice(0, 9), { unitUrls: [...ten.slice(0, 8).map((u) => `/training/modules/m/${u}`), "not a path"] })])), []);
});

test("diffUnits handles modules published outside /training/modules/", () => {
  const saas = (units) => ({ uid: "learn.saas", title: "S", path: "/training/saas/saas-foundations", units: units.map((u) => u), unitUrls: units.map((u) => `/training/saas/saas-foundations/${u}`) });
  const found = diffUnits(catalog([saas(["1-a", "2-b"])]), catalog([saas(["1-a", "3-b"])]));
  assert.deepEqual(found.map((c) => [c.path, c.parent]), [["/training/saas/saas-foundations/2-b", "/training/saas/saas-foundations"]]);
});

test("diffContent: tombstones carry the content kind and only new ones are reported", () => {
  const t = (type, slug, base) => ({ type, uid: `uid.${slug}`, path: `${base}${slug}`, title: `T ${slug}`, lastSeen: "2026-09-28", removedOn: "2026-10-05" });
  const removed = [
    t("learningPath", "lp", "/training/paths/"),
    t("course", "c", "/training/courses/"),
    t("certification", "cert", "/credentials/certifications/"),
    t("exam", "az-1", "/credentials/certifications/exams/"),
    t("appliedSkill", "skill", "/credentials/applied-skills/"),
    t("mystery", "m", "/training/paths/"),
  ];
  const previous = content({ removed: [removed[0]] });
  const next = content({ removed });
  assert.deepEqual(
    diffContent(previous, next).map((c) => [c.path, c.kind, c.evidence, c.firstSeen]),
    [
      ["/credentials/applied-skills/skill", "applied-skill", "tombstone", "2026-10-05"],
      ["/credentials/certifications/cert", "certification", "tombstone", "2026-10-05"],
      ["/credentials/certifications/exams/az-1", "exam", "tombstone", "2026-10-05"],
      ["/training/courses/c", "course", "tombstone", "2026-10-05"],
    ]
  );
  assert.equal(diffContent(null, next).length, 5);
  assert.deepEqual(diffContent(previous, null), []);
});

test("diffContent: a study guide that went from a path to null after a definitive probe; transient failures produce nothing", () => {
  const skill = (studyGuide) => ({ uid: "skill.1", code: "apl-1000", title: "Skill", path: "/credentials/applied-skills/s1", studyGuide });
  const skillGuide = "/credentials/applied-skills/resources/study-guides/apl-1000";
  const previous = content({
    exams: [exam("az-1", guidePath("az-1")), exam("az-2", guidePath("az-2")), exam("az-3", null), exam("az-4", guidePath("az-4")), exam("az-5", guidePath("az-5"))],
    appliedSkills: [skill(skillGuide)],
    studyGuides: [{ path: guidePath("az-1") }, { path: guidePath("az-2") }, { path: guidePath("az-4") }, { path: guidePath("az-5") }, { path: skillGuide }],
  });
  const next = content({
    exams: [
      exam("az-1", null), // definitive probe: no study guide any more
      exam("az-2", guidePath("az-2")), // transient failure: the previous value was kept
      exam("az-3", null), // never had one
      exam("az-4", null), // would be a candidate...
    ],
    // ...but az-5 left the exam list entirely: nothing proves its study guide page is gone
    appliedSkills: [skill(null)],
    studyGuides: [{ path: guidePath("az-2") }],
    unverifiedStudyGuides: [guidePath("az-4")], // ...unless it is flagged unverified, which is not definitive
  });
  assert.deepEqual(diffContent(previous, next), [
    { path: skillGuide, kind: "study-guide", title: null, evidence: "live-probe", firstSeen: "2026-10-06" },
    { path: guidePath("az-1"), kind: "study-guide", title: null, evidence: "live-probe", firstSeen: "2026-10-06" },
  ]);
  // a study guide the file still lists is not gone, whatever the exam field says
  assert.deepEqual(diffContent(previous, content({ exams: [exam("az-1", null)], studyGuides: [{ path: guidePath("az-1") }] })), []);
});

test("diffContent: a renamed path (same uid) reports the old path", () => {
  const lp = (path) => ({ uid: "lp.1", title: "LP", path, lastModified: null, modules: [] });
  const found = diffContent(content({ learningPaths: [lp("/training/paths/old")] }), content({ learningPaths: [lp("/training/paths/new")] }));
  assert.deepEqual(found, [{ path: "/training/paths/old", kind: "learning-path", title: "LP", evidence: "rename", firstSeen: "2026-10-06" }]);
  assert.deepEqual(diffContent(content({ learningPaths: [lp("/training/paths/old")] }), content({ learningPaths: [lp("/training/paths/old")] })), []);
});

test("makeIsLive follows the validator's rules and says undefined when the cache cannot know", () => {
  const isLive = makeIsLive({
    catalog: catalog(
      [
        mod("m", ["01-a"]),
        mod("n", null),
        mod("e", []), // a real, empty unit list is knowledge: the hierarchy answered
        mod("h", null, { hierarchyNotFound: true }),
        { uid: "learn.s", title: "S", path: "/training/saas/s", units: ["x"], unitUrls: ["/training/saas/s/1-x"] },
      ],
      { outOfScope: ["/training/modules/oos"] }
    ),
    content: content({
      learningPaths: [{ path: "/training/paths/lp" }, { path: "/training/paths/odd/odd" }],
      courses: [{ path: "/training/courses/c1" }],
      certifications: [{ path: "/credentials/certifications/cert" }],
      exams: [{ path: "/credentials/certifications/exams/az-1" }],
      appliedSkills: [{ path: "/credentials/applied-skills/s" }],
      studyGuides: [{ path: guidePath("az-1") }],
    }),
  });
  const expected = {
    "/training/modules/m": true,
    "/training/modules/m/01-a": true,
    "/training/modules/m/99-z": false,
    "/training/modules/n": undefined, // listed, not flagged, but its hierarchy is unreadable: nothing proves Learn serves it, so it must not delete an entry
    "/training/modules/n/01-a": undefined, // unitUrls unknown
    "/training/modules/e": true,
    "/training/modules/e/01-a": false,
    "/training/modules/h": false,
    "/training/modules/h/01-a": false,
    "/training/modules/oos": true,
    "/training/modules/oos/01-a": undefined,
    "/training/modules/ghost": false, // modules + outOfScope is complete
    "/training/modules/ghost/01-a": false,
    "/training/saas/s": true,
    "/training/saas/s/1-x": true,
    "/training/saas/unknown": undefined,
    "/training/paths/lp": true,
    "/training/paths/odd/odd": true, // listed with an unusual shape: exact membership wins
    "/training/paths/nope": false,
    "/training/courses/c1": true,
    "/training/courses/nope": false,
    "/credentials/applied-skills/s": true,
    "/credentials/applied-skills/nope": false,
    "/credentials/certifications/cert": true,
    "/credentials/certifications/nope": undefined, // may be a support or program page
    "/credentials/certifications/exams/az-1": true,
    "/credentials/certifications/exams/az-9": undefined, // the API lists only legacy exams
    [guidePath("az-1")]: true,
    [guidePath("az-9")]: undefined,
    "/azure/anything": undefined,
    "https://learn.microsoft.com/en-us/Training/Modules/M/": true,
    "not a path": undefined,
    "/": undefined,
  };
  for (const [path, want] of Object.entries(expected)) assert.equal(isLive(path), want, path);
  // without a catalog or content file nothing is known
  assert.equal(makeIsLive({})("/training/modules/m"), undefined);
  assert.equal(makeIsLive({ catalog: catalog([]) })("/training/paths/lp"), undefined);
});

// ---------------------------------------------------------------------------
// raw probe
// ---------------------------------------------------------------------------

function fetchStub(routes, log = []) {
  return async (url, init) => {
    log.push({ url, init });
    const route = routes[url];
    const answer = typeof route === "function" ? route(log.filter((l) => l.url === url).length) : route;
    if (answer instanceof Error) throw answer;
    if (!answer) throw new TypeError(`no stub for ${url}`);
    return answer.clone ? answer.clone() : answer;
  };
}
const redirect = (location, status = 301) => new Response(null, { status, headers: { location } });
const page = (title, status = 200) => new Response(`<html><head><title>${title}</title></head></html>`, { status });
const U = (path) => `https://learn.microsoft.com/en-us${path}/`;

test("rawProbe follows redirects by hand and keeps the first hop's status", async () => {
  const log = [];
  const raw = await rawProbe("/training/modules/old", {
    sleepImpl: async () => {},
    fetchImpl: fetchStub(
      {
        [U("/training/modules/old")]: redirect("/en-us/training/modules/new/"),
        [U("/training/modules/new")]: () => page("New module - Training"),
      },
      log
    ),
  });
  assert.deepEqual(raw, {
    status: 200,
    firstStatus: 301,
    finalUrl: U("/training/modules/new"),
    title: "New module - Training",
    hops: [{ status: 301, location: U("/training/modules/new") }],
    offsite: false,
    error: null,
  });
  assert.equal(log.length, 2);
  for (const { init } of log) {
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers["User-Agent"], BROWSER_UA);
    assert.equal(init.headers.Accept, "text/html");
  }
  // a page that does not redirect
  const same = await rawProbe("/training/modules/x", { sleepImpl: async () => {}, fetchImpl: fetchStub({ [U("/training/modules/x")]: () => page("X") }) });
  assert.equal(same.firstStatus, 200);
  assert.deepEqual(same.hops, []);
  // a 404 has no title read
  const missing = await rawProbe("/training/modules/x", { sleepImpl: async () => {}, fetchImpl: fetchStub({ [U("/training/modules/x")]: () => page("whatever", 404) }) });
  assert.equal(missing.status, 404);
  assert.equal(missing.title, "");
});

test("rawProbe retries 429 honouring Retry-After and 5xx with backoff, then gives up as status null", async () => {
  const waits = [];
  const sleepImpl = async (ms) => waits.push(ms);
  const flaky = await rawProbe("/a", {
    sleepImpl,
    fetchImpl: fetchStub({
      [U("/a")]: (n) => (n === 1 ? new Response(null, { status: 429, headers: { "retry-after": "7" } }) : page("A")),
    }),
  });
  assert.equal(flaky.status, 200);
  assert.deepEqual(waits, [7000]);

  waits.length = 0;
  const down = await rawProbe("/b", { sleepImpl, retries: 3, fetchImpl: fetchStub({ [U("/b")]: () => new Response(null, { status: 503 }) }) });
  assert.deepEqual(waits, [3000, 6000]); // no pointless sleep after the last attempt
  assert.deepEqual(down, { status: null, firstStatus: null, finalUrl: null, title: "", hops: [], offsite: false, error: "no response after retries" });
  const limited = await rawProbe("/c", { sleepImpl, retries: 1, fetchImpl: fetchStub({ [U("/c")]: () => new Response(null, { status: 429 }) }) });
  assert.equal(limited.status, null);
});

test("rawProbe never throws: network errors, off-site hops, loops and bad Location headers", async () => {
  const waits = [];
  const sleepImpl = async (ms) => waits.push(ms);
  const net = await rawProbe("/n", { sleepImpl, retries: 3, fetchImpl: fetchStub({ [U("/n")]: new TypeError("fetch failed") }) });
  assert.equal(net.status, null);
  assert.equal(net.error, "no response after retries");
  assert.deepEqual(waits, [1500, 3000]);

  const off = await rawProbe("/o", { sleepImpl, fetchImpl: fetchStub({ [U("/o")]: redirect("https://example.com/elsewhere", 302) }) });
  assert.deepEqual(off, {
    status: 302,
    firstStatus: 302,
    finalUrl: "https://example.com/elsewhere",
    title: "",
    hops: [{ status: 302, location: "https://example.com/elsewhere" }],
    offsite: true,
    error: null,
  });

  const loop = await rawProbe("/l", {
    sleepImpl,
    maxHops: 2,
    fetchImpl: async (url) => redirect(url.endsWith("/l/") ? "/en-us/l2/" : "/en-us/l/", 302),
  });
  assert.equal(loop.status, null);
  assert.equal(loop.error, "too many redirects");
  assert.equal(loop.firstStatus, 302);
  assert.equal(loop.hops.length, 3);

  // a stub that throws something that is not even an Error, and a missing fetch
  const weird = await rawProbe("/w", { sleepImpl, retries: 1, fetchImpl: async () => { throw "boom"; } });
  assert.equal(weird.status, null);
  const none = await rawProbe("/w", { sleepImpl, retries: 1, fetchImpl: null });
  assert.equal(none.status, null);
});

test("probe() is built on rawProbe and keeps its verdicts", async () => {
  const sleepImpl = async () => {};
  assert.deepEqual(await probe("/training/modules/x", { sleepImpl, fetchImpl: fetchStub({ [U("/training/modules/x")]: () => page("x", 404) }) }), {
    verdict: "broken",
    detail: "HTTP 404",
    redirectsTo: null,
  });
  const removed = await probe("/training/modules/gone", {
    sleepImpl,
    fetchImpl: fetchStub({
      [U("/training/modules/gone")]: redirect("/en-us/training/browse/", 302),
      [U("/training/browse")]: () => page("Browse all training - Training"),
    }),
  });
  assert.equal(removed.verdict, "broken");
  assert.match(removed.detail, /Browse all training/);
  const moved = await probe("/azure/old", {
    sleepImpl,
    fetchImpl: fetchStub({ [U("/azure/old")]: redirect("/en-us/azure/new/"), [U("/azure/new")]: () => page("New") }),
  });
  assert.deepEqual(moved, { verdict: "moved", detail: "redirects to /azure/new", redirectsTo: "/azure/new" });
  assert.equal((await probe("/azure/a", { sleepImpl, fetchImpl: fetchStub({ [U("/azure/a")]: () => page("A") }) })).verdict, "ok");
  assert.deepEqual(await probe("/azure/a", { sleepImpl, retries: 1, fetchImpl: fetchStub({ [U("/azure/a")]: new TypeError("down") }) }), {
    verdict: "unknown",
    detail: "no response after retries",
    redirectsTo: null,
  });
});

// ---------------------------------------------------------------------------
// classifyLearnProbe
// ---------------------------------------------------------------------------

test("classifyLearnProbe: the same-kind rule per kind", () => {
  const ctx = { modulePaths: new Set(["/training/saas/x", "/training/saas/x2"]) };
  const M = "/training/modules/m";
  const cases = [
    // [kind, path, raw, expected outcome, expected to]
    ["module", M, served(M), "live", null],
    ["module", M, served("/training/modules/m2", { first: 301 }), "moved", "/training/modules/m2"],
    ["module", M, served("/training/browse", { title: "Browse all training - Training" }), "landing", "/training/browse"],
    ["module", M, served("/training/paths/some-path"), "landing", "/training/paths/some-path"],
    ["module", M, served("/azure/azure-resource-manager"), "landing", "/azure/azure-resource-manager"],
    ["module", M, served("/training"), "landing", "/training"],
    ["module", M, served(`${M}/1-introduction`), "moved", `${M}/1-introduction`], // its own first unit: still the same content
    ["module", M, served("/training/saas/x"), "moved", "/training/saas/x"], // a module published outside /training/modules/ (known from the catalog)
    ["unit", `${M}/05-ex`, served(`${M}/05-ex`), "live", null],
    ["unit", `${M}/05-ex`, served(`${M}/04-ex`, { first: 301 }), "moved", `${M}/04-ex`],
    ["unit", `${M}/05-ex`, served("/training/modules/renamed/05-ex", { first: 301 }), "moved", "/training/modules/renamed/05-ex"],
    ["unit", `${M}/05-ex`, served("/training/saas/x/1-a"), "moved", "/training/saas/x/1-a"],
    ["unit", `${M}/05-ex`, served(M), "landing", M], // a unit that lands on its module root is NOT moved
    ["unit", `${M}/05-ex`, served("/training/modules/other"), "landing", "/training/modules/other"],
    ["unit", `${M}/05-ex`, served("/training/browse"), "landing", "/training/browse"],
    ["unit", `${M}/05-ex`, served("/training/paths/lp"), "landing", "/training/paths/lp"],
    ["unit", "/training/saas/x/1-a", served("/training/saas/x"), "landing", "/training/saas/x"],
    ["learning-path", "/training/paths/a", served("/training/paths/b"), "moved", "/training/paths/b"],
    ["learning-path", "/training/paths/a", served("/training/browse"), "landing", "/training/browse"],
    ["learning-path", "/training/paths/a", served("/training/modules/m"), "landing", "/training/modules/m"],
    ["course", "/training/courses/a", served("/training/courses/b"), "moved", "/training/courses/b"],
    ["course", "/training/courses/a", served("/training/browse"), "landing", "/training/browse"],
    ["certification", "/credentials/certifications/a", served("/credentials/certifications/b"), "moved", "/credentials/certifications/b"],
    ["certification", "/credentials/certifications/a", served("/credentials/browse"), "landing", "/credentials/browse"],
    ["certification", "/credentials/certifications/a", served("/credentials/certifications/exams/az-1"), "landing", "/credentials/certifications/exams/az-1"],
    ["applied-skill", "/credentials/applied-skills/a", served("/credentials/applied-skills/b"), "moved", "/credentials/applied-skills/b"],
    ["applied-skill", "/credentials/applied-skills/a", served("/credentials/browse"), "landing", "/credentials/browse"],
    // exams: a current exam URL redirecting to its certification page is healthy
    ["exam", "/credentials/certifications/exams/az-104", served("/credentials/certifications/azure-administrator"), "live", null],
    ["exam", "/credentials/certifications/exams/az-104", served("/credentials/certifications/exams/az-104"), "live", null],
    ["exam", "/credentials/certifications/exams/az-104", served("/credentials/certifications/exams/az-105"), "moved", "/credentials/certifications/exams/az-105"],
    ["exam", "/credentials/certifications/exams/az-104", served("/credentials/browse"), "landing", "/credentials/browse"],
    // a study guide that redirects does not exist
    ["study-guide", guidePath("az-1"), served(guidePath("az-1")), "live", null],
    ["study-guide", guidePath("az-1"), served("/credentials/browse", { first: 302 }), "gone", null],
    ["study-guide", guidePath("az-1"), served(guidePath("az-2")), "gone", null],
    // definitive misses
    ["unit", `${M}/05-ex`, NOT_FOUND, "gone", null],
    ["module", M, { ...NOT_FOUND, status: 410, firstStatus: 410 }, "gone", null],
    ["module", M, served(M, { title: "404 - Content not found" }), "gone", null],
    ["module", M, served("/training/browse", { title: "404" }), "gone", null],
    // off-site: not the same kind of page
    ["module", M, { status: 301, firstStatus: 301, finalUrl: "https://example.com/x", title: "", hops: [], offsite: true, error: null }, "landing", null],
    // never conclusions
    ["module", M, BLOCKED, "transient", null],
    ["module", M, { status: 429, firstStatus: 429, finalUrl: "x" }, "transient", null],
    ["module", M, { status: 503, finalUrl: "x" }, "transient", null],
    ["module", M, { status: 403, finalUrl: "x" }, "transient", null],
    ["module", M, { status: 200, finalUrl: "not a url", title: "" }, "transient", null],
    ["module", M, { status: 200, finalUrl: null, title: "" }, "transient", null],
    ["module", M, { status: 200, finalUrl: served(M).finalUrl, error: "something" }, "transient", null],
    ["module", M, null, "transient", null],
    ["module", M, undefined, "transient", null],
  ];
  for (const [kind, path, raw, outcome, to] of cases) {
    const got = classifyLearnProbe(kind, path, raw, ctx);
    assert.equal(got.outcome, outcome, `${kind} ${path} -> ${raw?.finalUrl}`);
    assert.equal(got.to, to, `${kind} ${path} -> ${raw?.finalUrl}`);
  }
  // without the catalog's module paths a /training/saas module is not recognised: conservative landing
  assert.equal(classifyLearnProbe("module", M, served("/training/saas/x")).outcome, "landing");
  // the array form of modulePaths works too
  assert.equal(classifyLearnProbe("module", M, served("/training/saas/x"), { modulePaths: ["/training/saas/x"] }).outcome, "moved");
});

test("classifyLearnProbe: status is the first hop's, docs kinds are not accepted", () => {
  const M = "/training/modules/m";
  assert.equal(classifyLearnProbe("module", M, served("/training/modules/m2", { first: 301 })).status, 301);
  assert.equal(classifyLearnProbe("module", M, { ...NOT_FOUND, firstStatus: 302 }).status, 302);
  assert.equal(classifyLearnProbe("module", M, { ...NOT_FOUND, firstStatus: undefined }).status, 404);
  assert.equal(classifyLearnProbe("module", M, served("/training/browse"), {}).status, 200);
  assert.equal(classifyLearnProbe("module", M, { status: 429 }).status, 429);
  assert.equal(classifyLearnProbe("module", M, BLOCKED).status, null);
  assert.throws(() => classifyLearnProbe("docs", "/azure/x", served("/azure/x")), TypeError);
  assert.throws(() => classifyLearnProbe("page", "/azure/x", served("/azure/x")), TypeError);
});

// ---------------------------------------------------------------------------
// applyChanges
// ---------------------------------------------------------------------------

test("applyChanges: a first run with no previous files records unverified entries", () => {
  const candidates = [cand("/training/modules/m", { title: "M" }), unitCand("/training/modules/x/01-a", "/training/modules/x")];
  for (const previous of [undefined, null, emptyChanges()]) {
    const out = apply({ previous, candidates, results: new Map() });
    assert.deepEqual(out.moved.entries, []);
    assert.deepEqual(out.removed.entries, [
      { path: "/training/modules/m", kind: "module", family: "learn", outcome: "unverified", to: null, title: "M", parent: null, firstSeen: "2026-10-05", lastVerified: null, evidence: "tombstone", status: null },
      { path: "/training/modules/x/01-a", kind: "unit", family: "learn", outcome: "unverified", to: null, title: null, parent: "/training/modules/x", firstSeen: "2026-10-05", lastVerified: null, evidence: "unit-diff", status: null },
    ]);
    assert.equal(out.removed.generatedAt, NOW);
    assert.deepEqual(out.removed.sources, { learn: NOW, docs: null });
    assert.deepEqual(out.moved.sources, { learn: NOW, docs: null });
    assert.equal(out.moved.generatedAt, NOW);
  }
  // a candidate without a firstSeen is dated today
  const undated = apply({ candidates: [{ path: "/training/modules/q", kind: "module", evidence: "hierarchy-not-found" }] });
  assert.equal(undated.removed.entries[0].firstSeen, TODAY);
});

test("applyChanges: results classify entries, set to/status/lastVerified and route them to the right file", () => {
  const out = apply({
    candidates: [cand("/training/modules/a"), cand("/training/modules/b"), unitCand("/training/modules/c/01-x", "/training/modules/c")],
    results: new Map([
      ["/training/modules/a", R("moved", "/training/modules/a2", 301)],
      ["/training/modules/b", R("gone", "/ignored", 404)],
      ["/training/modules/c/01-x", R("landing", "/training/modules/c", 200)],
    ]),
  });
  assert.deepEqual(pathsOf(out.moved), ["/training/modules/a"]);
  assert.deepEqual(out.moved.entries[0], {
    path: "/training/modules/a",
    kind: "module",
    family: "learn",
    outcome: "moved",
    to: "/training/modules/a2",
    title: null,
    parent: null,
    firstSeen: "2026-10-05",
    lastVerified: TODAY,
    evidence: "tombstone",
    status: 301,
  });
  assert.deepEqual(pathsOf(out.removed), ["/training/modules/b", "/training/modules/c/01-x"]);
  assert.deepEqual([out.removed.entries[0].outcome, out.removed.entries[0].to, out.removed.entries[0].status], ["gone", null, 404]);
  assert.deepEqual([out.removed.entries[1].outcome, out.removed.entries[1].to, out.removed.entries[1].lastVerified], ["landing", "/training/modules/c", TODAY]);
  // results may also be a plain object or an array
  const asObject = apply({ candidates: [cand("/training/modules/a")], results: { "/training/modules/a": R("gone", null, 404) } });
  assert.equal(asObject.removed.entries[0].outcome, "gone");
  const asArray = apply({ candidates: [cand("/training/modules/a")], results: [{ path: "/training/modules/a", ...R("gone", null, 404) }] });
  assert.equal(asArray.removed.entries[0].outcome, "gone");
});

test("applyChanges: a transient result leaves the entry unverified, the next run retries and keeps firstSeen", () => {
  const P = "/training/modules/p";
  const run1 = apply({ candidates: [cand(P)], results: new Map([[P, R("transient", null, 429)]]) });
  assert.deepEqual(
    [run1.removed.entries[0].outcome, run1.removed.entries[0].lastVerified, run1.removed.entries[0].status],
    ["unverified", null, null]
  );
  // a later run: no candidate any more (the diff only fires once), the probe now succeeds
  const run2 = applyChanges({ previous: run1, candidates: [], results: new Map([[P, R("gone", null, 404)]]), today: "2026-10-13", generatedAt: "2026-10-13T08:00:00.000Z", isLive: () => undefined });
  assert.deepEqual(run2.removed.entries[0], {
    path: P,
    kind: "module",
    family: "learn",
    outcome: "gone",
    to: null,
    title: null,
    parent: null,
    firstSeen: "2026-10-05",
    lastVerified: "2026-10-13",
    evidence: "tombstone",
    status: 404,
  });
  // a transient result never touches an entry that was verified before
  const verified = changesOf([E(P, { outcome: "landing", to: "/training/browse", status: 200, lastVerified: "2026-09-20" })]);
  const same = apply({ previous: verified, candidates: [], results: new Map([[P, R("transient", null, 503)]]) });
  assert.equal(find(same, P).lastVerified, "2026-09-20");
  assert.equal(find(same, P).outcome, "landing");
});

test("applyChanges: a known entry is upserted, never downgraded or re-dated", () => {
  const P = "/training/modules/p";
  const previous = changesOf([E(P, { outcome: "landing", to: "/training/browse", status: 200, firstSeen: "2026-09-01", lastVerified: "2026-09-20", title: null })]);
  // the hierarchy-not-found candidate shows up again every run
  const out = apply({ previous, candidates: [cand(P, { evidence: "hierarchy-not-found", firstSeen: "2026-10-06", title: "Better title" })], results: new Map() });
  assert.deepEqual(find(out, P), {
    path: P,
    kind: "module",
    family: "learn",
    outcome: "landing",
    to: "/training/browse",
    title: "Better title", // only fills a gap
    parent: null,
    firstSeen: "2026-09-01",
    lastVerified: "2026-09-20",
    evidence: "tombstone",
    status: 200,
  });
});

test("applyChanges: an entry moves between the files when its outcome changes (moved then removed, and back)", () => {
  const P = "/training/modules/p";
  const moved = changesOf([], [E(P, { outcome: "moved", to: "/training/modules/q", status: 301 })]);
  const toRemoved = apply({ previous: moved, candidates: [], results: new Map([[P, R("gone", null, 404)]]) });
  assert.deepEqual(pathsOf(toRemoved.moved), []);
  assert.deepEqual([find(toRemoved, P).outcome, find(toRemoved, P).to, find(toRemoved, P).lastVerified], ["gone", null, TODAY]);
  const back = apply({ previous: toRemoved, candidates: [], results: new Map([[P, R("moved", "/training/modules/r", 302)]]) });
  assert.deepEqual(pathsOf(back.removed), []);
  assert.deepEqual([find(back, P).outcome, find(back, P).to], ["moved", "/training/modules/r"]);
});

test("applyChanges: resurrection by the catalog, by unitUrls and by a live probe", () => {
  const previous = changesOf(
    [
      E("/training/modules/m"),
      E("/training/modules/n/01-x", { kind: "unit", parent: "/training/modules/n", evidence: "unit-diff" }),
      E("/training/modules/n/02-gone", { kind: "unit", parent: "/training/modules/n", evidence: "unit-diff" }),
      E("/training/paths/lp", { kind: "learning-path" }),
    ],
    [E("/training/modules/o", { outcome: "moved", to: "/training/modules/o2", status: 301 })]
  );
  const isLive = makeIsLive({
    catalog: catalog([mod("m", ["01-a"]), mod("n", ["01-x", "02-y"]), mod("o2")]),
    content: content({ learningPaths: [{ path: "/training/paths/lp" }] }),
  });
  const detail = applyChangesDetailed({ today: TODAY, generatedAt: NOW, previous, candidates: [], results: new Map(), isLive });
  assert.deepEqual(detail.resurrected, ["/training/modules/m", "/training/modules/n/01-x", "/training/paths/lp"]);
  assert.deepEqual(pathsOf(detail.changes.removed), ["/training/modules/n/02-gone"]);
  assert.deepEqual(pathsOf(detail.changes.moved), ["/training/modules/o"]); // not in the catalog: stays

  // a live probe that finds the path served on its own canonical path resurrects it too
  const probed = apply({ previous, candidates: [], results: new Map([["/training/modules/o", R("live")]]) });
  assert.deepEqual(pathsOf(probed.moved), []);
  // the isLive predicate must say exactly `true`: undefined and false are "no opinion" / "not there"
  const kept = apply({ previous, candidates: [], isLive: (p) => (p === "/training/modules/m" ? 1 : false) });
  assert.equal(all(kept).length, 5);
});

test("applyChanges: a listed module whose hierarchy is unreadable (unitUrls null) does not resurrect a classified entry; one hierarchy answer later it does", () => {
  const P = "/training/modules/p";
  const previous = changesOf([E(P, { outcome: "landing", to: "/training/paths/x", status: 301, firstSeen: "2026-10-05", lastVerified: "2026-10-05", evidence: "hierarchy-not-found" })]);
  // the hierarchy API answered with something that is no definitive "module_id_not_found" (a bare 404, a 403, a bad shape): the flag is gone, unitUrls is null
  const unreadable = makeIsLive({ catalog: catalog([mod("p", null)]) });
  assert.equal(unreadable(P), undefined);
  const kept = applyChangesDetailed({ today: TODAY, generatedAt: NOW, previous, candidates: [], results: new Map(), isLive: unreadable });
  assert.deepEqual(kept.resurrected, []);
  assert.deepEqual(find(kept.changes, P), previous.removed.entries[0], "the entry is exactly as the probe left it: firstSeen, evidence, destination");
  // the hierarchy answers again: now the cache really knows the module is served
  const readable = makeIsLive({ catalog: catalog([mod("p", ["01-a"])]) });
  assert.deepEqual(applyChangesDetailed({ today: TODAY, generatedAt: NOW, previous, candidates: [], results: new Map(), isLive: readable }).resurrected, [P]);
  // a live probe settles it either way
  const probed = apply({ previous, candidates: [], results: new Map([[P, R("live")]]), isLive: unreadable });
  assert.deepEqual(all(probed), []);
  // a tombstone candidate for a path that a module with an unreadable hierarchy occupies is recorded `unverified` (a probe decides), not suppressed
  const occupied = apply({ candidates: [cand(P)], isLive: unreadable });
  assert.deepEqual(all(occupied).map((e) => [e.path, e.outcome]), [[P, "unverified"]]);
});

test("applyChanges: a candidate whose path is live (a different module took the path over) is ignored", () => {
  const out = apply({ candidates: [cand("/training/modules/m"), cand("/training/modules/q")], isLive: (p) => p === "/training/modules/m" });
  assert.deepEqual(pathsOf(out.removed), ["/training/modules/q"]);
  const byProbe = apply({ candidates: [cand("/training/modules/m")], results: new Map([["/training/modules/m", R("live")]]) });
  assert.deepEqual(all(byProbe), []);
});

test("applyChanges: a classified removed module covers its unit entries; an unverified or a moved module does not", () => {
  const M = "/training/modules/m";
  const units = [
    E(`${M}/01-a`, { kind: "unit", parent: M, evidence: "unit-diff" }),
    E(`${M}/02-b`, { kind: "unit", parent: M, evidence: "unit-diff", outcome: "landing", to: M }),
    E("/training/modules/other/01-a", { kind: "unit", parent: "/training/modules/other", evidence: "unit-diff" }),
  ];
  const previous = changesOf(units);
  const withResult = (result) =>
    applyChangesDetailed({
      today: TODAY,
      generatedAt: NOW,
      previous,
      candidates: [cand(M)],
      results: result ? new Map([[M, result]]) : new Map(),
      isLive: () => undefined,
    });
  for (const result of [R("gone", null, 404), R("landing", "/training/browse")]) {
    const detail = withResult(result);
    assert.deepEqual(pathsOf(detail.changes.removed), [M, "/training/modules/other/01-a"], JSON.stringify(result));
    assert.deepEqual(detail.covered, [`${M}/01-a`, `${M}/02-b`]);
  }
  const retired = apply({ previous: changesOf([E(M, { outcome: "retired", to: "/previous-versions/x" }), ...units]), candidates: [] });
  assert.deepEqual(pathsOf(retired.removed), [M, "/training/modules/other/01-a"]);
  // unverified (a transient probe, no probe at all): the module entry may be false (an API flap), and units dropped
  // under it would never be re-derived, so they stand until the module is classified
  for (const result of [R("transient", null, 429), null]) {
    const detail = withResult(result);
    assert.deepEqual(pathsOf(detail.changes.removed), [M, `${M}/01-a`, `${M}/02-b`, "/training/modules/other/01-a"], JSON.stringify(result));
    assert.deepEqual(detail.covered, []);
    assert.equal(find(detail.changes, M).outcome, "unverified");
  }
  // ... and once the module came back (the flap is over) its own entry goes and the unit entries are still there
  const flapped = apply({ previous, candidates: [cand(M)] });
  const back = apply({ previous: flapped, candidates: [], isLive: (p) => (p === M ? true : p.startsWith(`${M}/`) ? false : undefined) });
  assert.deepEqual(pathsOf(back.removed), [`${M}/01-a`, `${M}/02-b`, "/training/modules/other/01-a"]);
  // moved: the units stay (they are individual facts about renamed slugs)
  const moved = apply({ previous, candidates: [cand(M)], results: new Map([[M, R("moved", "/training/modules/m2", 301)]]) });
  assert.deepEqual(pathsOf(moved.moved), [M]);
  assert.deepEqual(pathsOf(moved.removed), [`${M}/01-a`, `${M}/02-b`, "/training/modules/other/01-a"]);
  // a unit candidate under a module is dropped in the same run only when that module's removal is classified
  const same = apply({ candidates: [cand(M), unitCand(`${M}/03-c`, M)], results: new Map([[M, R("gone", null, 404)]]) });
  assert.deepEqual(pathsOf(same.removed), [M]);
  const pending = apply({ candidates: [cand(M), unitCand(`${M}/03-c`, M)], results: new Map() });
  assert.deepEqual(pathsOf(pending.removed), [M, `${M}/03-c`]);
  // only modules cover units: a removed learning path with a similar prefix covers nothing
  const lp = apply({ previous: changesOf([E("/training/modules/x/01", { kind: "unit", parent: "/training/modules/x", evidence: "unit-diff" })]), candidates: [cand("/training/modules/x-y")] });
  assert.equal(all(lp).length, 2);
});

test("applyChanges: the other family's entries pass through untouched", () => {
  const docsGone = docsEntry("/azure/old", { firstSeen: "2026-09-10" });
  const docsMoved = docsEntry("/azure/moved", { outcome: "moved", to: "/azure/new", evidence: "docs-redirect", status: 301 });
  const previous = changesOf([docsGone, E("/training/modules/m")], [docsMoved]);
  const out = apply({ previous, candidates: [cand("/training/modules/n")], results: new Map([["/training/modules/m", R("moved", "/training/modules/m2", 301)]]) });
  assert.deepEqual(find(out, "/azure/old"), previous.removed.entries.find((e) => e.path === "/azure/old"));
  assert.deepEqual(find(out, "/azure/moved"), previous.moved.entries[0]);
  assert.deepEqual(out.removed.sources, { learn: NOW, docs: "2026-09-29T09:00:00.000Z" });
  assert.equal(find(out, "/training/modules/m").outcome, "moved");
  // a docs probe result for a learn run is not applied to docs entries
  const ignored = apply({ previous, candidates: [], results: new Map([["/azure/old", R("live")]]) });
  assert.ok(find(ignored, "/azure/old"));
});

test("applyChanges is deterministic and idempotent", () => {
  const candidates = [
    cand("/training/modules/z"),
    cand("/training/modules/a", { evidence: "rename" }),
    cand("/training/modules/a", { evidence: "tombstone" }), // same path twice: the strongest evidence wins, whatever the order
    unitCand("/training/modules/k/09-u", "/training/modules/k"),
    cand("/training/paths/lp", { kind: "learning-path" }),
  ];
  const results = new Map([
    ["/training/modules/z", R("gone", null, 404)],
    ["/training/modules/a", R("moved", "/training/modules/a2", 301)],
  ]);
  const previous = changesOf([E("/training/modules/old", { lastVerified: "2026-09-02" })], [E("/training/modules/oldmoved", { outcome: "moved", to: "/training/modules/x", status: 301 })]);
  const first = apply({ previous, candidates, results });
  const shuffled = apply({ previous, candidates: [...candidates].reverse(), results });
  assert.equal(JSON.stringify(first), JSON.stringify(shuffled));
  assert.equal(find(first, "/training/modules/a").evidence, "tombstone");
  const second = apply({ previous: first, candidates, results });
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  // and writing it twice gives the same bytes
  const dir = mkdtempSync(join(tmpdir(), "changes-"));
  const w1 = writeChanges(dir, first);
  const bytes = readFileSync(w1.removed, "utf-8") + readFileSync(w1.moved, "utf-8");
  writeChanges(dir, loadChanges(dir));
  assert.equal(readFileSync(w1.removed, "utf-8") + readFileSync(w1.moved, "utf-8"), bytes);
});

test("applyChanges: lastVerified is today only when a probe classified the entry; bad input throws", () => {
  const out = apply({ candidates: [cand("/training/modules/a"), cand("/training/modules/b")], results: new Map([["/training/modules/a", R("gone", null, 404)]]) });
  assert.equal(find(out, "/training/modules/a").lastVerified, TODAY);
  assert.equal(find(out, "/training/modules/b").lastVerified, null);
  // malformed candidates are skipped, not fatal
  const messy = apply({
    candidates: [null, { path: "/training/modules/ok", kind: "module", evidence: "tombstone" }, { path: "/training/modules/x", kind: "docs", evidence: "tombstone" }, { path: "bad", kind: "module", evidence: "tombstone" }, { path: "/training/modules/y", kind: "module", evidence: "nope" }],
  });
  assert.deepEqual(pathsOf(messy.removed), ["/training/modules/ok"]);
  assert.throws(() => applyChanges({ today: "yesterday", generatedAt: NOW }), TypeError);
  assert.throws(() => applyChanges({ today: TODAY, generatedAt: "now" }), TypeError);
  assert.throws(() => applyChanges({ today: TODAY, generatedAt: NOW, family: "other" }), TypeError);
});

// ---------------------------------------------------------------------------
// verification queue
// ---------------------------------------------------------------------------

function queueLedger() {
  return changesOf(
    [
      E("/training/modules/u1", { outcome: "unverified", firstSeen: "2026-09-30", lastVerified: null, status: null }),
      E("/training/modules/u2", { outcome: "unverified", firstSeen: "2026-09-20", lastVerified: null, status: null }),
      E("/training/modules/r1", { lastVerified: "2026-08-01" }),
      E("/training/modules/r2", { lastVerified: "2026-09-01" }),
      E("/training/modules/r3", { lastVerified: null }),
      E("/training/modules/today", { lastVerified: TODAY }),
      docsEntry("/azure/docs-old"),
    ],
    [
      E("/training/modules/m1", { outcome: "moved", to: "/training/modules/r1", status: 301, lastVerified: "2026-09-15" }),
      E("/training/modules/m2", { outcome: "moved", to: "/training/modules/live", status: 301, lastVerified: "2026-07-01" }),
    ]
  );
}

test("verificationQueue: unverified first, then moved entries whose destination changed, then the oldest lastVerified", () => {
  const ledger = queueLedger();
  const plan = planVerification(ledger, { today: TODAY, limit: 100, reverifyLimit: 100 });
  assert.deepEqual(
    plan.queue.map((q) => [q.path.replace("/training/modules/", ""), q.reason]),
    [
      ["u2", "unverified"], // oldest firstSeen first
      ["u1", "unverified"],
      ["m1", "collapse"], // its destination r1 is itself a removed entry
      ["r3", "reverify"], // never verified
      ["m2", "reverify"],
      ["r1", "reverify"],
      ["r2", "reverify"],
    ]
  );
  assert.ok(plan.queue.every((q) => q.kind === "module"));
  assert.deepEqual([plan.truncated, plan.wanted], [false, 7]);
  // docs entries and entries verified today are never in the queue
  assert.ok(!plan.queue.some((q) => q.path === "/training/modules/today" || q.path.startsWith("/azure")));
  assert.deepEqual(verificationQueue(ledger, { today: TODAY }), plan.queue);

  // reverifyLimit caps only the rotation
  assert.deepEqual(
    verificationQueue(ledger, { today: TODAY, reverifyLimit: 2 }).map((q) => q.reason),
    ["unverified", "unverified", "collapse", "reverify", "reverify"]
  );
  assert.equal(verificationQueue(ledger, { today: TODAY, reverifyLimit: 0 }).length, 3);
  // limit caps everything, in priority order
  const cut = planVerification(ledger, { today: TODAY, limit: 4 });
  assert.deepEqual(cut.queue.map((q) => q.path.replace("/training/modules/", "")), ["u2", "u1", "m1", "r3"]);
  assert.deepEqual([cut.truncated, cut.wanted], [true, 7]);
  assert.deepEqual(planVerification(ledger, { today: TODAY, limit: 0 }).queue, []);
  assert.equal(planVerification(ledger, { today: TODAY, limit: 0 }).truncated, true);
  // exclude drops what a round already handled
  assert.ok(!verificationQueue(ledger, { today: TODAY, exclude: new Set(["/training/modules/u2"]) }).some((q) => q.path === "/training/modules/u2"));
  // without `today` nothing counts as verified today
  assert.ok(verificationQueue(ledger, {}).some((q) => q.path === "/training/modules/today"));
});

test("verificationQueue: the units of an unverified module wait for the module's result (no tier, rotation included); a classified module does not hold them", () => {
  const M = "/training/modules/m";
  const unit = (slug, over = {}) => E(`${M}/${slug}`, { kind: "unit", parent: M, evidence: "unit-diff", lastVerified: "2026-08-01", ...over });
  const waiting = changesOf([
    E(M, { outcome: "unverified", firstSeen: "2026-10-01", lastVerified: null, status: null }),
    unit("01-a", { outcome: "unverified", lastVerified: null, status: null }),
    unit("02-b"),
    E("/training/modules/other/01-a", { kind: "unit", parent: "/training/modules/other", evidence: "unit-diff", lastVerified: "2026-08-02" }),
  ]);
  assert.deepEqual(verificationQueue(waiting, { today: TODAY }).map((q) => [q.path.replace("/training/modules/", ""), q.reason]), [["m", "unverified"], ["other/01-a", "reverify"]]);
  // a module that a round already probed (it comes back as `exclude`) still counts as pending: its units do not jump the queue
  assert.deepEqual(verificationQueue(waiting, { today: TODAY, exclude: new Set([M]) }).map((q) => q.path), ["/training/modules/other/01-a"]);
  // the module is classified as moved: its units are ordinary entries again (here: re-verified by rotation, the unverified one first)
  const moved = changesOf([unit("01-a", { outcome: "unverified", lastVerified: null, status: null }), unit("02-b")], [E(M, { outcome: "moved", to: "/training/modules/m2", status: 301, lastVerified: TODAY })]);
  assert.deepEqual(verificationQueue(moved, { today: TODAY }).map((q) => [q.path.replace(`${M}/`, ""), q.reason]), [["01-a", "unverified"], ["02-b", "reverify"]]);
});

test("verificationQueue: a destination that is gone from the cache (isLive false) or covered by a removed module is a collapse", () => {
  const ledger = queueLedger();
  const queue = verificationQueue(ledger, { today: TODAY, reverifyLimit: 0, isLive: (p) => (p === "/training/modules/live" ? false : undefined) });
  assert.deepEqual(queue.map((q) => [q.path.replace("/training/modules/", ""), q.reason]), [["u2", "unverified"], ["u1", "unverified"], ["m1", "collapse"], ["m2", "collapse"]]);
  // undefined is "no opinion", true is fine
  assert.equal(verificationQueue(ledger, { today: TODAY, reverifyLimit: 0, isLive: () => undefined }).length, 3);
  assert.equal(verificationQueue(ledger, { today: TODAY, reverifyLimit: 0, isLive: () => true }).length, 3);

  const covered = changesOf(
    [E("/training/modules/dead")],
    [E("/training/modules/m1", { kind: "unit", outcome: "moved", to: "/training/modules/dead/01-a", status: 301, lastVerified: TODAY })]
  );
  assert.deepEqual(verificationQueue(covered, { today: TODAY, reverifyLimit: 0 }).map((q) => q.reason), ["collapse"]);
  // a moved entry whose destination moved again
  const chained = changesOf([], [
    E("/training/modules/a", { outcome: "moved", to: "/training/modules/b", status: 301, lastVerified: TODAY }),
    E("/training/modules/b", { outcome: "moved", to: "/training/modules/c", status: 301, lastVerified: TODAY }),
  ]);
  assert.deepEqual(verificationQueue(chained, { today: TODAY, reverifyLimit: 0 }).map((q) => q.path), ["/training/modules/a"]);
});

// ---------------------------------------------------------------------------
// refreshLearnChanges
// ---------------------------------------------------------------------------

const refresh = (over) =>
  refreshLearnChanges({ previous: emptyChanges(), today: TODAY, generatedAt: NOW, delayMs: 0, isLive: () => undefined, limits: { maxProbes: 50, reverifyPerRun: 10 }, ...over });

test("refreshLearnChanges: probes the queue, classifies, and reports stats", async () => {
  const calls = [];
  const out = await refresh({
    candidates: [cand("/training/modules/a"), cand("/training/modules/b"), cand("/training/modules/c")],
    probe: stubProbe(
      {
        "/training/modules/a": served("/training/modules/a2", { first: 301 }),
        "/training/modules/b": NOT_FOUND,
        "/training/modules/c": served("/training/browse", { title: "Browse all training" }),
      },
      calls
    ),
  });
  assert.deepEqual(calls, ["/training/modules/a", "/training/modules/b", "/training/modules/c"]);
  assert.deepEqual(out.stats, { newRemoved: 2, newMoved: 1, resurrected: 0, unverified: 0, probed: 3, probeBudgetExhausted: false, transient: 0, stoppedEarly: false, covered: 0 });
  assert.deepEqual(find(out.changes, "/training/modules/a"), {
    path: "/training/modules/a",
    kind: "module",
    family: "learn",
    outcome: "moved",
    to: "/training/modules/a2",
    title: null,
    parent: null,
    firstSeen: "2026-10-05",
    lastVerified: TODAY,
    evidence: "tombstone",
    status: 301,
  });
  assert.deepEqual([find(out.changes, "/training/modules/b").outcome, find(out.changes, "/training/modules/b").status], ["gone", 404]);
  assert.deepEqual([find(out.changes, "/training/modules/c").outcome, find(out.changes, "/training/modules/c").to], ["landing", "/training/browse"]);
});

test("refreshLearnChanges: at most 3 workers and the configured pause per worker", async () => {
  const candidates = Array.from({ length: 10 }, (_, i) => cand(`/training/modules/m${String(i).padStart(2, "0")}`));
  const flight = { now: 0, max: 0 };
  const probe = async () => {
    flight.max = Math.max(flight.max, ++flight.now);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flight.now--;
    return NOT_FOUND;
  };
  const out = await refresh({ candidates, probe, workers: 8 });
  assert.equal(out.stats.probed, 10);
  assert.equal(flight.max, 3);
  flight.max = 0;
  await refresh({ candidates, probe, workers: 1 });
  assert.equal(flight.max, 1);

  const sleeps = [];
  await refresh({ candidates: candidates.slice(0, 3), probe: async () => NOT_FOUND, workers: 1, delayMs: 500, sleepImpl: async (ms) => sleeps.push(ms) });
  assert.deepEqual(sleeps, [500, 500]); // between probes, not after the last
});

test("refreshLearnChanges: the probe budget leaves the rest unverified and says so", async () => {
  const candidates = ["a", "b", "c", "d", "e"].map((s) => cand(`/training/modules/${s}`));
  const calls = [];
  const out = await refresh({ candidates, probe: stubProbe({ "/training/modules/a": NOT_FOUND, "/training/modules/b": NOT_FOUND }, calls), limits: { maxProbes: 2, reverifyPerRun: 0 } });
  assert.deepEqual(calls, ["/training/modules/a", "/training/modules/b"]);
  assert.equal(out.stats.probed, 2);
  assert.equal(out.stats.probeBudgetExhausted, true);
  assert.equal(out.stats.unverified, 3);
  assert.deepEqual(out.changes.removed.entries.map((e) => e.outcome), ["gone", "gone", "unverified", "unverified", "unverified"]);

  // a budget of zero never calls the probe (and needs none)
  const none = await refresh({ candidates, limits: { maxProbes: 0, reverifyPerRun: 0 } });
  assert.deepEqual([none.stats.probed, none.stats.unverified, none.stats.probeBudgetExhausted], [0, 5, true]);
  // a probe that is required but missing is a programming error
  await assert.rejects(() => refresh({ candidates }), TypeError);
});

test("refreshLearnChanges: transient answers and a throwing probe leave entries unverified; a rate limit storm stops the run", async () => {
  const candidates = ["a", "b", "c", "d", "e", "f"].map((s) => cand(`/training/modules/${s}`));
  const calls = [];
  const storm = await refresh({ candidates, probe: stubProbe({}, calls), workers: 1, consecutiveTransientLimit: 3 });
  assert.equal(calls.length, 3);
  assert.deepEqual([storm.stats.probed, storm.stats.transient, storm.stats.stoppedEarly, storm.stats.unverified], [3, 3, true, 6]);
  assert.ok(storm.changes.removed.entries.every((e) => e.outcome === "unverified" && e.lastVerified === null));

  const throwing = await refresh({ candidates: [cand("/training/modules/a")], probe: async () => { throw new Error("boom"); } });
  assert.deepEqual([throwing.stats.transient, throwing.stats.unverified, throwing.stats.stoppedEarly], [1, 1, false]);

  // one success resets the streak
  const mixed = await refresh({
    candidates,
    workers: 1,
    consecutiveTransientLimit: 3,
    probe: async (p) => (p.endsWith("/c") ? NOT_FOUND : BLOCKED),
  });
  assert.equal(mixed.stats.stoppedEarly, false);
  assert.equal(mixed.stats.probed, 6);
  // a storm that ends exactly with the last probe left nothing unstarted
  assert.equal(mixed.stats.transient, 5);
  // the next run retries exactly the unverified ones
  calls.length = 0;
  const retry = await refresh({ previous: mixed.changes, candidates: [], probe: stubProbe({ "/training/modules/a": NOT_FOUND }, calls), limits: { maxProbes: 50, reverifyPerRun: 0 } });
  assert.deepEqual(calls.sort(), ["/training/modules/a", "/training/modules/b", "/training/modules/d", "/training/modules/e", "/training/modules/f"]);
  assert.equal(retry.stats.unverified, 4);
});

test("refreshLearnChanges: a module that turns out to be moved gets its unit entries probed in a second round", async () => {
  const M = "/training/modules/m";
  const previous = changesOf([
    E(`${M}/01-a`, { kind: "unit", parent: M, evidence: "unit-diff", outcome: "unverified", lastVerified: null, status: null }),
    E(`${M}/02-b`, { kind: "unit", parent: M, evidence: "unit-diff", outcome: "unverified", lastVerified: null, status: null }),
  ]);
  const calls = [];
  const probe = stubProbe(
    {
      [M]: served("/training/modules/m2", { first: 301 }),
      [`${M}/01-a`]: served("/training/modules/m2/01-a", { first: 301 }),
      [`${M}/02-b`]: served("/training/modules/m2/02-b", { first: 301 }),
    },
    calls
  );
  const out = await refresh({ previous, candidates: [cand(M, { evidence: "rename" })], probe, workers: 1 });
  assert.deepEqual(calls, [M, `${M}/01-a`, `${M}/02-b`]);
  assert.deepEqual(pathsOf(out.changes.removed), []);
  assert.deepEqual(out.changes.moved.entries.map((e) => [e.path, e.to]), [[M, "/training/modules/m2"], [`${M}/01-a`, "/training/modules/m2/01-a"], [`${M}/02-b`, "/training/modules/m2/02-b"]]);
  assert.deepEqual([out.stats.newMoved, out.stats.newRemoved, out.stats.probed, out.stats.covered], [3, 0, 3, 0]);

  // a second run with the same input changes nothing and probes nothing (idempotent)
  calls.length = 0;
  const again = await refresh({ previous: out.changes, candidates: [cand(M, { evidence: "rename" })], probe, workers: 1 });
  assert.deepEqual(calls, []);
  assert.deepEqual(again.changes, out.changes);

  // when the module turns out to be removed the unit entries are covered instead
  calls.length = 0;
  const gone = await refresh({ previous, candidates: [cand(M)], probe: stubProbe({ [M]: NOT_FOUND }, calls), workers: 1 });
  assert.deepEqual(calls, [M]);
  assert.deepEqual(pathsOf(gone.changes.removed), [M]);
  assert.equal(gone.stats.covered, 2);
});

test("refreshLearnChanges: units under a module that could not be probed are neither dropped nor probed; the next run settles them", async () => {
  const M = "/training/modules/m";
  const unitEntry = (slug, over = {}) => E(`${M}/${slug}`, { kind: "unit", parent: M, evidence: "unit-diff", outcome: "landing", to: M, status: 301, lastVerified: "2026-09-20", ...over });
  const previous = changesOf([unitEntry("2-rules")], [unitEntry("3-summary", { outcome: "moved", to: `${M}/2-summary` })]);
  const calls = [];
  // the module flapped out of the API for one run and Learn answers 429: the module entry is `unverified`
  const flap = await refresh({ previous, candidates: [cand(M)], probe: stubProbe({ [M]: BLOCKED }, calls), workers: 1 });
  assert.deepEqual(calls, [M], "the units are not probed while their module is unsettled");
  assert.deepEqual(flap.changes.removed.entries.map((e) => [e.path, e.outcome]), [[M, "unverified"], [`${M}/2-rules`, "landing"]]);
  assert.deepEqual(flap.changes.moved.entries.map((e) => [e.path, e.to]), [[`${M}/3-summary`, `${M}/2-summary`]]);
  assert.equal(flap.stats.covered, 0);

  // the API is whole again and the module is served: its own entry goes, the units' entries (their facts) stay
  const back = await refresh({ previous: flap.changes, candidates: [], isLive: (p) => (p === M ? true : p.startsWith(`${M}/`) ? false : undefined), probe: async () => assert.fail("nothing to probe: the entries were verified"), limits: { maxProbes: 50, reverifyPerRun: 0 } });
  assert.deepEqual(back.stats.resurrected, 1);
  assert.deepEqual(all(back.changes).map((e) => e.path), [`${M}/2-rules`, `${M}/3-summary`]);

  // or the module really is gone: now it covers its units
  const gone = await refresh({ previous: flap.changes, candidates: [], probe: stubProbe({ [M]: NOT_FOUND }), workers: 1 });
  assert.deepEqual(all(gone.changes).map((e) => [e.path, e.outcome]), [[M, "gone"]]);
  assert.equal(gone.stats.covered, 2);
});

test("refreshLearnChanges: resurrection, file switches and the catalog's module paths", async () => {
  const P = "/training/modules/p";
  // the cache says it is back: no probe, entry gone
  const back = await refresh({ previous: changesOf([E(P)]), candidates: [], isLive: (path) => path === P, probe: async () => assert.fail("no probe expected"), limits: { maxProbes: 50, reverifyPerRun: 10 } });
  assert.deepEqual(back.stats, { newRemoved: 0, newMoved: 0, resurrected: 1, unverified: 0, probed: 0, probeBudgetExhausted: false, transient: 0, stoppedEarly: false, covered: 0 });
  assert.deepEqual(all(back.changes), []);

  // re-verification finds a redirect where there was a 404: the entry switches files
  const switched = await refresh({ previous: changesOf([E(P)]), candidates: [], probe: stubProbe({ [P]: served("/training/modules/q", { first: 301 }) }) });
  assert.deepEqual([switched.stats.newMoved, switched.stats.newRemoved, switched.stats.probed], [1, 0, 1]);
  assert.deepEqual(pathsOf(switched.changes.moved), [P]);
  // ... and the other way round
  const worse = await refresh({ previous: changesOf([], [E(P, { outcome: "moved", to: "/training/modules/q", status: 301 })]), candidates: [], probe: stubProbe({ [P]: NOT_FOUND }) });
  assert.deepEqual([worse.stats.newMoved, worse.stats.newRemoved], [0, 1]);
  // a live probe result resurrects an entry during re-verification
  const live = await refresh({ previous: changesOf([E(P)]), candidates: [], probe: stubProbe({ [P]: served(P) }) });
  assert.deepEqual([live.stats.resurrected, all(live.changes).length], [1, 0]);

  const saas = { "/training/modules/a": served("/training/saas/x", { first: 301 }) };
  const withCtx = await refresh({ candidates: [cand("/training/modules/a")], probe: stubProbe(saas), ctx: { modulePaths: new Set(["/training/saas/x"]) } });
  assert.equal(find(withCtx.changes, "/training/modules/a").outcome, "moved");
  const withoutCtx = await refresh({ candidates: [cand("/training/modules/a")], probe: stubProbe(saas) });
  assert.equal(find(withoutCtx.changes, "/training/modules/a").outcome, "landing");
});

test("refreshLearnChanges: the reverify rotation re-confirms the oldest entries within its own budget", async () => {
  const entries = ["a", "b", "c", "d"].map((s, i) => E(`/training/modules/${s}`, { lastVerified: `2026-08-0${i + 1}` }));
  const calls = [];
  const out = await refresh({ previous: changesOf(entries), candidates: [], probe: stubProbe({}, calls), workers: 1, limits: { maxProbes: 50, reverifyPerRun: 2 } });
  assert.deepEqual(calls, ["/training/modules/a", "/training/modules/b"]); // the two oldest
  assert.equal(out.stats.probed, 2);
  assert.ok(entries.every((_, i) => find(out.changes, `/training/modules/${"abcd"[i]}`).lastVerified === `2026-08-0${i + 1}`)); // transient: unchanged
  // verified entries move to the back of the line
  const confirm = await refresh({ previous: changesOf(entries), candidates: [], probe: async () => NOT_FOUND, workers: 1, limits: { maxProbes: 50, reverifyPerRun: 2 } });
  assert.deepEqual(confirm.changes.removed.entries.map((e) => e.lastVerified), [TODAY, TODAY, "2026-08-03", "2026-08-04"]);
});

// ---------------------------------------------------------------------------
// docs family
// ---------------------------------------------------------------------------

const redirectsFixture = () => [
  { from: "/azure/a", to: "/azure/b", kind: "moved", status: 301, firstSeen: "2026-09-28", lastSeen: "2026-10-05" },
  { from: "/azure/old/deep", to: "/azure/old", kind: "landing", status: 302, firstSeen: "2026-09-29", lastSeen: "2026-10-05" },
  { from: "/azure/ret", to: "/previous-versions/azure/ret", kind: "retired", status: 301, firstSeen: "2026-09-30", lastSeen: "2026-10-04" },
  { from: "/azure/ext", to: null, kind: "moved", status: 301, firstSeen: "2026-10-01", lastSeen: "2026-10-05" },
  { from: "bad", to: "/x", kind: "moved" },
];
const invalidFixture = () => [
  { title: "T", url: "https://learn.microsoft.com/dynamics365/x/y", status: 404, firstDetected: "2026-09-28", lastChecked: "2026-10-05" },
  { title: "Off-site", url: "https://example.com/x", status: 404 },
  { title: "No URL" },
  null,
];

test("docsChanges maps the redirect ledger and the quarantine to entries", () => {
  const entries = docsChanges({ redirects: redirectsFixture(), invalid: invalidFixture(), today: TODAY });
  assert.deepEqual(entries, [
    { path: "/azure/a", kind: "docs", family: "docs", outcome: "moved", to: "/azure/b", title: null, parent: null, firstSeen: "2026-09-28", lastVerified: "2026-10-05", evidence: "docs-redirect", status: 301 },
    { path: "/azure/ext", kind: "docs", family: "docs", outcome: "moved", to: null, title: null, parent: null, firstSeen: "2026-10-01", lastVerified: "2026-10-05", evidence: "docs-redirect", status: 301 },
    { path: "/azure/old/deep", kind: "docs", family: "docs", outcome: "landing", to: "/azure/old", title: null, parent: null, firstSeen: "2026-09-29", lastVerified: "2026-10-05", evidence: "docs-redirect", status: 302 },
    { path: "/azure/ret", kind: "docs", family: "docs", outcome: "retired", to: "/previous-versions/azure/ret", title: null, parent: null, firstSeen: "2026-09-30", lastVerified: "2026-10-04", evidence: "docs-redirect", status: 301 },
    { path: "/dynamics365/x/y", kind: "docs", family: "docs", outcome: "gone", to: null, title: "T", parent: null, firstSeen: "2026-09-28", lastVerified: "2026-10-05", evidence: "quarantine", status: 404 },
  ]);
  // missing dates fall back to today / null; no input at all is fine
  const bare = docsChanges({ redirects: [{ from: "/azure/z", to: "/azure/y", kind: "moved" }], invalid: [{ url: "https://learn.microsoft.com/azure/q" }], today: TODAY });
  assert.deepEqual(bare.map((e) => [e.path, e.firstSeen, e.lastVerified, e.status]), [["/azure/q", TODAY, null, null], ["/azure/z", TODAY, null, null]]);
  assert.deepEqual(docsChanges({ today: TODAY }), []);
  assert.throws(() => docsChanges({ redirects: [], invalid: [] }), TypeError);
});

test("docsChanges: a path in both ledgers keeps the more recently verified claim, removed wins a tie", () => {
  const url = "https://learn.microsoft.com/azure/both";
  const redirects = (lastSeen) => [{ from: "/azure/both", to: "/azure/new", kind: "moved", status: 301, firstSeen: "2026-09-20", lastSeen }];
  const invalid = [{ url, status: 404, firstDetected: "2026-09-25", lastChecked: "2026-10-05" }];
  const tie = docsChanges({ redirects: redirects("2026-10-05"), invalid, today: TODAY });
  assert.deepEqual([tie.length, tie[0].outcome, tie[0].firstSeen], [1, "gone", "2026-09-20"]);
  const redirectNewer = docsChanges({ redirects: redirects("2026-10-06"), invalid, today: TODAY });
  assert.deepEqual([redirectNewer[0].outcome, redirectNewer[0].to], ["moved", "/azure/new"]);
  const quarantineNewer = docsChanges({ redirects: redirects("2026-10-01"), invalid, today: TODAY });
  assert.equal(quarantineNewer[0].outcome, "gone");
});

test("replaceFamily replaces only that family's entries and stamps its source", () => {
  const T2 = "2026-10-06T09:30:00.000Z";
  const base = changesOf(
    [E("/training/modules/m", { outcome: "unverified", lastVerified: null, status: null }), docsEntry("/azure/stale")],
    [E("/training/modules/mv", { outcome: "moved", to: "/training/modules/mv2", status: 301 }), docsEntry("/azure/stale-moved", { outcome: "moved", to: "/azure/x", evidence: "docs-redirect", status: 301 })]
  );
  const entries = docsChanges({ redirects: redirectsFixture(), invalid: invalidFixture(), today: TODAY });
  const out = replaceFamily(base, "docs", entries, T2);
  // learn untouched, byte for byte
  assert.deepEqual(out.removed.entries.filter((e) => e.family === "learn"), base.removed.entries.filter((e) => e.family === "learn"));
  assert.deepEqual(out.moved.entries.filter((e) => e.family === "learn"), base.moved.entries.filter((e) => e.family === "learn"));
  // stale docs entries are gone, fresh ones routed by outcome
  assert.deepEqual(out.removed.entries.filter((e) => e.family === "docs").map((e) => [e.path, e.outcome]), [
    ["/azure/old/deep", "landing"],
    ["/azure/ret", "retired"],
    ["/dynamics365/x/y", "gone"],
  ]);
  assert.deepEqual(out.moved.entries.filter((e) => e.family === "docs").map((e) => e.path), ["/azure/a", "/azure/ext"]);
  assert.deepEqual(out.removed.sources, { learn: OLD_STAMP, docs: T2 });
  assert.deepEqual(out.moved.sources, { learn: OLD_STAMP, docs: T2 });
  assert.equal(out.removed.generatedAt, T2);
  assert.equal(out.moved.generatedAt, T2);
  // an empty replacement clears the family
  const cleared = replaceFamily(out, "docs", [], "2026-10-07T00:00:00.000Z");
  assert.deepEqual(all(cleared).map((e) => e.family), ["learn", "learn"]);
  // idempotent
  assert.deepEqual(replaceFamily(out, "docs", entries, T2), out);
  // the learn family can be replaced without touching docs
  const learnOnly = replaceFamily(base, "learn", [], T2);
  assert.deepEqual(all(learnOnly).map((e) => e.path), ["/azure/stale", "/azure/stale-moved"]);
  assert.deepEqual(learnOnly.removed.sources, { learn: T2, docs: "2026-09-29T09:00:00.000Z" });
  // entries of another family are a bug of the caller
  assert.throws(() => replaceFamily(base, "docs", [E("/training/modules/x")], T2), TypeError);
  assert.throws(() => replaceFamily(base, "docs", [docsEntry("/azure/x", { outcome: "exploded" })], T2), TypeError);
  assert.throws(() => replaceFamily(base, "docs", [], "not a date"), TypeError);
  assert.throws(() => replaceFamily(base, "other", [], T2), TypeError);
});

test("the two families coexist across runs: a docs replace and a learn apply do not disturb each other", () => {
  const docs = docsChanges({ redirects: redirectsFixture(), invalid: invalidFixture(), today: TODAY });
  const afterDocs = replaceFamily(emptyChanges(), "docs", docs, NOW);
  const afterLearn = apply({ previous: afterDocs, candidates: [cand("/training/modules/m")], results: new Map(), generatedAt: "2026-10-06T09:00:00.000Z" });
  assert.deepEqual(afterLearn.removed.sources, { learn: "2026-10-06T09:00:00.000Z", docs: NOW });
  assert.equal(all(afterLearn).filter((e) => e.family === "docs").length, docs.length);
  const again = replaceFamily(afterLearn, "docs", docs, "2026-10-07T07:00:00.000Z");
  assert.deepEqual(again.removed.entries.filter((e) => e.family === "learn"), afterLearn.removed.entries.filter((e) => e.family === "learn"));
});

// ---------------------------------------------------------------------------
// consumers
// ---------------------------------------------------------------------------

const M = (slug) => `/training/modules/${slug}`;
const movedE = (path, to, over = {}) => E(path, { outcome: "moved", to, status: 301, ...over });

test("lookupChange: exact match wins; a removed module covers its units; unverified is low confidence", () => {
  const index = indexChanges(
    changesOf(
      [E(M("m"), { outcome: "gone" }), E(M("u"), { outcome: "unverified", lastVerified: null, status: null }), E(M("l"), { outcome: "landing", to: "/training/browse" })],
      [movedE(`${M("m")}/01-a`, `${M("n")}/01-a`, { kind: "unit", parent: M("m") })]
    )
  );
  const unit = lookupChange(`${M("m")}/09-z`, index);
  assert.deepEqual([unit.state, unit.outcome, unit.confidence, unit.match, unit.to, unit.chain], ["removed", "gone", "high", "ancestor", null, [`${M("m")}/09-z`]]);
  assert.equal(unit.entry.path, M("m"));
  assert.match(unit.reason, /its module \/training\/modules\/m was removed/);
  // an exact entry beats the ancestor (the unit entry says moved, its module says gone)
  const exact = lookupChange(`${M("m")}/01-a`, index);
  assert.deepEqual([exact.state, exact.match, exact.to, exact.confidence], ["moved", "exact", `${M("n")}/01-a`, "high"]);
  // exact removed entry: landing page reported
  const landing = lookupChange(M("l"), index);
  assert.deepEqual([landing.state, landing.outcome, landing.to, landing.confidence], ["removed", "landing", "/training/browse", "high"]);
  // unverified: still removed, but low confidence, also for its units
  assert.deepEqual([lookupChange(M("u"), index).state, lookupChange(M("u"), index).confidence], ["removed", "low"]);
  assert.deepEqual([lookupChange(`${M("u")}/01-a`, index).state, lookupChange(`${M("u")}/01-a`, index).confidence], ["removed", "low"]);
  // the ancestor walk respects segment boundaries
  assert.equal(lookupChange(`${M("m")}-other/01-a`, index), null);
  assert.equal(lookupChange(M("m2"), index), null);
});

test("lookupChange: a unit of a moved module probably moved to the same remainder (low); an exact move is high", () => {
  const index = indexChanges(changesOf([], [movedE(M("x"), M("y"))]));
  const inherited = lookupChange(`${M("x")}/05-exercise`, index);
  assert.deepEqual([inherited.state, inherited.outcome, inherited.confidence, inherited.match, inherited.to], ["moved", "moved", "low", "ancestor", `${M("y")}/05-exercise`]);
  assert.deepEqual(inherited.chain, [`${M("x")}/05-exercise`, `${M("y")}/05-exercise`]);
  const direct = lookupChange(M("x"), index);
  assert.deepEqual([direct.state, direct.confidence, direct.match, direct.to], ["moved", "high", "exact", M("y")]);
  // off-site move
  const offsite = lookupChange(M("z"), indexChanges(changesOf([], [movedE(M("z"), null)])));
  assert.deepEqual([offsite.state, offsite.to], ["moved", null]);
});

test("lookupChange follows a moved destination through the ledger: 5 hops, cycle safe, removed at the end counts as removed", () => {
  const chain = indexChanges(changesOf([], [movedE(M("a"), M("b")), movedE(M("b"), M("c"))]));
  const result = lookupChange(M("a"), chain);
  assert.deepEqual([result.state, result.to, result.chain, result.confidence, result.cycle, result.truncated], ["moved", M("c"), [M("a"), M("b"), M("c")], "high", false, false]);
  assert.equal(result.entry.path, M("a"));
  assert.equal(result.final.path, M("b"));

  // the chain ends in a removed entry
  const dead = indexChanges(changesOf([E(M("b"), { outcome: "landing", to: "/training/browse" })], [movedE(M("a"), M("b"))]));
  const ended = lookupChange(M("a"), dead);
  assert.deepEqual([ended.state, ended.outcome, ended.confidence, ended.chain, ended.to], ["removed", "landing", "high", [M("a"), M("b")], "/training/browse"]);
  assert.equal(ended.entry.path, M("a"));
  assert.equal(ended.final.path, M("b"));
  assert.match(ended.reason, /moved to \/training\/modules\/b, which was removed/);
  // ... through an unverified entry: low
  const unverifiedEnd = indexChanges(changesOf([E(M("b"), { outcome: "unverified", lastVerified: null, status: null })], [movedE(M("a"), M("b"))]));
  assert.deepEqual([lookupChange(M("a"), unverifiedEnd).state, lookupChange(M("a"), unverifiedEnd).confidence], ["removed", "low"]);
  // a moved module whose destination module was removed: its units are removed
  const viaModule = indexChanges(changesOf([E(M("y"))], [movedE(M("x"), M("y"))]));
  const unitResult = lookupChange(`${M("x")}/01-a`, viaModule);
  assert.deepEqual([unitResult.state, unitResult.confidence, unitResult.chain], ["removed", "low", [`${M("x")}/01-a`, `${M("y")}/01-a`]]);

  // a cycle
  const loop = indexChanges(changesOf([], [movedE(M("a"), M("b")), movedE(M("b"), M("a"))]));
  const cyclic = lookupChange(M("a"), loop);
  assert.deepEqual([cyclic.state, cyclic.cycle, cyclic.confidence, cyclic.to], ["moved", true, "low", M("a")]);
  const self = lookupChange(M("b"), loop);
  assert.equal(self.cycle, true);

  // five hops are followed, a sixth is not
  const nodes = Array.from({ length: 8 }, (_, i) => M(`p${i}`));
  const hops = (count) => indexChanges(changesOf([], nodes.slice(0, count).map((p, i) => movedE(p, nodes[i + 1]))));
  const five = lookupChange(nodes[0], hops(5)); // p0..p4 move on, p5 is not in the ledger
  assert.deepEqual([five.to, five.chain.length, five.truncated, five.confidence], [nodes[5], 6, false, "high"]);
  const six = lookupChange(nodes[0], hops(6)); // p5 moves on as well: that would be hop 6
  assert.deepEqual([six.to, five.chain.length, six.truncated, six.confidence], [nodes[5], 6, true, "low"]);
  assert.equal(six.chain.length, 6);
  assert.match(six.reason, /more than 5 redirects/);
});

test("lookupChange: docs and other kinds never inherit; URLs, case and junk input", () => {
  const index = indexChanges(
    changesOf(
      [
        docsEntry("/azure/foo", { outcome: "gone" }),
        E("/credentials/certifications/cert", { kind: "certification" }),
        E("/training/paths/lp", { kind: "learning-path" }),
        E("/training/saas/s", { outcome: "gone" }),
      ],
      [docsEntry("/azure/moved", { outcome: "moved", to: "/azure/new", evidence: "docs-redirect", status: 301 })]
    )
  );
  assert.equal(lookupChange("/azure/foo/bar", index), null);
  assert.equal(lookupChange("/credentials/certifications/cert/something", index), null);
  assert.equal(lookupChange("/training/paths/lp/x", index), null);
  assert.equal(lookupChange("/azure/moved/sub", index), null);
  assert.equal(lookupChange("/azure/foo", index).state, "removed");
  assert.deepEqual([lookupChange("/azure/moved", index).state, lookupChange("/azure/moved", index).to], ["moved", "/azure/new"]);
  // a module outside /training/modules/ covers its units as well
  assert.equal(lookupChange("/training/saas/s/1-intro", index).state, "removed");
  // URLs, locale, case, query strings
  assert.equal(lookupChange("https://learn.microsoft.com/en-us/AZURE/Foo/?view=x#frag", index).state, "removed");
  // nothing recorded is null, never "valid"
  assert.equal(lookupChange("/azure/unknown", index), null);
  for (const junk of [null, undefined, "", "relative", "/", "https://example.com/azure/foo", 7]) assert.equal(lookupChange(junk, index), null);
  assert.equal(lookupChange("/azure/foo", null), null);
  assert.equal(lookupChange("/azure/foo", indexChanges(emptyChanges())), null);
});

test("changesSince lists entries first seen on or after a date; summarizeChanges counts them", () => {
  const changes = changesOf(
    [
      E(M("old"), { firstSeen: "2026-09-01" }),
      E(M("new1"), { firstSeen: "2026-10-04", outcome: "unverified", lastVerified: null, status: null }),
      E(`${M("new1")}/01`, { kind: "unit", parent: M("new1"), firstSeen: "2026-10-05", evidence: "unit-diff", outcome: "landing", to: M("new1") }),
      docsEntry("/azure/gone", { firstSeen: "2026-10-05" }),
      E("/training/paths/lp", { kind: "learning-path", firstSeen: "2026-10-06" }),
    ],
    [movedE(M("mv"), M("mv2"), { firstSeen: "2026-10-04" }), docsEntry("/azure/m", { outcome: "moved", to: "/azure/n", evidence: "docs-redirect", firstSeen: "2026-09-30" })]
  );
  // oldest firstSeen first, then by path in code-point order
  assert.deepEqual(changesSince(changes, "2026-10-04").map((e) => e.path), [M("mv"), M("new1"), "/azure/gone", `${M("new1")}/01`, "/training/paths/lp"]);
  assert.deepEqual(changesSince(changes, "2026-10-06").map((e) => e.path), ["/training/paths/lp"]);
  assert.deepEqual(changesSince(changes, "2026-10-07"), []);
  assert.equal(changesSince(changes, "2000-01-01").length, 7);
  assert.deepEqual(changesSince(emptyChanges(), "2026-10-04"), []);
  for (const bad of ["yesterday", "2026-13-40", "", null, undefined]) assert.throws(() => changesSince(changes, bad), RangeError);

  const summary = summarizeChanges(changes);
  assert.equal(summary.total, 7);
  assert.deepEqual(summary.files, { removed: 5, moved: 2 });
  assert.deepEqual(summary.byOutcome, { gone: 3, landing: 1, retired: 0, unverified: 1, moved: 2 });
  assert.deepEqual(summary.byFamily, { learn: { removed: 4, moved: 1 }, docs: { removed: 1, moved: 1 } });
  assert.deepEqual(summary.byKind.module, { removed: 2, moved: 1 });
  assert.deepEqual(summary.byKind.unit, { removed: 1, moved: 0 });
  assert.deepEqual(summary.byKind["learning-path"], { removed: 1, moved: 0 });
  assert.deepEqual(summary.byKind.docs, { removed: 1, moved: 1 });
  assert.deepEqual(summary.byKind.course, { removed: 0, moved: 0 });
  assert.deepEqual(summary.sources, { learn: OLD_STAMP, docs: "2026-09-29T09:00:00.000Z" });
  assert.equal(summary.generatedAt, OLD_STAMP);
  const empty = summarizeChanges(emptyChanges());
  assert.equal(empty.total, 0);
  assert.deepEqual(Object.keys(empty.byKind), ["module", "unit", "learning-path", "course", "certification", "exam", "applied-skill", "study-guide", "docs"]);
  assert.equal(empty.generatedAt, null);
});

test("the evidence list and kind list in the contract are what the code accepts", () => {
  assert.deepEqual([...CHANGE_EVIDENCE].sort(), ["docs-redirect", "hierarchy-not-found", "history", "live-probe", "quarantine", "rename", "tombstone", "unit-diff"]);
});
