import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, reconcile } from "../scripts/lib/docs-reconcile.mjs";

const TODAY = "2026-10-05";
const ORIGIN = "https://learn.microsoft.com";

const row = (path, lastmod = "2026-09-20", cls = "learn", url = `${ORIGIN}${path}`) => ({ url, path, lastmod, family: "f", cls });
const rowsMap = (...rows) => new Map(rows.map((r) => [r.path, r]));
const rec = (path, extra = {}) => ({
  title: `Title ${path}`,
  url: `${ORIGIN}${path}`,
  product: "svc",
  subproduct: null,
  description: "desc",
  lastmod: "2026-09-20",
  checked: "2026-09-25",
  ...extra,
});
const idx = (...paths) => new Map(paths.map((p) => [p, "2026-09-20"]));
const quarantined = (path, extra = {}) => ({ ...rec(path), status: 404, firstDetected: "2026-09-01", lastChecked: "2026-09-10", ...extra });

// probe results as docs-phases.mjs produces them
const LIVE = { outcome: "live", status: 200 };
const GONE = { outcome: "gone", status: 404 };
const TRANSIENT = { outcome: "transient", status: 429 };
const moved = (to, kind = "moved", status = 301) => ({ outcome: "moved", status, to, kind });
const page = (title, extra = "") => ({
  outcome: "live",
  status: 200,
  text: `<html><head><title>${title} | Microsoft Learn</title><meta name="description" content="About ${title}"><meta name="ms.service" content="svc-new">${extra}</head><body></body></html>`,
});

function setup({ rows = [], catalog = [], previousIndex = new Map(), invalid = [], ledger = [], caps = {}, sitemapOk = true, git = undefined } = {}) {
  const p = plan({
    today: TODAY,
    caps: { verifyPerRun: 0, maxMissingChecks: 100, ...caps },
    previousIndex,
    catalog,
    invalid,
    ledger,
    rows: rowsMap(...rows),
    sitemapOk,
  });
  return {
    p,
    run: (results = {}, extra = {}) => reconcile({ plan: p, results, previousIndex, sitemapFailures: sitemapOk ? 0 : 1, ...(git ? { gitRecords: git } : {}), ...extra }),
  };
}

const byUrl = (catalog) => Object.fromEntries(catalog.map((r) => [r.url, r]));

// ---- page fetches ----------------------------------------------------------------------

test("fetch: a new page that is live gets a full record (checked today, lastmod from the sitemap) and counts as indexed", () => {
  const { run } = setup({ rows: [row("/azure/new", "2026-10-01")] });
  const out = run({ fetch: [page("New thing")] });
  assert.deepEqual(out.catalog, [
    { title: "New thing", url: `${ORIGIN}/azure/new`, product: "svc-new", subproduct: null, description: "About New thing", lastmod: "2026-10-01", checked: TODAY },
  ]);
  assert.equal(out.index.get("/azure/new"), "2026-10-01");
  assert.equal(out.status.pendingNew, 0);
  assert.equal(out.stats.fetched, 1);
});

test("fetch: a changed page that is live replaces its record", () => {
  const { run } = setup({ rows: [row("/azure/a", "2026-10-01")], catalog: [rec("/azure/a", { lastmod: "2026-08-01", title: "Old" })] });
  const out = run({ fetch: [page("Fresh title")] });
  assert.equal(out.catalog.length, 1);
  assert.equal(out.catalog[0].title, "Fresh title");
  assert.equal(out.catalog[0].lastmod, "2026-10-01");
  assert.equal(out.catalog[0].checked, TODAY);
});

test("fetch: a changed page that is now 404 is quarantined (and leaves the index and the catalog)", () => {
  const { run } = setup({ rows: [row("/azure/a", "2026-10-01")], catalog: [rec("/azure/a", { lastmod: "2026-08-01" })], previousIndex: idx("/azure/a") });
  const out = run({ fetch: [GONE] });
  assert.deepEqual(out.catalog, []);
  assert.equal(out.index.has("/azure/a"), false, "a probe-confirmed 404 beats a stale sitemap row");
  assert.equal(out.newlyQuarantined.length, 1);
  assert.deepEqual(
    { status: out.invalid[0].status, firstDetected: out.invalid[0].firstDetected, lastChecked: out.invalid[0].lastChecked, url: out.invalid[0].url },
    { status: 404, firstDetected: TODAY, lastChecked: TODAY, url: `${ORIGIN}/azure/a` }
  );
  assert.equal("lastmod" in out.invalid[0], false, "quarantine records carry no catalog-only fields");
  assert.equal("checked" in out.invalid[0], false);
});

test("fetch: a brand-new sitemap URL that 404s is sitemap lag, not a removal", () => {
  const { run } = setup({ rows: [row("/azure/lag")] });
  const out = run({ fetch: [GONE] });
  assert.equal(out.newlyQuarantined.length, 0);
  assert.equal(out.invalid.length, 0);
  assert.equal(out.catalog.length, 0);
  assert.equal(out.stats.newNotFound, 1);
  assert.equal(out.status.pendingNew, 1, "it stays a pending page: still listed, still no record");
  assert.equal(out.index.has("/azure/lag"), true);
});

test("fetch: a redirect goes to the ledger with its kind and status, and the record is dropped", () => {
  const { run } = setup({ rows: [row("/azure/old/page", "2026-10-01")], catalog: [rec("/azure/old/page", { lastmod: "2026-08-01" })] });
  const out = run({ fetch: [moved("/azure/old", "landing", 302)] });
  assert.deepEqual(out.catalog, []);
  assert.deepEqual(out.ledger, [{ from: "/azure/old/page", to: "/azure/old", kind: "landing", status: 302, firstSeen: TODAY, lastSeen: TODAY }]);
  assert.equal(out.stats.movedOnFetch, 1);
  assert.equal(out.newlyQuarantined.length, 0, "a redirect is never a quarantine");
});

test("fetch: a transient failure keeps the old record (old lastmod, so it re-queues) and counts as deferred", () => {
  const { run } = setup({ rows: [row("/azure/a", "2026-10-01")], catalog: [rec("/azure/a", { lastmod: "2026-08-01", title: "Old" })] });
  const out = run({ fetch: [TRANSIENT] });
  assert.equal(out.catalog[0].title, "Old");
  assert.equal(out.catalog[0].lastmod, "2026-08-01");
  assert.equal(out.status.deferredChanged, 1);
  assert.equal(out.status.complete, false);
});

test("fetch: items that never ran (deadline or breaker) are treated exactly like deferrals", () => {
  const { run } = setup({ rows: [row("/azure/a", "2026-10-01"), row("/azure/n")], catalog: [rec("/azure/a", { lastmod: "2026-08-01" })] });
  const out = run({ fetch: [undefined, undefined] });
  assert.equal(out.catalog.length, 1);
  assert.equal(out.catalog[0].lastmod, "2026-08-01");
  assert.equal(out.status.deferredChanged, 1);
  assert.equal(out.status.pendingNew, 1);
  assert.equal(out.status.complete, false);
});

test("fetch: a 200 with an empty body is unusable and treated as transient", () => {
  const { run } = setup({ rows: [row("/azure/a", "2026-10-01")], catalog: [rec("/azure/a", { lastmod: "2026-08-01", title: "Old" })] });
  const out = run({ fetch: [{ outcome: "live", status: 200, text: "" }] });
  assert.equal(out.catalog[0].title, "Old");
  assert.equal(out.stats.fetchTransient, 1);
  assert.equal(out.status.deferredChanged, 1);
});

test("fetch: noindex pages get no record", () => {
  const { run } = setup({ rows: [row("/azure/a", "2026-10-01")], catalog: [rec("/azure/a", { lastmod: "2026-08-01" })] });
  const out = run({ fetch: [page("Hidden", '<meta name="robots" content="noindex">')] });
  assert.deepEqual(out.catalog, []);
  assert.equal(out.stats.noindex, 1);
});

test("fetch: a page whose <title> is only the site suffix: new -> dropped, changed -> keeps its good record", () => {
  const empty = { outcome: "live", status: 200, text: "<html><head><title> | Microsoft Learn</title></head></html>" };
  const a = setup({ rows: [row("/azure/n")] }).run({ fetch: [empty] });
  assert.deepEqual(a.catalog, []);
  assert.equal(a.stats.untitledDropped, 1);
  const b = setup({ rows: [row("/azure/c", "2026-10-01")], catalog: [rec("/azure/c", { lastmod: "2026-08-01", title: "Good" })] }).run({ fetch: [empty] });
  assert.equal(b.catalog[0].title, "Good");
  assert.equal(b.stats.fetchKeptOnNoTitle, 1);
  assert.equal(b.status.deferredChanged, 1);
  // an already-untitled record that is still untitled is dropped (and the count is reported)
  const c = setup({ rows: [row("/azure/u")], catalog: [rec("/azure/u", { title: "", lastmod: "2026-09-20" })] }).run({ fetch: [empty] });
  assert.deepEqual(c.catalog, []);
  assert.equal(c.stats.untitledAfter, 0);
});

test("fetch: an untitled record is repaired when the page now has a title", () => {
  const { run } = setup({ rows: [row("/azure/u")], catalog: [rec("/azure/u", { title: "", lastmod: "2026-09-20" })] });
  const out = run({ fetch: [page("Repaired")] });
  assert.equal(out.catalog[0].title, "Repaired");
  assert.equal(out.stats.untitledAfter, 0);
});

// ---- verification pass ------------------------------------------------------------------

test("verify: live -> checked today; gone -> quarantined; moved -> ledger + record dropped; transient -> untouched", () => {
  const paths = ["/azure/v-live", "/azure/v-gone", "/azure/v-moved", "/azure/v-transient", "/azure/v-skipped"];
  const { p, run } = setup({
    rows: paths.map((x) => row(x)),
    catalog: paths.map((x, i) => rec(x, { checked: `2026-08-0${i + 1}` })),
    previousIndex: idx(...paths),
    caps: { verifyPerRun: 99 },
  });
  assert.deepEqual(p.verify.items.map((i) => i.path), paths, "oldest-checked first");
  const out = run({ verify: [LIVE, GONE, moved("/azure/elsewhere"), TRANSIENT, undefined] });
  const catalog = byUrl(out.catalog);
  assert.equal(catalog[`${ORIGIN}/azure/v-live`].checked, TODAY);
  assert.equal(`${ORIGIN}/azure/v-gone` in catalog, false);
  assert.equal(`${ORIGIN}/azure/v-moved` in catalog, false);
  assert.equal(catalog[`${ORIGIN}/azure/v-transient`].checked, "2026-08-04", "a transient failure changes nothing");
  assert.equal(catalog[`${ORIGIN}/azure/v-skipped`].checked, "2026-08-05");
  assert.deepEqual(out.invalid.map((q) => q.url), [`${ORIGIN}/azure/v-gone`]);
  assert.equal(out.index.has("/azure/v-gone"), false);
  assert.equal(out.index.has("/azure/v-moved"), true, "the sitemap still lists it");
  assert.deepEqual(out.ledger.map((e) => [e.from, e.to, e.kind]), [["/azure/v-moved", "/azure/elsewhere", "moved"]]);
  assert.equal(out.stats.verified, 1);
  assert.equal(out.stats.verifyDeferred, 1);
  assert.equal(out.stats.verifyTransient, 1);
});

// ---- fell out of the sitemaps -------------------------------------------------------------

test("missing: live stays in the index with its previous lastmod; gone -> quarantine; moved -> ledger; transient -> carried", () => {
  const paths = ["/azure/m-live", "/azure/m-gone", "/azure/m-moved", "/azure/m-transient", "/azure/m-skipped"];
  const catalog = paths.map((x, i) => rec(x, { lastmod: `2026-09-1${i}`, checked: `2026-07-0${i + 1}` }));
  const { p, run } = setup({ catalog, previousIndex: new Map(paths.map((x, i) => [x, `2026-09-1${i}`])) });
  assert.deepEqual(p.missing.items.map((i) => i.path), paths, "oldest-checked first");
  const out = run({ missing: [LIVE, GONE, moved("/azure/new-home"), TRANSIENT, undefined] });

  assert.equal(out.index.get("/azure/m-live"), "2026-09-10", "a live page missing from the sitemaps keeps its previous lastmod in the index");
  assert.equal(byUrl(out.catalog)[`${ORIGIN}/azure/m-live`].checked, TODAY);
  assert.equal(out.index.has("/azure/m-gone"), false);
  assert.equal(out.index.has("/azure/m-moved"), false);
  assert.deepEqual(out.invalid.map((q) => [q.url, q.status]), [[`${ORIGIN}/azure/m-gone`, 404]]);
  assert.deepEqual(out.ledger.map((e) => e.from), ["/azure/m-moved"]);
  assert.equal(out.index.get("/azure/m-transient"), "2026-09-13", "carried, retried next run");
  assert.equal(out.index.get("/azure/m-skipped"), "2026-09-14");
  assert.equal(`${ORIGIN}/azure/m-transient` in byUrl(out.catalog), true);
  assert.equal(`${ORIGIN}/azure/m-gone` in byUrl(out.catalog), false);
  assert.equal(`${ORIGIN}/azure/m-moved` in byUrl(out.catalog), false);
  assert.equal(out.status.deferredMissing, 2);
  assert.equal(out.status.complete, false);
  assert.equal(out.stats.missingLive, 1);
  assert.equal(out.stats.quarantinedOnMissing, 1);
  assert.equal(out.stats.missingMoved, 1);
});

test("missing: URLs beyond the cap are carried and counted as deferrals", () => {
  const paths = ["/azure/a", "/azure/b", "/azure/c", "/azure/d"];
  const { p, run } = setup({ catalog: paths.map((x) => rec(x)), previousIndex: idx(...paths), caps: { maxMissingChecks: 2 } });
  assert.equal(p.missing.items.length, 2);
  assert.equal(p.missing.deferred.length, 2);
  const out = run({ missing: [LIVE, LIVE] });
  assert.equal(out.index.size, 4, "deferred paths stay in the index until probed");
  assert.equal(out.status.deferredMissing, 2);
  assert.equal(out.catalog.length, 4);
});

test("missing: an index-only path that is gone is quarantined as a stub, and a live one stays", () => {
  const { p, run } = setup({ previousIndex: idx("/cli/azure/old", "/cli/azure/fine") });
  // path-only candidates rotate by a daily hash, so answer per item rather than by position
  const out = run({ missing: p.missing.items.map((i) => (i.path === "/cli/azure/old" ? GONE : LIVE)) });
  assert.deepEqual(out.index.has("/cli/azure/old"), false);
  assert.equal(out.index.has("/cli/azure/fine"), true);
  assert.equal(out.invalid.length, 1);
  assert.equal(out.invalid[0].url, `${ORIGIN}/cli/azure/old`);
  assert.equal(out.invalid[0].title, null);
  assert.equal(out.invalid[0].status, 404);
  assert.equal(out.catalog.length, 0, "index-only paths never get a metadata record");
});

test("sitemap failure: removal detection is off, everything is carried, the index is not written", () => {
  const previousIndex = idx("/azure/a", "/azure/b", "/azure/c");
  const { p, run } = setup({ rows: [row("/azure/a")], catalog: [rec("/azure/a"), rec("/azure/b")], previousIndex, sitemapOk: false });
  assert.equal(p.missing.items.length, 0);
  const out = run({});
  assert.equal(out.indexWritten, false);
  assert.equal(out.status.indexUrls, 3, "reports the previous index size: that is what stays on disk");
  assert.equal(out.status.sitemapFailures, 1);
  assert.equal(out.status.complete, false);
  assert.equal(out.index.has("/azure/b"), true);
  assert.equal(out.index.has("/azure/c"), true);
  assert.equal(out.catalog.length, 2, "no record is removed");
  assert.equal(out.invalid.length, 0);
  assert.equal(out.stats.missingCarried, 2);
});

// ---- quarantine ----------------------------------------------------------------------------

test("quarantine: a restored page is released (record back with the 'released' sentinel, in the index)", () => {
  const { run } = setup({ rows: [row("/azure/q", "2026-10-01")], invalid: [quarantined("/azure/q")] });
  const out = run({ quarantine: [LIVE] });
  assert.equal(out.invalid.length, 0);
  assert.equal(out.stats.released, 1);
  const r = out.catalog[0];
  assert.equal(r.url, `${ORIGIN}/azure/q`);
  assert.equal(r.lastmod, "released", "the next plan sees a mismatch and refetches it");
  assert.equal(r.checked, TODAY);
  assert.equal("status" in r || "firstDetected" in r, false);
  assert.equal(out.index.get("/azure/q"), "2026-10-01");
  // and the next plan really does refetch it
  const next = plan({ today: TODAY, caps: { verifyPerRun: 0 }, previousIndex: out.index, catalog: out.catalog, invalid: out.invalid, ledger: [], rows: rowsMap(row("/azure/q", "2026-10-01")), sitemapOk: true });
  assert.deepEqual(next.fetch.items.map((i) => [i.path, i.kind]), [["/azure/q", "changed"]]);
});

test("quarantine: gone stays (status and lastChecked refreshed, firstDetected kept); transient and unrun stay untouched", () => {
  const { run } = setup({
    rows: [row("/azure/q1"), row("/azure/q2"), row("/azure/q3")],
    invalid: [quarantined("/azure/q1"), quarantined("/azure/q2"), quarantined("/azure/q3")],
    previousIndex: idx("/azure/q1", "/azure/q2", "/azure/q3"),
  });
  const out = run({ quarantine: [{ outcome: "gone", status: 410 }, TRANSIENT, undefined] });
  const q = Object.fromEntries(out.invalid.map((x) => [x.url, x]));
  assert.deepEqual([q[`${ORIGIN}/azure/q1`].status, q[`${ORIGIN}/azure/q1`].lastChecked, q[`${ORIGIN}/azure/q1`].firstDetected], [410, TODAY, "2026-09-01"]);
  assert.deepEqual([q[`${ORIGIN}/azure/q2`].status, q[`${ORIGIN}/azure/q2`].lastChecked], [404, "2026-09-10"]);
  assert.deepEqual([q[`${ORIGIN}/azure/q3`].status, q[`${ORIGIN}/azure/q3`].lastChecked], [404, "2026-09-10"]);
  assert.equal(out.newlyQuarantined.length, 0, "an already quarantined URL is not 'newly' quarantined");
  assert.equal(out.index.has("/azure/q1"), false, "quarantined paths are never in the index, even if a stale sitemap row lists them");
  assert.equal(out.stats.quarantineDeferred, 2);
});

test("quarantine: a quarantined page that now redirects leaves the quarantine and enters the ledger", () => {
  const { run } = setup({ invalid: [quarantined("/azure/q")] });
  const out = run({ quarantine: [moved("/azure/new-home")] });
  assert.equal(out.invalid.length, 0);
  assert.deepEqual(out.ledger.map((e) => [e.from, e.to]), [["/azure/q", "/azure/new-home"]]);
  assert.equal(out.stats.quarantineMoved, 1);
  assert.equal(out.catalog.length, 0);
});

test("quarantine: an external (github/docs) entry is released into the git records", () => {
  const ext = { title: "gh", url: "https://docs.github.com/en/x", product: "p", subproduct: null, description: "d", status: 404, firstDetected: "2026-09-01", lastChecked: "2026-09-02" };
  const { p, run } = setup({ invalid: [ext] });
  assert.equal(p.quarantine.items[0].external, true);
  const out = run({ quarantine: [LIVE] });
  assert.equal(out.invalid.length, 0);
  assert.deepEqual(out.catalog.map((r) => r.url), ["https://docs.github.com/en/x"]);
  assert.equal("status" in out.catalog[0], false);
});

test("quarantine: case-variant quarantine entries fold into one", () => {
  const { p } = setup({ invalid: [quarantined("/azure/foo", { url: `${ORIGIN}/azure/Foo` }), quarantined("/azure/foo")] });
  assert.equal(p.invalidByKey.size, 1);
});

// ---- ledger, status, determinism ---------------------------------------------------------------

test("ledger: an entry disappears when its `from` reappears in the index, and firstSeen survives re-discovery", () => {
  const ledger = [
    { from: "/azure/back", to: "/azure/x", kind: "moved", status: 301, firstSeen: "2026-09-01", lastSeen: "2026-09-20" },
    { from: "/azure/still", to: "/azure/y", kind: "moved", status: 301, firstSeen: "2026-09-02", lastSeen: "2026-09-20" },
  ];
  const { run } = setup({ rows: [row("/azure/back"), row("/azure/p")], ledger, previousIndex: idx("/azure/p", "/azure/q"), catalog: [rec("/azure/p", { lastmod: "2026-01-01" })] });
  const out = run({ fetch: [moved("/azure/z"), undefined] });
  assert.deepEqual(out.ledger.map((e) => e.from), ["/azure/p", "/azure/still"]);
  const p = out.ledger.find((e) => e.from === "/azure/p");
  assert.equal(p.firstSeen, TODAY);
  // discover /azure/still again later: firstSeen is kept
  const again = setup({ rows: [], ledger: out.ledger, previousIndex: idx("/azure/still"), catalog: [rec("/azure/still")] }).run({ missing: [moved("/azure/yy")] });
  const still = again.ledger.find((e) => e.from === "/azure/still");
  assert.equal(still.firstSeen, "2026-09-02");
  assert.equal(still.to, "/azure/yy");
  assert.equal(still.lastSeen, TODAY);
});

test("ledger: a probe that finds the page live on its own path removes a stale redirect claim", () => {
  const ledger = [{ from: "/azure/a", to: "/azure/x", kind: "moved", status: 301, firstSeen: "2026-09-01", lastSeen: "2026-09-20" }];
  const { run } = setup({ rows: [row("/azure/a")], catalog: [rec("/azure/a", { lastmod: "2026-01-01" })], previousIndex: idx("/azure/a"), ledger });
  const out = run({ fetch: [page("Back")] });
  assert.deepEqual(out.ledger, []);
});

test("status: every field of the contract is present and consistent", () => {
  const { run } = setup({
    rows: [row("/azure/a", "2026-09-20"), row("/azure/b", "2026-09-01"), row("/cli/azure/vm", "2026-10-04", "index")],
    catalog: [rec("/azure/a")],
    previousIndex: idx("/azure/a"),
    invalid: [quarantined("/azure/zzz")],
    ledger: [{ from: "/azure/old", to: "/azure/n", kind: "moved", status: 301, firstSeen: "2026-09-01", lastSeen: "2026-09-02" }],
  });
  const out = run({ fetch: [undefined] });
  assert.deepEqual(Object.keys(out.status).sort(), [
    "catalogRecords", "complete", "deferredChanged", "deferredMissing", "indexUrls", "pendingNew", "quarantined", "redirects", "sitemapFailures", "sitemapMaxLastmod",
  ]);
  assert.equal(out.status.indexUrls, 3);
  assert.equal(out.status.catalogRecords, 1);
  assert.equal(out.status.sitemapMaxLastmod, "2026-10-04");
  assert.equal(out.status.pendingNew, 1, "/azure/b has no record yet; the index-only /cli row never counts");
  assert.equal(out.status.quarantined, 1);
  assert.equal(out.status.redirects, 1);
  assert.equal(out.status.sitemapFailures, 0);
  assert.equal(out.status.complete, true);
  // a degraded run (a circuit breaker tripped) is never "complete", whatever else is true
  assert.equal(run({}, { degraded: true }).status.complete, false);
});

test("output is sorted by code point: catalog, quarantine, ledger and index insertion are order-independent", () => {
  const rows = ["/azure/b-b", "/azure/b", "/azure/B", "/azure/a.b", "/azure/a/b"].map((x) => row(x.toLowerCase(), "2026-09-20", "learn", `${ORIGIN}${x}`));
  const out = setup({ rows }).run({ fetch: rows.map((_, i) => page(`T${i}`)) });
  const urls = out.catalog.map((r) => r.url);
  assert.deepEqual(urls, [...urls].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.equal(urls[0], `${ORIGIN}/azure/B`, "uppercase sorts before lowercase in code-point order (localeCompare would not)");
});

test("pages outside LEARN_SCOPE never receive a record, even when released from quarantine", () => {
  const { run } = setup({ invalid: [quarantined("/cli/azure/vm")] });
  const out = run({ quarantine: [LIVE] });
  assert.equal(out.catalog.length, 0);
  assert.equal(out.index.has("/cli/azure/vm"), true, "but the live index-only page is indexed");
});

test("git records pass through untouched and are part of the catalog", () => {
  const gh = { title: "gh", url: "https://docs.github.com/en/x", product: "p", subproduct: null, description: null };
  const { run } = setup({ rows: [row("/azure/a")], catalog: [rec("/azure/a"), gh] });
  const out = run({});
  assert.deepEqual(out.catalog.map((r) => r.url), ["https://docs.github.com/en/x", `${ORIGIN}/azure/a`], "one catalog, sorted by url across both sources");
  const replaced = setup({ rows: [row("/azure/a")], catalog: [rec("/azure/a"), gh], git: [{ ...gh, title: "gh2" }] }).run({});
  assert.equal(replaced.catalog.find((r) => r.url === gh.url).title, "gh2");
});
