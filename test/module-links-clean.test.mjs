import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanRecords, probeLink } from "../scripts/lib/module-links-clean.mjs";

const noSleep = async () => {};
const link = (path, extra = {}) => ({ kind: "docs", path, text: "t", section: "Learn more", ...extra });
const record = (slug, links) => ({ path: `/training/modules/${slug}`, unitSig: "s", unit: "u", links });
const validate = (verdicts) => (paths) => new Map(paths.map((p) => [p, verdicts[p] ?? { path: p, verdict: "unverifiable" }]));

const common = { today: "2026-10-16", maxProbes: 1000, recheckDays: 30, delayMs: 0, sleepImpl: noSleep };

test("cleanRecords splits the targets into settled by the caches, recently confirmed, probed and waiting", async () => {
  const records = [record("a", [link("/azure/ok"), link("/azure/fresh", { checked: "2026-10-10" }), link("/azure/p1"), link("/azure/p2"), link("/azure/p3")])];
  const probed = [];
  const result = await cleanRecords({
    ...common,
    records,
    maxProbes: 2,
    validate: validate({ "/azure/ok": { path: "/azure/ok", verdict: "valid" } }),
    probeImpl: async (path) => {
      probed.push(path);
      return { verdict: "ok" };
    },
  });
  assert.deepEqual(probed, ["/azure/p1", "/azure/p2"]);
  assert.deepEqual(result.stats, {
    targets: 5,
    settledByCaches: 1,
    fresh: 1,
    probed: 2,
    probeUnknown: 0,
    probeDropped: 0,
    waiting: 1,
    links: { kept: 4, rewritten: 0, dropped: 0, unverified: 1 },
    rewrittenPaths: 0,
    droppedPaths: 0,
  });
  assert.equal(result.broke, false);
  const byPath = Object.fromEntries(result.records[0].links.map((l) => [l.path, l]));
  assert.equal(byPath["/azure/ok"].checked, undefined);
  assert.equal(byPath["/azure/fresh"].checked, "2026-10-10");
  assert.equal(byPath["/azure/p1"].checked, "2026-10-16");
  assert.equal(byPath["/azure/p3"].unverified, true);
});

test("cleanRecords stops probing a dead site after the breaker minimum and marks the rest unverified", async () => {
  const records = [record("a", Array.from({ length: 80 }, (_, i) => link(`/azure/p${String(i).padStart(2, "0")}`)))];
  let calls = 0;
  const result = await cleanRecords({
    ...common,
    records,
    validate: validate({}),
    probeImpl: async () => {
      calls++;
      return { verdict: "unknown" };
    },
  });
  assert.equal(calls, 50, "one chunk");
  assert.equal(result.broke, true);
  assert.equal(result.stats.probed, 50);
  assert.equal(result.stats.probeUnknown, 50);
  assert.equal(result.stats.links.unverified, 80);
});

test("cleanRecords does nothing for records without Learn links", async () => {
  const records = [record("a", [{ kind: "external", url: "https://x.y/", text: "x", section: "s" }]), record("b", [])];
  const result = await cleanRecords({ ...common, records, validate: validate({}), probeImpl: async () => assert.fail("no probe expected") });
  assert.deepEqual(result.records, records);
  assert.equal(result.stats.targets, 0);
});

/** A fake fetch for rawProbe: url -> { status, location?, body? }. */
function fakeWeb(map) {
  return async (url) => {
    const hit = map[url.replace(/\/$/, "").replace("https://learn.microsoft.com/en-us", "")] ?? map[url];
    if (!hit) return new Response("", { status: 404 });
    const headers = hit.location ? { location: hit.location } : {};
    return new Response(hit.body ?? "", { status: hit.status, headers });
  };
}
const opts = (map) => ({ retries: 1, fetchImpl: fakeWeb(map), sleepImpl: noSleep });

test("probeLink: a page Learn redirects to a marketing site is gone, a Learn move is a move, a live page is ok", async () => {
  const web = {
    "/azure/removed": { status: 301, location: "/en-us/azure/other" },
    "/azure/other": { status: 301, location: "https://azure.microsoft.com/updates/x" },
    "/azure/moved": { status: 301, location: "/en-us/azure/new/moved" },
    "/azure/new/moved": { status: 200, body: "<title>Moved - Learn</title>" },
    "/azure/live": { status: 200, body: "<title>Live</title>" },
    "/azure/down": { status: 404 },
  };
  assert.deepEqual(await probeLink("/azure/removed", opts(web)), { verdict: "broken", detail: "redirects off Learn to azure.microsoft.com", redirectsTo: null });
  assert.deepEqual(await probeLink("/azure/moved", opts(web)), { verdict: "moved", detail: "redirects to /azure/new/moved", redirectsTo: "/azure/new/moved" });
  assert.deepEqual(await probeLink("/azure/live", opts(web)), { verdict: "ok", detail: "", redirectsTo: null });
  assert.equal((await probeLink("/azure/down", opts(web))).verdict, "broken");
  const failing = async () => {
    throw new Error("network down");
  };
  assert.equal((await probeLink("/azure/live", { retries: 1, fetchImpl: failing, sleepImpl: noSleep })).verdict, "unknown");
});
