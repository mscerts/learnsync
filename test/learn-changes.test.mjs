import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGES_PROBE_DELAY_MS, ChangesFileError, emptyChanges, normalizeChangeFile } from "../scripts/lib/changes.mjs";
import { CHANGES_CANDIDATE_WARN, changesCounters, modulePathsOf, openChanges, refreshChanges } from "../scripts/lib/learn-changes-run.mjs";
import { PROBE_BLOCKED, PROBE_NOT_FOUND, collectLogs, makeProbe, makeTempDir, probeServed, removeDir } from "./learn-fixtures.mjs";

const NOW = new Date("2026-10-06T08:00:00.000Z");
const LIMITS = { maxProbes: 300, reverifyPerRun: 100 };
const cand = (path, over = {}) => ({ path, kind: "module", title: null, evidence: "tombstone", firstSeen: "2026-10-05", ...over });
const noSleep = async () => {};
const recorder = () => {
  const sleeps = [];
  return { sleeps, sleepImpl: async (ms) => void sleeps.push(ms) };
};

test("openChanges: missing files are empty, the limits come from the environment, a corrupt file or a typo throws", () => {
  const dir = makeTempDir();
  try {
    const fresh = openChanges({ dataDir: dir, env: {}, warn: () => {} });
    assert.deepEqual(fresh.previous, emptyChanges());
    assert.deepEqual(fresh.limits, { maxProbes: 300, reverifyPerRun: 100 });
    assert.deepEqual(openChanges({ dataDir: dir, env: { CHANGES_MAX_PROBES: "5", CHANGES_REVERIFY_PER_RUN: "0" } }).limits, { maxProbes: 5, reverifyPerRun: 0 });
    assert.throws(() => openChanges({ dataDir: dir, env: { CHANGES_MAX_PROBES: "many" } }), /CHANGES_MAX_PROBES/);

    mkdirSync(join(dir, "changes"));
    writeFileSync(join(dir, "changes", "moved.json"), "not json");
    assert.throws(() => openChanges({ dataDir: dir, env: {} }), (err) => err instanceof ChangesFileError && /moved\.json/.test(err.message));
  } finally {
    removeDir(dir);
  }
});

test("openChanges warns about malformed rows of an otherwise valid file and keeps the good ones", () => {
  const dir = makeTempDir();
  try {
    mkdirSync(join(dir, "changes"));
    const good = { path: "/training/modules/x", kind: "module", family: "learn", outcome: "gone", to: null, title: null, parent: null, firstSeen: "2026-10-01", lastVerified: "2026-10-01", evidence: "tombstone", status: 404 };
    writeFileSync(join(dir, "changes", "removed.json"), JSON.stringify({ schemaVersion: 1, generatedAt: null, sources: {}, entries: [good, { path: "nope" }] }));
    const logs = collectLogs();
    const { previous } = openChanges({ dataDir: dir, env: {}, warn: logs.warn });
    assert.deepEqual(previous.removed.entries.map((e) => e.path), ["/training/modules/x"]);
    assert.equal(logs.lines.filter((l) => /dropped a malformed row/.test(l)).length, 1);
  } finally {
    removeDir(dir);
  }
});

test("modulePathsOf: modules and outOfScope in canonical form, junk tolerated", () => {
  const catalog = { modules: [{ path: "/training/modules/a" }, { path: "/training/saas/b" }, { path: null }, null, {}], outOfScope: ["/training/modules/C/", "", null, 5] };
  assert.deepEqual([...modulePathsOf(catalog)].sort(), ["/training/modules/a", "/training/modules/c", "/training/saas/b"]);
  assert.deepEqual([...modulePathsOf(null)], []);
  assert.deepEqual([...modulePathsOf({ modules: "x" })], []);
});

test("refreshChanges: stages candidates, probes, stamps sources.learn with the run's clock, logs one line, writes nothing", async () => {
  const probe = makeProbe({ "/training/modules/a": PROBE_NOT_FOUND, "/training/modules/b": probeServed("/training/paths/p", { first: 301 }), "/training/modules/c": probeServed("/training/modules/c2", { first: 301 }) });
  const logs = collectLogs();
  const result = await refreshChanges({
    previous: emptyChanges(),
    candidates: [cand("/training/modules/a"), cand("/training/modules/b"), cand("/training/modules/c")],
    now: NOW,
    limits: LIMITS,
    probe,
    sleepImpl: noSleep,
    delayMs: 0,
    log: logs.log,
    warn: logs.warn,
  });
  assert.deepEqual(result.changes.removed.entries.map((e) => [e.path, e.outcome, e.to, e.lastVerified]), [
    ["/training/modules/a", "gone", null, "2026-10-06"],
    ["/training/modules/b", "landing", "/training/paths/p", "2026-10-06"],
  ]);
  assert.deepEqual(result.changes.moved.entries.map((e) => [e.path, e.outcome, e.to]), [["/training/modules/c", "moved", "/training/modules/c2"]]);
  for (const file of [result.changes.removed, result.changes.moved]) {
    assert.equal(file.generatedAt, NOW.toISOString());
    assert.equal(file.sources.learn, NOW.toISOString());
  }
  assert.deepEqual(result.counters, { removed: 2, moved: 1, unverified: 0, newRemoved: 2, newMoved: 1, resurrected: 0, probed: 3 });
  assert.equal(logs.lines.filter((l) => l.startsWith("LOG")).length, 1, "exactly one summary line");
  assert.match(logs.lines[0], /change files \(changes\): 2 removed \(0 unverified\), 1 moved; this run 2 new removed, 1 new moved, 0 resurrected, 3 probed \(0 transient\)/);
});

test("refreshChanges: with nothing to do no probe is needed, and no probe function is required", async () => {
  const result = await refreshChanges({ previous: emptyChanges(), candidates: [], now: NOW, limits: LIMITS, sleepImpl: noSleep, log: () => {}, warn: () => {} });
  assert.deepEqual(result.counters, { removed: 0, moved: 0, unverified: 0, newRemoved: 0, newMoved: 0, resurrected: 0, probed: 0 });
  assert.deepEqual(result.changes.removed.entries, []);
});

test("refreshChanges: the catalog's module paths decide whether a destination outside /training/modules is a move", async () => {
  const answers = { "/training/modules/old": probeServed("/training/saas/new", { first: 301 }) };
  const run = (catalog) =>
    refreshChanges({ previous: emptyChanges(), candidates: [cand("/training/modules/old")], catalog, now: NOW, limits: LIMITS, probe: makeProbe(answers), sleepImpl: noSleep, delayMs: 0, log: () => {}, warn: () => {} });
  const known = await run({ modules: [{ path: "/training/saas/new", unitUrls: null }], outOfScope: [] });
  assert.deepEqual(known.changes.moved.entries.map((e) => [e.path, e.to]), [["/training/modules/old", "/training/saas/new"]]);
  const unknown = await run(null);
  assert.deepEqual(unknown.changes.removed.entries.map((e) => [e.path, e.outcome, e.to]), [["/training/modules/old", "landing", "/training/saas/new"]], "without the module list the conservative reading is landing");
});

test("refreshChanges: resurrection from the freshly built catalog and content, with no probe for those paths", async () => {
  const previous = {
    removed: normalizeChangeFile(
      {
        entries: [
          { path: "/training/modules/back", kind: "module", family: "learn", outcome: "unverified", to: null, title: null, parent: null, firstSeen: "2026-09-01", lastVerified: null, evidence: "tombstone", status: null },
          { path: "/training/paths/p-back", kind: "learning-path", family: "learn", outcome: "gone", to: null, title: null, parent: null, firstSeen: "2026-09-01", lastVerified: "2026-09-02", evidence: "tombstone", status: 404 },
        ],
      },
      "removed"
    ),
    moved: normalizeChangeFile({ entries: [] }, "moved"),
  };
  const probe = makeProbe();
  const result = await refreshChanges({
    previous,
    candidates: [],
    catalog: { modules: [{ path: "/training/modules/back", unitUrls: [] }], outOfScope: [] },
    content: { learningPaths: [{ path: "/training/paths/p-back" }] },
    now: NOW,
    limits: { maxProbes: 10, reverifyPerRun: 10 },
    probe,
    sleepImpl: noSleep,
    delayMs: 0,
    log: () => {},
    warn: () => {},
  });
  assert.deepEqual(result.changes.removed.entries, []);
  assert.equal(result.counters.resurrected, 2);
  assert.deepEqual(probe.calls, []);
});

test("refreshChanges: the default pace is 1000 ms per worker and an explicit pace and worker count are honoured", async () => {
  const candidates = [cand("/training/modules/a"), cand("/training/modules/b"), cand("/training/modules/c")];
  const base = { previous: emptyChanges(), candidates, now: NOW, limits: LIMITS, log: () => {}, warn: () => {} };
  const first = recorder();
  await refreshChanges({ ...base, probe: makeProbe({}, PROBE_NOT_FOUND), workers: 1, sleepImpl: first.sleepImpl });
  assert.equal(CHANGES_PROBE_DELAY_MS, 1000);
  assert.deepEqual(first.sleeps, [1000, 1000], "between probes of one worker, never after the last");
  const second = recorder();
  await refreshChanges({ ...base, probe: makeProbe({}, PROBE_NOT_FOUND), workers: 1, delayMs: 7, sleepImpl: second.sleepImpl });
  assert.deepEqual(second.sleeps, [7, 7]);
});

test("refreshChanges: the default probe is the raw probe over the run's fetch and sleep (a rate limit storm stays unverified and backs off through sleepImpl)", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([String(url), init.redirect]);
    return new Response("slow down", { status: 429, headers: { "retry-after": "1" } });
  };
  const { sleeps, sleepImpl } = recorder();
  const logs = collectLogs();
  const result = await refreshChanges({ previous: emptyChanges(), candidates: [cand("/training/modules/a")], now: NOW, limits: LIMITS, fetchImpl, sleepImpl, delayMs: 0, log: logs.log, warn: logs.warn });
  assert.deepEqual(result.changes.removed.entries.map((e) => [e.path, e.outcome, e.lastVerified, e.status]), [["/training/modules/a", "unverified", null, null]]);
  assert.equal(seen.length, 5, "rawProbe retries before giving up");
  assert.ok(seen.every(([url, redirect]) => url === "https://learn.microsoft.com/en-us/training/modules/a/" && redirect === "manual"));
  assert.ok(sleeps.length >= 4 && sleeps.every((ms) => ms >= 3000), `backoff went through the injected sleep: ${sleeps}`);
  assert.equal(result.counters.unverified, 1);
});

test("refreshChanges: an unusually long candidate list is warned about, never refused, and the probe budget bounds the work", async () => {
  const candidates = Array.from({ length: CHANGES_CANDIDATE_WARN + 1 }, (_, i) => cand(`/training/modules/m${String(i).padStart(4, "0")}`));
  const logs = collectLogs();
  const probe = makeProbe({}, PROBE_NOT_FOUND);
  const result = await refreshChanges({ previous: emptyChanges(), candidates, now: NOW, limits: { maxProbes: 2, reverifyPerRun: 0 }, probe, sleepImpl: noSleep, delayMs: 0, log: logs.log, warn: logs.warn });
  assert.equal(probe.calls.length, 2);
  assert.equal(result.changes.removed.entries.length, CHANGES_CANDIDATE_WARN + 1);
  assert.equal(result.counters.unverified, CHANGES_CANDIDATE_WARN - 1);
  assert.ok(logs.lines.some((l) => /WARNING: 501 new changes candidates in one run/.test(l)));
  assert.ok(logs.lines.some((l) => /longer than the probe budget \(2\)/.test(l)));
});

test("refreshChanges: a long run of transient answers stops the probing and says so", async () => {
  const candidates = Array.from({ length: 60 }, (_, i) => cand(`/training/modules/m${String(i).padStart(3, "0")}`));
  const logs = collectLogs();
  const probe = makeProbe({}, PROBE_BLOCKED);
  const result = await refreshChanges({ previous: emptyChanges(), candidates, now: NOW, limits: LIMITS, probe, workers: 1, sleepImpl: noSleep, delayMs: 0, log: logs.log, warn: logs.warn });
  assert.equal(result.stats.stoppedEarly, true);
  assert.equal(probe.calls.length, 40, "the breaker opens after 40 transient answers in a row");
  assert.equal(result.counters.unverified, 60);
  assert.ok(logs.lines.some((l) => /probes stopped early/.test(l)));
});

test("changesCounters counts Learn-family entries only and takes the per-run numbers from the stats", () => {
  const entry = (path, family, outcome, kind = family === "docs" ? "docs" : "module") => ({ path, kind, family, outcome, to: outcome === "moved" ? "/x/y" : null, title: null, parent: null, firstSeen: "2026-10-01", lastVerified: null, evidence: family === "docs" ? "quarantine" : "tombstone", status: null });
  const changes = {
    removed: normalizeChangeFile({ entries: [entry("/training/modules/a", "learn", "gone"), entry("/training/modules/b", "learn", "unverified"), entry("/azure/gone", "docs", "gone")] }, "removed"),
    moved: normalizeChangeFile({ entries: [entry("/training/modules/c", "learn", "moved"), entry("/azure/old", "docs", "moved")] }, "moved"),
  };
  const stats = { newRemoved: 5, newMoved: 4, resurrected: 3, unverified: 1, probed: 9, transient: 2, stoppedEarly: false, probeBudgetExhausted: false, covered: 0 };
  assert.deepEqual(changesCounters(changes, stats), { removed: 2, moved: 1, unverified: 1, newRemoved: 5, newMoved: 4, resurrected: 3, probed: 9 });
});
