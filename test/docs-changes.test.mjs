import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { CHANGES_DIR, emptyChanges, loadChanges, normalizeChangeEntry, writeChanges } from "../scripts/lib/changes.mjs";
import { buildDocsChanges, writeDocsChanges } from "../scripts/lib/docs-changes.mjs";
import { FakeLearn, ORIGIN, harness, run, stable } from "./docs-fixtures.mjs";

// The docs sync's share of data/changes/removed.json and moved.json. The library behind them has its own
// tests (changes.test.mjs); these cover the wiring: when the docs family is derived, what it is derived
// from, what it leaves alone and what a run that does not finish must never touch.

const T0 = "2026-10-05T10:00:00.000Z";

/** Azure pages a..f on top of the stable ones, so a few of them can leave the sitemap without tripping the 85% sanity failsafe. */
function changesLearn() {
  const learn = new FakeLearn();
  const lastmods = { a: "2026-09-20", b: "2026-09-21", c: "2026-09-22", d: "2026-09-23", e: "2026-09-24", f: "2026-09-25" };
  learn.family("azure", [...stable("azure", 24), ...Object.entries(lastmods).map(([name, lastmod]) => [`/azure/${name}`, lastmod])]);
  learn.family("entra", stable("entra", 4));
  learn.family("cli", [["/cli/azure/vm", "2026-09-01"]]);
  return learn;
}

const stamp = (when) => new Date(when).toISOString();
const readChangeFile = (h, name) => h.json(`${CHANGES_DIR}/${name}.json`);
const docsEntries = (h, name) => readChangeFile(h, name).entries.filter((e) => e.family === "docs");
const learnEntries = (h, name) => readChangeFile(h, name).entries.filter((e) => e.family === "learn");
const brief = (entries) => entries.map((e) => [e.path, e.outcome, e.to]);

/** The exact bytes an entry takes up inside an `entries` array written with JSON.stringify(x, null, 2). */
const blockOf = (entry) => JSON.stringify(entry, null, 2).replace(/^/gm, "    ");

const learnModule = (over = {}) => ({
  path: "/training/modules/gone-module",
  kind: "module",
  family: "learn",
  outcome: "landing",
  to: "/training/paths/some-path",
  title: "A removed module",
  parent: null,
  firstSeen: "2026-09-30",
  lastVerified: "2026-10-01",
  evidence: "tombstone",
  status: 301,
  ...over,
});
const learnUnit = (over = {}) => ({
  path: "/training/modules/other/05-exercise",
  kind: "unit",
  family: "learn",
  outcome: "unverified",
  to: null,
  title: "Exercise",
  parent: "/training/modules/other",
  firstSeen: "2026-10-02",
  lastVerified: null,
  evidence: "unit-diff",
  status: null,
  note: "an unknown field of a newer writer",
  ...over,
});
const learnMoved = (over = {}) => ({
  path: "/training/modules/old-name",
  kind: "module",
  family: "learn",
  outcome: "moved",
  to: "/training/modules/new-name",
  title: "Renamed",
  parent: null,
  firstSeen: "2026-09-29",
  lastVerified: "2026-10-01",
  evidence: "rename",
  status: 301,
  ...over,
});

/** Puts a Learn sync's change files into the data directory (through the library, so the bytes are canonical). */
function seedLearn(h, { removed = [learnModule(), learnUnit()], moved = [learnMoved()] } = {}) {
  const learnAt = "2026-10-01T06:00:00.000Z";
  const file = (entries) => ({ schemaVersion: 1, generatedAt: learnAt, sources: { learn: learnAt, docs: null }, entries });
  writeChanges(h.data, { removed: file(removed), moved: file(moved) });
  return learnAt;
}

// ---- the docs family follows the ledger and the quarantine -------------------------------------

test("docs entries appear and disappear as the redirect ledger and the quarantine change", async (t) => {
  const h = harness(t);
  const learn = changesLearn();
  const week0 = await run(h, learn);
  assert.equal(week0.exitCode, 0, week0.messages.join("\n"));
  assert.deepEqual(readChangeFile(h, "removed").entries, []);
  assert.deepEqual(readChangeFile(h, "moved").entries, []);

  // week 1: b is gone, c moved, d lands on the product root, e is retired into /previous-versions; all left the sitemap
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/f", "2026-09-25"]]);
  learn.page("/azure/b", "gone");
  learn.page("/azure/c", { to: "/azure/c-new" });
  learn.page("/azure/d", { to: "/azure" });
  learn.page("/azure/e", { to: "/previous-versions/azure/e" });
  const w1 = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(w1.exitCode, 0, w1.messages.join("\n"));
  assert.deepEqual(docsEntries(h, "removed"), [
    { path: "/azure/b", kind: "docs", family: "docs", outcome: "gone", to: null, title: "Page /azure/b", parent: null, firstSeen: "2026-10-12", lastVerified: "2026-10-12", evidence: "quarantine", status: 404 },
    { path: "/azure/d", kind: "docs", family: "docs", outcome: "landing", to: "/azure", title: null, parent: null, firstSeen: "2026-10-12", lastVerified: "2026-10-12", evidence: "docs-redirect", status: 301 },
    { path: "/azure/e", kind: "docs", family: "docs", outcome: "retired", to: "/previous-versions/azure/e", title: null, parent: null, firstSeen: "2026-10-12", lastVerified: "2026-10-12", evidence: "docs-redirect", status: 301 },
  ]);
  assert.deepEqual(docsEntries(h, "moved"), [
    { path: "/azure/c", kind: "docs", family: "docs", outcome: "moved", to: "/azure/c-new", title: null, parent: null, firstSeen: "2026-10-12", lastVerified: "2026-10-12", evidence: "docs-redirect", status: 301 },
  ]);
  for (const name of ["removed", "moved"]) {
    const file = readChangeFile(h, name);
    assert.equal(file.schemaVersion, 1);
    assert.equal(file.generatedAt, stamp("2026-10-12T10:00:00Z"));
    assert.deepEqual(file.sources, { learn: null, docs: stamp("2026-10-12T10:00:00Z") });
  }
  assert.deepEqual(h.json("status.json").docs.changes, { removed: 3, moved: 1 });
  assert.ok(w1.messages.some((m) => /change files: docs 3 removed, 1 moved/.test(m)), w1.messages.join("\n"));

  // week 2: b is restored (released from the quarantine), c is listed in the sitemap again (its ledger row is deleted)
  learn.page("/azure/b", "live");
  learn.page("/azure/c", "live");
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/c", "2026-10-18"], ["/azure/f", "2026-09-25"]]);
  const w2 = await run(h, learn, { when: "2026-10-19T10:00:00Z" });
  assert.equal(w2.exitCode, 0, w2.messages.join("\n"));
  assert.deepEqual(h.json("docs-catalog-invalid.json"), []);
  assert.deepEqual(h.json("docs-redirects.json").map((e) => e.from), ["/azure/d", "/azure/e"]);
  assert.deepEqual(brief(docsEntries(h, "removed")), [["/azure/d", "landing", "/azure"], ["/azure/e", "retired", "/previous-versions/azure/e"]]);
  assert.deepEqual(docsEntries(h, "moved"), [], "c is listed again: gone from moved.json");
  assert.ok(docsEntries(h, "removed").every((e) => e.firstSeen === "2026-10-12"), "an entry that stays keeps its firstSeen");
  assert.deepEqual(readChangeFile(h, "moved").sources.docs, stamp("2026-10-19T10:00:00Z"));
  assert.deepEqual(h.json("status.json").docs.changes, { removed: 2, moved: 0 });

  // week 3: d is back in the index (re-indexed), f 404s while still listed (quarantined by the verification pass)
  learn.page("/azure/d", "live");
  learn.page("/azure/f", "gone");
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/c", "2026-10-18"], ["/azure/d", "2026-10-25"], ["/azure/f", "2026-09-25"]]);
  const w3 = await run(h, learn, { when: "2026-10-26T10:00:00Z" });
  assert.equal(w3.exitCode, 0, w3.messages.join("\n"));
  assert.deepEqual(
    docsEntries(h, "removed").map((e) => [e.path, e.outcome, e.evidence, e.firstSeen]),
    [["/azure/e", "retired", "docs-redirect", "2026-10-12"], ["/azure/f", "gone", "quarantine", "2026-10-26"]]
  );
  assert.deepEqual(h.json("status.json").docs.changes, { removed: 2, moved: 0 });
});

test("a Learn entry is returned byte for byte: only the docs entries and the timestamps change", async (t) => {
  const h = harness(t);
  const learnAt = seedLearn(h);
  const before = { removed: learnEntries(h, "removed"), moved: learnEntries(h, "moved") };
  assert.equal(before.removed.length, 2);
  assert.equal(before.moved.length, 1);

  const learn = changesLearn();
  await run(h, learn); // week 0: nothing to report
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/f", "2026-09-25"]]);
  learn.page("/azure/b", "gone");
  learn.page("/azure/c", { to: "/azure/c-new" });
  const r = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(r.exitCode, 0, r.messages.join("\n"));

  for (const name of ["removed", "moved"]) {
    const text = h.read(`${CHANGES_DIR}/${name}.json`);
    assert.deepEqual(learnEntries(h, name), before[name], `${name}.json: Learn entries are equal`);
    for (const entry of before[name]) assert.ok(text.includes(blockOf(entry)), `${name}.json: ${entry.path} is byte-identical`);
    assert.deepEqual(readChangeFile(h, name).sources, { learn: learnAt, docs: stamp("2026-10-12T10:00:00Z") }, "sources.learn is the Learn sync's, sources.docs is this run's");
    assert.equal(readChangeFile(h, name).generatedAt, stamp("2026-10-12T10:00:00Z"));
  }
  assert.deepEqual(brief(docsEntries(h, "removed")), [["/azure/b", "gone", null]]);
  assert.deepEqual(brief(docsEntries(h, "moved")), [["/azure/c", "moved", "/azure/c-new"]]);
  // the two families do not mix into the counters or the log line
  assert.deepEqual(h.json("status.json").docs.changes, { removed: 1, moved: 1 });
  assert.ok(r.messages.some((m) => /change files: docs 1 removed, 1 moved .*3 Learn entries left untouched/.test(m)), r.messages.join("\n"));

  // the entries of the two families are interleaved by path, in code point order
  const paths = readChangeFile(h, "removed").entries.map((e) => e.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.deepEqual(paths, ["/azure/b", "/training/modules/gone-module", "/training/modules/other/05-exercise"]);
});

test("a docs run that changes nothing reproduces the files byte for byte (same clock) and says so", async (t) => {
  const h = harness(t);
  seedLearn(h);
  const learn = changesLearn();
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/f", "2026-09-25"]]);
  learn.page("/azure/b", "gone");
  const first = await run(h, changesLearn());
  assert.equal(first.exitCode, 0, first.messages.join("\n"));
  const second = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(second.exitCode, 0, second.messages.join("\n"));
  assert.equal(second.written.changes, true, "new entries and a new timestamp");
  const before = h.snapshot();
  const third = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(third.exitCode, 0, third.messages.join("\n"));
  assert.equal(third.written.changes, false, "identical bytes: nothing to write");
  assert.deepEqual(
    Object.fromEntries(Object.entries(h.snapshot()).filter(([name]) => name.startsWith("changes/"))),
    Object.fromEntries(Object.entries(before).filter(([name]) => name.startsWith("changes/")))
  );
});

test("missing change files are created, also when only one of them exists", async (t) => {
  const h = harness(t);
  seedLearn(h);
  rmSync(h.file(`${CHANGES_DIR}/moved.json`));
  const r = await run(h, changesLearn());
  assert.equal(r.exitCode, 0, r.messages.join("\n"));
  assert.deepEqual(readdirSync(h.file(CHANGES_DIR)).sort(), ["moved.json", "removed.json"]);
  assert.equal(learnEntries(h, "removed").length, 2, "the Learn entries of the file that existed survive");
  assert.deepEqual(readChangeFile(h, "moved").entries, [], "the missing file starts empty (its Learn entry was never on disk)");
  assert.deepEqual(readChangeFile(h, "moved").sources, { learn: null, docs: T0 });
});

test("a malformed row in a change file is dropped with a warning that reaches the log; the run goes on", async (t) => {
  const h = harness(t);
  mkdirSync(h.file(CHANGES_DIR));
  writeFileSync(
    h.file(`${CHANGES_DIR}/removed.json`),
    JSON.stringify({ schemaVersion: 1, generatedAt: null, sources: { learn: null, docs: null }, entries: [learnModule(), { path: "not-a-path", kind: "module" }] })
  );
  const r = await run(h, changesLearn());
  assert.equal(r.exitCode, 0, r.messages.join("\n"));
  assert.ok(r.messages.some((m) => /^WARN .*dropped a malformed row/.test(m)), r.messages.join("\n"));
  assert.deepEqual(readChangeFile(h, "removed").entries.map((e) => e.path), ["/training/modules/gone-module"]);
});

test("a quarantined page outside learn.microsoft.com has no place in the change files", async (t) => {
  const h = harness(t);
  const learn = changesLearn();
  await run(h, learn);
  const external = { title: "gh", url: "https://docs.github.com/en/gone", product: "p", subproduct: null, description: null, status: 404, firstDetected: "2026-09-01", lastChecked: "2026-09-02" };
  writeFileSync(h.file("docs-catalog-invalid.json"), JSON.stringify([external]));
  const base = learn.client();
  const client = { ...base, get: async (url, options) => (url.startsWith("https://docs.github.com") ? { status: 404, text: "" } : base.get(url, options)) };
  const r = await run(h, learn, { when: "2026-10-12T10:00:00Z", client });
  assert.equal(r.exitCode, 0, r.messages.join("\n"));
  assert.equal(h.json("docs-catalog-invalid.json").length, 1, "still quarantined (this sync's own bookkeeping)");
  assert.deepEqual(docsEntries(h, "removed"), []);
  assert.deepEqual(h.json("status.json").docs.changes, { removed: 0, moved: 0 });
});

test("a degraded run (a sitemap file failed, exit 1 after writing) still writes the change files from the carried-forward ledger", async (t) => {
  const h = harness(t);
  const learn = changesLearn();
  await run(h, learn);
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/f", "2026-09-25"]]);
  learn.page("/azure/b", "gone");
  await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.deepEqual(brief(docsEntries(h, "removed")), [["/azure/b", "gone", null]]);

  learn.failFamily("entra", 500);
  const r = await run(h, learn, { when: "2026-10-19T10:00:00Z" });
  assert.equal(r.exitCode, 1);
  assert.ok(r.messages.some((m) => /DEGRADED/.test(m)));
  assert.deepEqual(brief(docsEntries(h, "removed")), [["/azure/b", "gone", null]], "nothing is dropped because a sitemap file failed");
  assert.equal(readChangeFile(h, "removed").sources.docs, stamp("2026-10-19T10:00:00Z"));
});

// ---- nothing is written when the run does not finish --------------------------------------------

test("a failsafe abort writes nothing: the change files keep their bytes, and a first run creates none", async (t) => {
  const h = harness(t);
  seedLearn(h);
  const learn = changesLearn();
  await run(h, learn);
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/f", "2026-09-25"]]);
  learn.page("/azure/b", "gone");
  await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  const before = h.snapshot();
  assert.ok(Object.keys(before).includes("changes/removed.json"));

  // early failsafe (sitemap pass far below the index)
  const outage = changesLearn();
  outage.family("azure", stable("azure", 6));
  outage.family("entra", []);
  const early = await run(h, outage, { when: "2026-10-19T10:00:00Z" });
  assert.equal(early.exitCode, 1);
  assert.match(early.aborted, /outage or a format change/);
  assert.deepEqual(h.snapshot(), before, "every file, the change files and status.json included, is byte-identical");

  // late failsafe (a quarantine storm shrinks the catalog; the change files are derived after it, so they must not be touched)
  const storm = changesLearn();
  storm.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/f", "2026-09-25"]]);
  for (const [p] of [...stable("azure", 24), ...stable("entra", 4)]) storm.page(p, "gone");
  const late = await run(h, storm, { when: "2026-10-19T10:00:00Z" });
  assert.equal(late.exitCode, 1);
  assert.match(late.aborted, /catalog records, expected at least/);
  assert.deepEqual(h.snapshot(), before);

  // a data directory that predates the change files: an aborted run does not create them
  const old = harness(t);
  assert.equal((await run(old, changesLearn())).exitCode, 0);
  rmSync(old.file(CHANGES_DIR), { recursive: true });
  const aborted = await run(old, outage, { when: "2026-10-19T10:00:00Z" });
  assert.equal(aborted.exitCode, 1);
  assert.equal(readdirSync(old.data).includes(CHANGES_DIR), false);
});

test("DRY_RUN reads the change files but writes nothing, not even data/changes/", async (t) => {
  const none = harness(t);
  const r = await run(none, changesLearn(), { env: { DRY_RUN: "1" } });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(readdirSync(none.data), []);

  const h = harness(t);
  seedLearn(h);
  const before = h.snapshot();
  const dry = await run(h, changesLearn(), { env: { DRY_RUN: "1" }, when: "2026-10-12T10:00:00Z" });
  assert.equal(dry.exitCode, 0, dry.messages.join("\n"));
  assert.equal(dry.dryRun, true);
  assert.equal(dry.probes.length, 0);
  assert.deepEqual(h.snapshot(), before);
});

test("a corrupt change file fails the run loudly before any request or write", async (t) => {
  const corrupt = [
    ["invalid JSON", "{not json"],
    ["top level is not an object", "[]"],
    ["unsupported schemaVersion", JSON.stringify({ schemaVersion: 2, entries: [] })],
    ["no schemaVersion", JSON.stringify({ entries: [] })],
    ["entries is not an array", JSON.stringify({ schemaVersion: 1, entries: {} })],
  ];
  for (const [label, content] of corrupt) {
    for (const name of ["removed.json", "moved.json"]) {
      for (const env of [{}, { DRY_RUN: "1" }]) {
        const h = harness(t);
        mkdirSync(h.file(CHANGES_DIR));
        writeFileSync(h.file(`${CHANGES_DIR}/${name}`), content);
        const before = h.snapshot();
        const r = await run(h, changesLearn(), { env });
        const why = `${label} in ${name}${env.DRY_RUN ? " (DRY_RUN)" : ""}`;
        assert.equal(r.exitCode, 1, why);
        assert.match(r.aborted, new RegExp(`change file .*${name.replace(".", "\\.")}`), why);
        assert.ok(r.messages.some((m) => /^WARN \nAborting: Cannot use change file/.test(m)), `${why}: reported as an abort`);
        assert.equal(r.gets.length + r.probes.length, 0, `${why}: before any request`);
        assert.deepEqual(h.snapshot(), before, `${why}: nothing written, the damaged file untouched`);
      }
    }
  }
});

// ---- the derivation itself ----------------------------------------------------------------------

const ledgerRow = (from, to, kind, over = {}) => ({ from, to, kind, status: 301, firstSeen: "2026-10-01", lastSeen: "2026-10-05", ...over });
const quarantineRow = (path, over = {}) => ({ title: `Title ${path}`, url: `${ORIGIN}${path}`, product: "p", subproduct: null, description: "d", status: 404, firstDetected: "2026-09-20", lastChecked: "2026-10-04", ...over });

test("buildDocsChanges: ledger kinds and quarantine rows land in the right file; Learn entries ride along; counts add up", () => {
  const previous = emptyChanges();
  previous.removed.entries.push(learnModule());
  previous.removed.sources.learn = "2026-10-01T06:00:00.000Z";
  previous.moved.entries.push(learnMoved());
  // a stale docs entry from the previous run: the docs family is replaced, not merged
  previous.removed.entries.push(learnModule({ path: "/azure/stale", kind: "docs", family: "docs", outcome: "gone", to: null, evidence: "quarantine", status: 404 }));
  const previousText = JSON.stringify(previous);

  const { changes, counts, kept } = buildDocsChanges({
    previous,
    ledger: [ledgerRow("/azure/m", "/azure/m2", "moved"), ledgerRow("/azure/l", "/azure", "landing"), ledgerRow("/azure/r", "/previous-versions/azure/r", "retired"), ledgerRow("/azure/off", null, "moved", { status: 302 })],
    invalid: [quarantineRow("/azure/q"), { ...quarantineRow("/azure/ext"), url: "https://docs.github.com/en/ext" }],
    today: "2026-10-06",
    generatedAt: "2026-10-06T08:00:00.000Z",
  });
  assert.deepEqual(counts, { removed: 3, moved: 2 });
  assert.deepEqual(kept, { removed: 1, moved: 1 });
  assert.deepEqual(changes.removed.entries.map((e) => [e.path, e.outcome]), [["/azure/l", "landing"], ["/azure/q", "gone"], ["/azure/r", "retired"], ["/training/modules/gone-module", "landing"]]);
  assert.deepEqual(changes.moved.entries.map((e) => [e.path, e.to, e.status]), [["/azure/m", "/azure/m2", 301], ["/azure/off", null, 302], ["/training/modules/old-name", "/training/modules/new-name", 301]]);
  assert.deepEqual(changes.removed.sources, { learn: "2026-10-01T06:00:00.000Z", docs: "2026-10-06T08:00:00.000Z" });
  assert.equal(changes.moved.generatedAt, "2026-10-06T08:00:00.000Z");
  const q = changes.removed.entries.find((e) => e.path === "/azure/q");
  assert.deepEqual([q.title, q.firstSeen, q.lastVerified, q.evidence, q.status], ["Title /azure/q", "2026-09-20", "2026-10-04", "quarantine", 404]);
  assert.equal(JSON.stringify(previous), previousText, "the input is not modified");
});

test("buildDocsChanges: a row that cannot be represented is skipped with a warning instead of taking the sync down", () => {
  const warnings = [];
  const { changes, counts } = buildDocsChanges({
    previous: emptyChanges(),
    ledger: [ledgerRow("/azure/self", "/azure/self", "moved"), ledgerRow("/azure/fine", "/azure/fine2", "moved")],
    invalid: [],
    today: "2026-10-06",
    generatedAt: "2026-10-06T08:00:00.000Z",
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(counts, { removed: 0, moved: 1 });
  assert.deepEqual(changes.moved.entries.map((e) => e.path), ["/azure/fine"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\/azure\/self.*to equals path/);
});

test("buildDocsChanges: a missing date does not invent history, and bad arguments throw", () => {
  const { changes } = buildDocsChanges({
    previous: emptyChanges(),
    ledger: [{ from: "/azure/x", to: "/azure/y", kind: "moved", status: null, firstSeen: null, lastSeen: null }],
    invalid: [quarantineRow("/azure/z", { firstDetected: undefined, lastChecked: undefined, status: undefined })],
    today: "2026-10-06",
    generatedAt: "2026-10-06T08:00:00.000Z",
  });
  const [moved] = changes.moved.entries;
  assert.deepEqual([moved.firstSeen, moved.lastVerified, moved.status], ["2026-10-06", null, null]);
  const [gone] = changes.removed.entries;
  assert.deepEqual([gone.firstSeen, gone.lastVerified, gone.status], ["2026-10-06", null, null]);
  assert.throws(() => buildDocsChanges({ previous: emptyChanges(), ledger: [], invalid: [], today: "yesterday", generatedAt: "2026-10-06T08:00:00.000Z" }), TypeError);
  assert.throws(() => buildDocsChanges({ previous: emptyChanges(), ledger: [], invalid: [], today: "2026-10-06", generatedAt: "now" }), TypeError);
});

test("buildDocsChanges output is accepted by normalizeChangeEntry and round-trips through the files", (t) => {
  const h = harness(t);
  const { changes } = buildDocsChanges({
    previous: emptyChanges(),
    ledger: [ledgerRow("/azure/m", "/azure/m2", "moved")],
    invalid: [quarantineRow("/azure/q")],
    today: "2026-10-06",
    generatedAt: "2026-10-06T08:00:00.000Z",
  });
  for (const [file, set] of Object.entries(changes)) for (const entry of set.entries) assert.deepEqual(normalizeChangeEntry(entry, file), entry);
  assert.equal(writeDocsChanges(h.data, changes), true);
  assert.deepEqual(loadChanges(h.data), changes);
  assert.equal(writeDocsChanges(h.data, changes), false, "same bytes: reported as unchanged");
});
