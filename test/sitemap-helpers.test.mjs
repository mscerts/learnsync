import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSitemapIndex,
  parseUrlset,
  isSitemapIndex,
  sitemapFamily,
  normalizeLearnUrl,
  inScope,
  scopeOf,
  dedupeByUrl,
  parseHeadMeta,
  isNoIndex,
  recordFromHead,
  decodeHtmlEntities,
} from "../scripts/lib/sitemap-helpers.mjs";
import { cleanTitle } from "../scripts/lib/docs-helpers.mjs";

// Shapes copied from the live learn.microsoft.com/_sitemaps files (2026-09-25).
const INDEX = `\ufeff<?xml version="1.0" encoding="utf-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://learn.microsoft.com/_sitemaps/postgresql_en-us_1.xml</loc><lastmod>2026-08-25</lastmod></sitemap><sitemap><loc>https://learn.microsoft.com/_sitemaps/postgresql_de-de_1.xml</loc><lastmod>2026-06-16</lastmod></sitemap><sitemap><loc>https://learn.microsoft.com/_sitemaps/previous-versions_en-us_12.xml</loc><lastmod>2026-08-21</lastmod></sitemap></sitemapindex>`;
const URLSET = `\ufeff<?xml version="1.0" encoding="utf-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>https://learn.microsoft.com/en-us/postgresql/citus/reference-ddl?view=citus-14</loc><lastmod>2026-06-11</lastmod><xhtml:link rel="alternate" hreflang="de-de" href="https://learn.microsoft.com/de-de/postgresql/citus/reference-ddl?view=citus-14" /></url><url><loc>https://learn.microsoft.com/en-us/postgresql/citus/?view=citus-14</loc><lastmod>2026-08-07</lastmod></url></urlset>`;

test("parseSitemapIndex returns child sitemaps with lastmod", () => {
  const rows = parseSitemapIndex(INDEX);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { loc: "https://learn.microsoft.com/_sitemaps/postgresql_en-us_1.xml", lastmod: "2026-08-25" });
  assert.ok(isSitemapIndex(INDEX));
  assert.ok(!isSitemapIndex(URLSET));
});

test("parseUrlset ignores hreflang alternates", () => {
  const rows = parseUrlset(URLSET);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].loc, "https://learn.microsoft.com/en-us/postgresql/citus/reference-ddl?view=citus-14");
  assert.equal(rows[0].lastmod, "2026-06-11");
});

test("parseUrlset decodes XML entities in loc", () => {
  const rows = parseUrlset("<urlset><url><loc>https://learn.microsoft.com/en-us/a?x=1&amp;y=2</loc></url></urlset>");
  assert.equal(rows[0].loc, "https://learn.microsoft.com/en-us/a?x=1&y=2");
  assert.equal(rows[0].lastmod, null);
});

test("sitemapFamily splits family/locale, handles hyphenated families", () => {
  assert.deepEqual(sitemapFamily("https://learn.microsoft.com/_sitemaps/dotnet_en-us_90.xml"), { family: "dotnet", locale: "en-us" });
  assert.deepEqual(sitemapFamily("https://learn.microsoft.com/_sitemaps/previous-versions_en-us_1.xml"), { family: "previous-versions", locale: "en-us" });
  assert.deepEqual(sitemapFamily("https://learn.microsoft.com/_sitemaps/stream-analytics-query_zh-tw_1.xml"), { family: "stream-analytics-query", locale: "zh-tw" });
  assert.equal(sitemapFamily("https://learn.microsoft.com/_sitemaps/sitemapindex.xml"), null);
});

test("normalizeLearnUrl matches the catalog's existing URL shape", () => {
  assert.equal(normalizeLearnUrl("https://learn.microsoft.com/en-us/azure/key-vault/general/overview"), "https://learn.microsoft.com/azure/key-vault/general/overview");
  assert.equal(normalizeLearnUrl("https://learn.microsoft.com/en-us/postgresql/citus/?view=citus-14"), "https://learn.microsoft.com/postgresql/citus");
  assert.equal(normalizeLearnUrl("https://learn.microsoft.com/EN-US/sql/t-sql/statements/select?view=sql-server-ver16"), "https://learn.microsoft.com/sql/t-sql/statements/select");
  assert.equal(normalizeLearnUrl("https://learn.microsoft.com/en-us/a?tabs=cli&view=x"), "https://learn.microsoft.com/a?tabs=cli");
  assert.equal(normalizeLearnUrl("https://learn.microsoft.com/de-de/azure/x"), null);
  assert.equal(normalizeLearnUrl("https://docs.github.com/en/actions"), null);
  assert.equal(normalizeLearnUrl("not a url"), null);
});

test("inScope respects segment boundaries and excludes", () => {
  const scope = { include: ["azure", "defender"], exclude: ["azure/templates"] };
  assert.ok(inScope("https://learn.microsoft.com/azure", scope));
  assert.ok(inScope("https://learn.microsoft.com/azure/aks/what-is-aks", scope));
  assert.ok(!inScope("https://learn.microsoft.com/azure-sdk/x", scope)); // "azure" must not match "azure-sdk"
  assert.ok(!inScope("https://learn.microsoft.com/azure/templates/microsoft.compute/virtualmachines", scope));
  assert.ok(!inScope("https://learn.microsoft.com/defender-endpoint/x", scope)); // "defender" != "defender-endpoint"
  assert.ok(inScope("https://learn.microsoft.com/defender/threat-intelligence/x", scope));
});

test("scopeOf returns the longest matching prefix", () => {
  const include = ["defender", "defender-xdr", "microsoft-365"];
  assert.equal(scopeOf("https://learn.microsoft.com/defender-xdr/x", include), "defender-xdr");
  assert.equal(scopeOf("https://learn.microsoft.com/defender/y", include), "defender");
  assert.equal(scopeOf("https://learn.microsoft.com/other", include), null);
});

test("dedupeByUrl keeps the newest lastmod across moniker variants", () => {
  const m = dedupeByUrl([
    { url: "u", lastmod: "2026-01-01" },
    { url: "u", lastmod: "2026-03-01" },
    { url: "u", lastmod: "2026-02-01" },
    { url: "v", lastmod: null },
  ]);
  assert.equal(m.get("u").lastmod, "2026-03-01");
  assert.equal(m.size, 2);
});

// <head> shape based on a live Learn page (what-is-citus, fetched 2026-09-25).
const HEAD = `<!DOCTYPE html><html lang="en-us"><head>
<meta charset="utf-8" />
<title>Citus Overview - Citus for PostgreSQL | Microsoft Learn</title>
<meta name="description" content="Learn what Citus is &amp; the core architecture concepts." />
<meta content="postgresql-citus" name="ms.service" />
<meta name="ms.topic" content="overview" />
<meta property="og:title" content="Citus Overview - Citus for PostgreSQL" />
</head><body><meta name="description" content="BODY SHOULD BE IGNORED" /></body></html>`;

test("parseHeadMeta reads title and meta in either attribute order, head only", () => {
  const { title, meta } = parseHeadMeta(HEAD);
  assert.equal(title, "Citus Overview - Citus for PostgreSQL | Microsoft Learn");
  assert.equal(meta.description, "Learn what Citus is & the core architecture concepts.");
  assert.equal(meta["ms.service"], "postgresql-citus");
  assert.equal(meta["og:title"], "Citus Overview - Citus for PostgreSQL");
});

test("recordFromHead produces the catalog record shape", () => {
  const rec = recordFromHead(parseHeadMeta(HEAD), "https://learn.microsoft.com/postgresql/citus/what-is-citus", cleanTitle);
  assert.deepEqual(rec, {
    title: "Citus Overview - Citus for PostgreSQL",
    url: "https://learn.microsoft.com/postgresql/citus/what-is-citus",
    product: "postgresql-citus",
    subproduct: null,
    description: "Learn what Citus is & the core architecture concepts.",
  });
});

test("recordFromHead returns null when there's no title at all", () => {
  assert.equal(recordFromHead({ title: null, meta: {} }, "u", cleanTitle), null);
});

test("isNoIndex detects robots noindex", () => {
  assert.ok(isNoIndex({ robots: "NOINDEX, NOFOLLOW" }));
  assert.ok(isNoIndex({ "ms.robots": "noindex" }));
  assert.ok(!isNoIndex({ robots: "index,follow" }));
  assert.ok(!isNoIndex({}));
});

test("decodeHtmlEntities handles numeric and named entities", () => {
  assert.equal(decodeHtmlEntities("A &#39;b&#x27; &quot;c&quot; &amp;amp; &lt;d&gt;"), `A 'b' "c" &amp; <d>`);
});
