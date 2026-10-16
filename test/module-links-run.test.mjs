import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FailsafeAbort } from "../scripts/lib/learn-io.mjs";
import { runModuleLinksSync } from "../scripts/lib/module-links-run.mjs";
import { collectLogs, makeTempDir, removeDir, silent } from "./learn-fixtures.mjs";

const noSleep = async () => {};
const D1 = new Date("2026-10-05T07:00:00.000Z");
const D2 = new Date("2026-10-12T07:00:00.000Z");
const COURSES_URL = "https://learn.microsoft.com/api/catalog/?type=courses&locale=en-us";

const slugPath = (slug) => `/training/modules/${slug}`;
const lastUnit = (slug) => `${slugPath(slug)}/2-summary`;

function catalogModule(slug, sig) {
  return { uid: `learn.${slug}`, path: slugPath(slug), unitSig: sig, unitUrls: [`${slugPath(slug)}/1-introduction`, lastUnit(slug)] };
}

/** A last-unit page with a "Learn more" list of the given docs paths. */
function unitPage(title, docs) {
  const items = docs.map((d) => `<li><a href="/en-us${d}?azure-portal=true">${d.split("/").pop()}</a></li>`).join("");
  return `<div id="unit-inner-section"><h1 id="module-unit-title">${title}</h1><p>You learned.</p>${docs.length ? `<h2>Learn more</h2><ul>${items}</ul>` : ""}</div><div id="next-section" hidden></div><a href="https://github.com/x">feedback</a>`;
}

/** Fake Learn: the course list plus the unit pages in `units` (path -> html | http status | Error). */
function fakeSite({ units, courses }) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url === COURSES_URL) return new Response(JSON.stringify({ courses: courses() }), { status: 200 });
    const page = units.get(url.replace("https://learn.microsoft.com/en-us", ""));
    if (page instanceof Error) throw page;
    if (page === undefined) return new Response("", { status: 404 });
    if (typeof page === "number") return new Response("", { status: page });
    return new Response(page, { status: 200 });
  };
  return { fetchImpl, calls, pageCalls: () => calls.filter((c) => c !== COURSES_URL) };
}

/** modules A and B belong to a course (path-1); C is in no course. */
function setup({ extraModules = [], sigs = {} } = {}) {
  const dir = makeTempDir();
  const modules = [catalogModule("a", sigs.a ?? "sig-a1"), catalogModule("b", sigs.b ?? "sig-b1"), catalogModule("c", sigs.c ?? "sig-c1"), ...extraModules];
  const writeCatalog = (list = modules) => writeFileSync(join(dir, "learn-catalog.json"), JSON.stringify({ modules: list }));
  writeCatalog();
  writeFileSync(
    join(dir, "learn-content.json"),
    JSON.stringify({ learningPaths: [{ uid: "learn.path-1", modules: [slugPath("a"), slugPath("b")] }, { uid: "learn.path-2", modules: [slugPath("c")] }] }),
  );
  const units = new Map([
    [lastUnit("a"), unitPage("Summary", ["/azure/a/one", "/azure/a/two"])],
    [lastUnit("b"), unitPage("Summary and resources", ["/azure/b/one"])],
    [lastUnit("c"), unitPage("Summary", ["/azure/c/one"])],
  ]);
  const site = fakeSite({ units, courses: () => [{ course_number: "AZ-1T00", study_guide: [{ uid: "learn.path-1", type: "learningPath" }] }] });
  const out = collectLogs();
  // link cleaning: the validator says "valid" for everything unless a test overrides a path, and a live
  // probe that nobody planned fails the test
  const verdictOf = new Map();
  const probeOutcome = new Map();
  const probeCalls = [];
  const validateImpl = (paths) => new Map(paths.map((p) => [p, verdictOf.get(p) ?? { path: p, verdict: "valid", confidence: "high" }]));
  const probeImpl = async (p) => {
    probeCalls.push(p);
    const outcome = probeOutcome.get(p);
    if (!outcome) throw new Error(`unexpected live probe of ${p}`);
    return outcome;
  };
  const run = (over = {}) =>
    runModuleLinksSync({
      dataDir: dir,
      env: {},
      now: D1,
      fetchImpl: site.fetchImpl,
      sleepImpl: noSleep,
      delayMs: 0,
      log: out.log,
      warn: out.warn,
      validateImpl,
      probeImpl,
      limits: { MIN_SCOPE_MODULES: { courses: 1, all: 1 }, FAIL_MIN_SAMPLE: 2, WITH_LINKS_MIN_PREVIOUS: 1 },
      httpOptions: { attempts: 1, baseBackoffMs: 1 },
      ...over,
    });
  const file = () => JSON.parse(readFileSync(join(dir, "module-links.json"), "utf8"));
  const status = () => JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  return { dir, units, site, out, run, file, status, writeCatalog, modules, verdictOf, probeOutcome, probeCalls, cleanup: () => removeDir(dir) };
}

const paths = (file) => file.modules.map((m) => m.path.split("/").pop());

test("first run: harvests the last unit of every course module, leaves other modules out and writes the heartbeat", async () => {
  const t = setup();
  try {
    const summary = await t.run();
    assert.deepEqual(t.site.pageCalls(), [`https://learn.microsoft.com/en-us${lastUnit("a")}`, `https://learn.microsoft.com/en-us${lastUnit("b")}`].sort());
    const file = t.file();
    assert.equal(file.schemaVersion, 1);
    assert.equal(file.scope, "courses");
    assert.deepEqual(paths(file), ["a", "b"]);
    const a = file.modules[0];
    assert.equal(a.unitSig, "sig-a1");
    assert.equal(a.unit, lastUnit("a"));
    assert.equal(a.unitTitle, "Summary");
    assert.equal(a.harvestedAt, "2026-10-05");
    assert.deepEqual(a.links.map((l) => l.path), ["/azure/a/one", "/azure/a/two"], "canonical paths, the azure-portal query is gone");
    assert.equal(file.fullRefreshAt, "2026-10-05", "a first run is a full pass");
    assert.equal(summary.written, true);
    assert.equal(summary.withLinks, 2);
    const moduleLinks = t.status().moduleLinks;
    assert.equal(moduleLinks.scope, "courses");
    assert.equal(moduleLinks.modules, 2);
    assert.equal(moduleLinks.links, 3);
    assert.equal(moduleLinks.failed, 0);
    assert.equal(moduleLinks.generatedAt, D1.toISOString());
  } finally {
    t.cleanup();
  }
});

test("second run with unchanged signatures fetches no unit page, keeps the file byte for byte and still writes the heartbeat", async () => {
  const t = setup();
  try {
    await t.run();
    const before = readFileSync(join(t.dir, "module-links.json"), "utf8");
    t.site.calls.length = 0;
    const summary = await t.run({ now: D2 });
    assert.deepEqual(t.site.pageCalls(), []);
    assert.equal(readFileSync(join(t.dir, "module-links.json"), "utf8"), before);
    assert.equal(summary.written, false);
    assert.equal(t.status().moduleLinks.generatedAt, D2.toISOString());
  } finally {
    t.cleanup();
  }
});

test("a changed unitSig refetches only that module and replaces its record", async () => {
  const t = setup();
  try {
    await t.run();
    t.writeCatalog([catalogModule("a", "sig-a2"), catalogModule("b", "sig-b1"), catalogModule("c", "sig-c1")]);
    t.units.set(lastUnit("a"), unitPage("Summary", ["/azure/a/new"]));
    t.site.calls.length = 0;
    await t.run({ now: D2 });
    assert.deepEqual(t.site.pageCalls(), [`https://learn.microsoft.com/en-us${lastUnit("a")}`]);
    const a = t.file().modules.find((m) => m.path === slugPath("a"));
    assert.equal(a.unitSig, "sig-a2");
    assert.deepEqual(a.links.map((l) => l.path), ["/azure/a/new"]);
    assert.equal(a.harvestedAt, "2026-10-12");
    assert.equal(t.file().modules.find((m) => m.path === slugPath("b")).harvestedAt, "2026-10-05");
  } finally {
    t.cleanup();
  }
});

test("a module whose page cannot be read keeps its old record only while its signature is unchanged", async () => {
  const t = setup();
  try {
    await t.run();
    // unchanged signature + full refresh + page down: the old record stays
    t.units.set(lastUnit("a"), 500);
    const kept = await t.run({ now: D2, env: { FULL_REFRESH: "1" }, limits: { MIN_SCOPE_MODULES: { courses: 1 }, FAIL_MIN_SAMPLE: 10, WITH_LINKS_MIN_PREVIOUS: 1 } });
    assert.equal(kept.failed, 1);
    assert.deepEqual(paths(t.file()), ["a", "b"]);
    assert.equal(t.file().fullRefreshAt, "2026-10-05", "an incomplete pass does not move fullRefreshAt");
    // changed signature + page down: no stale record, never an empty guess
    t.writeCatalog([catalogModule("a", "sig-a2"), catalogModule("b", "sig-b1"), catalogModule("c", "sig-c1")]);
    // (the "links vanished" failsafe keeps its production minimum of 50 modules here: one module of two is not a trend)
    await t.run({ now: D2, limits: { MIN_SCOPE_MODULES: { courses: 1 }, FAIL_MIN_SAMPLE: 10 } });
    assert.deepEqual(paths(t.file()), ["b"]);
  } finally {
    t.cleanup();
  }
});

test("pages without unit content abort the run and write nothing", async () => {
  const t = setup();
  try {
    t.units.set(lastUnit("a"), "<html>Learn redesigned its pages</html>");
    t.units.set(lastUnit("b"), "<html>Learn redesigned its pages</html>");
    await assert.rejects(t.run(), (err) => err instanceof FailsafeAbort && /no unit content/.test(err.message));
    assert.equal(existsSync(join(t.dir, "module-links.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
  } finally {
    t.cleanup();
  }
});

test("too many unreadable pages abort the run and leave an existing file alone", async () => {
  const t = setup();
  try {
    await t.run();
    const before = readFileSync(join(t.dir, "module-links.json"), "utf8");
    t.units.set(lastUnit("a"), 503);
    t.units.set(lastUnit("b"), new Error("network down"));
    await assert.rejects(t.run({ now: D2, env: { FULL_REFRESH: "1" } }), (err) => err instanceof FailsafeAbort && /could not be read/.test(err.message));
    assert.equal(readFileSync(join(t.dir, "module-links.json"), "utf8"), before);
    assert.equal(t.status().moduleLinks.generatedAt, D1.toISOString(), "status.json is not touched either");
  } finally {
    t.cleanup();
  }
});

test("links that vanish from most modules abort the run", async () => {
  const t = setup();
  try {
    await t.run();
    t.units.set(lastUnit("a"), unitPage("Summary", []));
    t.units.set(lastUnit("b"), unitPage("Summary", []));
    await assert.rejects(t.run({ now: D2, env: { FULL_REFRESH: "1" } }), (err) => err instanceof FailsafeAbort && /the link extraction probably stopped working/.test(err.message));
    assert.deepEqual(t.file().modules.map((m) => m.links.length > 0), [true, true]);
  } finally {
    t.cleanup();
  }
});

test("the circuit breaker stops a dead site after the first chunk", async () => {
  const many = Array.from({ length: 120 }, (_, i) => catalogModule(`m${i}`, "s"));
  const t = setup({ extraModules: many });
  try {
    writeFileSync(
      join(t.dir, "learn-content.json"),
      JSON.stringify({ learningPaths: [{ uid: "learn.path-1", modules: many.map((m) => m.path) }] }),
    );
    for (const m of many) t.units.set(`${m.path}/2-summary`, 500);
    await assert.rejects(t.run(), (err) => err instanceof FailsafeAbort && /circuit breaker stopped the run after 50 pages/.test(err.message));
    assert.equal(t.site.pageCalls().length, 50);
    assert.equal(existsSync(join(t.dir, "module-links.json")), false);
  } finally {
    t.cleanup();
  }
});

test("DRY_RUN fetches and computes but writes neither file", async () => {
  const t = setup();
  try {
    const summary = await t.run({ env: { DRY_RUN: "1" } });
    assert.equal(summary.fetched, 2);
    assert.equal(summary.written, false);
    assert.equal(existsSync(join(t.dir, "module-links.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
  } finally {
    t.cleanup();
  }
});

test("scope all covers every catalog module and never asks for the course list", async () => {
  const t = setup();
  try {
    await t.run({ env: { MODULE_LINKS_SCOPE: "all" } });
    assert.deepEqual(paths(t.file()), ["a", "b", "c"]);
    assert.equal(t.file().scope, "all");
    assert.ok(!t.site.calls.includes(COURSES_URL));
  } finally {
    t.cleanup();
  }
});

test("a smaller scope drops the records that fell out of it, and a module that left the catalog disappears", async () => {
  const t = setup();
  try {
    await t.run({ env: { MODULE_LINKS_SCOPE: "all" } });
    await t.run({ now: D2 }); // back to the course scope
    assert.deepEqual(paths(t.file()), ["a", "b"]);
    t.writeCatalog([catalogModule("a", "sig-a1"), catalogModule("c", "sig-c1")]);
    await t.run({ now: D2 });
    assert.deepEqual(paths(t.file()), ["a"]);
  } finally {
    t.cleanup();
  }
});

test("the fetch cap leaves modules waiting and does not claim a full pass", async () => {
  const t = setup();
  try {
    const first = await t.run({ env: { MODULE_LINKS_MAX_FETCHES: "1" } });
    assert.equal(first.fetched, 1);
    assert.equal(first.waiting, 1);
    assert.equal(t.file().fullRefreshAt, null);
    const second = await t.run({ now: D2, env: { MODULE_LINKS_MAX_FETCHES: "1" } });
    assert.equal(second.fetched, 1);
    assert.deepEqual(paths(t.file()), ["a", "b"]);
    assert.equal(t.file().fullRefreshAt, null, "the second run was not a full-refresh run");
  } finally {
    t.cleanup();
  }
});

test("a full refresh is due after the configured number of days", async () => {
  const t = setup();
  try {
    await t.run();
    t.site.calls.length = 0;
    await t.run({ now: new Date("2026-11-20T07:00:00.000Z") }); // 46 days later, default 30
    assert.equal(t.site.pageCalls().length, 2);
    assert.equal(t.file().fullRefreshAt, "2026-11-20");
  } finally {
    t.cleanup();
  }
});

test("unusable inputs fail before any page is requested", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.dir, "module-links.json"), JSON.stringify({ schemaVersion: 9, modules: [] }));
    await assert.rejects(t.run(), /schemaVersion 9, expected 1/);
    writeFileSync(join(t.dir, "module-links.json"), "{ not json");
    // an unreadable file is warned about and treated as absent, like the other data files
    await t.run({ warn: silent.warn });
    assert.ok(t.file().modules.length > 0);
    await assert.rejects(t.run({ env: { MODULE_LINKS_SCOPE: "everything" } }), /Invalid MODULE_LINKS_SCOPE/);
    await assert.rejects(t.run({ env: { MODULE_LINKS_MAX_FETCHES: "0" } }), /Invalid MODULE_LINKS_MAX_FETCHES/);
    writeFileSync(join(t.dir, "learn-catalog.json"), JSON.stringify({ nope: true }));
    await assert.rejects(t.run(), /learn-catalog\.json is missing or has no modules/);
  } finally {
    t.cleanup();
  }
});

test("a scope that is too small aborts", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ limits: { MIN_SCOPE_MODULES: { courses: 5 } } }), (err) => err instanceof FailsafeAbort && /only 2 modules are in scope "courses" \(floor 5\)/.test(err.message));
    assert.equal(existsSync(join(t.dir, "module-links.json")), false);
  } finally {
    t.cleanup();
  }
});

// ------------------------------------------------------------------------------------------------
// link cleaning
// ------------------------------------------------------------------------------------------------

const A_ONE = "/azure/a/one";
const A_TWO = "/azure/a/two";
const linksOf = (file, slug) => file.modules.find((m) => m.path === slugPath(slug)).links;
const unverifiable = (path) => ({ path, verdict: "unverifiable", confidence: "high" });

test("cleaning: a moved page is rewritten to its current path, the old path is kept as `was`, and the next run needs no probe", async () => {
  const t = setup();
  try {
    t.verdictOf.set(A_ONE, unverifiable(A_ONE));
    t.probeOutcome.set(A_ONE, { verdict: "moved", redirectsTo: "/azure/new-home/one" });
    const first = await t.run();
    assert.deepEqual(t.probeCalls, [A_ONE]);
    assert.equal(first.probed, 1);
    assert.equal(first.rewritten, 1);
    const moved = linksOf(t.file(), "a")[0];
    assert.deepEqual(moved, { kind: "docs", path: "/azure/new-home/one", text: "one", section: "Learn more", was: A_ONE, checked: "2026-10-05" });
    // the destination is in the index now (the validator calls it valid): `checked` goes, `was` stays
    t.probeCalls.length = 0;
    await t.run({ now: D2 });
    assert.deepEqual(t.probeCalls, []);
    assert.deepEqual(linksOf(t.file(), "a")[0], { kind: "docs", path: "/azure/new-home/one", text: "one", section: "Learn more", was: A_ONE });
  } finally {
    t.cleanup();
  }
});

test("cleaning: pages that are gone, or that redirect to a landing page or an archive, are dropped", async () => {
  const t = setup();
  try {
    t.verdictOf.set(A_ONE, unverifiable(A_ONE));
    t.verdictOf.set(A_TWO, unverifiable(A_TWO));
    t.verdictOf.set("/azure/b/one", unverifiable("/azure/b/one"));
    t.probeOutcome.set(A_ONE, { verdict: "broken", redirectsTo: null });
    t.probeOutcome.set(A_TWO, { verdict: "moved", redirectsTo: "/azure" }); // a product root = landing page
    t.probeOutcome.set("/azure/b/one", { verdict: "moved", redirectsTo: "/previous-versions/azure/b" });
    const summary = await t.run({ limits: { MIN_SCOPE_MODULES: { courses: 1 }, FAIL_MIN_SAMPLE: 10, WITH_LINKS_MIN_PREVIOUS: 50 } });
    assert.equal(summary.dropped, 3);
    assert.deepEqual(t.file().modules.map((m) => [m.path.split("/").pop(), m.links.length]), [["a", 0], ["b", 0]]);
  } finally {
    t.cleanup();
  }
});

test("cleaning: an inconclusive check keeps the link as `unverified` and the next run tries again", async () => {
  const t = setup();
  try {
    t.verdictOf.set(A_ONE, unverifiable(A_ONE));
    t.probeOutcome.set(A_ONE, { verdict: "unknown", detail: "HTTP 429" });
    const first = await t.run({ limits: { MIN_SCOPE_MODULES: { courses: 1 }, FAIL_MIN_SAMPLE: 10, WITH_LINKS_MIN_PREVIOUS: 50 } });
    assert.equal(first.unverified, 1);
    assert.equal(linksOf(t.file(), "a")[0].unverified, true);
    assert.equal(linksOf(t.file(), "a")[0].checked, undefined);
    t.probeOutcome.set(A_ONE, { verdict: "ok" });
    t.probeCalls.length = 0;
    await t.run({ now: D2 });
    assert.deepEqual(t.probeCalls, [A_ONE]);
    assert.deepEqual(linksOf(t.file(), "a")[0], { kind: "docs", path: A_ONE, text: "one", section: "Learn more", checked: "2026-10-12" });
  } finally {
    t.cleanup();
  }
});

test("cleaning: a link a live check confirmed is not checked again within the recheck window, but is after it", async () => {
  const t = setup();
  try {
    t.verdictOf.set(A_ONE, unverifiable(A_ONE));
    t.probeOutcome.set(A_ONE, { verdict: "ok" });
    await t.run();
    assert.equal(linksOf(t.file(), "a")[0].checked, "2026-10-05");
    t.probeCalls.length = 0;
    await t.run({ now: D2 }); // a week later
    assert.deepEqual(t.probeCalls, []);
    assert.equal(linksOf(t.file(), "a")[0].checked, "2026-10-05", "the date of the last live check stays");
    await t.run({ now: new Date("2026-11-20T07:00:00.000Z") }); // 46 days later
    assert.deepEqual(t.probeCalls, [A_ONE]);
    assert.equal(linksOf(t.file(), "a")[0].checked, "2026-11-20");
  } finally {
    t.cleanup();
  }
});

test("cleaning: a move the caches know with high confidence is applied without a live probe", async () => {
  const t = setup();
  try {
    t.verdictOf.set(A_ONE, { path: A_ONE, verdict: "moved", confidence: "high", redirectsTo: "/azure/ledger/one" });
    t.verdictOf.set(A_TWO, { path: A_TWO, verdict: "moved", confidence: "high", redirectsTo: "/azure" }); // the ledger says landing page
    await t.run({ limits: { MIN_SCOPE_MODULES: { courses: 1 }, FAIL_MIN_SAMPLE: 10, WITH_LINKS_MIN_PREVIOUS: 50 } });
    assert.deepEqual(t.probeCalls, []);
    assert.deepEqual(linksOf(t.file(), "a").map((l) => [l.path, l.was, l.checked]), [["/azure/ledger/one", A_ONE, undefined]]);
  } finally {
    t.cleanup();
  }
});

test("cleaning: external links are never checked and links that end up on the same target are merged", async () => {
  const t = setup();
  try {
    t.units.set(
      lastUnit("a"),
      `<div id="unit-inner-section"><h1 id="module-unit-title">Summary</h1><h2>Learn more</h2><ul><li><a href="/en-us${A_ONE}">one</a></li><li><a href="/en-us${A_TWO}">two</a></li><li><a href="https://github.com/x/y">repo</a></li></ul></div><div id="next-section"></div>`,
    );
    t.verdictOf.set(A_ONE, unverifiable(A_ONE));
    t.verdictOf.set(A_TWO, unverifiable(A_TWO));
    t.probeOutcome.set(A_ONE, { verdict: "moved", redirectsTo: "/azure/same" });
    t.probeOutcome.set(A_TWO, { verdict: "moved", redirectsTo: "/azure/same" });
    await t.run();
    assert.deepEqual(t.probeCalls.sort(), [A_ONE, A_TWO]);
    assert.deepEqual(linksOf(t.file(), "a").map((l) => l.path ?? l.url), ["/azure/same", "https://github.com/x/y"]);
  } finally {
    t.cleanup();
  }
});

test("cleaning: the probe budget leaves the rest unverified and the failsafes judge the live checks", async () => {
  const t = setup();
  try {
    for (const p of [A_ONE, A_TWO]) t.verdictOf.set(p, unverifiable(p));
    t.probeOutcome.set(A_ONE, { verdict: "ok" });
    t.probeOutcome.set(A_TWO, { verdict: "ok" });
    const capped = await t.run({ env: { MODULE_LINKS_MAX_PROBES: "1" } });
    assert.equal(capped.probed, 1);
    assert.equal(capped.unverified, 1);
    // everything found gone: an outage or a bad probe looks like that, and nothing is written
    const t2 = setup();
    try {
      for (const p of [A_ONE, A_TWO]) {
        t2.verdictOf.set(p, unverifiable(p));
        t2.probeOutcome.set(p, { verdict: "broken", redirectsTo: null });
      }
      await assert.rejects(t2.run(), (err) => err instanceof FailsafeAbort && /found the page gone or sent to a landing page/.test(err.message));
      assert.equal(existsSync(join(t2.dir, "module-links.json")), false);
    } finally {
      t2.cleanup();
    }
    // everything inconclusive
    const t3 = setup();
    try {
      for (const p of [A_ONE, A_TWO]) {
        t3.verdictOf.set(p, unverifiable(p));
        t3.probeOutcome.set(p, { verdict: "unknown" });
      }
      await assert.rejects(t3.run(), (err) => err instanceof FailsafeAbort && /live link checks were inconclusive/.test(err.message));
    } finally {
      t3.cleanup();
    }
  } finally {
    t.cleanup();
  }
});
