import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FailsafeAbort } from "../scripts/lib/learn-io.mjs";
import { runCatalogSync } from "../scripts/lib/learn-catalog-run.mjs";
import { contributeLearnStatus } from "../scripts/lib/learn-status.mjs";
import { TEST_CONFIG, TEST_LIMITS, collectLogs, hierarchyOf, makeFakeLearn, makeTempDir, mod, removeDir, standardWorld, unitsOf } from "./learn-fixtures.mjs";

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
