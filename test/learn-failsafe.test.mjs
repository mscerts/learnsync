import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkApiDrop,
  checkAppliedSkillCodeCoverage,
  checkCategoryCoverage,
  checkContentCounts,
  checkHierarchyFailures,
  checkMinModules,
  checkModuleDrop,
  checkProbeFailures,
  checkUnitFallback,
  checkUnresolvedModules,
  dropPercent,
  evaluateCatalogFailsafes,
  previousBaseline,
  recoveredEmptyCategories,
  shouldAbortHierarchyEarly,
} from "../scripts/lib/learn-failsafe.mjs";
import { LIMITS } from "../scripts/lib/learn-config.mjs";

test("dropPercent is zero when the count grew or there is no previous value", () => {
  assert.equal(dropPercent(100, 95), 5);
  assert.equal(dropPercent(100, 120), 0);
  assert.equal(dropPercent(0, 10), 0);
  assert.equal(dropPercent(undefined, 10), 0);
});

test("MIN_MODULES floor", () => {
  assert.equal(checkMinModules(3000, 3000).length, 0);
  assert.match(checkMinModules(2999, 3000)[0], /only 2999 in-scope modules/);
});

test("in-scope drop: exactly the limit passes, more aborts", () => {
  assert.deepEqual(checkModuleDrop(3355, 3200, 5), []);
  assert.deepEqual(checkModuleDrop(100, 95, 5), [], "5.0% exact is allowed");
  assert.match(checkModuleDrop(3355, 3186, 5)[0], /fell from 3355 to 3186/);
  assert.deepEqual(checkModuleDrop(0, 10, 5), [], "first run has nothing to compare");
});

test("raw API drop: the truncated response the reviewer reproduced (first 2,900 modules only) aborts", () => {
  const problems = checkApiDrop(3421, 2900, 3);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /3421/);
  assert.match(problems[0], /truncated/);
  assert.deepEqual(checkApiDrop(3421, 3330, 3), [], "2.7% drop is tolerated");
  assert.equal(checkApiDrop(3421, 3318, 3).length, 1, "3.01% drop aborts");
});

test("category coverage: zero modules in an allowlisted category aborts unless it is a known-empty one", () => {
  const allowed = ["azure", "github", "viva"];
  assert.deepEqual(checkCategoryCoverage({ allowed, counts: { azure: 5, github: 2, viva: 1 } }), []);
  const missing = checkCategoryCoverage({ allowed, counts: { azure: 5, github: 2 } });
  assert.equal(missing.length, 1);
  assert.match(missing[0], /"viva" has zero modules/);
  assert.deepEqual(checkCategoryCoverage({ allowed, knownEmpty: ["viva"], counts: { azure: 5, github: 2 } }), []);
  const lost = checkCategoryCoverage({ allowed, knownEmpty: ["viva"], counts: { azure: 5, github: 2 }, previousCategoryIds: ["viva"] });
  assert.match(lost[0], /had modules in the previous data and has none now/, "a known-empty id that had modules before is still a truncation signal");
});

test("recoveredEmptyCategories lists known-empty ids that have modules again", () => {
  assert.deepEqual(recoveredEmptyCategories({ knownEmpty: ["a", "b"], counts: { b: 2 } }), ["b"]);
});

test("unit title fallback: a truncated units array makes most titles fall back to uids", () => {
  assert.deepEqual(checkUnitFallback({ missing: 119, total: 27206, maxPct: 5 }), []);
  assert.equal(checkUnitFallback({ missing: 20000, total: 27206, maxPct: 5 }).length, 1);
  assert.deepEqual(checkUnitFallback({ missing: 0, total: 0, maxPct: 5 }), []);
});

test("hierarchy failure share: more than 10% aborts, small samples are exempt", () => {
  assert.deepEqual(checkHierarchyFailures({ requests: 1000, failures: 100, maxPct: 10, minSample: 20 }), []);
  assert.equal(checkHierarchyFailures({ requests: 1000, failures: 101, maxPct: 10, minSample: 20 }).length, 1);
  assert.deepEqual(checkHierarchyFailures({ requests: 3, failures: 3, maxPct: 10, minSample: 20 }), [], "3 requests prove nothing");
  assert.deepEqual(checkHierarchyFailures({ requests: 0, failures: 0, maxPct: 10, minSample: 0 }), []);
});

test("circuit breaker stops the pool once the early sample is over the limit", () => {
  assert.equal(shouldAbortHierarchyEarly({ completed: 49, failures: 49, maxPct: 10, earlySample: 50 }), false, "sample not reached yet");
  assert.equal(shouldAbortHierarchyEarly({ completed: 50, failures: 6, maxPct: 10, earlySample: 50 }), true);
  assert.equal(shouldAbortHierarchyEarly({ completed: 50, failures: 5, maxPct: 10, earlySample: 50 }), false);
});

test("evaluateCatalogFailsafes bundles every catalog-stage check", () => {
  const base = {
    inScopeCount: 3355,
    apiTotal: 3421,
    previous: { inScopeCount: 3355, apiTotal: 3421, categoryIds: ["azure"] },
    categoryModuleCounts: { azure: 3000 },
    previousCategoryIds: ["azure"],
    allowedCategories: ["azure"],
    knownEmptyCategories: [],
    unitRefs: 27206,
    missingUnitTitles: 119,
    limits: LIMITS,
  };
  assert.deepEqual(evaluateCatalogFailsafes(base), []);
  const truncated = evaluateCatalogFailsafes({ ...base, inScopeCount: 2850, apiTotal: 2900, categoryModuleCounts: { azure: 2850 } });
  assert.ok(truncated.length >= 3, `expected floor + in-scope drop + api drop, got ${truncated.length}: ${truncated.join(" | ")}`);
});

test("previousBaseline derives counts, the raw total (stored or lower bound) and the categories that had modules", () => {
  const names = new Map([["azure", "Azure"], ["github", "GitHub"]]);
  const v2 = { totalApiModules: 3421, modules: [{ categories: ["Azure"] }, { categories: ["Azure", "GitHub"] }], outOfScope: ["/a"] };
  assert.deepEqual(previousBaseline(v2, { categoryNameByTopId: names }), { inScopeCount: 2, apiTotal: 3421, categoryIds: ["azure", "github"] });
  const v1 = { modules: [{ categories: ["Azure"] }] };
  assert.equal(previousBaseline(v1, { categoryNameByTopId: names }).apiTotal, 1, "schema v1 has no total: in-scope count is the best lower bound");
  assert.equal(previousBaseline(null, { categoryNameByTopId: names }), null);
  assert.equal(previousBaseline({ modules: "x" }, { categoryNameByTopId: names }), null);
});

test("content counts: floor and per-list relative drop", () => {
  const floors = { exams: 70, courses: 70 };
  assert.deepEqual(checkContentCounts({ previous: { exams: 145, courses: 139 }, current: { exams: 150, courses: 139 }, maxDropPct: 20, floors }), []);
  const dropped = checkContentCounts({ previous: { exams: 145, courses: 139 }, current: { exams: 100, courses: 139 }, maxDropPct: 20, floors });
  assert.equal(dropped.length, 1);
  assert.match(dropped[0], /exams fell from 145 to 100/);
  const floor = checkContentCounts({ previous: null, current: { exams: 5, courses: 139 }, maxDropPct: 20, floors });
  assert.match(floor[0], /exams: only 5 entries \(floor 70\)/);
  assert.deepEqual(checkContentCounts({ previous: { exams: 145 }, current: { exams: 117 }, maxDropPct: 20 }), [], "19.3% is within 20%");
});

test("unresolved learning-path module references", () => {
  assert.deepEqual(checkUnresolvedModules({ unresolved: 15, total: 3815, maxPct: 5 }), []);
  assert.equal(checkUnresolvedModules({ unresolved: 1000, total: 3815, maxPct: 5 }).length, 1);
  assert.deepEqual(checkUnresolvedModules({ unresolved: 0, total: 0, maxPct: 5 }), []);
});

test("probe failures and applied-skill code coverage", () => {
  assert.deepEqual(checkProbeFailures({ label: "exam", probes: 145, transient: 14, maxPct: 10, minSample: 20 }), []);
  assert.match(checkProbeFailures({ label: "exam", probes: 145, transient: 15, maxPct: 10, minSample: 20 })[0], /15 of 145 exam probes/);
  assert.deepEqual(checkProbeFailures({ label: "exam", probes: 5, transient: 5, maxPct: 10, minSample: 20 }), []);
  assert.deepEqual(checkAppliedSkillCodeCoverage({ previousWithCode: 37, currentWithCode: 37, minSharePct: 50 }), []);
  assert.deepEqual(checkAppliedSkillCodeCoverage({ previousWithCode: 0, currentWithCode: 0, minSharePct: 50 }), []);
  assert.match(checkAppliedSkillCodeCoverage({ previousWithCode: 37, currentWithCode: 0, minSharePct: 50 })[0], /only 0 of the 37/);
});
