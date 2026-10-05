import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeRows,
  daysBetween,
  listSitemapChildren,
  rowsFromUrlset,
  selectSitemapFiles,
  updateFamilies,
} from "../scripts/lib/docs-sitemaps.mjs";
import { scopeSignature } from "../scripts/lib/docs-scope.mjs";

const urlset = (...entries) =>
  `<?xml version="1.0"?><urlset>${entries.map(([loc, lm]) => `<url><loc>${loc}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`).join("")}</urlset>`;

test("listSitemapChildren keeps one locale and reports nested indexes", () => {
  const xml = `<sitemapindex>
    <sitemap><loc>https://learn.microsoft.com/_sitemaps/azure_en-us_1.xml</loc><lastmod>2026-10-01</lastmod></sitemap>
    <sitemap><loc>https://learn.microsoft.com/_sitemaps/azure_fr-fr_1.xml</loc></sitemap>
    <sitemap><loc>https://learn.microsoft.com/_sitemaps/more_index.xml</loc></sitemap>
  </sitemapindex>`;
  const { files, nested } = listSitemapChildren(xml);
  assert.deepEqual(files.map((f) => [f.family, f.locale]), [["azure", "en-us"]]);
  assert.deepEqual(nested, ["https://learn.microsoft.com/_sitemaps/more_index.xml"]);
});

test("rowsFromUrlset covers BOTH scopes, tags each row, and keeps the sitemap's spelling", () => {
  const xml = urlset(
    ["https://learn.microsoft.com/en-us/azure/Key-Vault/General/Overview/", "2026-10-01"],
    ["https://learn.microsoft.com/en-us/cli/azure/vm", "2026-09-01"],
    ["https://learn.microsoft.com/en-us/azure/templates/microsoft.compute/virtualmachines", "2026-09-01"],
    ["https://learn.microsoft.com/en-us/dotnet/api/system.string", "2026-09-01"],
    ["https://learn.microsoft.com/en-us/azure/storage/blobs?view=azure-cli-latest", null],
    ["https://learn.microsoft.com/en-us/azure/foo?tab=x&view=y", "2026-01-01"]
  );
  const segments = new Map();
  const { rows, total, queryRows } = rowsFromUrlset(xml, { family: "mixed", segments });
  assert.equal(total, 6);
  assert.deepEqual(
    rows.map((r) => [r.path, r.cls, r.url]),
    [
      ["/azure/key-vault/general/overview", "learn", "https://learn.microsoft.com/azure/Key-Vault/General/Overview"],
      ["/cli/azure/vm", "index", "https://learn.microsoft.com/cli/azure/vm"],
      ["/azure/storage/blobs", "learn", "https://learn.microsoft.com/azure/storage/blobs"],
      ["/azure/foo", "learn", "https://learn.microsoft.com/azure/foo"],
    ]
  );
  assert.equal(rows[0].lastmod, "2026-10-01");
  assert.equal(rows[2].lastmod, null);
  assert.equal(rows[0].family, "mixed");
  assert.equal(queryRows, 1, "only a non-view query counts as a dropped query");
  // segments counts EVERY url, in scope or not, so uncovered product areas can be reported
  assert.equal(segments.get("azure"), 4);
  assert.equal(segments.get("dotnet"), 1);
  assert.equal(segments.get("cli"), 1);
});

test("rowsFromUrlset ignores non-en-us and non-Learn locations", () => {
  const xml = urlset(
    ["https://learn.microsoft.com/fr-fr/azure/x", "2026-01-01"],
    ["https://example.com/en-us/azure/x", "2026-01-01"],
    ["https://learn.microsoft.com/en-us/azure/y", "2026-01-01"]
  );
  const { rows } = rowsFromUrlset(xml, { family: "f" });
  assert.deepEqual(rows.map((r) => r.path), ["/azure/y"]);
});

test("dedupeRows: one row per canonical path, newest lastmod, then the catalog's spelling, then code point", () => {
  const mk = (url, lastmod) => ({ url, path: url.replace("https://learn.microsoft.com", "").toLowerCase(), lastmod, family: "f", cls: "learn" });
  const rows = [
    mk("https://learn.microsoft.com/azure/Foo", "2026-01-01"),
    mk("https://learn.microsoft.com/azure/foo", "2026-02-01"), // newer wins regardless of spelling
    mk("https://learn.microsoft.com/azure/Bar", "2026-03-01"),
    mk("https://learn.microsoft.com/azure/bar", "2026-03-01"), // tie: catalog spelling
    mk("https://learn.microsoft.com/azure/Baz", "2026-03-01"),
    mk("https://learn.microsoft.com/azure/baz", "2026-03-01"), // tie, no preference: smallest url (uppercase first)
    mk("https://learn.microsoft.com/azure/nolm", null),
    mk("https://learn.microsoft.com/azure/nolm", "2026-05-05"),
  ];
  const out = dedupeRows(rows, new Map([["/azure/bar", "https://learn.microsoft.com/azure/bar"]]));
  assert.equal(out.size, 4);
  assert.equal(out.get("/azure/foo").url, "https://learn.microsoft.com/azure/foo");
  assert.equal(out.get("/azure/bar").url, "https://learn.microsoft.com/azure/bar");
  assert.equal(out.get("/azure/baz").url, "https://learn.microsoft.com/azure/Baz");
  assert.equal(out.get("/azure/nolm").lastmod, "2026-05-05");
  // the outcome never depends on the order rows arrive in
  const reversed = dedupeRows([...rows].reverse(), new Map([["/azure/bar", "https://learn.microsoft.com/azure/bar"]]));
  for (const [path, row] of out) assert.equal(reversed.get(path).url, row.url);
});

const files = (...families) => families.map((family) => ({ loc: `https://learn.microsoft.com/_sitemaps/${family}_en-us_1.xml`, family, locale: "en-us" }));
const sig = scopeSignature();

test("selectSitemapFiles: relevant and new families are downloaded, current irrelevant ones skipped", () => {
  const memo = {
    azure: { relevant: true, checked: "2026-10-01", scope: sig },
    dotnet: { relevant: false, checked: "2026-10-01", scope: sig },
  };
  const out = selectSitemapFiles(files("azure", "dotnet", "brand-new"), memo, { scopeSig: sig, today: "2026-10-05" });
  assert.deepEqual(out.selected.map((f) => f.family), ["azure", "brand-new"]);
  assert.deepEqual(out.skipped, ["dotnet"]);
  assert.deepEqual(out.reasons, { azure: "relevant", "brand-new": "new family" });
});

test("selectSitemapFiles: a scope change re-opens every irrelevant family (new INDEX_ONLY prefix)", () => {
  const memo = { cli: { relevant: false, checked: "2026-10-01", scope: "oldsig" }, dotnet: { relevant: false, checked: "2026-10-01" } };
  const out = selectSitemapFiles(files("cli", "dotnet"), memo, { scopeSig: sig, today: "2026-10-05" });
  assert.deepEqual(out.selected.map((f) => f.family), ["cli", "dotnet"]);
  assert.equal(out.reasons.cli, "scope changed");
  assert.equal(out.reasons.dotnet, "scope changed", "an old memo entry without a scope field counts as stale");
});

test("selectSitemapFiles: FULL_DISCOVERY downloads everything", () => {
  const memo = { dotnet: { relevant: false, checked: "2026-10-04", scope: sig } };
  const out = selectSitemapFiles(files("dotnet", "x"), memo, { full: true, scopeSig: sig, today: "2026-10-05" });
  assert.equal(out.selected.length, 2);
  assert.deepEqual(Object.values(out.reasons), ["full discovery", "full discovery"]);
});

test("selectSitemapFiles: aged irrelevant families are re-looked-at, oldest first, capped per run", () => {
  const memo = {
    a: { relevant: false, checked: "2026-08-01", scope: sig },
    b: { relevant: false, checked: "2026-08-03", scope: sig },
    c: { relevant: false, checked: "2026-08-02", scope: sig },
    d: { relevant: false, checked: "2026-10-01", scope: sig },
  };
  const out = selectSitemapFiles(files("a", "b", "c", "d"), memo, { scopeSig: sig, today: "2026-10-05", recheckDays: 28, maxRechecks: 2 });
  assert.deepEqual(out.selected.map((f) => f.family), ["a", "c"]);
  assert.deepEqual(out.skipped, ["b", "d"]);
  // recheckDays <= 0 disables the periodic look entirely
  const none = selectSitemapFiles(files("a"), memo, { scopeSig: sig, today: "2026-10-05", recheckDays: 0 });
  assert.equal(none.selected.length, 0);
});

test("selectSitemapFiles: all files of a selected family are downloaded", () => {
  const two = [...files("azure"), { loc: "https://learn.microsoft.com/_sitemaps/azure_en-us_2.xml", family: "azure", locale: "en-us" }];
  const out = selectSitemapFiles(two, { azure: { relevant: true, scope: sig } }, { scopeSig: sig, today: "2026-10-05" });
  assert.equal(out.selected.length, 2);
});

test("updateFamilies: relevance covers either scope; failures never flip an answer to false", () => {
  const memo = {
    kept: { relevant: true, checked: "2026-09-01", scope: "old" },
    flaky: { relevant: true, checked: "2026-09-01", scope: "old" },
    half: { relevant: false, checked: "2026-09-01", scope: "old" },
    gone: { relevant: false },
  };
  const outcomes = new Map([
    ["empty", { failed: 0, inScope: 0 }], // downloaded fully, nothing in scope
    ["cli", { failed: 0, inScope: 120 }], // only INDEX_ONLY rows are in scope here
    ["flaky", { failed: 1, inScope: 0 }], // the failed file may hold the URLs
    ["half", { failed: 1, inScope: 0 }],
  ]);
  const next = updateFamilies(memo, ["kept", "flaky", "half", "empty", "cli", "fresh"], outcomes, { scopeSig: "sigX", today: "2026-10-05" });
  assert.deepEqual(next.cli, { relevant: true, checked: "2026-10-05", scope: "sigX" });
  assert.deepEqual(next.empty, { relevant: false, checked: "2026-10-05", scope: "sigX" });
  assert.deepEqual(next.flaky, memo.flaky);
  assert.deepEqual(next.half, memo.half);
  assert.deepEqual(next.kept, memo.kept, "not downloaded: unchanged");
  assert.deepEqual(next.fresh, {}, "never seen and failed/not downloaded: no answer yet, so it is downloaded next time");
  assert.equal("gone" in next, false, "families that left the sitemap index are dropped");
  assert.deepEqual(Object.keys(next), ["cli", "empty", "flaky", "fresh", "half", "kept"], "sorted by code point");
});

test("daysBetween", () => {
  assert.equal(daysBetween("2026-10-01", "2026-10-05"), 4);
  assert.equal(daysBetween("2026-10-05", "2026-10-05"), 0);
});
