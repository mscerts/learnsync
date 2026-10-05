import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyHierarchy,
  hierarchyUrl,
  isModuleIdNotFound,
  parseHierarchy,
  planUnitRefresh,
  refreshReason,
  resolveUnitUrls,
} from "../scripts/lib/learn-hierarchy.mjs";

const MODULE = "/training/modules/foundry-sdk";
const UIDS = ["m.intro", "m.exercise", "m.summary"];
const body = (urls, uids = UIDS) => ({ units: urls.map((url, i) => ({ uid: uids[i], url })) });
const GOOD = [`${MODULE}/1-intro/`, `${MODULE}/3-exercise/`, `${MODULE}/4-summary/`];

test("hierarchyUrl percent-encodes the uid, including a leading $", () => {
  assert.equal(
    hierarchyUrl("$learn.become-learn-contributor"),
    "https://learn.microsoft.com/api/hierarchy/modules/%24learn.become-learn-contributor?locale=en-us"
  );
  assert.equal(hierarchyUrl("learn.wwl.x"), "https://learn.microsoft.com/api/hierarchy/modules/learn.wwl.x?locale=en-us");
  assert.equal(hierarchyUrl("a b/c"), "https://learn.microsoft.com/api/hierarchy/modules/a%20b%2Fc?locale=en-us");
});

test("parseHierarchy keeps the REAL unit urls, canonicalised, including skipped numbers", () => {
  const parsed = parseHierarchy(body(GOOD), { modulePath: MODULE, catalogUnitUids: UIDS });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.unitUrls, [`${MODULE}/1-intro`, `${MODULE}/3-exercise`, `${MODULE}/4-summary`]);
});

test("parseHierarchy rejects anything that is not a clean 1:1 answer instead of guessing", () => {
  const ctx = { modulePath: MODULE, catalogUnitUids: UIDS };
  assert.equal(parseHierarchy(null, ctx).kind, "bad-shape");
  assert.equal(parseHierarchy({}, ctx).kind, "bad-shape");
  assert.equal(parseHierarchy({ units: "x" }, ctx).kind, "bad-shape");
  assert.equal(parseHierarchy(body([`${MODULE}/1-intro/`, "/training/modules/other/1-x/", `${MODULE}/4-summary/`]), ctx).kind, "bad-shape", "unit of another module");
  assert.equal(parseHierarchy(body([`${MODULE}/`, `${MODULE}/3-exercise/`, `${MODULE}/4-summary/`]), ctx).kind, "bad-shape", "the module page itself is not a unit");
  assert.equal(parseHierarchy(body([`${MODULE}/1-intro/`, `${MODULE}/1-intro/`, `${MODULE}/4-summary/`]), ctx).kind, "bad-shape", "duplicate urls");
  assert.equal(parseHierarchy(body(GOOD.slice(0, 2), UIDS.slice(0, 2)), ctx).kind, "misaligned", "fewer units than the catalog");
  assert.equal(parseHierarchy(body(GOOD, ["m.intro", "m.other", "m.summary"]), ctx).kind, "misaligned", "different uid");
  assert.equal(parseHierarchy({ units: [{ uid: "m.intro" }] }, { modulePath: MODULE, catalogUnitUids: ["m.intro"] }).kind, "bad-shape", "unit without url");
});

test("parseHierarchy accepts a module without units (empty array on both sides)", () => {
  assert.deepEqual(parseHierarchy({ units: [] }, { modulePath: MODULE, catalogUnitUids: [] }), { ok: true, unitUrls: [] });
});

test("classifyHierarchy maps request outcomes", () => {
  const ctx = { modulePath: MODULE, catalogUnitUids: UIDS };
  assert.equal(classifyHierarchy({ outcome: "ok", body: body(GOOD) }, ctx).ok, true);
  assert.equal(classifyHierarchy({ outcome: "notFound", status: 404, errorBody: '{"ErrorCode":"module_id_not_found","Retriable":false}' }, ctx).kind, "not-found");
  assert.equal(classifyHierarchy({ outcome: "notFound", status: 404, errorBody: "<html>Not found</html>" }, ctx).kind, "http-error", "a bare/CDN 404 is not the API's definitive answer");
  assert.equal(classifyHierarchy({ outcome: "notFound", status: 404, errorBody: null }, ctx).kind, "http-error");
  assert.equal(classifyHierarchy({ outcome: "notFound", status: 404, errorBody: '{"ErrorCode":"other"}' }, ctx).kind, "http-error");
  assert.equal(classifyHierarchy({ outcome: "transient", error: "timeout" }, ctx).kind, "transient");
  assert.equal(classifyHierarchy({ outcome: "error", error: "HTTP 403", status: 403 }, ctx).kind, "http-error");
});

const record = (over = {}) => ({ uid: "m", path: MODULE, units: ["a", "b", "c"], unitSig: "sig1", ...over });
const previous = (over = {}) => ({ uid: "m", unitSig: "sig1", unitUrls: [`${MODULE}/1-a`, `${MODULE}/2-b`, `${MODULE}/3-c`], ...over });

test("refreshReason: reusable only when everything still checks out", () => {
  assert.equal(refreshReason(previous(), record(), null), null);
  assert.equal(refreshReason(undefined, record(), null), "new");
  assert.equal(refreshReason(previous({ unitUrls: null }), record(), null), "no-unit-urls");
  assert.equal(refreshReason(previous(), record({ unitSig: "sig2" }), null), "sig-changed");
  assert.equal(refreshReason(previous({ unitUrls: [`${MODULE}/1-a`] }), record(), null), "inconsistent", "count differs from units");
  assert.equal(refreshReason(previous({ unitUrls: [`${MODULE}/1-a`, "/training/modules/zzz/2-b", `${MODULE}/3-c`] }), record(), null), "inconsistent", "url outside the module");
  assert.equal(refreshReason(previous(), record(), `${MODULE}/9-other`), "first-unit-moved", "catalog firstUnitUrl disagrees with the stored first unit");
  assert.equal(refreshReason(previous(), record(), `${MODULE}/1-a`), null);
});

test("planUnitRefresh: incremental fetches only what changed; a full refresh fetches everything", () => {
  const records = [record({ uid: "a", path: "/training/modules/a" }), record({ uid: "b", path: "/training/modules/b", unitSig: "new" }), record({ uid: "c", path: "/training/modules/c" })];
  const previousByUid = new Map([
    ["a", previous({ uid: "a", unitUrls: ["/training/modules/a/1-a", "/training/modules/a/2-b", "/training/modules/a/3-c"] })],
    ["b", previous({ uid: "b", unitUrls: ["/training/modules/b/1-a", "/training/modules/b/2-b", "/training/modules/b/3-c"] })],
  ]);
  const meta = new Map();
  const inc = planUnitRefresh({ records, meta, previousByUid, fullRefresh: false });
  assert.deepEqual(inc.fetchUids, ["b", "c"]);
  assert.deepEqual(inc.reuseUids, ["a"]);
  assert.deepEqual(inc.reasons, { "sig-changed": 1, new: 1 });
  const full = planUnitRefresh({ records, meta, previousByUid, fullRefresh: true });
  assert.deepEqual(full.fetchUids, ["a", "b", "c"]);
  assert.deepEqual(full.reasons, { full: 3 });
});

test("resolveUnitUrls: reuse, fresh values, same-signature carry-forward on failure, null otherwise (never an empty guess)", () => {
  const records = [
    record({ uid: "reuse", path: "/training/modules/reuse" }),
    record({ uid: "ok", path: "/training/modules/ok", unitSig: "n" }),
    record({ uid: "failSame", path: "/training/modules/failSame" }),
    record({ uid: "failChanged", path: "/training/modules/failChanged", unitSig: "n" }),
    record({ uid: "failNew", path: "/training/modules/failNew" }),
  ];
  const mk = (uid, sig = "sig1") => previous({ uid, unitSig: sig, unitUrls: [`/training/modules/${uid}/1-a`, `/training/modules/${uid}/2-b`, `/training/modules/${uid}/3-c`] });
  const previousByUid = new Map([["reuse", mk("reuse")], ["ok", mk("ok", "old")], ["failSame", mk("failSame")], ["failChanged", mk("failChanged", "old")]]);
  const meta = new Map();
  const plan = { fetchUids: ["ok", "failSame", "failChanged", "failNew"], reuseUids: ["reuse"], reasons: {} };
  const fetchResults = new Map([
    ["ok", { ok: true, unitUrls: ["/training/modules/ok/1-x", "/training/modules/ok/2-y", "/training/modules/ok/3-z"] }],
    ["failSame", { ok: false, kind: "transient", reason: "timeout" }],
    ["failChanged", { ok: false, kind: "transient", reason: "timeout" }],
    ["failNew", { ok: false, kind: "not-found", reason: "HTTP 404" }],
  ]);
  const { unitUrlsByUid, stats } = resolveUnitUrls({ records, meta, previousByUid, plan, fetchResults });
  assert.deepEqual(unitUrlsByUid.get("reuse"), mk("reuse").unitUrls);
  assert.deepEqual(unitUrlsByUid.get("ok"), ["/training/modules/ok/1-x", "/training/modules/ok/2-y", "/training/modules/ok/3-z"]);
  assert.deepEqual(unitUrlsByUid.get("failSame"), mk("failSame").unitUrls, "same signature: previous value is still trustworthy");
  assert.equal(unitUrlsByUid.get("failChanged"), null, "signature changed: the old urls may be wrong");
  assert.equal(unitUrlsByUid.get("failNew"), null);
  assert.equal(stats.requests, 4);
  assert.equal(stats.reused, 1);
  assert.equal(stats.fetchedOk, 1);
  assert.equal(stats.failures, 3);
  assert.equal(stats.carriedForward, 1);
  assert.equal(stats.nulls, 2);
  assert.deepEqual(stats.failureKinds, { transient: 2, "not-found": 1 });
  assert.equal(stats.failureSamples.length, 3);
});

test("resolveUnitUrls treats a missing result as a failure, not as success", () => {
  const records = [record({ uid: "x", path: "/training/modules/x" })];
  const { unitUrlsByUid, stats } = resolveUnitUrls({ records, meta: new Map(), previousByUid: new Map(), plan: { fetchUids: ["x"], reuseUids: [] }, fetchResults: new Map() });
  assert.equal(unitUrlsByUid.get("x"), null);
  assert.equal(stats.failureKinds["missing-result"], 1);
});

test("isModuleIdNotFound recognises only the hierarchy API's own error body", () => {
  assert.equal(isModuleIdNotFound('{"ErrorCode":"module_id_not_found","ErrorMessage":"x","Retriable":false}'), true);
  for (const bad of ['{"ErrorCode":"throttled"}', "not json", "", null, undefined, "[]", "null"]) assert.equal(isModuleIdNotFound(bad), false, String(bad));
});

test("resolveUnitUrls flags definitive not-found modules; a transient failure keeps a previous flag; a success or other answer clears it", () => {
  const records = [
    record({ uid: "ghost", path: "/training/modules/ghost" }),
    record({ uid: "ghostTransient", path: "/training/modules/ghostTransient" }),
    record({ uid: "healed", path: "/training/modules/healed" }),
    record({ uid: "plainTransient", path: "/training/modules/plainTransient" }),
  ];
  const flagged = (uid) => ({ uid, unitSig: "sig1", unitUrls: null, hierarchyNotFound: true });
  const previousByUid = new Map([["ghostTransient", flagged("ghostTransient")], ["healed", flagged("healed")], ["ghost", flagged("ghost")]]);
  const plan = { fetchUids: ["ghost", "ghostTransient", "healed", "plainTransient"], reuseUids: [] };
  const fetchResults = new Map([
    ["ghost", { ok: false, kind: "not-found", reason: "x" }],
    ["ghostTransient", { ok: false, kind: "transient", reason: "timeout" }],
    ["healed", { ok: true, unitUrls: ["/training/modules/healed/1-a", "/training/modules/healed/2-b", "/training/modules/healed/3-c"] }],
    ["plainTransient", { ok: false, kind: "transient", reason: "timeout" }],
  ]);
  const { notFoundUids, unitUrlsByUid, stats } = resolveUnitUrls({ records, meta: new Map(), previousByUid, plan, fetchResults });
  assert.deepEqual([...notFoundUids].sort(), ["ghost", "ghostTransient"]);
  assert.equal(stats.notFound, 2);
  assert.equal(unitUrlsByUid.get("ghost"), null);
  assert.equal(unitUrlsByUid.get("healed").length, 3);
});
