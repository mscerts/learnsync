import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOG_SCHEMA_VERSION,
  assembleCatalog,
  buildTaxonomy,
  computeRemovals,
  computeUnitSig,
  finalizeModules,
  findRenamedPaths,
  findTombstonePathCollisions,
  isModulePath,
  sameExceptTimestamp,
  transformModules,
  validateCatalogOutput,
} from "../scripts/lib/learn-build.mjs";
import { PRODUCTS, SUBJECTS, TEST_CONFIG, mod, standardWorld, unit, unitsOf } from "./learn-fixtures.mjs";
import * as LIVE_CONFIG from "../scripts/lib/learn-config.mjs";

const taxonomy = () => buildTaxonomy({ products: PRODUCTS, subjects: SUBJECTS }, TEST_CONFIG.customSubjects);

function transform(world = standardWorld(), config = TEST_CONFIG) {
  return transformModules({ apiModules: world.modules, apiUnits: world.units, taxonomy: taxonomy(), config });
}

test("buildTaxonomy resolves products/subjects and merges custom subjects without overriding official ones", () => {
  const t = buildTaxonomy({ products: PRODUCTS, subjects: [...SUBJECTS, { id: "education", name: "Official Education" }] }, { education: "Education", devops: "Hijack" });
  assert.equal(t.productNameById.get("azure-firewall"), "Azure Firewall");
  assert.equal(t.productTopIdById.get("azure-firewall"), "azure");
  assert.equal(t.subjectNameById.get("education"), "Official Education", "official wins");
  assert.equal(t.subjectNameById.get("devops"), "DevOps");
  const withCustom = buildTaxonomy({ products: PRODUCTS, subjects: SUBJECTS }, { education: "Education" });
  assert.equal(withCustom.subjectNameById.get("education"), "Education");
  assert.deepEqual(t.topLevelProductIds, PRODUCTS.map((p) => p.id));
});

test("transformModules: category filtering keeps allowlisted modules and sends the rest to outOfScope by path", () => {
  const built = transform();
  assert.deepEqual(built.records.map((r) => r.uid), ["$learn.become-contributor", "learn.azure.firewall-intro", "learn.azure.vm-basics", "learn.saas-foundations"]);
  assert.deepEqual(built.outOfScope, ["/training/modules/games"]);
  assert.equal(built.stats.apiTotal, 5);
  assert.equal(built.stats.inScope, 4);
  assert.equal(built.stats.outOfScope, 1);
  assert.deepEqual([...built.apiUids].sort(), ["$learn.become-contributor", "learn.azure.firewall-intro", "learn.azure.vm-basics", "learn.consumer.games", "learn.saas-foundations"]);
});

test("transformModules: records carry the legacy fields unchanged plus path, lastModified and unitSig", () => {
  const world = standardWorld();
  const rec = transform(world).records.find((r) => r.uid === "learn.azure.vm-basics");
  assert.equal(rec.title, "Module vm-basics");
  assert.equal(rec.url, "https://learn.microsoft.com/training/modules/vm-basics/?WT.mc_id=studentamb_165290", "legacy url form: no /en-us/, tracking id rewritten");
  assert.equal(rec.path, "/training/modules/vm-basics");
  assert.deepEqual(rec.categories, ["Azure"]);
  assert.deepEqual(rec.products, ["Azure Virtual Machines"]);
  assert.deepEqual(rec.subjects, ["DevOps"]);
  assert.deepEqual(rec.units, ["introduction", "summary"]);
  assert.equal(rec.lastModified, "2026-02-01T00:00:00+00:00");
  assert.match(rec.unitSig, /^[0-9a-f]{40}$/);
});

test("transformModules: product subject hints add subjects but never remove or override official ones", () => {
  const world = standardWorld();
  const fw = transform(world).records.find((r) => r.uid === "learn.azure.firewall-intro");
  assert.deepEqual(fw.subjects, ["Networking"], "hint adds Networking");
  const official = mod({ uid: "learn.azure.fw2", slug: "fw2", products: ["azure-firewall"], subjects: ["databases", "networking"] });
  const rec = transformModules({ apiModules: [official], apiUnits: unitsOf([official]), taxonomy: taxonomy(), config: TEST_CONFIG }).records[0];
  assert.deepEqual(rec.subjects, ["Databases", "Networking"], "official subjects preserved, hint not duplicated");
  const built = transformModules({ apiModules: [official], apiUnits: [], taxonomy: taxonomy(), config: TEST_CONFIG });
  assert.equal(built.stats.modulesWithHintedSubjects, 0, "the hint added nothing new, so it is not counted");
  const world2 = standardWorld();
  assert.equal(transform(world2).stats.modulesWithHintedSubjects, 1);
});

test("transformModules: unit titles fall back to the uid when the catalog does not list the unit, and the module is reported", () => {
  const m = mod({ uid: "learn.azure.fallback", slug: "fallback", unitSpecs: [["a", "A"], ["b", "B"]] });
  const built = transformModules({ apiModules: [m], apiUnits: [unit("learn.azure.fallback.a", "Title A")], taxonomy: taxonomy(), config: TEST_CONFIG });
  assert.deepEqual(built.records[0].units, ["Title A", "learn.azure.fallback.b"]);
  assert.equal(built.stats.missingUnitTitles, 1);
  assert.equal(built.stats.unitRefs, 2);
  assert.deepEqual(built.stats.fallbackModules, [{ uid: "learn.azure.fallback", unresolved: 1, total: 2 }]);
});

test("transformModules: modules are sorted by uid in plain code-point order (not locale order)", () => {
  const uids = ["learn.b", "learn.B", "learn.a", "learn._x", "$learn.z", "learn.Z"];
  const modules = uids.map((uid) => mod({ uid, slug: uid.replace(/[^a-z0-9]/gi, "-").toLowerCase() + Math.random().toString(36).slice(2, 6) }));
  const built = transformModules({ apiModules: modules, apiUnits: [], taxonomy: taxonomy(), config: TEST_CONFIG });
  assert.deepEqual(built.records.map((r) => r.uid), [...uids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(built.records[0].uid, "$learn.z");
  assert.ok(built.records.findIndex((r) => r.uid === "learn.B") < built.records.findIndex((r) => r.uid === "learn.a"), "uppercase sorts before lowercase, which localeCompare would not do");
});

test("transformModules: duplicate uids and unusable urls are API anomalies that abort", () => {
  const a = mod({ uid: "learn.dup", slug: "dup" });
  assert.throws(() => transformModules({ apiModules: [a, a], apiUnits: [], taxonomy: taxonomy(), config: TEST_CONFIG }), /more than once/);
  assert.throws(() => transformModules({ apiModules: [{ ...a, url: "https://example.com/x" }], apiUnits: [], taxonomy: taxonomy(), config: TEST_CONFIG }), /no usable Learn url/);
  assert.throws(() => transformModules({ apiModules: [{ ...a, url: undefined }], apiUnits: [], taxonomy: taxonomy(), config: TEST_CONFIG }), /no usable Learn url/);
});

test("transformModules: taxonomy drift = top-level product with modules in neither the allowlist nor the exclusion list", () => {
  const agent = mod({ uid: "learn.agents.x", slug: "agents-x", products: ["microsoft-agents"] });
  const built = transformModules({ apiModules: [agent, ...standardWorld().modules], apiUnits: [], taxonomy: taxonomy(), config: TEST_CONFIG });
  assert.deepEqual(built.stats.unusedCategoryIds, ["microsoft-agents"]);
  assert.equal(built.stats.categoryModuleCounts["microsoft-agents"], 1);
  assert.deepEqual(transform().stats.unusedCategoryIds, [], "consumer is explicitly excluded, so it is not drift");
  const gone = transformModules({ apiModules: [], apiUnits: [], taxonomy: taxonomy(), config: { ...TEST_CONFIG, allowedCategories: ["azure", "renamed-upstream"] } });
  assert.deepEqual(gone.stats.allowedMissingFromTaxonomy, ["renamed-upstream"]);
});

test("the live config: allowlist and exclusion list are disjoint and every excluded id is documented", () => {
  const allowed = new Set(LIVE_CONFIG.ALLOWED_CATEGORIES);
  assert.equal(allowed.size, LIVE_CONFIG.ALLOWED_CATEGORIES.length, "no duplicates in ALLOWED_CATEGORIES");
  for (const id of LIVE_CONFIG.EXCLUDED_CATEGORIES) assert.equal(allowed.has(id), false, `${id} is both allowed and excluded`);
  for (const id of LIVE_CONFIG.KNOWN_EMPTY_CATEGORIES) assert.equal(allowed.has(id), true, `${id} must be allowlisted to be known-empty`);
});

test("transformModules: a module in several products lands in every allowlisted category, sorted", () => {
  const multi = mod({ uid: "learn.multi", slug: "multi", products: ["github-actions", "azure-vm", "consumer"] });
  const rec = transformModules({ apiModules: [multi], apiUnits: [], taxonomy: taxonomy(), config: TEST_CONFIG }).records[0];
  assert.deepEqual(rec.categories, ["Azure", "GitHub"]);
  assert.deepEqual(rec.products, ["Azure Virtual Machines", "Consumer", "GitHub Actions"]);
});

test("computeUnitSig changes when the module date, a unit date, the unit order or the unit set changes", () => {
  const units = new Map([["u1", { last_modified: "d1" }], ["u2", { last_modified: "d2" }]]);
  const base = computeUnitSig("m1", ["u1", "u2"], units);
  assert.equal(base, computeUnitSig("m1", ["u1", "u2"], units), "deterministic");
  assert.notEqual(base, computeUnitSig("m2", ["u1", "u2"], units), "module last_modified");
  assert.notEqual(base, computeUnitSig("m1", ["u2", "u1"], units), "reorder");
  assert.notEqual(base, computeUnitSig("m1", ["u1"], units), "removed unit");
  assert.notEqual(base, computeUnitSig("m1", ["u1", "u2", "u3"], units), "added unit");
  const touched = new Map([["u1", { last_modified: "d1" }], ["u2", { last_modified: "d2b" }]]);
  assert.notEqual(base, computeUnitSig("m1", ["u1", "u2"], touched), "unit last_modified");
  assert.match(base, /^[0-9a-f]{40}$/);
});

test("transformModules: a unit edit changes the signature of exactly that module", () => {
  const world = standardWorld();
  const before = transform(world).records;
  const edited = { ...world, units: world.units.map((u) => (u.uid === "learn.azure.vm-basics.summary" ? { ...u, last_modified: "2027-01-01T00:00:00+00:00" } : u)) };
  const after = transform(edited).records;
  const changed = after.filter((r, i) => r.unitSig !== before[i].unitSig).map((r) => r.uid);
  assert.deepEqual(changed, ["learn.azure.vm-basics"]);
});

const NOW = "2026-10-05";

test("computeRemovals: a uid in the previous modules and absent from the WHOLE api response becomes a tombstone", () => {
  const previousModules = [
    { uid: "gone", path: "/training/modules/gone", title: "Gone" },
    { uid: "stays", path: "/training/modules/stays", title: "Stays" },
    { uid: "left-allowlist", path: "/training/modules/left", title: "Left" },
  ];
  const apiUids = new Set(["stays", "left-allowlist"]);
  const r = computeRemovals({ previousModules, previousRemoved: [], apiUids, today: NOW, previousSeenDate: "2026-09-28" });
  assert.deepEqual(r.removed, [{ uid: "gone", path: "/training/modules/gone", title: "Gone", lastSeen: "2026-09-28", removedOn: NOW }]);
  assert.equal(r.newlyRemoved, 1);
});

test("computeRemovals: a module that merely left the allowlist (still in the API) is NOT removed", () => {
  const r = computeRemovals({ previousModules: [{ uid: "x", path: "/training/modules/x", title: "X" }], previousRemoved: [], apiUids: new Set(["x"]), today: NOW });
  assert.deepEqual(r.removed, []);
});

test("computeRemovals: tombstones are carried forward untouched and dropped only when the uid returns", () => {
  const old = { uid: "old", path: "/training/modules/old", title: "Old", lastSeen: "2026-01-01", removedOn: "2026-02-01" };
  const back = { uid: "back", path: "/training/modules/back", title: "Back", lastSeen: "2026-01-01", removedOn: "2026-02-01" };
  const r = computeRemovals({ previousModules: [], previousRemoved: [old, back], apiUids: new Set(["back"]), today: NOW });
  assert.deepEqual(r.removed, [old], "dates are preserved, not reset to today");
  assert.equal(r.resurrected, 1);
  const again = computeRemovals({ previousModules: [], previousRemoved: r.removed, apiUids: new Set(), today: "2027-01-01" });
  assert.deepEqual(again.removed, [old]);
});

test("computeRemovals: output is sorted by uid in code-point order and tolerates garbage entries", () => {
  const r = computeRemovals({
    previousModules: [{ uid: "b", path: "/p/b", title: "B" }, { uid: "B", path: "/p/B", title: "B2" }, null, { path: "no-uid" }],
    previousRemoved: [{ uid: "a" }, null, { nouid: 1 }],
    apiUids: new Set(),
    today: NOW,
  });
  assert.deepEqual(r.removed.map((t) => t.uid), ["B", "a", "b"]);
  const a = r.removed.find((t) => t.uid === "a");
  assert.equal(a.path, null);
  assert.equal(a.title, null);
});

test("findRenamedPaths and findTombstonePathCollisions", () => {
  const previous = [{ uid: "m", path: "/training/modules/old-slug" }, { uid: "n", url: "https://learn.microsoft.com/training/modules/same/" }];
  const records = [{ uid: "m", path: "/training/modules/new-slug" }, { uid: "n", path: "/training/modules/same" }, { uid: "o", path: "/training/modules/o" }];
  assert.deepEqual(findRenamedPaths(previous, records), [{ uid: "m", from: "/training/modules/old-slug", to: "/training/modules/new-slug" }]);
  const tombs = [{ uid: "t", path: "/training/modules/o" }, { uid: "u", path: "/training/modules/nowhere" }];
  assert.deepEqual(findTombstonePathCollisions(tombs, records, ["/training/modules/zzz"]), [{ uid: "t", path: "/training/modules/o" }]);
});

function buildOutput(over = {}) {
  const world = standardWorld();
  const built = transform(world);
  const unitUrls = new Map(built.records.map((r) => [r.uid, r.units.map((_, i) => `${r.path}/${i + 1}-u${i}`)]));
  const modules = finalizeModules(built.records, unitUrls);
  return assembleCatalog({
    now: new Date("2026-10-05T10:00:00Z"),
    sourceApi: "x",
    categoryFilter: ["azure"],
    modules,
    totalApiModules: 5,
    unitUrlsRefreshedAt: "2026-10-05",
    removed: [],
    outOfScope: built.outOfScope,
    ...over,
  });
}

test("assembleCatalog/finalizeModules produce the contract shape and key order", () => {
  const out = buildOutput();
  assert.equal(out.schemaVersion, CATALOG_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(out), ["schemaVersion", "lastChecked", "sourceApi", "categoryFilter", "totalModules", "totalApiModules", "unitUrlsRefreshedAt", "modules", "removed", "outOfScope"]);
  assert.deepEqual(Object.keys(out.modules[0]), ["uid", "title", "url", "path", "categories", "products", "subjects", "units", "unitUrls", "lastModified", "unitSig"]);
  assert.equal(out.totalModules, 4);
  assert.deepEqual(validateCatalogOutput(out), []);
});

test("finalizeModules gives null (never an empty list) to modules without a hierarchy answer", () => {
  const built = transform();
  const modules = finalizeModules(built.records, new Map());
  assert.ok(modules.every((m) => m.unitUrls === null));
  assert.deepEqual(validateCatalogOutput(assembleCatalog({ now: new Date(), sourceApi: "x", categoryFilter: [], modules, totalApiModules: 5, unitUrlsRefreshedAt: null, removed: [], outOfScope: built.outOfScope })), []);
});

test("sameExceptTimestamp ignores lastChecked only", () => {
  const a = buildOutput();
  const b = buildOutput({ now: new Date("2027-01-01T00:00:00Z") });
  assert.equal(sameExceptTimestamp(a, b), true);
  assert.equal(sameExceptTimestamp(a, buildOutput({ unitUrlsRefreshedAt: "2026-11-05" })), false);
  assert.equal(sameExceptTimestamp(a, buildOutput({ removed: [{ uid: "z", path: "/training/modules/z", title: "z", lastSeen: null, removedOn: NOW }] })), false);
  assert.equal(sameExceptTimestamp(null, a), false);
  assert.equal(sameExceptTimestamp({ modules: [] }, a), false, "a schema v1 file is never equal to v2");
});

test("isModulePath accepts the standard shape and the three non-standard areas, but not paths/courses/other pages", () => {
  for (const ok of ["/training/modules/x", "/training/saas/saas-foundations", "/training/azure-databases/postgresql/basic-sql-join-tables", "/training/research/farmvibes"]) assert.equal(isModulePath(ok), true, ok);
  for (const bad of ["/training/modules", "/training/paths/x", "/training/courses/az-104t00", "/azure/x", "", null, "/training/x"]) assert.equal(isModulePath(bad), false, String(bad));
});

test("validateCatalogOutput catches every contract violation", () => {
  const clone = () => JSON.parse(JSON.stringify(buildOutput()));
  const cases = [
    ["schemaVersion", (o) => void (o.schemaVersion = 1), /schemaVersion/],
    ["totalModules", (o) => void (o.totalModules = 99), /totalModules/],
    ["unsorted", (o) => void o.modules.reverse(), /not sorted/],
    ["duplicate uid", (o) => void o.modules.push(o.modules[0]), /sorted by uid|duplicate/],
    ["sig", (o) => void (o.modules[0].unitSig = "zz"), /unitSig/],
    ["path", (o) => void (o.modules[0].path = "/Training/Modules/X/"), /canonical module path/],
    ["unitUrls length", (o) => void o.modules[0].unitUrls.pop(), /unitUrls but/],
    ["unitUrls dup", (o) => void (o.modules[0].unitUrls[1] = o.modules[0].unitUrls[0]), /duplicate unitUrls/],
    ["unitUrls outside", (o) => void (o.modules[0].unitUrls[0] = "/training/modules/other/1-x"), /not canonical or not under/],
    ["unitUrls type", (o) => void (o.modules[0].unitUrls = "x"), /neither null nor an array/],
    ["unitUrls empty guess", (o) => void (o.modules[0].unitUrls = []), /unitUrls but/],
    ["tombstone date", (o) => void o.removed.push({ uid: "z", path: "/training/modules/z", title: "z", lastSeen: null, removedOn: "yesterday" }), /bad removedOn/],
    ["tombstone live", (o) => void o.removed.push({ uid: o.modules[0].uid, path: "/training/modules/q", title: "q", lastSeen: null, removedOn: NOW }), /also a live module/],
    ["outOfScope unsorted", (o) => void (o.outOfScope = ["/training/modules/b", "/training/modules/a"]), /outOfScope is not sorted/],
    ["outOfScope overlap", (o) => void o.outOfScope.push(o.modules[0].path), /also an in-scope module/],
    ["refreshed date", (o) => void (o.unitUrlsRefreshedAt = "soon"), /unitUrlsRefreshedAt/],
    ["flag with urls", (o) => void (o.modules[0].hierarchyNotFound = true), /hierarchyNotFound must be true/],
    ["flag false", (o) => void ((o.modules[0].unitUrls = null), (o.modules[0].hierarchyNotFound = false)), /hierarchyNotFound must be true/],
  ];
  for (const [name, mutate, expected] of cases) {
    const out = clone();
    mutate(out);
    const problems = validateCatalogOutput(out);
    assert.ok(problems.length > 0, `${name}: no problem reported`);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: expected ${expected}, got ${problems.join(" | ")}`);
  }
  assert.deepEqual(validateCatalogOutput(clone()), []);
  assert.deepEqual(validateCatalogOutput(null), ["output is not an object"]);
});

test("finalizeModules emits hierarchyNotFound only for flagged modules whose unitUrls are null", () => {
  const built = transform();
  const [first, second] = built.records;
  const modules = finalizeModules(built.records, new Map([[second.uid, ["x"]]]), new Set([first.uid, second.uid]));
  assert.equal(modules[0].hierarchyNotFound, true);
  assert.deepEqual(Object.keys(modules[0]).slice(-2), ["unitSig", "hierarchyNotFound"]);
  assert.equal("hierarchyNotFound" in modules[1], false, "the module has urls, so it cannot be flagged");
  assert.equal("hierarchyNotFound" in modules[2], false);
});
