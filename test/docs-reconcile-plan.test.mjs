import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CAPS,
  foldCatalog,
  foldInvalid,
  hash32,
  normalizeRecord,
  orderByChecked,
  orderQueue,
  pickWinner,
  plan,
  selectMissingBatch,
  splitFetchBudget,
} from "../scripts/lib/docs-reconcile.mjs";

export const TODAY = "2026-10-05";
const ORIGIN = "https://learn.microsoft.com";

export const row = (path, lastmod = "2026-09-20", cls = "learn", url = `${ORIGIN}${path}`) => ({ url, path, lastmod, family: "f", cls });
export const rowsMap = (...rows) => new Map(rows.map((r) => [r.path, r]));
export const rec = (path, extra = {}) => ({
  title: `Title ${path}`,
  url: `${ORIGIN}${path}`,
  product: "svc",
  subproduct: null,
  description: "desc",
  lastmod: "2026-09-20",
  checked: "2026-09-25",
  ...extra,
});
export const idx = (...paths) => new Map(paths.map((p) => [p, "2026-09-20"]));
export const quarantined = (path, extra = {}) => ({ ...rec(path), status: 404, firstDetected: "2026-09-01", lastChecked: "2026-09-10", ...extra });

/** plan() input with quiet defaults: no verification, no previous index, sitemap fine. */
export function planArgs(over = {}) {
  return {
    today: TODAY,
    caps: { verifyPerRun: 0, ...(over.caps || {}) },
    previousIndex: new Map(),
    catalog: [],
    invalid: [],
    ledger: [],
    rows: new Map(),
    sitemapOk: true,
    ...over,
    ...(over.caps ? { caps: { verifyPerRun: 0, ...over.caps } } : {}),
  };
}

test("plan classifies kept, changed, new and bootstrapped pages", () => {
  const p = plan(
    planArgs({
      rows: rowsMap(row("/azure/kept"), row("/azure/changed", "2026-10-01"), row("/azure/new"), row("/azure/boot", "2026-09-30"), row("/azure/untitled"), row("/azure/released", "2026-09-20")),
      catalog: [
        rec("/azure/kept"),
        rec("/azure/changed", { lastmod: "2026-08-01" }),
        (({ lastmod, ...rest }) => rest)(rec("/azure/boot")), // built by the git era: no lastmod key at all
        rec("/azure/untitled", { title: "" }),
        rec("/azure/released", { lastmod: "released" }),
      ],
    })
  );
  const kinds = Object.fromEntries(p.fetch.items.map((i) => [i.path, `${i.kind}${i.reason ? `:${i.reason}` : ""}`]));
  assert.deepEqual(kinds, {
    "/azure/changed": "changed:lastmod",
    "/azure/released": "changed:lastmod",
    "/azure/untitled": "changed:untitled",
    "/azure/new": "new",
  });
  assert.equal(p.stats.kept, 2);
  assert.equal(p.stats.bootstrapped, 1);
  assert.equal(p.known.get("/azure/boot").lastmod, "2026-09-30", "adopts the sitemap lastmod without a refetch");
  assert.equal(p.stats.untitledRecords, 1);
});

test("plan: index-only rows never queue a fetch and never get a record", () => {
  const p = plan(planArgs({ rows: rowsMap(row("/cli/azure/vm", "2026-09-20", "index"), row("/azure/a")) }));
  assert.deepEqual(p.fetch.items.map((i) => i.path), ["/azure/a"]);
  assert.equal(p.stats.indexOnlyRows, 1);
  assert.equal(p.stats.learnRows, 1);
  assert.equal(p.known.has("/cli/azure/vm"), false);
});

test("plan: a quarantined sitemap row is not fetched (the quarantine re-check decides)", () => {
  const p = plan(planArgs({ rows: rowsMap(row("/azure/q"), row("/azure/ok")), invalid: [quarantined("/azure/q")] }));
  assert.deepEqual(p.fetch.items.map((i) => i.path), ["/azure/ok"]);
  assert.equal(p.stats.quarantinedRows, 1);
});

test("plan: a case-variant quarantine entry still blocks the sitemap spelling", () => {
  const p = plan(planArgs({ rows: rowsMap(row("/azure/foo", "2026-09-20", "learn", `${ORIGIN}/azure/Foo`)), invalid: [quarantined("/azure/Foo", { url: `${ORIGIN}/azure/Foo` })] }));
  assert.equal(p.fetch.items.length, 0);
  assert.equal(p.quarantine.items.length, 1);
  assert.equal(p.quarantine.items[0].key, "/azure/foo");
});

test("plan: case-variant catalog records fold into the sitemap's spelling and never queue refetches", () => {
  const sitemapUrl = `${ORIGIN}/azure/Foo`;
  const p = plan(
    planArgs({
      rows: rowsMap(row("/azure/foo", "2026-09-20", "learn", sitemapUrl), row("/azure/bar", "2026-09-20", "learn", `${ORIGIN}/azure/bar`)),
      catalog: [
        rec("/azure/foo", { url: sitemapUrl, title: "Right spelling" }),
        rec("/azure/foo", { url: `${ORIGIN}/azure/foo`, title: "Lowercase orphan" }),
        rec("/azure/bar", { url: `${ORIGIN}/Azure/Bar`, title: "Orphan with another case" }), // no exact match: respelled
      ],
    })
  );
  assert.equal(p.fetch.items.length, 0, "no case variant is refetched as a new page");
  assert.equal(p.stats.aliasesFolded, 1);
  assert.equal(p.stats.respelled, 1);
  assert.equal(p.known.get("/azure/foo").title, "Right spelling");
  assert.equal(p.known.get("/azure/bar").url, `${ORIGIN}/azure/bar`);
  assert.equal(p.known.get("/azure/bar").title, "Orphan with another case");
  assert.equal(p.missing.items.length, 0, "aliases are not 'missing from the sitemap'");
  assert.equal(p.stats.missingCandidates, 0);
});

test("plan: a known redirecting sitemap URL is not refetched for 30 days", () => {
  const rows = rowsMap(row("/azure/stale-row"), row("/azure/old-ledger"), row("/azure/new"));
  const p = plan(
    planArgs({
      rows,
      ledger: [
        { from: "/azure/stale-row", to: "/azure/else", kind: "moved", status: 301, firstSeen: "2026-09-20", lastSeen: "2026-09-25" },
        { from: "/azure/old-ledger", to: "/azure/else2", kind: "moved", status: 301, firstSeen: "2026-08-01", lastSeen: "2026-08-20" },
      ],
    })
  );
  assert.deepEqual(p.fetch.items.map((i) => i.path).sort(), ["/azure/new", "/azure/old-ledger"]);
  assert.equal(p.stats.knownRedirectSkipped, 1);
});

test("plan: a redirecting URL that (re)appears in the sitemap is fetched at once, not skipped", () => {
  const p = plan(
    planArgs({
      rows: rowsMap(row("/azure/stale-row"), row("/azure/reappeared")),
      previousIndex: idx("/azure/stale-row", "/azure/other"),
      ledger: [
        { from: "/azure/stale-row", to: "/azure/else", kind: "moved", status: 301, firstSeen: "2026-09-20", lastSeen: "2026-09-25" },
        { from: "/azure/reappeared", to: "/azure/else2", kind: "moved", status: 301, firstSeen: "2026-09-20", lastSeen: "2026-09-25" },
      ],
    })
  );
  assert.deepEqual(p.fetch.items.map((i) => i.path), ["/azure/reappeared"]);
  assert.equal(p.stats.knownRedirectSkipped, 1);
});

test("plan: records outside LEARN_SCOPE are dropped from the catalog (index-only prefixes carry no metadata)", () => {
  const p = plan(planArgs({ rows: rowsMap(row("/azure/a")), catalog: [rec("/azure/a"), rec("/cli/azure/vm"), rec("/azure/templates/x"), { title: "gh", url: "https://docs.github.com/en/x" }] }));
  assert.deepEqual([...p.known.keys()], ["/azure/a"]);
  assert.equal(p.stats.outOfScopeRecords, 2);
  assert.deepEqual(p.git.map((r) => r.url), ["https://docs.github.com/en/x"]);
});

// --- queue ordering and budgets -------------------------------------------------------

test("orderQueue: freshest lastmod first, null last, ties by path", () => {
  const out = orderQueue([
    { path: "/b", lastmod: "2026-01-01" },
    { path: "/a", lastmod: "2026-01-01" },
    { path: "/n", lastmod: null },
    { path: "/z", lastmod: "2026-09-09" },
  ]);
  assert.deepEqual(out.map((x) => x.path), ["/z", "/a", "/b", "/n"]);
});

test("splitFetchBudget: changed pages first, each kind keeps at least its reserve", () => {
  assert.deepEqual(splitFetchBudget({ cap: 10, changed: 3, fresh: 4 }), { changed: 3, fresh: 4 }, "everything fits");
  assert.deepEqual(splitFetchBudget({ cap: 10, changed: 3, fresh: 100 }), { changed: 3, fresh: 7 }, "a small changed set never starves behind a huge backlog");
  assert.deepEqual(splitFetchBudget({ cap: 10, changed: 100, fresh: 100 }), { changed: 8, fresh: 2 }, "20% of the cap is reserved for new pages");
  assert.deepEqual(splitFetchBudget({ cap: 10, changed: 100, fresh: 1 }), { changed: 9, fresh: 1 });
  assert.deepEqual(splitFetchBudget({ cap: 10, changed: 0, fresh: 100 }), { changed: 0, fresh: 10 });
  assert.deepEqual(splitFetchBudget({ cap: 10, changed: 100, fresh: 0 }), { changed: 10, fresh: 0 });
  assert.deepEqual(splitFetchBudget({ cap: 0, changed: 5, fresh: 5 }), { changed: 0, fresh: 0 });
  // changed pages always get at least 20% of the cap when both kinds exist and changed is large enough
  const split = splitFetchBudget({ cap: 1000, changed: 5000, fresh: 5000 });
  assert.ok(split.changed >= 200 && split.fresh >= 200 && split.changed + split.fresh === 1000);
});

test("plan fetch queue: changed before new, both freshest first, cap and deferrals reported", () => {
  const rows = [];
  const catalog = [];
  for (let i = 0; i < 6; i++) {
    rows.push(row(`/azure/c${i}`, `2026-10-0${i + 1}`));
    catalog.push(rec(`/azure/c${i}`, { lastmod: "2026-01-01" }));
  }
  for (let i = 0; i < 6; i++) rows.push(row(`/azure/n${i}`, `2026-09-0${i + 1}`));
  const p = plan(planArgs({ rows: rowsMap(...rows), catalog, caps: { maxPageFetches: 5 } }));
  // cap 5: reserve ceil(5*0.2)=1 for new, so 4 changed (freshest) then 1 new (freshest)
  assert.deepEqual(p.fetch.items.map((i) => i.path), ["/azure/c5", "/azure/c4", "/azure/c3", "/azure/c2", "/azure/n5"]);
  assert.deepEqual(p.fetch.deferredChanged.map((i) => i.path), ["/azure/c1", "/azure/c0"]);
  assert.equal(p.fetch.deferredNew.length, 5);
  assert.equal(p.stats.changed, 6);
  assert.equal(p.stats.new, 6);
});

test("plan: a zero cap fetches nothing and defers everything", () => {
  const p = plan(planArgs({ rows: rowsMap(row("/azure/a"), row("/azure/b")), caps: { maxPageFetches: 0 } }));
  assert.equal(p.fetch.items.length, 0);
  assert.equal(p.fetch.deferredNew.length, 2);
});

// --- verification pass ----------------------------------------------------------------

test("orderByChecked: never-checked first, then oldest, ties by url (code point)", () => {
  const out = orderByChecked([
    { url: "b", checked: "2026-09-01" },
    { url: "a", checked: "2026-09-01" },
    { url: "z", checked: undefined },
    { url: "c", checked: "2026-08-01" },
  ]);
  assert.deepEqual(out.map((x) => x.url), ["z", "c", "a", "b"]);
});

test("plan verification pass: oldest-checked kept records first, capped by VERIFY_PER_RUN", () => {
  const rows = [];
  const catalog = [];
  const checked = { a: "2026-09-30", b: "2026-08-01", c: undefined, d: "2026-08-01", e: "2026-10-04" };
  for (const [k, v] of Object.entries(checked)) {
    rows.push(row(`/azure/${k}`));
    catalog.push(rec(`/azure/${k}`, { checked: v }));
  }
  const p = plan(planArgs({ rows: rowsMap(...rows), catalog, caps: { verifyPerRun: 3 } }));
  assert.deepEqual(p.verify.items.map((i) => i.path), ["/azure/c", "/azure/b", "/azure/d"]);
  // never more than asked, and an unchanged record needs no fetch
  assert.equal(p.fetch.items.length, 0);
  assert.equal(plan(planArgs({ rows: rowsMap(...rows), catalog, caps: { verifyPerRun: 99 } })).verify.items.length, 5);
});

test("plan verification pass skips records that are about to be refetched or are quarantined", () => {
  const p = plan(
    planArgs({
      rows: rowsMap(row("/azure/changed", "2026-10-01"), row("/azure/kept"), row("/azure/q")),
      catalog: [rec("/azure/changed", { lastmod: "2026-01-01" }), rec("/azure/kept"), rec("/azure/q")],
      invalid: [quarantined("/azure/q")],
      caps: { verifyPerRun: 10 },
    })
  );
  assert.deepEqual(p.verify.items.map((i) => i.path), ["/azure/kept"]);
});

// --- fell out of the sitemaps ---------------------------------------------------------

test("plan: URLs in the previous index or the catalog that left the sitemaps become removal-detection candidates", () => {
  const p = plan(
    planArgs({
      rows: rowsMap(row("/azure/here")),
      previousIndex: idx("/azure/here", "/azure/in-index-only", "/cli/azure/vm", "/dotnet/out-of-scope"),
      catalog: [rec("/azure/here"), rec("/azure/in-catalog")],
      caps: { maxMissingChecks: 100 },
    })
  );
  assert.deepEqual(p.missing.items.map((i) => i.path).sort(), ["/azure/in-catalog", "/azure/in-index-only", "/cli/azure/vm"]);
  assert.equal(p.stats.indexOutOfScope, 1, "a path outside both scopes is dropped from the index, not probed");
  const byPath = Object.fromEntries(p.missing.items.map((i) => [i.path, i]));
  assert.equal(byPath["/azure/in-catalog"].rec.title, "Title /azure/in-catalog");
  assert.equal(byPath["/azure/in-index-only"].rec, null);
  assert.equal(byPath["/azure/in-index-only"].prevLastmod, "2026-09-20");
});

test("plan: removal detection probes the OLDEST-checked records first, not catalog order", () => {
  const catalog = [];
  for (let i = 0; i < 6; i++) catalog.push(rec(`/azure/p${i}`, { checked: i === 3 ? "2026-07-01" : i === 5 ? undefined : `2026-09-0${i + 1}` }));
  const p = plan(planArgs({ rows: new Map(), catalog, caps: { maxMissingChecks: 3 } }));
  // never-checked (p5) first, then the oldest (p3), then p0
  assert.deepEqual(p.missing.items.map((i) => i.path), ["/azure/p5", "/azure/p3", "/azure/p0"]);
  assert.equal(p.missing.deferred.length, 3);
});

test("plan: aliases never consume the removal-detection budget", () => {
  const catalog = [];
  for (let i = 0; i < 5; i++) {
    catalog.push(rec(`/azure/p${i}`, { url: `${ORIGIN}/azure/P${i}` }), rec(`/azure/p${i}`, { url: `${ORIGIN}/azure/p${i}` }), rec(`/azure/p${i}`, { url: `${ORIGIN}/Azure/p${i}` }));
  }
  const p = plan(planArgs({ rows: new Map(), catalog, caps: { maxMissingChecks: 100 } }));
  assert.equal(p.missing.items.length, 5, "15 alias records = 5 pages = 5 probes");
  assert.equal(p.stats.aliasesFolded, 10);
});

test("plan: quarantined URLs are not removal-detection candidates (they are re-checked instead)", () => {
  const p = plan(planArgs({ rows: new Map(), previousIndex: idx("/azure/q"), catalog: [rec("/azure/q")], invalid: [quarantined("/azure/q")] }));
  assert.equal(p.missing.items.length, 0);
  assert.equal(p.quarantine.items.length, 1);
});

test("plan: when a sitemap file failed, removal detection is OFF and every candidate is carried", () => {
  const p = plan(planArgs({ rows: new Map(), previousIndex: idx("/azure/a"), catalog: [rec("/azure/b")], sitemapOk: false }));
  assert.equal(p.missing.items.length, 0);
  assert.deepEqual(p.missing.carried.map((c) => c.path).sort(), ["/azure/a", "/azure/b"]);
});

test("selectMissingBatch: each kind is guaranteed half the cap while both are waiting", () => {
  const withRec = Array.from({ length: 50 }, (_, i) => ({ path: `/azure/r${i}`, url: `u${i}`, rec: { checked: `2026-08-${String(i % 28 + 1).padStart(2, "0")}` } }));
  const pathOnly = Array.from({ length: 50 }, (_, i) => ({ path: `/cli/c${i}`, url: `v${i}`, rec: null }));
  const out = selectMissingBatch([...withRec, ...pathOnly], 20, TODAY);
  assert.equal(out.items.length, 20);
  assert.equal(out.items.filter((i) => i.rec).length, 10);
  assert.equal(out.items.filter((i) => !i.rec).length, 10);
  assert.equal(out.deferred.length, 80);
  // short on one kind: the other fills the cap
  const fewRec = selectMissingBatch([...withRec.slice(0, 3), ...pathOnly], 20, TODAY);
  assert.equal(fewRec.items.length, 20);
  assert.equal(fewRec.items.filter((i) => i.rec).length, 3);
  const fewPath = selectMissingBatch([...withRec, ...pathOnly.slice(0, 2)], 20, TODAY);
  assert.equal(fewPath.items.length, 20);
  assert.equal(fewPath.items.filter((i) => !i.rec).length, 2);
  // everything fits: nothing deferred
  assert.equal(selectMissingBatch([...withRec.slice(0, 3), ...pathOnly.slice(0, 3)], 20, TODAY).deferred.length, 0);
  assert.deepEqual(selectMissingBatch(withRec, 0, TODAY).items, []);
});

test("selectMissingBatch: path-only rotation is stable within a day and moves across days", () => {
  const pathOnly = Array.from({ length: 40 }, (_, i) => ({ path: `/cli/c${i}`, url: `v${i}`, rec: null }));
  const a = selectMissingBatch(pathOnly, 5, "2026-10-05").items.map((i) => i.path);
  assert.deepEqual(selectMissingBatch([...pathOnly].reverse(), 5, "2026-10-05").items.map((i) => i.path), a);
  const b = selectMissingBatch(pathOnly, 5, "2026-10-06").items.map((i) => i.path);
  assert.notDeepEqual(a, b);
  assert.equal(hash32("x"), hash32("x"));
  assert.notEqual(hash32("x"), hash32("y"));
});

// --- quarantine re-check ----------------------------------------------------------------

test("plan: quarantine re-checks go least-recently-checked first and are capped; external URLs are flagged", () => {
  const invalid = [
    quarantined("/azure/a", { lastChecked: "2026-10-01" }),
    quarantined("/azure/b", { lastChecked: "2026-09-01" }),
    { title: "gh", url: "https://docs.github.com/en/x", status: 404, firstDetected: "2026-09-01", lastChecked: "2026-08-01" },
    quarantined("/azure/c", { lastChecked: "2026-09-15" }),
  ];
  const p = plan(planArgs({ invalid, caps: { maxQuarantineRechecks: 3 } }));
  assert.deepEqual(p.quarantine.items.map((q) => q.key), ["https://docs.github.com/en/x", "/azure/b", "/azure/c"]);
  assert.equal(p.quarantine.items[0].external, true);
  assert.equal(p.quarantine.items[1].path, "/azure/b");
  assert.equal(p.quarantine.deferred.length, 1);
});

// --- helpers --------------------------------------------------------------------------

test("pickWinner prefers the sitemap spelling, then titled, then lastmod, then recently checked", () => {
  const a = { url: `${ORIGIN}/azure/Foo`, title: "", checked: "2026-10-01" };
  const b = { url: `${ORIGIN}/azure/foo`, title: "T", lastmod: "2026-01-01", checked: "2026-09-01" };
  const c = { url: `${ORIGIN}/azure/FOO`, title: "T", lastmod: "2026-01-01", checked: "2026-09-20" };
  assert.equal(pickWinner([a, b, c], `${ORIGIN}/azure/Foo`).url, a.url, "exact sitemap spelling wins first");
  assert.equal(pickWinner([a, b, c], null).url, c.url, "then titled + lastmod + most recently checked");
  assert.equal(pickWinner([b, { ...b, url: `${ORIGIN}/azure/Foo` }], null).url, `${ORIGIN}/azure/Foo`, "last tie: smallest url");
});

test("foldCatalog and foldInvalid", () => {
  const folded = foldCatalog([rec("/azure/a"), rec("/azure/a", { url: `${ORIGIN}/azure/A` }), rec("/cli/x"), { url: "https://docs.github.com/x", title: "g" }], new Map());
  assert.equal(folded.byPath.size, 1);
  assert.equal(folded.aliases, 1);
  assert.equal(folded.outOfScope, 1);
  assert.equal(folded.git.length, 1);
  const inv = foldInvalid([
    quarantined("/azure/a", { url: `${ORIGIN}/azure/A`, firstDetected: "2026-09-05", lastChecked: "2026-09-10", status: 404 }),
    quarantined("/azure/a", { url: `${ORIGIN}/azure/a`, firstDetected: "2026-09-01", lastChecked: "2026-09-20", status: 410 }),
    { nope: true },
  ]);
  assert.equal(inv.size, 1);
  const q = inv.get("/azure/a");
  assert.equal(q.firstDetected, "2026-09-01");
  assert.equal(q.lastChecked, "2026-09-20");
  assert.equal(q.status, 410);
});

test("normalizeRecord keeps the canonical key order and unknown keys", () => {
  const out = normalizeRecord({ extra: 1, checked: "2026-10-05", lastmod: "x", description: null, url: "u", title: "t" });
  assert.deepEqual(Object.keys(out), ["title", "url", "product", "subproduct", "description", "lastmod", "checked", "extra"]);
  assert.deepEqual(Object.keys(normalizeRecord({ url: "u", title: null })), ["title", "url", "product", "subproduct"]);
  assert.equal(DEFAULT_CAPS.verifyPerRun, 2000);
  assert.equal(DEFAULT_CAPS.maxPageFetches, 6000);
  assert.equal(DEFAULT_CAPS.maxMissingChecks, 2000);
});
