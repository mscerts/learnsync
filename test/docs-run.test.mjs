import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../scripts/lib/docs-config.mjs";
import { runDocsSync } from "../scripts/lib/docs-run.mjs";
import { FakeLearn, ORIGIN, baseLearn, byPath, harness, indexLines, readCatalog, run, stable } from "./docs-fixtures.mjs";

// The fake Learn, the temp data directory and run() live in docs-fixtures.mjs (shared with docs-changes.test.mjs).

// ---- scenarios -------------------------------------------------------------------------------

test("first run builds every file from nothing, with the contract's formats", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  const r = await run(h, learn);
  assert.equal(r.exitCode, 0, r.messages.join("\n"));

  // index: every sitemap URL of BOTH scopes, canonical, sorted by code point, no page fetch for the index-only one
  const lines = indexLines(h);
  assert.equal(lines.length, 24 + 3 + 4 + 1);
  assert.ok(lines.includes("/cli/azure/vm\t2026-09-01"));
  assert.deepEqual(lines, [...lines].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  assert.ok(r.probes.every((p) => !p.path.startsWith("/cli")), "no probe for an index-only page");

  // catalog: metadata for LEARN_SCOPE only, with checked/lastmod
  const catalog = readCatalog(h);
  assert.equal(catalog.length, 24 + 3 + 4);
  assert.ok(catalog.every((x) => x.checked === "2026-10-05" && x.lastmod && x.title.startsWith("Page ")));
  assert.equal(byPath(catalog).has("/cli/azure/vm"), false);

  assert.deepEqual(h.json("docs-redirects.json"), []);
  assert.deepEqual(h.json("docs-catalog-invalid.json"), []);
  const families = h.json("docs-sitemap-families.json");
  assert.deepEqual(Object.keys(families), ["azure", "cli", "entra"]);
  assert.equal(families.cli.relevant, true, "a family holding only index-only URLs is relevant");

  const status = h.json("status.json");
  assert.equal(status.schemaVersion, 1);
  assert.deepEqual(
    { ...status.docs, generatedAt: typeof status.docs.generatedAt },
    {
      generatedAt: "string",
      runId: null,
      indexUrls: 32,
      catalogRecords: 31,
      sitemapMaxLastmod: "2026-09-22",
      pendingNew: 0,
      deferredChanged: 0,
      deferredMissing: 0,
      quarantined: 0,
      redirects: 0,
      sitemapFailures: 0,
      complete: true,
      changes: { removed: 0, moved: 0 },
    }
  );

  // change files: created (data/changes/), empty, stamped with this run
  for (const name of ["removed", "moved"]) {
    assert.deepEqual(h.json(`changes/${name}.json`), {
      schemaVersion: 1,
      generatedAt: status.docs.generatedAt,
      sources: { learn: null, docs: status.docs.generatedAt },
      entries: [],
    });
  }
  assert.equal(r.written.changes, true);
});

test("a second run over unchanged sitemaps is stable: no fetch, no data rewrite, only the heartbeat moves", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  const before = h.snapshot();
  const r = await run(h, learn, { when: "2026-10-05T11:00:00Z" });
  assert.equal(r.exitCode, 0);
  assert.ok(r.probes.every((p) => p.readHead === false), "only status checks (verification), no page fetch");
  assert.equal(r.summary.stats.fetched, 0);
  assert.equal(r.written.catalog, false);
  assert.equal(r.written.index, false);
  const after = h.snapshot();
  assert.deepEqual(Object.keys(after), Object.keys(before));
  for (const name of Object.keys(before)) {
    if (name !== "status.json" && !name.startsWith("changes/")) assert.equal(after[name], before[name], `${name} must not change`);
  }
  assert.notEqual(after["status.json"], before["status.json"], "status.json is written even when nothing else changed");
  assert.equal(JSON.parse(after["status.json"]).docs.generatedAt, "2026-10-05T11:00:00.000Z");

  // the change files carry the run's timestamp (sources.docs = "refreshed by the run at ..."), nothing else moves
  for (const name of ["changes/removed.json", "changes/moved.json"]) {
    const [was, now] = [JSON.parse(before[name]), JSON.parse(after[name])];
    assert.equal(now.generatedAt, "2026-10-05T11:00:00.000Z");
    assert.equal(now.sources.docs, "2026-10-05T11:00:00.000Z");
    assert.deepEqual({ ...now, generatedAt: null, sources: null }, { ...was, generatedAt: null, sources: null }, `${name}: entries unchanged`);
  }
});

test("lifecycle: change, removal, restore, move and reappearance across runs", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn); // week 0

  // week 1: a changed, d is new, b dropped from the sitemap and is gone, c dropped but still live
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-10-10"], ["/azure/d", "2026-10-11"]]);
  learn.page("/azure/a", { title: "A version two" });
  learn.page("/azure/b", "gone");
  const w1 = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(w1.exitCode, 0, w1.messages.join("\n"));
  let catalog = byPath(readCatalog(h));
  assert.equal(catalog.get("/azure/a").title, "A version two");
  assert.equal(catalog.get("/azure/a").lastmod, "2026-10-10");
  assert.ok(catalog.has("/azure/d"), "new page fetched");
  assert.equal(catalog.has("/azure/b"), false, "gone page left the catalog");
  assert.ok(catalog.has("/azure/c"), "live page that fell out of the sitemaps stays");
  let invalid = h.json("docs-catalog-invalid.json");
  assert.deepEqual(invalid.map((q) => [q.url, q.status, q.firstDetected]), [[`${ORIGIN}/azure/b`, 404, "2026-10-12"]]);
  let lines = indexLines(h);
  assert.ok(lines.includes("/azure/c\t2026-09-22"), "live-but-unlisted keeps its previous lastmod in the index");
  assert.ok(!lines.some((l) => l.startsWith("/azure/b\t")));
  assert.ok(lines.some((l) => l.startsWith("/azure/d\t")));
  assert.match(readFileSync(w1.reportFile, "utf-8"), /azure\/b/);
  assert.equal(readFileSync(w1.githubOutput, "utf-8"), "new_quarantine_count=1\n");

  // week 2: b is restored (still not in the sitemap): the quarantine re-check releases it
  learn.page("/azure/b", "live");
  const w2 = await run(h, learn, { when: "2026-10-19T10:00:00Z" });
  assert.equal(w2.exitCode, 0, w2.messages.join("\n"));
  assert.deepEqual(h.json("docs-catalog-invalid.json"), []);
  catalog = byPath(readCatalog(h));
  assert.equal(catalog.get("/azure/b").lastmod, "released");
  assert.ok(indexLines(h).some((l) => l.startsWith("/azure/b\t")));
  assert.equal(readFileSync(w2.githubOutput, "utf-8"), "new_quarantine_count=1\n", "no new quarantine in week 2, so nothing is appended");

  // week 3: c now redirects elsewhere: ledger entry, gone from index and catalog
  learn.page("/azure/c", { to: "/azure/c-new" });
  const w3 = await run(h, learn, { when: "2026-10-26T10:00:00Z" });
  assert.equal(w3.exitCode, 0, w3.messages.join("\n"));
  assert.deepEqual(h.json("docs-redirects.json"), [
    { from: "/azure/c", to: "/azure/c-new", kind: "moved", status: 301, firstSeen: "2026-10-26", lastSeen: "2026-10-26" },
  ]);
  assert.ok(!indexLines(h).some((l) => l.startsWith("/azure/c\t")));
  assert.equal(byPath(readCatalog(h)).has("/azure/c"), false);
  assert.equal(h.json("status.json").docs.redirects, 1);

  // week 4: the sitemap lists c again: the ledger entry is deleted and c is a new page
  learn.page("/azure/c", "live");
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-10-10"], ["/azure/c", "2026-11-01"], ["/azure/d", "2026-10-11"]]);
  const w4 = await run(h, learn, { when: "2026-11-02T10:00:00Z" });
  assert.equal(w4.exitCode, 0, w4.messages.join("\n"));
  assert.deepEqual(h.json("docs-redirects.json"), []);
  assert.ok(byPath(readCatalog(h)).has("/azure/c"));
  assert.ok(indexLines(h).some((l) => l.startsWith("/azure/c\t2026-11-01")));
});

test("a sitemap file that fails: index and records carried forward, nothing removed, exit 1 after writing", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  const beforeIndex = h.read("docs-urls.txt");
  const beforeCatalog = readCatalog(h).length;

  learn.failFamily("entra", 500); // 4 of 32 pages: above the sanity ratio, so the run goes on
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/b", "2026-09-21"]]); // c really left the sitemap
  learn.page("/azure/c", "gone"); // would be quarantined if removal detection were on
  const r = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(r.exitCode, 1);
  assert.equal(h.read("docs-urls.txt"), beforeIndex, "the index file is not rewritten");
  assert.equal(readCatalog(h).length, beforeCatalog, "no record is removed while removal detection is off");
  assert.deepEqual(h.json("docs-catalog-invalid.json"), []);
  assert.ok(!r.probes.some((p) => p.path === "/azure/c"), "missing-from-sitemap URLs are not probed");
  const s = h.json("status.json").docs;
  assert.equal(s.sitemapFailures, 1);
  assert.equal(s.complete, false);
  assert.equal(s.indexUrls, 32, "reports the index that is actually on disk");
  assert.ok(r.messages.some((m) => /DEGRADED/.test(m)));
});

test("failsafe: a sitemap pass far below last run's index aborts without touching ANY file", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  const before = h.snapshot();

  learn.family("azure", stable("azure", 6)); // an outage-sized pass: 7 of 32
  learn.family("entra", []);
  const r = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(r.exitCode, 1);
  assert.match(r.aborted, /outage or a format change/);
  assert.deepEqual(h.snapshot(), before, "every file, status.json included, is byte-identical");
  assert.equal(r.probes.length, 0, "aborted before any page probe");
});

test("failsafe: first run without an index compares against the previous catalog", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  const catalogBefore = h.read("docs-catalog.json");
  rmSync(h.file("docs-urls.txt")); // an old checkout without the index
  learn.family("azure", stable("azure", 3));
  learn.family("entra", []);
  const r = await run(h, learn);
  assert.equal(r.exitCode, 1);
  assert.match(r.aborted, /previous catalog/);
  assert.equal(h.read("docs-catalog.json"), catalogBefore);
});

test("failsafe: mass quarantine would shrink the catalog below 60% and aborts the write", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  const before = h.snapshot();
  for (const [p] of [...stable("azure", 24), ...stable("entra", 4)]) learn.page(p, "gone"); // a false-positive storm
  const r = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(r.exitCode, 1);
  assert.match(r.aborted, /catalog records, expected at least/);
  assert.deepEqual(h.snapshot(), before);
});

test("budget: the wall-clock deadline stops the fetch phase, everything gathered is written, the rest is deferred", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  // every page changed -> 31 queued fetches; each probe costs one fake minute; budget 5 minutes
  const changed = (prefix, n) => stable(prefix, n, "2026-10-15");
  learn.family("azure", [...changed("azure", 24), ["/azure/a", "2026-10-15"], ["/azure/b", "2026-10-15"], ["/azure/c", "2026-10-15"]]);
  learn.family("entra", changed("entra", 4));
  learn.tickMs = 60_000;
  const r = await run(h, learn, { when: "2026-10-16T10:00:00Z", env: { MAX_RUNTIME_MINUTES: "5" }, config: { concurrency: 1 } });
  assert.equal(r.exitCode, 0, "running out of time is not a failure");
  assert.equal(r.summary.stops.fetch, "deadline");
  assert.equal(r.probes.filter((p) => p.readHead).length, 5);
  const refreshed = readCatalog(h).filter((x) => x.lastmod === "2026-10-15");
  assert.equal(refreshed.length, 5, "what was fetched is written");
  const s = h.json("status.json").docs;
  assert.equal(s.deferredChanged, 26);
  assert.equal(s.complete, false);
  assert.equal(readCatalog(h).length, 31, "deferred pages keep their old records");
  // the next run (no more pressure) finishes the job
  learn.tickMs = 0;
  const r2 = await run(h, learn, { when: "2026-10-23T10:00:00Z", config: { concurrency: 1 } });
  assert.equal(h.json("status.json").docs.deferredChanged, 0);
  assert.equal(readCatalog(h).filter((x) => x.lastmod === "2026-10-15").length, 31);
  assert.equal(r2.exitCode, 0);
});

test("budget: a rate-limit storm trips the circuit breaker, the run is degraded (exit 1) but still writes", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  const changed = (prefix, n) => stable(prefix, n, "2026-10-15");
  learn.family("azure", [...changed("azure", 24), ["/azure/a", "2026-10-15"], ["/azure/b", "2026-10-15"], ["/azure/c", "2026-10-15"]]);
  learn.family("entra", changed("entra", 4));
  for (const [p] of [...changed("azure", 24), ...changed("entra", 4), ["/azure/a"], ["/azure/b"], ["/azure/c"]]) learn.page(p, "transient");
  const r = await run(h, learn, { when: "2026-10-16T10:00:00Z", env: { CONSECUTIVE_TRANSIENT_LIMIT: "3" }, config: { concurrency: 1 } });
  assert.equal(r.exitCode, 1);
  assert.equal(r.summary.stops.fetch, "breaker");
  assert.equal(r.probes.filter((p) => p.readHead).length, 3, "no request after the breaker tripped");
  assert.equal(readCatalog(h).length, 31, "previous records are all kept");
  const s = h.json("status.json").docs;
  assert.equal(s.deferredChanged, 31);
  assert.equal(s.complete, false);
  assert.equal(h.json("docs-catalog-invalid.json").length, 0, "a rate-limit storm never quarantines anything");
});

test("DRY_RUN reads the sitemaps and writes nothing at all", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  const r = await run(h, learn, { env: { DRY_RUN: "1" } });
  assert.equal(r.exitCode, 0);
  assert.equal(r.dryRun, true);
  assert.deepEqual(readdirSync(h.data), []);
  assert.equal(r.probes.length, 0);
  assert.equal(r.summary.rows, 32);
  assert.equal(r.summary.perPrefix.index.get("cli"), 1);
  assert.equal(r.summary.perPrefix.learn.get("azure"), 27);
  assert.ok(r.messages.some((m) => /DRY_RUN=1/.test(m)));
});

test("fetch cap: MAX_PAGE_FETCHES bounds the run and the backlog shows up as pendingNew", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  const r = await run(h, learn, { env: { MAX_PAGE_FETCHES: "10" } });
  assert.equal(r.exitCode, 0);
  assert.equal(r.probes.filter((p) => p.readHead).length, 10);
  const s = h.json("status.json").docs;
  assert.equal(s.pendingNew, 21);
  assert.equal(s.catalogRecords, 10);
  assert.equal(s.indexUrls, 32, "the index is complete regardless of the fetch cap");
});

test("case variants: orphans fold into the sitemap spelling and cost no probes", async (t) => {
  const h = harness(t);
  const learn = new FakeLearn();
  learn.family("azure", [...stable("azure", 6), ["/azure/Foo", "2026-09-01"]]);
  const rec = (url, title) => ({ title, url, product: null, subproduct: null, description: "d", lastmod: "2026-09-01" });
  const seed = [
    rec(`${ORIGIN}/azure/foo`, "lowercase orphan"),
    rec(`${ORIGIN}/azure/Foo`, "exact spelling"),
    rec(`${ORIGIN}/Azure/FOO`, "another orphan"),
    ...stable("azure", 6).map(([p]) => rec(`${ORIGIN}${p}`, `T ${p}`)),
  ];
  writeFileSync(h.file("docs-catalog.json"), JSON.stringify(seed));
  const r = await run(h, learn, { env: { VERIFY_PER_RUN: "0" } });
  assert.equal(r.exitCode, 0, r.messages.join("\n"));
  const catalog = readCatalog(h);
  assert.equal(catalog.length, 7);
  assert.deepEqual(catalog.filter((x) => /foo/i.test(x.url)).map((x) => [x.url, x.title]), [[`${ORIGIN}/azure/Foo`, "exact spelling"]]);
  assert.equal(r.probes.length, 0, "no refetch, no removal probe for any alias");
  assert.deepEqual(indexLines(h).filter((l) => /foo/.test(l)), ["/azure/foo\t2026-09-01"], "the index is canonical lowercase");
});

test("a damaged previous file aborts before anything is written", async (t) => {
  for (const [name, content] of [
    ["docs-catalog.json", "{not json"],
    ["docs-catalog-invalid.json", "{}"],
    ["docs-urls.txt", "no-leading-slash\t-\n"],
    ["docs-redirects.json", '{"a":1}'],
  ]) {
    const h = harness(t);
    writeFileSync(h.file(name), content);
    const r = await run(h, baseLearn());
    assert.equal(r.exitCode, 1, name);
    assert.ok(r.aborted, name);
    assert.deepEqual(readdirSync(h.data), [name], `${name}: nothing else written`);
    assert.equal(h.read(name), content);
  }
});

test("github/docs source: a failure carries its previous entries forward and degrades the run", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  const gh = { title: "gh", url: "https://docs.github.com/en/x", product: "p", subproduct: null, description: null };
  await run(h, learn, { git: async () => ({ records: [gh], failed: false }) });
  assert.ok(readCatalog(h).some((x) => x.url === gh.url));
  const r = await run(h, learn, { git: async ({ previous }) => ({ records: previous, failed: true }) });
  assert.equal(r.exitCode, 1);
  assert.ok(readCatalog(h).some((x) => x.url === gh.url), "previous git entries survive a failed clone");
});

test("an unreadable sitemap index is an abort with no output", async (t) => {
  const h = harness(t);
  const client = { stats: {}, get: async () => ({ status: 503, text: "" }), probe: async () => ({ status: null }) };
  const r = await runDocsSync({ dataDir: h.data, client, env: {}, config: readConfig({}), log: () => {}, warn: () => {}, sleep: async () => {} });
  assert.equal(r.exitCode, 1);
  assert.match(r.aborted, /sitemap index/);
  assert.deepEqual(readdirSync(h.data), []);
});

test("status.json: the docs section is replaced wholesale and the learn section is left alone", async (t) => {
  const h = harness(t);
  const learnSection = { generatedAt: "2026-10-01T00:00:00.000Z", runId: "7", modules: 3355 };
  writeFileSync(h.file("status.json"), JSON.stringify({ schemaVersion: 1, learn: learnSection, docs: { stale: true } }));
  const r = await run(h, baseLearn(), { env: { GITHUB_RUN_ID: "123" }, config: {} });
  assert.equal(r.exitCode, 0);
  const status = h.json("status.json");
  assert.deepEqual(status.learn, learnSection);
  assert.equal("stale" in status.docs, false);
  assert.equal(status.docs.indexUrls, 32);
});

test("sitemap families: irrelevant ones are skipped on later runs, FULL_DISCOVERY revisits them, a scope change re-opens them", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  learn.family("dotnet", [["/dotnet/api/system.string", "2026-09-01"], ["/dotnet/api/system.int32", "2026-09-01"]]);
  await run(h, learn);
  assert.equal(h.json("docs-sitemap-families.json").dotnet.relevant, false);
  assert.ok(learn.gets.some((u) => u.includes("dotnet_en-us_1")), "a never-seen family is downloaded once");

  const second = await run(h, learn, { when: "2026-10-06T10:00:00Z" });
  assert.ok(!second.gets.some((u) => u.includes("dotnet_en-us_1")), "known irrelevant: skipped");
  assert.ok(second.gets.some((u) => u.includes("azure_en-us_1")), "relevant: always downloaded");

  const full = await run(h, learn, { when: "2026-10-07T10:00:00Z", env: { FULL_DISCOVERY: "1" } });
  assert.ok(full.gets.some((u) => u.includes("dotnet_en-us_1")), "FULL_DISCOVERY downloads everything");

  // a consumer starts linking to /dotnet: it is added to INDEX_ONLY_SCOPE, the family is re-opened and its URLs indexed
  const scopes = {
    learn: { include: ["azure", "entra", "fabric"], exclude: ["azure/templates"] },
    index: { include: ["cli", "dotnet"], exclude: [] },
  };
  const third = await run(h, learn, { when: "2026-10-08T10:00:00Z", scopes });
  assert.equal(third.exitCode, 0, third.messages.join("\n"));
  assert.ok(third.gets.some((u) => u.includes("dotnet_en-us_1")), "scope changed: the family is looked at again");
  assert.ok(indexLines(h).includes("/dotnet/api/system.string\t2026-09-01"));
  assert.equal(byPath(readCatalog(h)).has("/dotnet/api/system.string"), false, "index-only prefixes get no metadata record");
  assert.equal(h.json("docs-sitemap-families.json").dotnet.relevant, true);
});

test("failsafe: a systemic duplicate/alias explosion aborts the write; a few are cleaned up with a warning", async (t) => {
  const mk = (i, upper) => ({ title: `gh ${i}`, url: `https://docs.github.com/en/${upper ? "Page" : "page"}-${i}`, product: "p", subproduct: null, description: null });
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  const before = h.snapshot();

  // 60 alias pairs (over the threshold of 50): abort, nothing is written
  const many = Array.from({ length: 60 }, (_, i) => [mk(i, true), mk(i, false)]).flat();
  const bad = await run(h, learn, { git: async () => ({ records: many, failed: false }) });
  assert.equal(bad.exitCode, 1);
  assert.match(bad.aborted, /duplicate audit: 0 exact and 60 case-variant/);
  assert.deepEqual(h.snapshot(), before);

  // 3 alias pairs: the first of each is kept and the run succeeds
  const few = Array.from({ length: 3 }, (_, i) => [mk(i, true), mk(i, false)]).flat();
  const ok = await run(h, learn, { when: "2026-10-06T10:00:00Z", git: async () => ({ records: few, failed: false }) });
  assert.equal(ok.exitCode, 0, ok.messages.join("\n"));
  assert.equal(readCatalog(h).filter((x) => x.url.startsWith("https://docs.github.com")).length, 3);
  assert.ok(ok.messages.some((m) => /case-variant URL group/.test(m)));
});
