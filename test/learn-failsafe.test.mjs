import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessCatalogFailsafes,
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
  classifyCategoryCoverage,
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

// ---------------------------------------------------------------------------
// emptied categories: a category that had modules and has none now
// ---------------------------------------------------------------------------

// The real incident (2026-10-12): the category held ONE module, which left the API.
const EMPTIED = {
  allowed: ["azure", "ems"],
  counts: { azure: 3000 },
  previousCategoryIds: ["azure", "ems"],
  previousModulesByCategory: { azure: ["learn.azure.a"], ems: ["learn.mec.soc"] },
  apiUids: new Set(["learn.azure.a"]), // learn.mec.soc is gone from the whole response
  maxEmptied: 1,
};

test("emptied category: the only module left the API in an otherwise healthy run -> accepted and reported, not a problem", () => {
  const result = classifyCategoryCoverage(EMPTIED);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.emptied, [{ id: "ems", modules: ["learn.mec.soc"] }]);
  assert.deepEqual(result.stillEmpty, []);
});

test("emptied category: strict unless the caller passes the accounting data AND a limit above zero", () => {
  const { previousModulesByCategory, apiUids, maxEmptied, ...bare } = EMPTIED;
  assert.match(classifyCategoryCoverage({ ...bare, maxEmptied: 1 }).problems[0], /cannot be accounted for/, "no per-module data -> not accepted");
  assert.match(classifyCategoryCoverage({ ...bare, previousModulesByCategory, maxEmptied: 1 }).problems[0], /cannot be accounted for/, "no API uids -> not accepted");
  assert.match(checkCategoryCoverage(bare)[0], /had modules in the previous data and has none now/, "checkCategoryCoverage keeps the old strict reading");
  assert.match(classifyCategoryCoverage({ ...EMPTIED, maxEmptied: 0 }).problems[0], /switched off \(MAX_EMPTIED_CATEGORIES=0\)/);
  assert.deepEqual(classifyCategoryCoverage({ ...EMPTIED, maxEmptied: 0 }).emptied, []);
});

test("emptied category: an unhealthy rest of the run (truncation) makes it a problem again", () => {
  const result = classifyCategoryCoverage({ ...EMPTIED, otherProblems: ["the API returned 2900 modules vs 3421 last run"] });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /allowlisted category "ems" had modules in the previous data and has none now/);
  assert.match(result.problems[0], /rest of the run does not look healthy \(1 other failsafe problem\)/);
  assert.deepEqual(result.emptied, []);
});

test("emptied category: several categories emptying at once abort, every one of them is named", () => {
  const result = classifyCategoryCoverage({
    allowed: ["azure", "ems", "viva"],
    counts: { azure: 3000 },
    previousCategoryIds: ["azure", "ems", "viva"],
    previousModulesByCategory: { azure: ["learn.azure.a"], ems: ["learn.mec.soc"], viva: ["learn.viva.x"] },
    apiUids: new Set(["learn.azure.a"]),
    maxEmptied: 1,
  });
  assert.equal(result.problems.length, 2);
  assert.match(result.problems[0], /"ems".*2 allowlisted categories emptied in one run \(limit 1\): ems, viva/);
  assert.match(result.problems[1], /"viva".*2 allowlisted categories emptied in one run \(limit 1\): ems, viva/);
  assert.deepEqual(result.emptied, []);
  assert.deepEqual(classifyCategoryCoverage({ ...EMPTIED, maxEmptied: 2, allowed: ["azure", "ems", "viva"], previousCategoryIds: ["azure", "ems", "viva"], previousModulesByCategory: { ...EMPTIED.previousModulesByCategory, viva: ["learn.viva.x"] } }).problems, [], "a higher limit accepts both");
});

test("emptied category: every previous module must be gone from the API (a re-tagged module is not a removal)", () => {
  const result = classifyCategoryCoverage({
    ...EMPTIED,
    previousModulesByCategory: { ...EMPTIED.previousModulesByCategory, ems: ["learn.mec.soc", "learn.mec.retagged"] },
    apiUids: new Set(["learn.azure.a", "learn.mec.retagged"]), // one module left, the other is still served without the category
  });
  assert.equal(result.problems.length, 1);
  assert.match(result.problems[0], /1 of its 2 previous modules are still in the API, re-tagged rather than removed: learn\.mec\.retagged/);
  assert.doesNotMatch(result.problems[0], /learn\.mec\.soc/, "only the unaccounted module is named");
  assert.deepEqual(result.emptied, []);
  // the single-module wording of the same rule (the real incident, had the module only been re-tagged)
  assert.match(
    classifyCategoryCoverage({ ...EMPTIED, apiUids: new Set(["learn.azure.a", "learn.mec.soc"]) }).problems[0],
    /its only previous module is still in the API, re-tagged rather than removed: learn\.mec\.soc/
  );
  // a record without any module uid cannot be accounted for either
  assert.match(classifyCategoryCoverage({ ...EMPTIED, previousModulesByCategory: { ems: [] } }).problems[0], /cannot be accounted for/);
});

test("emptied category: a known-empty id that had modules is judged the same way", () => {
  assert.deepEqual(classifyCategoryCoverage({ ...EMPTIED, knownEmpty: ["ems"] }).problems, []);
  assert.deepEqual(classifyCategoryCoverage({ ...EMPTIED, knownEmpty: ["ems"] }).emptied.map((e) => e.id), ["ems"]);
});

test("still-empty category: allowlisted and already empty last time is tolerated, a new empty allowlist entry is not", () => {
  const next = { allowed: ["azure", "ems"], counts: { azure: 3000 }, previousCategoryIds: ["azure"], maxEmptied: 1 };
  // the file written by the run that accepted the emptying lists "ems" in its categoryFilter but holds no module in it
  assert.deepEqual(classifyCategoryCoverage({ ...next, previousAllowed: ["azure", "ems"] }), { problems: [], emptied: [], stillEmpty: ["ems"] });
  // an id added to the allowlist since (typo, renamed product) has no history: still an abort
  assert.match(classifyCategoryCoverage({ ...next, previousAllowed: ["azure"] }).problems[0], /"ems" has zero modules \(not listed in KNOWN_EMPTY_CATEGORIES\)/);
  // no categoryFilter in the previous file (first run, schema v1): strict
  assert.match(classifyCategoryCoverage({ ...next, previousAllowed: null }).problems[0], /"ems" has zero modules/);
  // known-empty stays exempt and is not reported as "still empty"
  assert.deepEqual(classifyCategoryCoverage({ ...next, knownEmpty: ["ems"], previousAllowed: ["azure", "ems"] }), { problems: [], emptied: [], stillEmpty: [] });
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

// A healthy 3370-module world in which the only module of "ems" left the API (what happened on 2026-10-12).
const HEALTHY_EMPTIED = {
  inScopeCount: 3369,
  apiTotal: 3435,
  previous: {
    inScopeCount: 3370,
    apiTotal: 3436,
    categoryIds: ["azure", "ems"],
    allowedIds: ["azure", "ems"],
    modulesByCategory: { azure: ["learn.azure.a"], ems: ["learn.mec.soc"] },
  },
  categoryModuleCounts: { azure: 3369 },
  allowedCategories: ["azure", "ems"],
  knownEmptyCategories: [],
  unitRefs: 27206,
  missingUnitTitles: 119,
  limits: LIMITS,
  apiUids: new Set(["learn.azure.a"]),
};

test("assessCatalogFailsafes: the real incident (one module of a one-module category left, everything else healthy) passes and is reported", () => {
  const result = assessCatalogFailsafes(HEALTHY_EMPTIED);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.emptied, [{ id: "ems", modules: ["learn.mec.soc"] }]);
  assert.deepEqual(result.stillEmpty, []);
  assert.deepEqual(evaluateCatalogFailsafes(HEALTHY_EMPTIED), [], "the problems-only wrapper agrees");
});

test("assessCatalogFailsafes: the same emptied category in a truncated response still aborts, with every symptom listed", () => {
  const truncated = assessCatalogFailsafes({ ...HEALTHY_EMPTIED, inScopeCount: 2850, apiTotal: 2900, categoryModuleCounts: { azure: 2850 } });
  assert.deepEqual(truncated.emptied, []);
  const text = truncated.problems.join(" | ");
  assert.match(text, /in-scope modules fell/);
  assert.match(text, /the API returned 2900 modules vs 3436 last run/);
  assert.match(text, /allowlisted category "ems" had modules in the previous data and has none now \(the rest of the run does not look healthy \(3 other failsafe problems\)/);
  // each single check that is over its limit is enough
  assert.match(assessCatalogFailsafes({ ...HEALTHY_EMPTIED, missingUnitTitles: 20000 }).problems.join(" | "), /ems.*does not look healthy/);
  assert.match(assessCatalogFailsafes({ ...HEALTHY_EMPTIED, inScopeCount: 3100 }).problems.join(" | "), /ems.*does not look healthy/);
});

test("assessCatalogFailsafes: the exception needs apiUids and the baseline's module data, and MAX_EMPTIED_CATEGORIES above zero", () => {
  assert.match(assessCatalogFailsafes({ ...HEALTHY_EMPTIED, apiUids: null }).problems[0], /cannot be accounted for/);
  assert.match(assessCatalogFailsafes({ ...HEALTHY_EMPTIED, previous: { ...HEALTHY_EMPTIED.previous, modulesByCategory: undefined } }).problems[0], /cannot be accounted for/);
  assert.match(assessCatalogFailsafes({ ...HEALTHY_EMPTIED, limits: { ...LIMITS, MAX_EMPTIED_CATEGORIES: 0 } }).problems[0], /switched off/);
  assert.equal(LIMITS.MAX_EMPTIED_CATEGORIES, 1, "one category at a time by default");
});

test("assessCatalogFailsafes: the category carried over from the run that accepted it keeps passing, and is listed as still empty", () => {
  const next = {
    ...HEALTHY_EMPTIED,
    previous: { inScopeCount: 3369, apiTotal: 3435, categoryIds: ["azure"], allowedIds: ["azure", "ems"], modulesByCategory: { azure: ["learn.azure.a"] } },
    previousCategoryIds: undefined,
  };
  const result = assessCatalogFailsafes(next);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.emptied, []);
  assert.deepEqual(result.stillEmpty, ["ems"]);
});

test("previousBaseline derives counts, the raw total (stored or lower bound) and the categories that had modules", () => {
  const names = new Map([["azure", "Azure"], ["github", "GitHub"]]);
  const v2 = { totalApiModules: 3421, modules: [{ categories: ["Azure"] }, { categories: ["Azure", "GitHub"] }], outOfScope: ["/a"] };
  assert.deepEqual(previousBaseline(v2, { categoryNameByTopId: names }), {
    inScopeCount: 2,
    apiTotal: 3421,
    categoryIds: ["azure", "github"],
    allowedIds: null,
    modulesByCategory: {},
  });
  const v1 = { modules: [{ categories: ["Azure"] }] };
  assert.equal(previousBaseline(v1, { categoryNameByTopId: names }).apiTotal, 1, "schema v1 has no total: in-scope count is the best lower bound");
  assert.equal(previousBaseline(null, { categoryNameByTopId: names }), null);
  assert.equal(previousBaseline({ modules: "x" }, { categoryNameByTopId: names }), null);
});

test("previousBaseline also records which module uids each category held and the allowlist the file was written with", () => {
  const names = new Map([["azure", "Azure"], ["github", "GitHub"], ["ems", "ems"]]);
  const previous = {
    categoryFilter: ["github", "azure", "ems", 7],
    modules: [
      { uid: "learn.b", categories: ["Azure", "GitHub"] },
      { uid: "learn.a", categories: ["Azure"] },
      { uid: "learn.c", categories: ["ems", "Not In The Allowlist"] },
      { categories: ["Azure"] }, // no uid: counted for the category, cannot be accounted for
    ],
  };
  const baseline = previousBaseline(previous, { categoryNameByTopId: names });
  assert.deepEqual(baseline.categoryIds, ["azure", "ems", "github"]);
  assert.deepEqual(baseline.modulesByCategory, { azure: ["learn.a", "learn.b"], ems: ["learn.c"], github: ["learn.b"] });
  assert.deepEqual(baseline.allowedIds, ["azure", "ems", "github"], "strings only, sorted");
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
