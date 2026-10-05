import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSitemaps, discoverSitemapFiles, SITEMAP_INDEX_URL } from "../scripts/lib/docs-sitemap-pass.mjs";
import { scopeSignature } from "../scripts/lib/docs-scope.mjs";

const ORIGIN = "https://learn.microsoft.com";
const file = (family, n = 1) => `${ORIGIN}/_sitemaps/${family}_en-us_${n}.xml`;
const urlset = (...entries) =>
  `<?xml version="1.0"?><urlset>${entries.map(([p, lm]) => `<url><loc>${ORIGIN}/en-us${p}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`).join("")}</urlset>\n`;
const index = (...urls) => `<sitemapindex>${urls.map((u) => `<sitemap><loc>${u}</loc></sitemap>`).join("")}</sitemapindex>`;

/** client.get from a map url -> { status, text }; unknown urls are 404. */
function client(map) {
  const gets = [];
  return {
    gets,
    async get(url) {
      gets.push(url);
      return map[url] ?? { status: 404, text: "" };
    },
  };
}

const base = { today: "2026-10-05", sleep: async () => {}, delayMs: 0 };

test("discoverSitemapFiles follows nested indexes, keeps one locale and dedupes files", async () => {
  const c = client({
    [SITEMAP_INDEX_URL]: { status: 200, text: index(file("azure"), file("azure"), `${ORIGIN}/_sitemaps/azure_fr-fr_1.xml`, `${ORIGIN}/_sitemaps/nested_index.xml`) },
    [`${ORIGIN}/_sitemaps/nested_index.xml`]: { status: 200, text: index(file("entra")) },
  });
  const files = await discoverSitemapFiles(c);
  assert.deepEqual(files.map((f) => f.family), ["azure", "entra"]);
});

test("an unreadable sitemap index throws (the stage has no output at all)", async () => {
  await assert.rejects(() => collectSitemaps({ ...base, client: client({}), memo: {} }), /sitemap index .* -> 404/);
  await assert.rejects(() => discoverSitemapFiles({ get: async () => ({ status: null, error: "timeout" }) }), /timeout/);
});

test("collectSitemaps: rows of both scopes, family outcomes, segments across every url", async () => {
  const c = client({
    [SITEMAP_INDEX_URL]: { status: 200, text: index(file("azure"), file("cli"), file("dotnet")) },
    [file("azure")]: { status: 200, text: urlset(["/azure/a", "2026-09-01"], ["/azure/b", "2026-09-02"]) },
    [file("cli")]: { status: 200, text: urlset(["/cli/azure/vm", "2026-09-03"]) },
    [file("dotnet")]: { status: 200, text: urlset(["/dotnet/api/x", "2026-09-04"]) },
  });
  const out = await collectSitemaps({ ...base, client: c, memo: {} });
  assert.deepEqual([...out.rows.keys()].sort(), ["/azure/a", "/azure/b", "/cli/azure/vm"]);
  assert.equal(out.rows.get("/cli/azure/vm").cls, "index");
  assert.equal(out.rows.get("/azure/a").family, "azure");
  assert.deepEqual(out.failures, []);
  assert.equal(out.downloaded, 3);
  const sig = scopeSignature();
  assert.deepEqual(out.families, {
    azure: { relevant: true, checked: "2026-10-05", scope: sig },
    cli: { relevant: true, checked: "2026-10-05", scope: sig },
    dotnet: { relevant: false, checked: "2026-10-05", scope: sig },
  });
  assert.equal(out.segments.get("dotnet"), 1);
  assert.equal(out.segments.get("azure"), 2);
});

test("a truncated sitemap file (no closing </urlset>) is a failure, not a smaller sitemap", async () => {
  const whole = urlset(["/azure/a", "2026-09-01"], ["/azure/b", "2026-09-02"]);
  const cut = whole.slice(0, whole.indexOf("</url>") + 6); // one complete <url>, then the connection died
  const c = client({
    [SITEMAP_INDEX_URL]: { status: 200, text: index(file("azure")) },
    [file("azure")]: { status: 200, text: cut },
  });
  const memo = { azure: { relevant: true, checked: "2026-09-01", scope: "x" } };
  const out = await collectSitemaps({ ...base, client: c, memo });
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0], /truncated/);
  assert.equal(out.downloaded, 0);
  assert.deepEqual(out.families.azure, memo.azure, "a failed family keeps its previous answer");
});

test("a failed file is reported with its status; other families are still read", async () => {
  const c = client({
    [SITEMAP_INDEX_URL]: { status: 200, text: index(file("azure"), file("entra", 1), file("entra", 2)) },
    [file("azure")]: { status: 500, text: "" },
    [file("entra", 1)]: { status: 200, text: urlset(["/entra/a", "2026-09-01"]) },
    [file("entra", 2)]: { status: null, text: "", error: "socket hang up" },
  });
  const out = await collectSitemaps({ ...base, client: c, memo: {} });
  assert.equal(out.failures.length, 2);
  assert.match(out.failures[0], /azure_en-us_1\.xml -> 500/);
  assert.match(out.failures[1], /socket hang up/);
  assert.deepEqual([...out.rows.keys()], ["/entra/a"]);
  assert.equal(out.families.entra.relevant, true);
  assert.deepEqual(out.families.azure, {}, "never answered: it is looked at again next run");
});

test("only the files the memo asks for are downloaded", async () => {
  const sig = scopeSignature();
  const memo = {
    azure: { relevant: true, checked: "2026-10-01", scope: sig },
    dotnet: { relevant: false, checked: "2026-10-01", scope: sig },
  };
  const c = client({
    [SITEMAP_INDEX_URL]: { status: 200, text: index(file("azure"), file("dotnet")) },
    [file("azure")]: { status: 200, text: urlset(["/azure/a", "2026-09-01"]) },
    [file("dotnet")]: { status: 200, text: urlset(["/dotnet/api/x", "2026-09-01"]) },
  });
  const out = await collectSitemaps({ ...base, client: c, memo });
  assert.deepEqual(c.gets, [SITEMAP_INDEX_URL, file("azure")]);
  assert.deepEqual(out.skippedFamilies, ["dotnet"]);
  assert.deepEqual(out.families.dotnet, memo.dotnet);
  const full = await collectSitemaps({ ...base, client: c, memo, full: true });
  assert.ok(c.gets.includes(file("dotnet")));
  assert.equal(full.skippedFamilies.length, 0);
});

test("rows prefer the spelling the catalog already uses when sitemap variants tie", async () => {
  const c = client({
    [SITEMAP_INDEX_URL]: { status: 200, text: index(file("azure")) },
    [file("azure")]: { status: 200, text: urlset(["/azure/Foo", "2026-09-01"], ["/azure/foo", "2026-09-01"]) },
  });
  const out = await collectSitemaps({ ...base, client: c, memo: {}, prefer: new Map([["/azure/foo", `${ORIGIN}/azure/foo`]]) });
  assert.equal(out.rows.size, 1);
  assert.equal(out.rows.get("/azure/foo").url, `${ORIGIN}/azure/foo`);
});
