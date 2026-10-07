import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { indexChanges, loadChanges, lookupChange } from "../scripts/lib/changes.mjs";
import { runCatalogSync } from "../scripts/lib/learn-catalog-run.mjs";
import { runContentSync } from "../scripts/lib/learn-content-run.mjs";
import { FailsafeAbort } from "../scripts/lib/learn-io.mjs";
import { PROBE_NOT_FOUND, TEST_CONFIG, TEST_LIMITS, hierarchyOf, makeFakeLearn, makeProbe, mod, probeServed, unitsOf } from "./learn-fixtures.mjs";
import { FakeLearn, harness, run as runDocs, stable } from "./docs-fixtures.mjs";

// Multi-run scenarios: the REAL catalog run, content run and docs run, one shared data directory, a fake Learn
// (catalog / hierarchy / study guide pages), a scripted live probe for the change files and a fake docs site.
// They assert how data/changes/removed.json and moved.json EVOLVE week after week, not what one run does.
//
//   W0  baseline: the files exist, nothing is invented
//   W1  a module is removed, one is replaced by a new slug, one renamed under its uid, a unit renamed, a unit
//       removed, one probe is transient, a learning path / course / study guide change, a docs page moves
//   W2  the transient resolves, a removed module comes back, the docs ledger gains and loses entries
//   W3+ API glitches and failsafe aborts must not create or lose anything

const noSleep = async () => {};
const LM = "2026-01-01T00:00:00+00:00";
const U = (path) => `https://learn.microsoft.com/en-us${path}/?WT.mc_id=api_CatalogApi`;
const SG = (code) => `/credentials/certifications/resources/study-guides/${code}`;
const M = (slug) => `/training/modules/${slug}`;

/** Week n: the three syncs of one Monday (the Learn syncs first, the docs sync an hour later), one week apart. */
const weekAt = (n) => {
  const day = new Date(Date.UTC(2026, 9, 5 + 7 * n));
  const at = (time) => `${day.toISOString().slice(0, 10)}T${time}.000Z`;
  return { catalog: at("07:17:00"), content: at("07:45:00"), docs: at("08:00:00") };
};
const WEEKS = new Proxy({}, { get: (_, key) => weekAt(Number(key)) });
const SAME = (when) => ({ catalog: when, content: when, docs: when });

// ---------------------------------------------------------------------------
// the lab: one data directory, one fake Learn, one probe table, one fake docs site
// ---------------------------------------------------------------------------

const unitSet = (...slugs) => slugs.map((s) => [s, s[0].toUpperCase() + s.slice(1)]);

/** The module specs of the world; a test mutates `lab.specs` and calls lab.sync() before the next week. */
function baseSpecs() {
  const specs = new Map();
  for (let i = 0; i < 60; i++) {
    const n = String(i).padStart(2, "0");
    specs.set(`learn.azure.f${n}`, { uid: `learn.azure.f${n}`, slug: `f${n}` });
  }
  // the one module whose uid starts with "$" (a real tombstone of the live catalog is exactly this shape)
  specs.set("dollar", { uid: "$learn.become-contributor", slug: "become-contributor" });
  specs.set("gh", { uid: "learn.gh.one", slug: "gh-one", products: ["github-actions"] });
  specs.set("m365", { uid: "learn.m365.one", slug: "m365-one", products: ["m365"] });
  specs.set("keep", { uid: "learn.azure.keep", slug: "keep", unitSpecs: unitSet("introduction", "rules", "summary", "quiz") });
  specs.set("gone", { uid: "learn.azure.gone", slug: "gone-mod" });
  specs.set("ren", { uid: "learn.azure.ren", slug: "ren-old" });
  specs.set("repl", { uid: "learn.azure.repl", slug: "repl-old" });
  specs.set("unitren", { uid: "learn.azure.unitren", slug: "unit-ren", unitSpecs: unitSet("introduction", "rules", "summary") });
  specs.set("unitgone", { uid: "learn.azure.unitgone", slug: "unit-gone", unitSpecs: unitSet("introduction", "rules", "summary") });
  specs.set("flaky", { uid: "learn.azure.flaky", slug: "flaky-mod" });
  specs.set("comeback", { uid: "learn.azure.comeback", slug: "comeback" });
  return specs;
}

function baseContent() {
  return {
    learningPaths: [
      { uid: "learn.path-keep", title: "Keep", url: U("/training/paths/path-keep"), last_modified: LM, modules: ["learn.azure.keep"] },
      { uid: "learn.path-gone", title: "Gone", url: U("/training/paths/path-gone"), last_modified: LM, modules: ["learn.azure.f00"] },
    ],
    courses: [
      { uid: "course.keep", course_number: "", title: "Keep", url: U("/training/courses/keep-c"), last_modified: LM },
      { uid: "course.ren", course_number: "", title: "Ren", url: U("/training/courses/old-c"), last_modified: LM },
    ],
    certifications: [{ uid: "certification.admin", title: "Admin", url: U("/credentials/certifications/admin"), last_modified: LM, exams: ["exam.az-305"] }],
    exams: [
      { uid: "exam.az-305", title: "AZ-305", display_name: "AZ-305", url: U("/credentials/certifications/exams/az-305"), last_modified: LM },
      { uid: "exam.ab-100", title: "AB-100", display_name: "AB-100", url: U("/credentials/certifications/exams/ab-100"), last_modified: LM },
    ],
    appliedSkills: [],
  };
}

function docsSite() {
  const learn = new FakeLearn();
  const lastmods = { a: "2026-09-20", b: "2026-09-21", c: "2026-09-22", d: "2026-09-23", e: "2026-09-24", f: "2026-09-25" };
  learn.family("azure", [...stable("azure", 24), ...Object.entries(lastmods).map(([name, lastmod]) => [`/azure/${name}`, lastmod])]);
  learn.family("entra", stable("entra", 4));
  learn.family("cli", [["/cli/azure/vm", "2026-09-01"]]);
  return learn;
}

function makeLab(t, { from = null } = {}) {
  const h = harness(t);
  if (from) cpSync(from.h.data, h.data, { recursive: true });
  const lab = {
    h,
    specs: baseSpecs(),
    answers: {},
    docsSite: docsSite(),
    fake: makeFakeLearn({
      pages: new Map([
        [SG("az-305"), { status: 200 }],
        [SG("ab-100"), { status: 200 }],
      ]),
    }),
    content: baseContent(),
  };
  lab.probe = makeProbe(lab.answers);
  lab.sync = () => {
    const modules = [...lab.specs.values()].map((spec) => mod({ products: ["azure-vm"], ...spec }));
    lab.fake.state.modules = modules;
    lab.fake.state.units = unitsOf(modules);
    lab.fake.state.content = lab.content;
  };
  lab.catalog = (when, { env = {}, ...over } = {}) => {
    lab.sync();
    return runCatalogSync({
      dataDir: h.data,
      env: { MAX_MODULE_DROP_PCT: "20", MAX_API_DROP_PCT: "20", ...env },
      now: new Date(when),
      fetchImpl: lab.fake.fetchImpl,
      sleepImpl: noSleep,
      delayMs: 0,
      config: TEST_CONFIG,
      limits: TEST_LIMITS,
      httpOptions: { attempts: 2, baseBackoffMs: 1 },
      changes: { delayMs: 0, probe: lab.probe },
      log: () => {},
      warn: () => {},
      ...over,
    });
  };
  lab.contentRun = (when, { env = {}, ...over } = {}) => {
    lab.sync();
    return runContentSync({
      dataDir: h.data,
      env: { MAX_CONTENT_DROP_PCT: "100", ...env },
      now: new Date(when),
      fetchImpl: lab.fake.fetchImpl,
      sleepImpl: noSleep,
      delayMs: 0,
      minCounts: {},
      minResolutionModules: 1,
      limits: { PROBE_MIN_SAMPLE: 3 },
      httpOptions: { attempts: 2, baseBackoffMs: 1 },
      changes: { delayMs: 0, probe: lab.probe },
      log: () => {},
      warn: () => {},
      ...over,
    });
  };
  lab.docs = (when, over = {}) => runDocs(h, lab.docsSite, { when, ...over });
  /** One week: the three syncs in the production order, or any other. */
  lab.week = async (n, { order = ["catalog", "content", "docs"], when = WEEKS[n], catalog = {}, content = {}, docs = {} } = {}) => {
    const out = {};
    for (const part of order) {
      if (part === "catalog") out.catalog = await lab.catalog(when.catalog, catalog);
      if (part === "content") out.content = await lab.contentRun(when.content, content);
      if (part === "docs") {
        out.docs = await lab.docs(when.docs, docs);
        assert.equal(out.docs.exitCode, 0, out.docs.messages.join("\n"));
      }
    }
    return out;
  };
  lab.file = (name) => JSON.parse(readFileSync(join(h.data, name), "utf-8"));
  lab.text = (name) => readFileSync(join(h.data, name), "utf-8");
  lab.changes = (family = null) => {
    const pick = (name) => lab.file(`changes/${name}.json`).entries.filter((e) => family === null || e.family === family);
    return { removed: pick("removed"), moved: pick("moved") };
  };
  return lab;
}

const row = (e) => [e.path, e.outcome, e.to, e.firstSeen, e.lastVerified, e.evidence];
const rows = (entries) => entries.map(row);
const learnRows = (lab) => {
  const { removed, moved } = lab.changes("learn");
  return { removed: rows(removed), moved: rows(moved) };
};

/** The scripted live answers of W1 (the probe table is the live Learn the change files are verified against). */
function answersW1(a) {
  a[M("gone-mod")] = PROBE_NOT_FOUND;
  a[M("repl-old")] = probeServed(M("repl-new"), { first: 301 });
  a[M("ren-old")] = probeServed(M("ren-new"), { first: 301 });
  a[`${M("unit-ren")}/2-rules`] = probeServed(`${M("unit-ren")}/2-firewall-rules`, { first: 301 });
  a[`${M("unit-gone")}/2-rules`] = probeServed(M("unit-gone"), { first: 301 });
  a[`${M("unit-gone")}/3-summary`] = probeServed(`${M("unit-gone")}/2-summary`, { first: 301 });
  a[M("comeback")] = PROBE_NOT_FOUND;
  // flaky-mod: no answer = blocked (a transient probe)
  a["/training/paths/path-gone"] = PROBE_NOT_FOUND;
  a["/training/courses/old-c"] = probeServed("/training/courses/new-c", { first: 301 });
  a[SG("ab-100")] = PROBE_NOT_FOUND;
}

/** The world changes of W1. */
function mutateW1(lab) {
  const { specs, content } = lab;
  specs.delete("gone");
  specs.delete("flaky");
  specs.delete("comeback");
  specs.delete("repl");
  specs.set("repl2", { uid: "learn.azure.repl2", slug: "repl-new" });
  specs.set("ren", { uid: "learn.azure.ren", slug: "ren-new" });
  specs.set("unitren", { uid: "learn.azure.unitren", slug: "unit-ren", unitSpecs: unitSet("introduction", "firewall-rules", "summary") });
  specs.set("unitgone", { uid: "learn.azure.unitgone", slug: "unit-gone", unitSpecs: unitSet("introduction", "summary") });
  content.learningPaths = content.learningPaths.filter((p) => p.uid !== "learn.path-gone");
  content.courses = content.courses.map((c) => (c.uid === "course.ren" ? { ...c, url: U("/training/courses/new-c") } : c));
  lab.fake.state.pages.set(SG("ab-100"), { status: 404 });
  const d = lab.docsSite;
  d.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/d", "2026-09-23"], ["/azure/e", "2026-09-24"], ["/azure/f", "2026-09-25"]]);
  d.page("/azure/b", "gone");
  d.page("/azure/c", { to: "/azure/c-new" });
}

/** The world changes of W2: comeback returns, the docs site restores b and c and sends d to the product root. */
function mutateW2(lab) {
  lab.specs.set("comeback", { uid: "learn.azure.comeback", slug: "comeback" });
  const d = lab.docsSite;
  d.page("/azure/b", "live");
  d.page("/azure/c", "live");
  d.page("/azure/d", { to: "/azure" });
  d.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/b", "2026-10-18"], ["/azure/c", "2026-10-18"], ["/azure/e", "2026-09-24"], ["/azure/f", "2026-09-25"]]);
}

/** A lab that has lived through weeks 0..n of the evolution scenario (no assertions: scenario 1 owns them). */
async function labAt(t, n, options) {
  const lab = makeLab(t, options);
  await lab.week(0);
  if (n >= 1) {
    mutateW1(lab);
    answersW1(lab.answers);
    await lab.week(1);
  }
  if (n >= 2) {
    lab.answers[M("flaky-mod")] = PROBE_NOT_FOUND;
    mutateW2(lab);
    await lab.week(2);
  }
  return lab;
}

const PATHS_OF_W1_UNITS = [`${M("unit-gone")}/2-rules`, `${M("unit-gone")}/3-summary`, `${M("unit-ren")}/2-rules`];
const ledgerPaths = (lab) => {
  const { removed, moved } = lab.changes("learn");
  return new Set([...removed, ...moved].map((e) => e.path));
};
const stableColumns = (lab) => {
  const { removed, moved } = learnRows(lab);
  return { removed: removed.map((r) => r.slice(0, 4)), moved: moved.map((r) => r.slice(0, 4)) };
};
const indexOf = (lab) => indexChanges(loadChanges(lab.h.data, { warn: () => {} }));
const tombstoneUids = (lab) => lab.file("learn-catalog.json").removed.map((r) => r.uid);

// ---------------------------------------------------------------------------
// the evolution scenario
// ---------------------------------------------------------------------------

test("scenario: W0 baseline, W1 removed / moved / renamed / unit changes / one transient probe, W2 transient resolves, resurrection, docs ledger churn", async (t) => {
  const lab = makeLab(t);

  // ---- W0: baseline ----
  await lab.week(0);
  assert.deepEqual(lab.changes(), { removed: [], moved: [] }, "a first run records no history");
  for (const name of ["removed", "moved"]) {
    const file = lab.file(`changes/${name}.json`);
    assert.equal(file.generatedAt, WEEKS[0].docs, "the docs run wrote last");
    assert.deepEqual(file.sources, { learn: WEEKS[0].content, docs: WEEKS[0].docs });
  }
  const w0Status = lab.file("status.json");
  assert.equal(w0Status.learn.generatedAt, WEEKS[0].catalog, "status.learn.generatedAt is the OLDER of the two Learn stamps");
  assert.equal(w0Status.learn.contentGeneratedAt, WEEKS[0].content);

  // ---- W1 ----
  mutateW1(lab);
  answersW1(lab.answers);
  const w1 = await lab.week(1);
  const byPath = (a, b) => (a[0] < b[0] ? -1 : 1);
  assert.deepEqual(learnRows(lab), {
    removed: [
      [SG("ab-100"), "gone", null, "2026-10-12", "2026-10-12", "live-probe"],
      ["/training/paths/path-gone", "gone", null, "2026-10-12", "2026-10-12", "tombstone"],
      [M("comeback"), "gone", null, "2026-10-12", "2026-10-12", "tombstone"],
      [M("flaky-mod"), "unverified", null, "2026-10-12", null, "tombstone"],
      [M("gone-mod"), "gone", null, "2026-10-12", "2026-10-12", "tombstone"],
      [`${M("unit-gone")}/2-rules`, "landing", M("unit-gone"), "2026-10-12", "2026-10-12", "unit-diff"],
    ].sort(byPath),
    moved: [
      ["/training/courses/old-c", "moved", "/training/courses/new-c", "2026-10-12", "2026-10-12", "rename"],
      [M("ren-old"), "moved", M("ren-new"), "2026-10-12", "2026-10-12", "rename"],
      [M("repl-old"), "moved", M("repl-new"), "2026-10-12", "2026-10-12", "tombstone"],
      [`${M("unit-gone")}/3-summary`, "moved", `${M("unit-gone")}/2-summary`, "2026-10-12", "2026-10-12", "unit-diff"],
      [`${M("unit-ren")}/2-rules`, "moved", `${M("unit-ren")}/2-firewall-rules`, "2026-10-12", "2026-10-12", "unit-diff"],
    ].sort(byPath),
  });
  assert.equal(w1.catalog.changesStats.unverified, 1);
  assert.equal(lab.file("learn-catalog.json").removed.length, 4, "gone, flaky, comeback and repl are tombstoned in the catalog");

  // ---- W2: the transient resolves, comeback returns, docs ledger gains and loses entries ----
  lab.answers[M("flaky-mod")] = PROBE_NOT_FOUND;
  mutateW2(lab);
  await lab.week(2);
  const learn2 = learnRows(lab);
  assert.deepEqual(
    learn2.removed.find((r) => r[0] === M("flaky-mod")),
    [M("flaky-mod"), "gone", null, "2026-10-12", "2026-10-19", "tombstone"],
    "a resolved transient keeps its firstSeen and the original evidence"
  );
  assert.ok(!learn2.removed.some((r) => r[0] === M("comeback")), "the module that came back is deleted from the ledger");
  assert.equal(tombstoneUids(lab).includes("learn.azure.comeback"), false, "and its tombstone is dropped");
  for (const r of [...learn2.removed, ...learn2.moved].filter((r) => r[0] !== M("flaky-mod"))) {
    assert.equal(r[3], "2026-10-12", `${r[0]} keeps its firstSeen`);
    assert.equal(r[4], "2026-10-19", `${r[0]} was re-verified in W2`);
  }
  const docs2 = lab.changes("docs");
  assert.deepEqual(rows(docs2.removed).map((r) => r.slice(0, 3)), [["/azure/d", "landing", "/azure"]]);
  assert.deepEqual(docs2.moved, [], "b was restored, c is listed again: both are gone from the files");
});

// ---------------------------------------------------------------------------
// W3+: glitches
// ---------------------------------------------------------------------------

test("scenario: a hierarchy glitch (truncated unit lists) never creates a removal: the sync notices and carries the old lists forward", async (t) => {
  const lab = await labAt(t, 2);
  const before = stableColumns(lab);
  const truncated = new Set(["learn.azure.keep", "learn.azure.f00", "learn.azure.f01"]);
  lab.fake.state.hierarchyFor = (m) => {
    const hierarchy = hierarchyOf(m);
    if (truncated.has(m.uid)) hierarchy.units = hierarchy.units.slice(0, Math.ceil(hierarchy.units.length / 2));
    return hierarchy;
  };
  lab.probe.calls.length = 0;
  const w3 = await lab.week(3, { catalog: { env: { FULL_UNIT_REFRESH: "1" } } });
  assert.equal(w3.catalog.unitStats.failures, 3, "the misaligned answers are failures");
  assert.equal(w3.catalog.unitStats.carriedForward, 3);
  assert.deepEqual(stableColumns(lab), before, "nothing new, nothing lost");
  assert.ok(![...ledgerPaths(lab)].some((p) => /\/(keep|f00|f01)(\/|$)/.test(p)));
  const keep = lab.file("learn-catalog.json").modules.find((m) => m.uid === "learn.azure.keep");
  assert.equal(keep.unitUrls.length, 4, "the old list is still the list");
});

test("scenario: a glitch that truncates the catalog AND the hierarchy leaves no removal behind: a live probe dismisses it, or the next whole run does", async (t) => {
  const lab = await labAt(t, 2);
  const before = stableColumns(lab);
  const keepFull = lab.specs.get("keep");
  const keepCut = { ...keepFull, unitSpecs: unitSet("introduction", "rules") };
  const cutPaths = [`${M("keep")}/3-summary`, `${M("keep")}/4-quiz`];

  // W3: the live probe works and says the cut units are served on their own paths
  lab.specs.set("keep", keepCut);
  for (const path of cutPaths) lab.answers[path] = probeServed(path);
  await lab.week(3);
  assert.deepEqual(stableColumns(lab), before, "a live probe dismissed both candidates");
  assert.deepEqual(lab.probe.calls.filter((p) => cutPaths.includes(p)).sort(), cutPaths);

  // W4: whole again
  lab.specs.set("keep", keepFull);
  await lab.week(4);
  assert.deepEqual(stableColumns(lab), before);

  // W5: the glitch again, this time the probe is blocked: the entries exist as `unverified` (the sync cannot tell)
  for (const path of cutPaths) delete lab.answers[path];
  lab.specs.set("keep", keepCut);
  await lab.week(5);
  const w5 = lab.changes("learn").removed.filter((e) => cutPaths.includes(e.path));
  assert.deepEqual(w5.map((e) => [e.path, e.outcome, e.evidence]), cutPaths.map((p) => [p, "unverified", "unit-diff"]));

  // W6: whole again: every false entry is gone, nothing else changed
  lab.specs.set("keep", keepFull);
  await lab.week(6);
  assert.deepEqual(stableColumns(lab), before, "no false removed entry survives the end of the glitch");
});

test("scenario: a catalog API flap (modules vanish for one run) leaves no false removed entry and no tombstone once the API is whole, at any probe budget", async (t) => {
  const flapped = ["learn.azure.f50", "learn.azure.f51", "learn.azure.f52", "dollar"];
  const slugs = ["f50", "f51", "f52", "become-contributor"];
  for (const budget of ["300", "1", "0"]) {
    const lab = await labAt(t, 2);
    const before = stableColumns(lab);
    const trueTombstones = tombstoneUids(lab);
    const saved = flapped.map((key) => lab.specs.get(key));
    for (const key of flapped) lab.specs.delete(key);
    // the live site still serves every flapped module
    for (const slug of slugs) lab.answers[M(slug)] = probeServed(M(slug));

    // both Learn runs have their own budget and work through the same queue
    await lab.week(3, { catalog: { env: { CHANGES_MAX_PROBES: budget } }, content: { env: { CHANGES_MAX_PROBES: budget } } });
    assert.equal(tombstoneUids(lab).length, trueTombstones.length + 4, `budget ${budget}: the flap is tombstoned (that is the sync's rule)`);
    const during = ledgerPaths(lab);
    const stillRecorded = slugs.filter((s) => during.has(M(s)));
    if (budget === "300") assert.deepEqual(stillRecorded, [], "a working probe dismisses the candidates in the same run");
    else assert.equal(stillRecorded.length, Math.max(0, 4 - 2 * Number(budget)), `budget ${budget}: what the two budgets did not reach stays recorded as unverified`);

    flapped.forEach((key, i) => lab.specs.set(key, saved[i]));
    await lab.week(4);
    assert.deepEqual(stableColumns(lab), before, `budget ${budget}: nothing false survives the flap`);
    assert.deepEqual(tombstoneUids(lab), trueTombstones, `budget ${budget}: the flap's tombstones are dropped`);
  }
});

test("scenario: a content API flap (an exam and a learning path vanish for one run) leaves no false removed entry and no tombstone", async (t) => {
  const lab = await labAt(t, 2);
  const before = stableColumns(lab);
  const trueTombstones = lab.file("learn-content.json").removed.map((r) => `${r.type}:${r.uid}`);
  const full = lab.content;
  lab.content = { ...full, exams: full.exams.filter((e) => e.uid !== "exam.az-305"), learningPaths: full.learningPaths.filter((p) => p.uid !== "learn.path-keep") };
  lab.answers["/training/paths/path-keep"] = probeServed("/training/paths/path-keep");
  // (the exam probe stays blocked: a transient answer on top of the flap)
  await lab.week(3);
  const during = ledgerPaths(lab);
  assert.ok(during.has("/credentials/certifications/exams/az-305"), "the blocked exam probe leaves an unverified entry");
  assert.ok(!during.has("/training/paths/path-keep"), "a live answer dismissed the path");
  lab.content = full;
  await lab.week(4);
  assert.deepEqual(stableColumns(lab), before);
  assert.deepEqual(lab.file("learn-content.json").removed.map((r) => `${r.type}:${r.uid}`), trueTombstones);
});

// Step 4 "collapse" of applyChangesDetailed (scripts/lib/changes.mjs): a unit entry is deleted for good when ITS MODULE has a
// CLASSIFIED removed entry (gone, landing, retired). An `unverified` module entry covers nothing: it may be false (the module
// flapped out of the API, or the hierarchy API flapped), and a unit entry dropped under it would never come back, because the
// units are still missing from the module's unit list and no detector re-derives them.
test("scenario: units recorded as removed or moved survive a flap of their module (the module entry only covers them while it stands)", async (t) => {
  const lab = await labAt(t, 2);
  const before = stableColumns(lab);
  assert.ok(PATHS_OF_W1_UNITS.every((p) => ledgerPaths(lab).has(p)));
  // W3: unit-gone is missing from the catalog API for one run and the probe budget is spent on other things
  const saved = lab.specs.get("unitgone");
  lab.specs.delete("unitgone");
  await lab.week(3, { catalog: { env: { CHANGES_MAX_PROBES: "0" } }, content: { env: { CHANGES_MAX_PROBES: "0" } } });
  // W4: it is back with the same units: the module entry is resurrected
  lab.specs.set("unitgone", saved);
  await lab.week(4);
  assert.deepEqual(stableColumns(lab), before, "the units that really were removed in W1 are still recorded as removed");
});

// The same rule, reached through a hierarchy API flap instead of a catalog flap.
test("scenario: units recorded as removed survive a one-run hierarchy flap of their module (module_id_not_found with a changed signature)", async (t) => {
  const lab = await labAt(t, 2);
  const before = stableColumns(lab);
  // W3: the module's content changed (new signature) and the hierarchy API wrongly answers module_id_not_found for it
  const spec = lab.specs.get("unitgone");
  lab.fake.state.hierarchyFailures.set("learn.azure.unitgone", 404);
  lab.specs.set("unitgone", { ...spec, lastModified: "2026-10-20T00:00:00+00:00" });
  await lab.week(3, { catalog: { env: { CHANGES_MAX_PROBES: "0" } }, content: { env: { CHANGES_MAX_PROBES: "0" } } });
  const mid = lab.file("learn-catalog.json").modules.find((m) => m.uid === "learn.azure.unitgone");
  assert.equal(mid.hierarchyNotFound, true, "the glitch flags the module");
  // W4: the hierarchy API answers again
  lab.fake.state.hierarchyFailures.delete("learn.azure.unitgone");
  await lab.week(4);
  assert.deepEqual(stableColumns(lab), before, "the module entry is gone again and the unit entries are still there");
});

// The same flap with the DEFAULT probe budget: the probe of the module is attempted but Learn blocks it (a transient answer),
// the case that needs no tiny budget at all. The units are neither dropped nor probed while the module is unsettled.
test("scenario: with the default probe budget, a blocked probe of a flapped module leaves its units' entries recorded and unprobed", async (t) => {
  const lab = await labAt(t, 2);
  const before = stableColumns(lab);
  const saved = lab.specs.get("unitgone");
  lab.specs.delete("unitgone");
  lab.probe.calls.length = 0;
  await lab.week(3); // no answer for the module: blocked
  const during = lab.changes("learn");
  const mid = [...during.removed, ...during.moved].find((e) => e.path === M("unit-gone"));
  assert.equal(mid?.outcome, "unverified", "the module is recorded but could not be classified");
  assert.ok(PATHS_OF_W1_UNITS.slice(0, 2).every((p) => ledgerPaths(lab).has(p)), "its units' entries are still there");
  assert.ok(!lab.probe.calls.some((p) => p.startsWith(`${M("unit-gone")}/`)), "and were not probed while the module is unsettled");
  lab.specs.set("unitgone", saved);
  await lab.week(4);
  assert.deepEqual(stableColumns(lab), before);
});

// A module Learn lists but does not serve (the hierarchy API says module_id_not_found, the page lands on a learning path) is
// recorded with a probed classification. A later hierarchy answer that is NOT definitive (a bare 404, a 403) clears the flag
// but proves nothing about the module (unitUrls stays null): the entry must survive, with its firstSeen, until the hierarchy
// really answers. (Before the fix a single such answer deleted the entry and the next run re-created it with a later firstSeen.)
test("scenario: a listed-but-unserved module keeps its probed entry and firstSeen through non-definitive hierarchy answers, and goes only when the hierarchy answers", async (t) => {
  const lab = await labAt(t, 2);
  const f10 = M("f10");
  const entryOf = () => lab.changes("learn").removed.find((e) => e.path === f10);
  const flag = () => lab.file("learn-catalog.json").modules.find((m) => m.uid === "learn.azure.f10");
  lab.answers[f10] = probeServed("/training/paths/azure", { first: 301 });

  // W3: the module changed (a new signature, so its old unit list is not reused) and the hierarchy API answers module_id_not_found
  lab.fake.state.hierarchyFailures.set("learn.azure.f10", 404);
  lab.specs.set("learn.azure.f10", { ...lab.specs.get("learn.azure.f10"), lastModified: "2026-10-20T00:00:00+00:00" });
  await lab.week(3);
  assert.equal(flag().hierarchyNotFound, true);
  assert.deepEqual(row(entryOf()), [f10, "landing", "/training/paths/azure", "2026-10-26", "2026-10-26", "hierarchy-not-found"]);

  // W4 and W5: the API answers, but not with its own definitive "not found"
  for (const [n, failure] of [[4, "bare404"], [5, 403]]) {
    lab.fake.state.hierarchyFailures.set("learn.azure.f10", failure);
    await lab.week(n);
    assert.equal("hierarchyNotFound" in flag(), false, `week ${n}: the flag follows the API's own answer only`);
    assert.equal(flag().unitUrls, null);
    const kept = entryOf();
    assert.ok(kept, `week ${n}: the entry is not erased by a non-answer`);
    assert.deepEqual([kept.outcome, kept.firstSeen, kept.evidence], ["landing", "2026-10-26", "hierarchy-not-found"], `week ${n}`);
    assert.equal(kept.lastVerified, weekAt(n).catalog.slice(0, 10), `week ${n}: re-verified by the rotation`);
  }

  // W6: the hierarchy answers with real units: the cache vouches for the module and the entry goes, without a probe
  lab.fake.state.hierarchyFailures.delete("learn.azure.f10");
  lab.probe.calls.length = 0;
  await lab.week(6);
  assert.equal(entryOf(), undefined);
  assert.ok(!lab.probe.calls.includes(f10), "a resurrection by the cache needs no probe");
  assert.ok(Array.isArray(flag().unitUrls));
});

// ---------------------------------------------------------------------------
// moves that change their mind, renames of renames, a repeated run
// ---------------------------------------------------------------------------

test("scenario: a move whose destination is later removed is followed through the ledger and, once re-probed, switches files with its firstSeen", async (t) => {
  const lab = await labAt(t, 2);
  assert.equal(lookupChange(M("repl-old"), indexOf(lab))?.state, "moved");
  // W3: the replacement module is removed, but the live site still redirects the old slug to it for now (a stale answer)
  lab.specs.delete("repl2");
  lab.answers[M("repl-new")] = PROBE_NOT_FOUND;
  await lab.week(3);
  const hit = lookupChange(M("repl-old"), indexOf(lab));
  assert.equal(hit.state, "removed", "the chain ends in a removed entry: the old link counts as removed");
  assert.deepEqual(hit.chain, [M("repl-old"), M("repl-new")]);
  assert.deepEqual(rows(lab.changes("learn").moved).find((r) => r[0] === M("repl-old")).slice(0, 3), [M("repl-old"), "moved", M("repl-new")]);
  // W4: the live site now answers 404 for the old slug as well
  lab.answers[M("repl-old")] = PROBE_NOT_FOUND;
  await lab.week(4);
  const { removed, moved } = lab.changes("learn");
  assert.ok(!moved.some((e) => e.path === M("repl-old")), "left moved.json");
  const entry = removed.find((e) => e.path === M("repl-old"));
  assert.deepEqual([entry.outcome, entry.to, entry.firstSeen, entry.evidence, entry.lastVerified], ["gone", null, "2026-10-12", "tombstone", "2026-11-02"], "it keeps its firstSeen and evidence");
  const everywhere = [...removed, ...moved].map((e) => e.path);
  assert.equal(new Set(everywhere).size, everywhere.length, "every path is in exactly one file, once");
});

test("scenario: a module renamed twice keeps one entry per old slug and the chain ends at the newest one", async (t) => {
  const lab = await labAt(t, 2);
  lab.specs.set("ren", { uid: "learn.azure.ren", slug: "ren-newest" });
  lab.answers[M("ren-old")] = probeServed(M("ren-newest"), { first: 301 });
  lab.answers[M("ren-new")] = probeServed(M("ren-newest"), { first: 301 });
  await lab.week(3);
  const moved = Object.fromEntries(lab.changes("learn").moved.map((e) => [e.path, e]));
  assert.deepEqual([moved[M("ren-new")].to, moved[M("ren-new")].firstSeen, moved[M("ren-new")].evidence], [M("ren-newest"), "2026-10-26", "rename"]);
  assert.deepEqual([moved[M("ren-old")].to, moved[M("ren-old")].firstSeen], [M("ren-newest"), "2026-10-12"], "the first rename's entry now points at the newest slug (it was re-probed because its destination moved again)");
  const hit = lookupChange(M("ren-old"), indexOf(lab));
  assert.deepEqual([hit.state, hit.to, hit.confidence], ["moved", M("ren-newest"), "high"]);
});

test("scenario: running the same week again later the same day changes no entry (only the timestamps move), and does not re-report anything", async (t) => {
  const lab = await labAt(t, 1);
  const entriesOf = () => JSON.stringify([lab.file("changes/removed.json").entries, lab.file("changes/moved.json").entries]);
  const first = entriesOf();
  const catalogBefore = lab.text("learn-catalog.json");
  const again = { catalog: "2026-10-12T15:00:00.000Z", content: "2026-10-12T15:30:00.000Z", docs: "2026-10-12T16:00:00.000Z" };
  const w = await lab.week(1, { when: again });
  assert.equal(entriesOf(), first, "same entries, byte for byte");
  assert.equal(lab.text("learn-catalog.json"), catalogBefore, "the catalog is unchanged");
  assert.equal(w.catalog.changesStats.newRemoved + w.catalog.changesStats.newMoved, 0);
  assert.equal(lab.file("changes/removed.json").generatedAt, again.docs);
  assert.equal(lab.file("changes/removed.json").sources.learn, again.content);
});

// ---------------------------------------------------------------------------
// aborted runs, run order
// ---------------------------------------------------------------------------

test("scenario: a run that a failsafe aborts leaves every byte of data/ as it was, probes nothing, and the next healthy run is the same as without the abort", async (t) => {
  const lab = await labAt(t, 2);
  const control = await labAt(t, 2);
  assert.deepEqual(lab.h.snapshot(), control.h.snapshot(), "two labs with the same history have the same files");
  const before = lab.h.snapshot();
  const calls = lab.probe.calls.length;
  const contentBefore = structuredClone(lab.content);

  // catalog: half of the API vanishes
  lab.fake.state.truncateModulesTo = 30;
  await assert.rejects(lab.catalog(WEEKS[3].catalog), FailsafeAbort);
  lab.fake.state.truncateModulesTo = null;
  assert.deepEqual(lab.h.snapshot(), before, "catalog abort");

  // content: every course vanishes (default drop limit)
  lab.content.courses = [];
  await assert.rejects(lab.contentRun(WEEKS[3].content, { env: { MAX_CONTENT_DROP_PCT: "" } }), FailsafeAbort);
  lab.content = contentBefore;
  assert.deepEqual(lab.h.snapshot(), before, "content abort");

  // docs: the sitemaps shrink to a fraction
  const docsFamilies = lab.docsSite.families;
  lab.docsSite.families = new Map([["entra", { entries: stable("entra", 4), fail: null }]]);
  const aborted = await lab.docs(WEEKS[3].docs);
  assert.equal(aborted.exitCode, 1, aborted.messages.join("\n"));
  assert.match(aborted.aborted ?? "", /./);
  lab.docsSite.families = docsFamilies;
  assert.deepEqual(lab.h.snapshot(), before, "docs abort");
  assert.equal(lab.probe.calls.length, calls, "no live probe was made by an aborted run");

  // the next healthy week is byte-identical to the control lab that never saw an abort
  await lab.week(3);
  await control.week(3);
  assert.deepEqual(lab.h.snapshot(), control.h.snapshot());
});

const COMPARED = ["changes/removed.json", "changes/moved.json", "learn-catalog.json", "learn-content.json", "docs-catalog.json", "docs-catalog-invalid.json", "docs-redirects.json", "docs-urls.txt", "docs-sitemap-families.json"];
const statusWithoutCounters = (lab) => {
  const status = lab.file("status.json");
  delete status.learn.catalogChanges;
  delete status.learn.contentChanges;
  return status;
};

test("scenario: the order of the three syncs does not change the final files (same clock): all six orders end in the same bytes", async (t) => {
  const base = await labAt(t, 0);
  const parts = ["catalog", "content", "docs"];
  const orders = [];
  for (const a of parts) for (const b of parts) for (const c of parts) if (new Set([a, b, c]).size === 3) orders.push([a, b, c]);
  assert.equal(orders.length, 6);
  const when = SAME("2026-10-12T08:00:00.000Z");
  const labs = orders.map((order, i) => ({ order, lab: i === 0 ? base : makeLab(t, { from: base }) }));
  for (const { order, lab } of labs) {
    mutateW1(lab);
    answersW1(lab.answers);
    await lab.week(1, { order, when });
  }
  const [reference, ...others] = labs;
  for (const { order, lab } of others) {
    for (const file of COMPARED) assert.equal(lab.text(file), reference.lab.text(file), `${file}: order ${order.join(">")} differs from ${reference.order.join(">")}`);
    assert.deepEqual(statusWithoutCounters(lab), statusWithoutCounters(reference.lab), `status.json (${order.join(">")})`);
  }
  assert.ok(reference.lab.changes("learn").removed.length > 0, "the comparison was not between two empty files");
  assert.ok(reference.lab.changes("docs").removed.length + reference.lab.changes("docs").moved.length > 0);
});
