import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOOTSTRAP_INDEX_RATIO,
  CATALOG_MIN_ABSOLUTE,
  INDEX_SANITY_RATIO,
  auditDuplicates,
  catalogFloor,
  checkCatalogSize,
  checkIndexSanity,
  dropDuplicates,
  indexSanityBaseline,
} from "../scripts/lib/docs-failsafes.mjs";
import { aliasKey, findAliasDuplicates } from "../scripts/lib/docs-helpers.mjs";

test("checkIndexSanity aborts below 85% of the previous index (fault injection: sitemap outage)", () => {
  assert.equal(INDEX_SANITY_RATIO, 0.85);
  // a sitemap outage that returns a third of the pages
  const bad = checkIndexSanity({ newCount: 40_000, previousCount: 120_000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.minimum, 102_000);
  assert.match(bad.message, /outage or a format change/);
  // exactly at the minimum passes, one below fails
  assert.equal(checkIndexSanity({ newCount: 102_000, previousCount: 120_000 }).ok, true);
  assert.equal(checkIndexSanity({ newCount: 101_999, previousCount: 120_000 }).ok, false);
  // growth and no baseline are fine
  assert.equal(checkIndexSanity({ newCount: 130_000, previousCount: 120_000 }).ok, true);
  assert.equal(checkIndexSanity({ newCount: 0, previousCount: 0 }).ok, true);
});

test("indexSanityBaseline: previous index first, else the catalog with the legacy 50% rule, current scope only", () => {
  const inScope = (p) => !p.startsWith("/dotnet");
  const withIndex = indexSanityBaseline({ previousIndex: new Map([["/azure/a", null], ["/azure/b", null], ["/dotnet/x", null]]), catalogPaths: ["/azure/a"], inScope });
  assert.deepEqual(withIndex, { count: 2, ratio: INDEX_SANITY_RATIO, source: "previous index" });
  const bootstrap = indexSanityBaseline({ previousIndex: new Map(), catalogPaths: ["/azure/a", "/azure/a", "/azure/b", "/dotnet/x"], inScope });
  assert.deepEqual(bootstrap, { count: 2, ratio: BOOTSTRAP_INDEX_RATIO, source: "previous catalog" });
  assert.equal(BOOTSTRAP_INDEX_RATIO, 0.5);
  // narrowing a scope on purpose: an index made only of now-out-of-scope paths falls through to the catalog
  const narrowed = indexSanityBaseline({ previousIndex: new Map([["/dotnet/x", null]]), catalogPaths: [], inScope });
  assert.equal(narrowed.count, 0);
});

test("catalog floor is max(20000, 60% of the previous catalog)", () => {
  assert.equal(CATALOG_MIN_ABSOLUTE, 20000);
  assert.equal(catalogFloor(0), 20000);
  assert.equal(catalogFloor(10_000), 20000);
  assert.equal(catalogFloor(90_000), 54_000);
  assert.equal(catalogFloor(33_334), 20_001);
  const bad = checkCatalogSize({ newCount: 50_000, previousCount: 90_000 });
  assert.equal(bad.ok, false);
  assert.equal(bad.minimum, 54_000);
  assert.match(bad.message, /only 50000 catalog records/);
  assert.equal(checkCatalogSize({ newCount: 54_000, previousCount: 90_000 }).ok, true);
  assert.equal(checkCatalogSize({ newCount: 19_999, previousCount: 0 }).ok, false);
});

test("aliasKey and findAliasDuplicates see case variants, locale and query as the same page", () => {
  assert.equal(aliasKey("https://learn.microsoft.com/azure/Foo/"), "/azure/foo");
  assert.equal(aliasKey("https://learn.microsoft.com/en-us/azure/foo?view=x"), "/azure/foo");
  assert.equal(aliasKey("https://docs.github.com/En/Actions"), "https://docs.github.com/en/actions");
  const groups = findAliasDuplicates([
    { url: "https://learn.microsoft.com/azure/Foo" },
    { url: "https://learn.microsoft.com/azure/foo" },
    { url: "https://learn.microsoft.com/azure/bar" },
    { url: "https://learn.microsoft.com/azure/bar" }, // an exact repeat is findDuplicateUrls' job, not an alias
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].key, "/azure/foo");
  assert.deepEqual(groups[0].urls, ["https://learn.microsoft.com/azure/Foo", "https://learn.microsoft.com/azure/foo"]);
});

test("auditDuplicates fails past the threshold for exact duplicates AND for aliases (fault injection)", () => {
  const clean = Array.from({ length: 10 }, (_, i) => ({ url: `https://learn.microsoft.com/azure/p${i}` }));
  assert.equal(auditDuplicates(clean).ok, true);

  const exact = [...clean];
  for (let i = 0; i < 51; i++) exact.push({ url: `https://learn.microsoft.com/azure/dup${i}` }, { url: `https://learn.microsoft.com/azure/dup${i}` });
  const a = auditDuplicates(exact);
  assert.equal(a.ok, false);
  assert.equal(a.exact.length, 51);
  assert.match(a.message, /51 exact/);

  const aliases = [...clean];
  for (let i = 0; i < 51; i++) aliases.push({ url: `https://learn.microsoft.com/azure/Alias${i}` }, { url: `https://learn.microsoft.com/azure/alias${i}` });
  const b = auditDuplicates(aliases);
  assert.equal(b.ok, false);
  assert.equal(b.exact.length, 0);
  assert.equal(b.aliases.length, 51);
  assert.match(b.message, /51 case-variant/);

  // at the threshold it still passes (and reports what it found)
  const few = [...clean, { url: "https://learn.microsoft.com/azure/X" }, { url: "https://learn.microsoft.com/azure/x" }];
  const c = auditDuplicates(few);
  assert.equal(c.ok, true);
  assert.equal(c.aliases.length, 1);
  assert.equal(auditDuplicates(aliases, { threshold: 100 }).ok, true);
});

test("dropDuplicates keeps the first of each group", () => {
  const entries = [
    { url: "https://learn.microsoft.com/azure/Foo", n: 1 },
    { url: "https://learn.microsoft.com/azure/foo", n: 2 },
    { url: "https://learn.microsoft.com/azure/bar", n: 3 },
  ];
  assert.deepEqual(dropDuplicates(entries, (e) => aliasKey(e.url)).map((e) => e.n), [1, 3]);
});
