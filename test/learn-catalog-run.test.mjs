import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChangesFileError, indexChanges, loadChanges, lookupChange } from "../scripts/lib/changes.mjs";
import { FailsafeAbort } from "../scripts/lib/learn-io.mjs";
import { runCatalogSync } from "../scripts/lib/learn-catalog-run.mjs";
import { contributeLearnStatus } from "../scripts/lib/learn-status.mjs";
import {
  PROBE_BLOCKED,
  PROBE_NOT_FOUND,
  TEST_CONFIG,
  TEST_LIMITS,
  collectLogs,
  hierarchyOf,
  makeFakeLearn,
  makeProbe,
  makeTempDir,
  mod,
  probeServed,
  removeDir,
  standardWorld,
  unitsOf,
} from "./learn-fixtures.mjs";

const noSleep = async () => {};
const D1 = new Date("2026-10-05T07:00:00.000Z");
const D1_LATER = new Date("2026-10-05T19:00:00.000Z");

function setup(initial = {}) {
  const dir = makeTempDir();
  const world = standardWorld();
  const fake = makeFakeLearn({ ...world, ...initial });
  const run = (over = {}) =>
    runCatalogSync({
      dataDir: dir,
      env: {},
      now: D1,
      fetchImpl: fake.fetchImpl,
      sleepImpl: noSleep,
      delayMs: 0,
      config: TEST_CONFIG,
      limits: TEST_LIMITS,
      httpOptions: { attempts: 2, baseBackoffMs: 1 },
      changes: { delayMs: 0 },
      ...collectLogs(),
      ...over,
    });
  const read = (name) => JSON.parse(readFileSync(join(dir, name), "utf-8"));
  const text = (name) => readFileSync(join(dir, name), "utf-8");
  return { dir, fake, run, read, text, cleanup: () => removeDir(dir) };
}

/** A world of n azure modules (uids sorted), for the relative failsafes. */
function bigWorld(n) {
  const modules = Array.from({ length: n }, (_, i) => mod({ uid: `learn.azure.m${String(i).padStart(4, "0")}`, slug: `m${i}`, products: ["azure-vm"] }));
  modules.push(mod({ uid: "learn.gh.one", slug: "gh-one", products: ["github-actions"] }), mod({ uid: "learn.m365.one", slug: "m365-one", products: ["m365"] }));
  return { modules, units: unitsOf(modules) };
}

test("first run writes schema v2: sorted modules, real unit urls, outOfScope, status heartbeat", async () => {
  const t = setup();
  try {
    const r = await t.run();
    assert.equal(r.wrote, true);
    const cat = t.read("learn-catalog.json");
    assert.equal(cat.schemaVersion, 2);
    assert.equal(cat.totalModules, 4);
    assert.equal(cat.totalApiModules, 5);
    assert.equal(cat.unitUrlsRefreshedAt, "2026-10-05");
    assert.deepEqual(cat.modules.map((m) => m.uid), ["$learn.become-contributor", "learn.azure.firewall-intro", "learn.azure.vm-basics", "learn.saas-foundations"]);
    assert.deepEqual(cat.outOfScope, ["/training/modules/games"]);
    assert.deepEqual(cat.removed, []);
    const fw = cat.modules.find((m) => m.uid === "learn.azure.firewall-intro");
    assert.deepEqual(fw.unitUrls, ["/training/modules/firewall-intro/1-introduction", "/training/modules/firewall-intro/2-rules", "/training/modules/firewall-intro/3-summary"]);
    assert.equal(fw.units.length, fw.unitUrls.length);
    const saas = cat.modules.find((m) => m.uid === "learn.saas-foundations");
    assert.equal(saas.path, "/training/saas/saas-foundations");
    assert.ok(saas.unitUrls[0].startsWith("/training/saas/saas-foundations/"));
    const status = t.read("status.json");
    assert.equal(status.learn.modules, 4);
    assert.equal(status.learn.outOfScope, 1);
    assert.equal(status.learn.removed, 0);
    assert.equal(status.learn.unitUrlsRefreshedAt, "2026-10-05");
    assert.equal(status.learn.unitHierarchyRequests, 4);
    assert.equal(status.learn.unitHierarchyFailures, 0);
    assert.equal(status.learn.unitUrlsNull, 0);
    assert.equal(status.learn.generatedAt, D1.toISOString());
  } finally {
    t.cleanup();
  }
});

test("a uid that starts with $ is requested percent-encoded and its units are recorded", async () => {
  const t = setup();
  try {
    await t.run();
    assert.ok(t.fake.hierarchyRequests().some((u) => u.includes("/modules/%24learn.become-contributor?")), t.fake.hierarchyRequests().join("\n"));
    const m = t.read("learn-catalog.json").modules.find((x) => x.uid === "$learn.become-contributor");
    assert.equal(m.unitUrls.length, 2);
  } finally {
    t.cleanup();
  }
});

test("skipped unit numbers in the live hierarchy are preserved (urls are never derived from positions)", async () => {
  const t = setup();
  t.fake.state.hierarchyFor = (m) => hierarchyOf(m, { skip: [2] });
  try {
    await t.run();
    const fw = t.read("learn-catalog.json").modules.find((m) => m.uid === "learn.azure.firewall-intro");
    assert.deepEqual(fw.unitUrls.map((u) => u.split("/").pop().split("-")[0]), ["1", "3", "4"]);
  } finally {
    t.cleanup();
  }
});

test("second run: no hierarchy requests, the write is skipped, but the heartbeat still advances", async () => {
  const t = setup();
  try {
    await t.run();
    const before = t.text("learn-catalog.json");
    t.fake.clearRequests();
    const r = await t.run({ now: D1_LATER });
    assert.equal(r.unchanged, true);
    assert.equal(r.wrote, false);
    assert.equal(t.fake.hierarchyRequests().length, 0, "everything was reused");
    assert.equal(t.text("learn-catalog.json"), before, "file untouched, lastChecked included");
    const status = t.read("status.json");
    assert.equal(status.learn.catalogGeneratedAt, D1_LATER.toISOString());
    assert.equal(status.learn.unitHierarchyRequests, 0);
    assert.equal(status.learn.unitUrlsRefreshedAt, "2026-10-05", "no full refresh happened, so the date did not move");
  } finally {
    t.cleanup();
  }
});

test("a changed unit refetches only that module; a new module is fetched; unchanged ones are reused", async () => {
  const t = setup();
  try {
    await t.run();
    t.fake.clearRequests();
    const { modules, units } = t.fake.state;
    t.fake.state.units = units.map((u) => (u.uid === "learn.azure.vm-basics.summary" ? { ...u, last_modified: "2027-01-01T00:00:00+00:00" } : u));
    const added = mod({ uid: "learn.azure.added", slug: "added", products: ["azure-vm"] });
    t.fake.state.modules = [...modules, added];
    t.fake.state.units = [...t.fake.state.units, ...unitsOf([added])];
    const r = await t.run({ now: D1_LATER });
    const fetched = t.fake.hierarchyRequests().map((u) => decodeURIComponent(u.split("/modules/")[1].split("?")[0])).sort();
    assert.deepEqual(fetched, ["learn.azure.added", "learn.azure.vm-basics"]);
    assert.equal(r.wrote, true);
    assert.equal(r.plan.reasons["sig-changed"], 1);
    assert.equal(r.plan.reasons.new, 1);
    assert.equal(t.read("learn-catalog.json").unitUrlsRefreshedAt, "2026-10-05", "an incremental run does not claim a full refresh");
  } finally {
    t.cleanup();
  }
});

test("FULL_UNIT_REFRESH=1 refetches everything; the automatic refresh kicks in after 30 days and moves the date", async () => {
  const t = setup();
  try {
    await t.run();
    t.fake.clearRequests();
    await t.run({ env: { FULL_UNIT_REFRESH: "1" } });
    assert.equal(t.fake.hierarchyRequests().length, 4);
    t.fake.clearRequests();
    const early = await t.run({ now: new Date("2026-11-04T07:00:00Z") });
    assert.equal(t.fake.hierarchyRequests().length, 0, "30 days later is not yet due");
    assert.equal(early.fullRefresh, false);
    const late = await t.run({ now: new Date("2026-11-05T07:00:00Z") });
    assert.equal(late.fullRefresh, true);
    assert.equal(t.fake.hierarchyRequests().length, 4);
    assert.equal(t.read("learn-catalog.json").unitUrlsRefreshedAt, "2026-11-05");
  } finally {
    t.cleanup();
  }
});

test("a hierarchy failure keeps the previous urls when the signature is unchanged, and is null otherwise (never an empty guess)", async () => {
  const t = setup();
  try {
    await t.run();
    const prev = t.read("learn-catalog.json");
    t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", 503);
    const r = await t.run({ env: { FULL_UNIT_REFRESH: "1" }, now: D1_LATER });
    const after = t.read("learn-catalog.json");
    const vm = (c) => c.modules.find((m) => m.uid === "learn.azure.vm-basics");
    assert.deepEqual(vm(after).unitUrls, vm(prev).unitUrls, "carried forward");
    assert.equal(r.unitStats.failures, 1);
    assert.equal(r.unitStats.carriedForward, 1);
    assert.equal(t.read("status.json").learn.unitHierarchyFailures, 1);

    // now the module changes upstream AND its hierarchy is still failing: the old urls cannot be trusted
    t.fake.state.units = t.fake.state.units.map((u) => (u.uid === "learn.azure.vm-basics.summary" ? { ...u, last_modified: "2028-01-01T00:00:00+00:00" } : u));
    const r2 = await t.run({ now: D1_LATER });
    assert.equal(vm(t.read("learn-catalog.json")).unitUrls, null);
    assert.equal(r2.unitStats.nulls, 1);
    assert.equal(t.read("status.json").learn.unitUrlsNull, 1);

    // next healthy run heals it
    t.fake.state.hierarchyFailures.clear();
    await t.run({ now: D1_LATER });
    assert.equal(vm(t.read("learn-catalog.json")).unitUrls.length, 2);
  } finally {
    t.cleanup();
  }
});

test("a module the hierarchy API does not know (404) or answers inconsistently gets null and is counted as a failure", async () => {
  const t = setup();
  const known = standardWorld().modules;
  t.fake.state.hierarchyFor = (m) => (m.uid === "learn.azure.firewall-intro" ? { units: [{ uid: "other", url: "/training/modules/firewall-intro/1-x/" }] } : hierarchyOf(m));
  t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", 404);
  try {
    const r = await t.run();
    const cat = t.read("learn-catalog.json");
    assert.equal(cat.modules.find((m) => m.uid === "learn.azure.vm-basics").unitUrls, null);
    assert.equal(cat.modules.find((m) => m.uid === "learn.azure.firewall-intro").unitUrls, null);
    assert.equal(r.unitStats.failures, 2);
    assert.deepEqual(r.unitStats.failureKinds, { "not-found": 1, misaligned: 1 });
    assert.equal(cat.modules.find((m) => m.uid === "learn.azure.vm-basics").hierarchyNotFound, true, "definitive module_id_not_found is recorded");
    assert.equal("hierarchyNotFound" in cat.modules.find((m) => m.uid === "learn.azure.firewall-intro"), false, "an inconsistent answer is not a not-found");
    assert.equal(t.read("status.json").learn.unitHierarchyNotFound, 1);
    assert.equal(cat.modules.filter((m) => m.unitUrls === null).length, 2);
    assert.ok(known.length > 0);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: more than 10% hierarchy failures aborts without writing the data file or the status", async () => {
  const t = setup(bigWorld(40));
  try {
    for (let i = 0; i < 8; i++) t.fake.state.hierarchyFailures.set(`learn.azure.m${String(i).padStart(4, "0")}`, 500);
    await assert.rejects(t.run(), (err) => err instanceof FailsafeAbort && /hierarchy requests failed/.test(err.message));
    assert.equal(existsSync(join(t.dir, "learn-catalog.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: up to 10% hierarchy failures is tolerated", async () => {
  const t = setup(bigWorld(40));
  try {
    for (let i = 0; i < 4; i++) t.fake.state.hierarchyFailures.set(`learn.azure.m${String(i).padStart(4, "0")}`, 500);
    const r = await t.run();
    assert.equal(r.unitStats.failures, 4);
    assert.equal(r.output.modules.filter((m) => m.unitUrls === null).length, 4);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE circuit breaker: a dead hierarchy API stops the run after the early sample instead of requesting everything", async () => {
  const t = setup(bigWorld(60));
  for (const m of t.fake.state.modules) t.fake.state.hierarchyFailures.set(m.uid, 500);
  try {
    await assert.rejects(t.run(), (err) => err instanceof FailsafeAbort && /run stopped early/.test(err.message));
    assert.ok(t.fake.hierarchyRequests().length < 40, `only ${t.fake.hierarchyRequests().length} (x attempts) requests before stopping`);
    assert.equal(existsSync(join(t.dir, "learn-catalog.json")), false);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: a truncated catalog response (first 90% of modules) aborts and the previous file is untouched", async () => {
  const t = setup(bigWorld(100));
  try {
    await t.run();
    const before = t.text("learn-catalog.json");
    const statusBefore = t.text("status.json");
    t.fake.state.truncateModulesTo = 92; // ~9% fewer: over both the 3% raw and the 5% in-scope limits
    await assert.rejects(t.run({ now: D1_LATER }), (err) => err instanceof FailsafeAbort && /API returned 92 modules vs 102/.test(err.message) && /in-scope modules fell/.test(err.message));
    assert.equal(t.text("learn-catalog.json"), before);
    assert.equal(t.text("status.json"), statusBefore, "a failed run must not look like a success");
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: a drop within the limits is accepted and produces tombstones", async () => {
  const t = setup(bigWorld(100));
  try {
    await t.run();
    t.fake.state.truncateModulesTo = 100; // the two non-azure modules disappear: -1.96%, but github and m365 lose their only modules
    await assert.rejects(t.run({ now: D1_LATER }), /allowlisted category "(github|m365)"/);
    t.fake.state.truncateModulesTo = null;
    t.fake.state.modules = t.fake.state.modules.filter((m) => m.uid !== "learn.azure.m0007");
    const r = await t.run({ now: D1_LATER });
    assert.equal(r.removals.removed.length, 1);
    assert.equal(r.removals.removed[0].uid, "learn.azure.m0007");
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: an allowlisted category with zero modules aborts", async () => {
  const world = standardWorld();
  const t = setup({ ...world, modules: world.modules.filter((m) => !m.products.includes("github-actions")) });
  try {
    await assert.rejects(t.run(), /allowlisted category "github" has zero modules/);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: the MIN_MODULES floor still applies on a first run", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ limits: { ...TEST_LIMITS, MIN_MODULES: 100 } }), /only 4 in-scope modules \(floor 100\)/);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: a truncated unit list (titles fall back to uids almost everywhere) aborts", async () => {
  const t = setup({ units: [] });
  try {
    await assert.rejects(t.run(), /fell back to a uid/);
  } finally {
    t.cleanup();
  }
});

test("a malformed catalog response aborts with a schema message", async () => {
  const t = setup();
  const original = t.fake.fetchImpl;
  try {
    await assert.rejects(
      t.run({
        fetchImpl: async (url) => {
          if (String(url).includes("type=products")) return new Response(JSON.stringify({ nope: [] }), { status: 200 });
          return original(url);
        },
      }),
      /no "products" array/
    );
  } finally {
    t.cleanup();
  }
});

test("tombstones: removed module -> tombstone dated today with lastSeen = last run; moved out of the allowlist -> outOfScope, not removed; return -> tombstone dropped", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    const original = t.fake.state.modules;
    // 1) m0001 vanishes entirely, m0002 merely changes product to an excluded one
    t.fake.state.modules = original
      .filter((m) => m.uid !== "learn.azure.m0001")
      .map((m) => (m.uid === "learn.azure.m0002" ? { ...m, products: ["consumer"] } : m));
    const day2 = new Date("2026-10-12T07:00:00Z");
    await t.run({ now: day2 });
    let cat = t.read("learn-catalog.json");
    assert.deepEqual(cat.removed, [{ uid: "learn.azure.m0001", path: "/training/modules/m1", title: "Module m1", lastSeen: "2026-10-05", removedOn: "2026-10-12" }]);
    assert.ok(cat.outOfScope.includes("/training/modules/m2"), "left the allowlist -> outOfScope");
    assert.equal(cat.modules.some((m) => m.uid === "learn.azure.m0002"), false);
    assert.equal(cat.removed.some((r) => r.uid === "learn.azure.m0002"), false);
    assert.equal(t.read("status.json").learn.removed, 1);
    assert.equal(t.read("status.json").learn.outOfScope, 1);

    // 2) a later run keeps the tombstone untouched
    await t.run({ now: new Date("2026-10-20T07:00:00Z") });
    cat = t.read("learn-catalog.json");
    assert.equal(cat.removed.length, 1);
    assert.equal(cat.removed[0].removedOn, "2026-10-12");
    assert.equal(cat.removed[0].lastSeen, "2026-10-05");

    // 3) it comes back -> tombstone dropped, outOfScope entry gone
    t.fake.state.modules = original;
    await t.run({ now: new Date("2026-10-27T07:00:00Z") });
    cat = t.read("learn-catalog.json");
    assert.deepEqual(cat.removed, []);
    assert.ok(cat.modules.some((m) => m.uid === "learn.azure.m0001"));
    assert.equal(cat.outOfScope.includes("/training/modules/m2"), false);
  } finally {
    t.cleanup();
  }
});

test("lastSeen uses the last RUN (status heartbeat) when later runs skipped the write", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    await t.run({ now: new Date("2026-10-08T07:00:00Z") }); // unchanged: file keeps lastChecked 2026-10-05, status advances
    t.fake.state.modules = t.fake.state.modules.filter((m) => m.uid !== "learn.azure.m0001");
    await t.run({ now: new Date("2026-10-12T07:00:00Z") });
    assert.equal(t.read("learn-catalog.json").removed[0].lastSeen, "2026-10-08");
  } finally {
    t.cleanup();
  }
});

test("upgrading from a schema v1 file: written as v2, no phantom tombstones, previous unit urls absent -> fetched", async () => {
  const t = setup();
  try {
    const world = standardWorld();
    writeFileSync(
      join(t.dir, "learn-catalog.json"),
      JSON.stringify({ lastChecked: "2026-09-28T00:00:00Z", sourceApi: "x", categoryFilter: ["azure"], totalModules: 2, modules: [{ uid: world.modules[0].uid, title: "t", url: "u", categories: ["Azure"], products: [], subjects: [], units: [] }] })
    );
    const r = await t.run();
    assert.equal(r.wrote, true);
    const cat = t.read("learn-catalog.json");
    assert.equal(cat.schemaVersion, 2);
    assert.deepEqual(cat.removed, []);
    assert.ok(cat.modules.every((m) => Array.isArray(m.unitUrls)));
    assert.equal(r.fullRefresh, true, "no unitUrlsRefreshedAt in a v1 file -> full refresh");
  } finally {
    t.cleanup();
  }
});

test("a corrupt previous data file is treated as absent (relative failsafes skipped, floors apply) with a warning", async () => {
  const t = setup();
  try {
    writeFileSync(join(t.dir, "learn-catalog.json"), "{broken");
    const logs = collectLogs();
    const r = await t.run({ log: logs.log, warn: logs.warn });
    assert.equal(r.wrote, true);
    assert.ok(logs.lines.some((l) => /could not read/.test(l)));
    assert.equal(t.read("learn-catalog.json").schemaVersion, 2);
  } finally {
    t.cleanup();
  }
});

test("taxonomy drift is warned about and listed in status.json", async () => {
  const world = standardWorld();
  const agent = mod({ uid: "learn.agents.x", slug: "agents-x", products: ["microsoft-agents"] });
  const t = setup({ modules: [...world.modules, agent], units: [...world.units, ...unitsOf([agent])] });
  try {
    const logs = collectLogs();
    await t.run({ log: logs.log, warn: logs.warn });
    assert.ok(logs.lines.some((l) => /taxonomy drift.*microsoft-agents \(1\)/.test(l)), logs.lines.join("\n"));
    assert.deepEqual(t.read("status.json").learn.unusedCategories, ["microsoft-agents"]);
  } finally {
    t.cleanup();
  }
});

test("modules whose unit titles fell back to uids are printed by name, not just counted", async () => {
  const world = bigWorld(40);
  const t = setup({ ...world, units: world.units.filter((u) => u.uid !== "learn.azure.m0003.summary") });
  try {
    const logs = collectLogs();
    await t.run({ log: logs.log, warn: logs.warn });
    assert.ok(logs.lines.some((l) => /learn\.azure\.m0003 \(1\/2 units\)/.test(l)), logs.lines.join("\n"));
  } finally {
    t.cleanup();
  }
});

test("the catalog run does not clobber the content part of the learn status", async () => {
  const t = setup();
  try {
    contributeLearnStatus(join(t.dir, "status.json"), "content", { content: { exams: 145 } }, { now: new Date("2026-10-04T07:00:00Z"), env: {} });
    await t.run();
    const status = t.read("status.json");
    assert.deepEqual(status.learn.content, { exams: 145 });
    assert.equal(status.learn.modules, 4);
    assert.equal(status.learn.generatedAt, "2026-10-04T07:00:00.000Z", "the section is only as fresh as its stalest part");
  } finally {
    t.cleanup();
  }
});

test("DRY_RUN=1 computes everything and writes nothing", async () => {
  const t = setup();
  try {
    const r = await t.run({ env: { DRY_RUN: "1" } });
    assert.equal(r.dryRun, true);
    assert.equal(existsSync(join(t.dir, "learn-catalog.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
  } finally {
    t.cleanup();
  }
});

test("an invalid threshold in the environment aborts instead of silently using the default", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ env: { MAX_MODULE_DROP_PCT: "five" } }), /Invalid MAX_MODULE_DROP_PCT/);
  } finally {
    t.cleanup();
  }
});

test("the written file passes the contract self-check and is byte-stable across identical runs", async () => {
  const t = setup();
  try {
    const { validateCatalogOutput } = await import("../scripts/lib/learn-build.mjs");
    await t.run();
    assert.deepEqual(validateCatalogOutput(t.read("learn-catalog.json")), []);
    assert.ok(t.text("learn-catalog.json").endsWith("}\n"));
  } finally {
    t.cleanup();
  }
});

test("hierarchyNotFound lifecycle across runs: flagged on a definitive 404, kept through a transient failure, a bare 404 is no flag, cleared when the hierarchy answers again", async () => {
  const t = setup();
  const vm = () => t.read("learn-catalog.json").modules.find((m) => m.uid === "learn.azure.vm-basics");
  try {
    t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", 404);
    await t.run();
    assert.equal(vm().hierarchyNotFound, true);
    assert.equal(vm().unitUrls, null);

    // re-requested every run (null unitUrls), transient failure keeps the flag
    t.fake.clearRequests();
    t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", 503);
    await t.run({ now: D1_LATER });
    assert.equal(t.fake.hierarchyRequests().length >= 1, true);
    assert.equal(vm().hierarchyNotFound, true, "a transient failure says nothing new");

    // an unrecognised 404 is NOT the API's definitive answer
    t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", "bare404");
    await t.run({ now: D1_LATER });
    assert.equal("hierarchyNotFound" in vm(), false);
    assert.equal(vm().unitUrls, null);

    // healthy again
    t.fake.state.hierarchyFailures.clear();
    await t.run({ now: D1_LATER });
    assert.equal("hierarchyNotFound" in vm(), false);
    assert.equal(vm().unitUrls.length, 2);
  } finally {
    t.cleanup();
  }
});

// ---------------------------------------------------------------------------
// change files (data/changes/removed.json + moved.json), see DATA_CONTRACT.md
// ---------------------------------------------------------------------------

const D2 = new Date("2026-10-12T07:00:00.000Z");
const D3 = new Date("2026-10-19T07:00:00.000Z");
const D4 = new Date("2026-10-26T07:00:00.000Z");
const mUid = (i) => `learn.azure.m${String(i).padStart(4, "0")}`;
const mPath = (i) => `/training/modules/m${i}`;
const changeFiles = (t) => ({ removed: t.read("changes/removed.json"), moved: t.read("changes/moved.json") });
const entryAt = (file, path) => file.entries.find((e) => e.path === path);
const without = (modules, ...uids) => modules.filter((m) => !uids.includes(m.uid));
const withProbe = (probe) => ({ changes: { delayMs: 0, probe } });

test("changes: a first run without change files creates both, empty, and invents no history (tombstones of the previous file are not new)", async () => {
  const t = setup(bigWorld(40));
  try {
    assert.equal(existsSync(join(t.dir, "changes")), false);
    const probe = makeProbe();
    await t.run(withProbe(probe));
    const { removed, moved } = changeFiles(t);
    for (const file of [removed, moved]) {
      assert.deepEqual(file, { schemaVersion: 1, generatedAt: D1.toISOString(), sources: { learn: D1.toISOString(), docs: null }, entries: [] });
    }
    assert.deepEqual(probe.calls, []);
    assert.deepEqual(t.read("status.json").learn.catalogChanges, { removed: 0, moved: 0, unverified: 0, newRemoved: 0, newMoved: 0, resurrected: 0, probed: 0 });

    // the catalog already carries a tombstone from before change files existed: it is NOT a new change
    const catalog = t.read("learn-catalog.json");
    catalog.removed = [{ uid: "learn.azure.longgone", path: "/training/modules/longgone", title: "Long gone", lastSeen: "2026-08-01", removedOn: "2026-08-08" }];
    writeFileSync(join(t.dir, "learn-catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
    rmSync(join(t.dir, "changes"), { recursive: true });
    await t.run({ now: D2, ...withProbe(probe) });
    assert.deepEqual(changeFiles(t).removed.entries, []);
    assert.deepEqual(probe.calls, []);
  } finally {
    t.cleanup();
  }
});

test("changes: a removed module is probed and recorded; gone and landing go to removed.json, moved to moved.json", async () => {
  const t = setup(bigWorld(150));
  try {
    await t.run();
    // m3 is replaced by a module with a new uid and slug (how Learn usually renames): its old path redirects to the new module
    const successor = mod({ uid: "learn.azure.m3-successor", slug: "m3-renamed", products: ["azure-vm"] });
    t.fake.state.modules = [...without(t.fake.state.modules, mUid(1), mUid(2), mUid(3)), successor];
    t.fake.state.units = [...t.fake.state.units, ...unitsOf([successor])];
    const answers = {
      [mPath(1)]: PROBE_NOT_FOUND,
      [mPath(2)]: probeServed("/training/paths/azure-vm", { first: 301 }),
      [mPath(3)]: probeServed("/training/modules/m3-renamed", { first: 301 }),
    };
    const probe = makeProbe(answers);
    const logs = collectLogs();
    const r = await t.run({ now: D2, ...withProbe(probe), log: logs.log, warn: logs.warn });
    const { removed, moved } = changeFiles(t);
    assert.deepEqual(entryAt(removed, mPath(1)), {
      path: mPath(1),
      kind: "module",
      family: "learn",
      outcome: "gone",
      to: null,
      title: "Module m1",
      parent: null,
      firstSeen: "2026-10-12",
      lastVerified: "2026-10-12",
      evidence: "tombstone",
      status: 404,
    });
    assert.deepEqual(removed.entries.map((e) => [e.path, e.outcome, e.to, e.status]), [
      [mPath(1), "gone", null, 404],
      [mPath(2), "landing", "/training/paths/azure-vm", 301],
    ]);
    assert.deepEqual(moved.entries.map((e) => [e.path, e.outcome, e.to, e.status]), [[mPath(3), "moved", "/training/modules/m3-renamed", 301]]);
    assert.deepEqual([...probe.calls].sort(), [mPath(1), mPath(2), mPath(3)]);
    for (const file of [removed, moved]) assert.equal(file.sources.learn, D2.toISOString());
    assert.deepEqual(r.changesStats, { newRemoved: 2, newMoved: 1, resurrected: 0, unverified: 0, probed: 3, probeBudgetExhausted: false, transient: 0, stoppedEarly: false, covered: 0 });
    assert.deepEqual(t.read("status.json").learn.catalogChanges, { removed: 2, moved: 1, unverified: 0, newRemoved: 2, newMoved: 1, resurrected: 0, probed: 3 });
    assert.ok(logs.lines.some((l) => /change files \(catalog\): 2 removed \(0 unverified\), 1 moved; this run 2 new removed, 1 new moved, 0 resurrected, 3 probed/.test(l)), logs.lines.join("\n"));

    // the same day again: nothing is probed twice and the files are byte-identical
    const before = { removed: t.text("changes/removed.json"), moved: t.text("changes/moved.json") };
    const again = makeProbe();
    await t.run({ now: D2, ...withProbe(again) });
    assert.deepEqual(again.calls, []);
    assert.equal(t.text("changes/removed.json"), before.removed);
    assert.equal(t.text("changes/moved.json"), before.moved);
  } finally {
    t.cleanup();
  }
});

test("changes: a unit that disappears from a live module is recorded with its module and title", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    t.fake.state.modules = t.fake.state.modules.map((m) => (m.uid === mUid(5) ? { ...m, units: [m.units[0]] } : m));
    t.fake.state.units = t.fake.state.units.filter((u) => u.uid !== `${mUid(5)}.summary`);
    const probe = makeProbe({ "/training/modules/m5/2-summary": PROBE_NOT_FOUND });
    await t.run({ now: D2, ...withProbe(probe) });
    const { removed, moved } = changeFiles(t);
    assert.deepEqual(removed.entries, [
      {
        path: "/training/modules/m5/2-summary",
        kind: "unit",
        family: "learn",
        outcome: "gone",
        to: null,
        title: "summary",
        parent: "/training/modules/m5",
        firstSeen: "2026-10-12",
        lastVerified: "2026-10-12",
        evidence: "unit-diff",
        status: 404,
      },
    ]);
    assert.deepEqual(moved.entries, []);
    assert.deepEqual(probe.calls, ["/training/modules/m5/2-summary"]);
  } finally {
    t.cleanup();
  }
});

test("changes: a unit renamed inside a live module is a move to the new slug, and lookupChange follows it", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    t.fake.state.hierarchyFor = (m) =>
      m.uid === mUid(5) ? { units: m.units.map((uid, i) => ({ uid, url: `/training/modules/m5/${i + 1}-${i === 1 ? "wrap-up" : "introduction"}/` })) } : hierarchyOf(m);
    t.fake.state.units = t.fake.state.units.map((u) => (u.uid === `${mUid(5)}.summary` ? { ...u, last_modified: "2027-01-01T00:00:00+00:00" } : u));
    const probe = makeProbe({ "/training/modules/m5/2-summary": probeServed("/training/modules/m5/2-wrap-up", { first: 301 }) });
    await t.run({ now: D2, ...withProbe(probe) });
    const { removed, moved } = changeFiles(t);
    assert.deepEqual(removed.entries, []);
    assert.deepEqual(moved.entries.map((e) => [e.path, e.kind, e.parent, e.outcome, e.to, e.status, e.evidence]), [
      ["/training/modules/m5/2-summary", "unit", "/training/modules/m5", "moved", "/training/modules/m5/2-wrap-up", 301, "unit-diff"],
    ]);
    const hit = lookupChange("https://learn.microsoft.com/en-us/training/modules/m5/2-summary/?WT.mc_id=x", indexChanges({ removed, moved }));
    assert.equal(hit.state, "moved");
    assert.equal(hit.to, "/training/modules/m5/2-wrap-up");
    assert.equal(hit.confidence, "high");
  } finally {
    t.cleanup();
  }
});

test("changes: a module renamed under the same uid is a move of its OLD path, and its units are covered by it", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    const renamed = mod({ uid: mUid(4), slug: "m4-renamed", title: "Module m4 (renamed)", products: ["azure-vm"] });
    t.fake.state.modules = t.fake.state.modules.map((m) => (m.uid === mUid(4) ? renamed : m));
    const probe = makeProbe({ [mPath(4)]: probeServed("/training/modules/m4-renamed", { first: 301 }) });
    await t.run({ now: D2, ...withProbe(probe) });
    const { removed, moved } = changeFiles(t);
    assert.deepEqual(removed.entries, []);
    assert.deepEqual(moved.entries.map((e) => [e.path, e.kind, e.outcome, e.to, e.evidence, e.title]), [[mPath(4), "module", "moved", "/training/modules/m4-renamed", "rename", "Module m4"]]);
    assert.deepEqual(probe.calls, [mPath(4)], "the unit urls of the renamed module are not compared (no unit entries)");
    const hit = lookupChange("/training/modules/m4/1-introduction", indexChanges({ removed, moved }));
    assert.equal(hit.state, "moved");
    assert.equal(hit.to, "/training/modules/m4-renamed/1-introduction");
    assert.equal(hit.confidence, "low", "an inherited move is never certain");
  } finally {
    t.cleanup();
  }
});

test("changes: a transient probe leaves the entry unverified, a throwing probe never fails the sync, a later healthy run classifies it and keeps firstSeen", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    t.fake.state.modules = without(t.fake.state.modules, mUid(1));
    const blocked = makeProbe({ [mPath(1)]: PROBE_BLOCKED });
    await t.run({ now: D2, ...withProbe(blocked) });
    let e = entryAt(changeFiles(t).removed, mPath(1));
    assert.deepEqual([e.outcome, e.lastVerified, e.status, e.to, e.firstSeen, e.evidence], ["unverified", null, null, null, "2026-10-12", "tombstone"]);
    assert.deepEqual(t.read("status.json").learn.catalogChanges, { removed: 1, moved: 0, unverified: 1, newRemoved: 1, newMoved: 0, resurrected: 0, probed: 1 });

    const throwing = async () => {
      throw new Error("boom");
    };
    const logs = collectLogs();
    await t.run({ now: D3, ...withProbe(throwing), log: logs.log, warn: logs.warn });
    e = entryAt(changeFiles(t).removed, mPath(1));
    assert.equal(e.outcome, "unverified", "an exception from the probe reads as transient");
    assert.ok(logs.lines.some((l) => /1 removed \(1 unverified\)/.test(l)));

    const healthy = makeProbe({ [mPath(1)]: PROBE_NOT_FOUND });
    await t.run({ now: D4, ...withProbe(healthy) });
    e = entryAt(changeFiles(t).removed, mPath(1));
    assert.deepEqual([e.outcome, e.lastVerified, e.status, e.firstSeen, e.evidence], ["gone", "2026-10-26", 404, "2026-10-12", "tombstone"]);
    assert.equal(t.read("status.json").learn.catalogChanges.unverified, 0);
  } finally {
    t.cleanup();
  }
});

test("changes: some blocked probes keep their entries unverified while the others are classified, and the run still finishes", async () => {
  const t = setup(bigWorld(150));
  try {
    await t.run();
    t.fake.state.modules = without(t.fake.state.modules, mUid(1), mUid(2), mUid(3));
    const probe = makeProbe({ [mPath(1)]: PROBE_NOT_FOUND });
    const r = await t.run({ now: D2, changes: { delayMs: 0, workers: 1, probe } });
    assert.equal(r.changesStats.transient, 2);
    assert.equal(r.changesStats.stoppedEarly, false, "the circuit breaker needs a long run of transient answers");
    assert.deepEqual(changeFiles(t).removed.entries.map((e) => [e.path, e.outcome]), [[mPath(1), "gone"], [mPath(2), "unverified"], [mPath(3), "unverified"]]);
  } finally {
    t.cleanup();
  }
});

test("changes: a failed or truncated hierarchy never looks like removed units", async () => {
  // (a) the hierarchy request fails while the signature changed: unitUrls becomes null and nothing is compared
  const t = setup(bigWorld(40));
  try {
    await t.run();
    t.fake.state.modules = t.fake.state.modules.map((m) => (m.uid === mUid(5) ? { ...m, units: [m.units[0]] } : m));
    t.fake.state.units = t.fake.state.units.filter((u) => u.uid !== `${mUid(5)}.summary`);
    t.fake.state.hierarchyFailures.set(mUid(5), 503);
    const probe = makeProbe();
    await t.run({ now: D2, ...withProbe(probe) });
    assert.equal(t.read("learn-catalog.json").modules.find((m) => m.uid === mUid(5)).unitUrls, null);
    assert.deepEqual(changeFiles(t).removed.entries, []);
    // healthy again: the old list is gone (null), so the removal cannot be known; the validator and a live probe cover it
    t.fake.state.hierarchyFailures.clear();
    await t.run({ now: D3, ...withProbe(probe) });
    assert.deepEqual(changeFiles(t).removed.entries, []);
    assert.deepEqual(probe.calls, []);
  } finally {
    t.cleanup();
  }

  // (b) the failure keeps the previous urls (same signature): old list == carried-forward list
  const t2 = setup(bigWorld(40));
  try {
    await t2.run();
    t2.fake.state.hierarchyFailures.set(mUid(5), 503);
    const probe = makeProbe();
    const r = await t2.run({ now: D2, env: { FULL_UNIT_REFRESH: "1" }, ...withProbe(probe) });
    assert.equal(r.unitStats.carriedForward, 1);
    assert.deepEqual(changeFiles(t2).removed.entries, []);
    assert.deepEqual(probe.calls, []);
  } finally {
    t2.cleanup();
  }

  // (c) a module that suddenly lists fewer than half of its units is a truncated answer; exactly half is trusted
  for (const [keep, expected] of [[2, 0], [3, 3]]) {
    const big = mod({ uid: "learn.azure.big", slug: "big", products: ["azure-vm"], unitSpecs: ["u1", "u2", "u3", "u4", "u5", "u6"].map((s) => [s, s]) });
    const world = bigWorld(40);
    const t3 = setup({ modules: [...world.modules, big], units: [...world.units, ...unitsOf([big])] });
    try {
      await t3.run();
      t3.fake.state.modules = t3.fake.state.modules.map((m) => (m.uid === big.uid ? { ...m, units: m.units.slice(0, keep) } : m));
      t3.fake.state.units = t3.fake.state.units.filter((u) => !u.uid.startsWith("learn.azure.big.") || big.units.slice(0, keep).includes(u.uid));
      const probe = makeProbe({}, PROBE_NOT_FOUND);
      await t3.run({ now: D2, ...withProbe(probe) });
      assert.equal(changeFiles(t3).removed.entries.length, expected, `6 -> ${keep} units`);
      if (expected) assert.deepEqual(changeFiles(t3).removed.entries.map((e) => e.path), ["/training/modules/big/4-u4", "/training/modules/big/5-u5", "/training/modules/big/6-u6"]);
    } finally {
      t3.cleanup();
    }
  }
});

test("changes: resurrection removes an entry when the module or unit is back, or when a probe finds the path served live", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    const original = { modules: t.fake.state.modules, units: t.fake.state.units };
    // week 2: m1 vanishes and m5 loses a unit; the probe is blocked, so both stay unverified
    t.fake.state.modules = without(original.modules, mUid(1)).map((m) => (m.uid === mUid(5) ? { ...m, units: [m.units[0]] } : m));
    t.fake.state.units = original.units.filter((u) => u.uid !== `${mUid(5)}.summary`);
    await t.run({ now: D2, ...withProbe(makeProbe()) });
    assert.deepEqual(changeFiles(t).removed.entries.map((e) => [e.path, e.outcome]), [[mPath(1), "unverified"], ["/training/modules/m5/2-summary", "unverified"]]);

    // week 3: both are back
    t.fake.state.modules = original.modules;
    t.fake.state.units = original.units;
    const probe = makeProbe();
    const r = await t.run({ now: D3, ...withProbe(probe) });
    assert.deepEqual(changeFiles(t).removed.entries, []);
    assert.equal(r.changesStats.resurrected, 2);
    assert.deepEqual(probe.calls, [], "resurrected entries are not probed");
    assert.deepEqual(t.read("learn-catalog.json").removed, []);
  } finally {
    t.cleanup();
  }

  // a tombstoned path that Learn still serves (HTTP 200 on its own path) is never recorded
  const t2 = setup(bigWorld(40));
  try {
    await t2.run();
    t2.fake.state.modules = without(t2.fake.state.modules, mUid(2));
    const probe = makeProbe({ [mPath(2)]: probeServed(mPath(2)) });
    await t2.run({ now: D2, ...withProbe(probe) });
    assert.deepEqual(probe.calls, [mPath(2)]);
    assert.deepEqual(changeFiles(t2).removed.entries, []);
    assert.equal(t2.read("learn-catalog.json").removed.length, 1, "the catalog tombstone stays: the cache and the live site disagree");
  } finally {
    t2.cleanup();
  }
});

test("changes: a module the hierarchy API does not know is recorded every run, re-verified later, and keeps its firstSeen", async () => {
  const t = setup();
  try {
    t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", 404);
    const landing = probeServed("/training/paths/azure", { first: 301 });
    await t.run(withProbe(makeProbe({ "/training/modules/vm-basics": landing })));
    let e = entryAt(changeFiles(t).removed, "/training/modules/vm-basics");
    assert.deepEqual([e.kind, e.outcome, e.to, e.status, e.evidence, e.firstSeen, e.lastVerified], ["module", "landing", "/training/paths/azure", 301, "hierarchy-not-found", "2026-10-05", "2026-10-05"]);

    const again = makeProbe({ "/training/modules/vm-basics": landing });
    await t.run({ now: D2, ...withProbe(again) });
    e = entryAt(changeFiles(t).removed, "/training/modules/vm-basics");
    assert.equal(changeFiles(t).removed.entries.length, 1);
    assert.deepEqual([e.firstSeen, e.lastVerified], ["2026-10-05", "2026-10-12"]);
    assert.deepEqual(again.calls, ["/training/modules/vm-basics"], "rotation: the oldest verified entry is re-confirmed");

    // Learn serves it through the hierarchy API again: the flag clears and the entry goes away without a probe
    t.fake.state.hierarchyFailures.clear();
    const healed = makeProbe();
    const r = await t.run({ now: D3, ...withProbe(healed) });
    assert.deepEqual(changeFiles(t).removed.entries, []);
    assert.equal(r.changesStats.resurrected, 1);
    assert.deepEqual(healed.calls, []);
  } finally {
    t.cleanup();
  }
});

test("changes: a hierarchy answer that is not definitive (bare 404, 403, bad shape) clears the flag but never deletes a probed entry; only a readable hierarchy does", async () => {
  const t = setup();
  const VM = "/training/modules/vm-basics";
  try {
    // W1: the API does not know the module and the probe sees it land on a learning path
    t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", 404);
    const landing = probeServed("/training/paths/azure", { first: 301 });
    await t.run(withProbe(makeProbe({ [VM]: landing })));
    const entry = () => entryAt(changeFiles(t).removed, VM);
    const first = entry();
    assert.deepEqual([first.outcome, first.firstSeen, first.lastVerified, first.evidence], ["landing", "2026-10-05", "2026-10-05", "hierarchy-not-found"]);

    // W2..W4: one unreadable answer per week, each of a different kind. The flag is gone (the API did not say module_id_not_found
    // this time) and unitUrls is null, so the cache cannot vouch for the module: the entry stays and is re-verified, firstSeen intact
    const weeks = [
      [D2, "bare404"],
      [D3, 403],
      [D4, () => 200], // a 200 whose body is no hierarchy at all is a bad shape
    ];
    for (const [when, failure] of weeks) {
      t.fake.state.hierarchyFailures.set("learn.azure.vm-basics", failure);
      const probe = makeProbe({ [VM]: landing });
      const r = await t.run({ now: when, ...withProbe(probe) });
      const vm = t.read("learn-catalog.json").modules.find((m) => m.uid === "learn.azure.vm-basics");
      assert.equal("hierarchyNotFound" in vm, false, "the flag only rests on the API's own answer");
      assert.equal(vm.unitUrls, null);
      const now = entry();
      assert.ok(now, `${when.toISOString()}: the probe-classified entry was not deleted on a non-answer`);
      assert.deepEqual([now.outcome, now.firstSeen, now.evidence], ["landing", "2026-10-05", "hierarchy-not-found"]);
      assert.equal(now.lastVerified, when.toISOString().slice(0, 10), "it was re-verified by the rotation instead");
      assert.equal(r.changesStats.resurrected, 0);
      assert.deepEqual(probe.calls, [VM]);
    }

    // W5: the hierarchy answers (units known): the cache now vouches for the module, the entry goes without a probe
    t.fake.state.hierarchyFailures.clear();
    const healed = makeProbe();
    const r = await t.run({ now: new Date("2026-11-02T07:00:00.000Z"), ...withProbe(healed) });
    assert.deepEqual(changeFiles(t).removed.entries, []);
    assert.equal(r.changesStats.resurrected, 1);
    assert.deepEqual(healed.calls, []);
  } finally {
    t.cleanup();
  }
});

test("changes: without an injected probe the real raw probe runs over the run's fetch (404 = gone, 200 on its own path = live)", async () => {
  const t = setup(bigWorld(150));
  try {
    await t.run();
    t.fake.state.modules = without(t.fake.state.modules, mUid(1), mUid(2));
    t.fake.state.pages.set(mPath(2), { status: 200, body: "<html><head><title>Module m2</title></head></html>" });
    await t.run({ now: D2 });
    const { removed } = changeFiles(t);
    assert.deepEqual(removed.entries.map((e) => [e.path, e.outcome, e.status]), [[mPath(1), "gone", 404]]);
    assert.ok(t.fake.requests.includes("https://learn.microsoft.com/en-us/training/modules/m1/"));
    assert.ok(t.fake.requests.includes("https://learn.microsoft.com/en-us/training/modules/m2/"));
  } finally {
    t.cleanup();
  }
});

test("changes: entries of the docs family and of the content kinds pass through the catalog run, the docs ones untouched", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    const stamp = "2026-10-01T08:00:00.000Z";
    const docs = { path: "/azure/old", kind: "docs", family: "docs", outcome: "moved", to: "/azure/new", title: null, parent: null, firstSeen: "2026-09-28", lastVerified: "2026-10-01", evidence: "docs-redirect", status: 301 };
    const exam = { path: "/credentials/certifications/exams/70-767", kind: "exam", family: "learn", outcome: "gone", to: null, title: "70-767", parent: null, firstSeen: "2026-09-20", lastVerified: "2026-10-05", evidence: "tombstone", status: 404 };
    writeFileSync(join(t.dir, "changes", "moved.json"), JSON.stringify({ schemaVersion: 1, generatedAt: stamp, sources: { learn: stamp, docs: stamp }, entries: [docs] }, null, 2) + "\n");
    writeFileSync(join(t.dir, "changes", "removed.json"), JSON.stringify({ schemaVersion: 1, generatedAt: stamp, sources: { learn: stamp, docs: stamp }, entries: [exam] }, null, 2) + "\n");
    t.fake.state.modules = without(t.fake.state.modules, mUid(1));
    const probe = makeProbe({ [mPath(1)]: PROBE_NOT_FOUND, [exam.path]: PROBE_NOT_FOUND });
    await t.run({ now: D2, ...withProbe(probe) });
    const { removed, moved } = changeFiles(t);
    assert.deepEqual(moved.entries, [docs], "the docs family is never touched or probed here");
    assert.deepEqual(moved.sources, { learn: D2.toISOString(), docs: stamp });
    assert.ok(!probe.calls.includes("/azure/old"));
    assert.deepEqual(removed.entries.map((e) => [e.path, e.outcome, e.lastVerified]), [
      ["/credentials/certifications/exams/70-767", "gone", "2026-10-12"],
      [mPath(1), "gone", "2026-10-12"],
    ]);
  } finally {
    t.cleanup();
  }
});

test("changes: a corrupt change file or a typo in CHANGES_* fails the run before any request and before anything is written", async () => {
  const t = setup(bigWorld(40));
  try {
    mkdirSync(join(t.dir, "changes"));
    for (const body of ["{broken", JSON.stringify({ schemaVersion: 2, entries: [] }), JSON.stringify({ schemaVersion: 1, entries: {} }), "[]"]) {
      writeFileSync(join(t.dir, "changes", "removed.json"), body);
      await assert.rejects(t.run(), (err) => err instanceof ChangesFileError && /removed\.json/.test(err.message), body);
      assert.equal(t.fake.requests.length, 0, "failed before the first download");
      assert.equal(existsSync(join(t.dir, "learn-catalog.json")), false);
      assert.equal(existsSync(join(t.dir, "status.json")), false);
      assert.equal(existsSync(join(t.dir, "changes", "moved.json")), false);
      assert.equal(readFileSync(join(t.dir, "changes", "removed.json"), "utf-8"), body, "the unreadable file is left alone");
    }
    rmSync(join(t.dir, "changes"), { recursive: true });
    await assert.rejects(t.run({ env: { CHANGES_MAX_PROBES: "lots" } }), /CHANGES_MAX_PROBES/);
    await assert.rejects(t.run({ env: { CHANGES_REVERIFY_PER_RUN: "-1" } }), /CHANGES_REVERIFY_PER_RUN/);
    assert.equal(t.fake.requests.length, 0);
    assert.equal(existsSync(join(t.dir, "changes")), false);
  } finally {
    t.cleanup();
  }
});

test("changes: CHANGES_MAX_PROBES from the environment caps the probes of a run, the rest stays unverified", async () => {
  const t = setup(bigWorld(150));
  try {
    await t.run();
    t.fake.state.modules = without(t.fake.state.modules, mUid(1), mUid(2), mUid(3));
    const probe = makeProbe({}, PROBE_NOT_FOUND);
    const logs = collectLogs();
    const r = await t.run({ now: D2, env: { CHANGES_MAX_PROBES: "1" }, ...withProbe(probe), log: logs.log, warn: logs.warn });
    assert.equal(probe.calls.length, 1);
    assert.equal(r.changesStats.probeBudgetExhausted, true);
    assert.deepEqual(changeFiles(t).removed.entries.map((e) => e.outcome).sort(), ["gone", "unverified", "unverified"]);
    assert.ok(logs.lines.some((l) => /verification queue is longer than the probe budget \(1\)/.test(l)));
  } finally {
    t.cleanup();
  }
});

test("changes FAILSAFE: an aborted run writes no change file and does not probe", async () => {
  const t = setup(bigWorld(100));
  try {
    await t.run();
    t.fake.state.modules = without(t.fake.state.modules, mUid(7));
    await t.run({ now: D2, ...withProbe(makeProbe({ [mPath(7)]: PROBE_NOT_FOUND })) });
    const snapshot = () => ({ removed: t.text("changes/removed.json"), moved: t.text("changes/moved.json"), catalog: t.text("learn-catalog.json"), status: t.text("status.json") });
    const before = snapshot();
    assert.equal(JSON.parse(before.removed).entries.length, 1);

    // a truncated catalog response would look like ten removed modules: the failsafe aborts first
    const probe = makeProbe({}, PROBE_NOT_FOUND);
    t.fake.state.truncateModulesTo = 90;
    await assert.rejects(t.run({ now: D3, ...withProbe(probe) }), (err) => err instanceof FailsafeAbort);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(probe.calls, []);

    // too many failed hierarchy requests abort after the downloads: still nothing written
    t.fake.state.truncateModulesTo = null;
    for (let i = 10; i < 30; i++) t.fake.state.hierarchyFailures.set(mUid(i), 500);
    await assert.rejects(t.run({ now: D3, env: { FULL_UNIT_REFRESH: "1" }, ...withProbe(probe) }), /hierarchy requests failed/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(probe.calls, []);
  } finally {
    t.cleanup();
  }
});

test("changes: DRY_RUN=1 computes and probes but writes no change file, data file or status", async () => {
  const t = setup(bigWorld(40));
  try {
    const first = await t.run({ env: { DRY_RUN: "1" } });
    assert.equal(existsSync(join(t.dir, "changes")), false);
    assert.equal(first.changes.removed.entries.length, 0);

    await t.run();
    const snapshot = () => ({ removed: t.text("changes/removed.json"), moved: t.text("changes/moved.json"), catalog: t.text("learn-catalog.json"), status: t.text("status.json") });
    const before = snapshot();
    t.fake.state.modules = without(t.fake.state.modules, mUid(1));
    const probe = makeProbe({ [mPath(1)]: PROBE_NOT_FOUND });
    const logs = collectLogs();
    const r = await t.run({ now: D2, env: { DRY_RUN: "1" }, ...withProbe(probe), log: logs.log, warn: logs.warn });
    assert.deepEqual(probe.calls, [mPath(1)], "a dry run still verifies, so the operator sees the outcome");
    assert.deepEqual(r.changes.removed.entries.map((e) => [e.path, e.outcome]), [[mPath(1), "gone"]]);
    assert.deepEqual(snapshot(), before);
    assert.ok(logs.lines.some((l) => /DRY_RUN=1: not writing the data file, the change files or status\.json/.test(l)));
  } finally {
    t.cleanup();
  }
});

test("changes: the files are byte-stable (writeChanges(loadChanges) reproduces them) and the other part's status counters survive", async () => {
  const t = setup(bigWorld(40));
  try {
    await t.run();
    t.fake.state.modules = without(t.fake.state.modules, mUid(1));
    await t.run({ now: D2, ...withProbe(makeProbe({ [mPath(1)]: probeServed("/training/paths/azure", { first: 301 }) })) });
    const { writeChanges } = await import("../scripts/lib/changes.mjs");
    const before = { removed: t.text("changes/removed.json"), moved: t.text("changes/moved.json") };
    writeChanges(t.dir, loadChanges(t.dir));
    assert.equal(t.text("changes/removed.json"), before.removed);
    assert.equal(t.text("changes/moved.json"), before.moved);
    assert.ok(before.removed.endsWith("}\n"));

    contributeLearnStatus(join(t.dir, "status.json"), "content", { contentChanges: { removed: 9 } }, { now: D2, env: {} });
    await t.run({ now: D3, ...withProbe(makeProbe({ [mPath(1)]: probeServed("/training/paths/azure", { first: 301 }) })) });
    const learn = t.read("status.json").learn;
    assert.deepEqual(learn.contentChanges, { removed: 9 });
    assert.equal(learn.catalogChanges.removed, 1);
    assert.equal(learn.removed, 1, "the top-level `removed` still means module tombstones");
  } finally {
    t.cleanup();
  }
});
