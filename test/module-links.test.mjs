import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MODULE_LINKS_LIMITS,
  MODULE_LINKS_SCHEMA_VERSION,
  applyDecisions,
  breakerTripped,
  decideOffline,
  decideProbe,
  learnPaths,
  planProbes,
  buildFile,
  buildRecord,
  classifyLink,
  decodeText,
  evaluateFailsafes,
  extractUnitLinks,
  learnKind,
  planHarvest,
  readPrevious,
  scopeModulePaths,
  splitSections,
  stableContent,
  summarizeRecords,
  unitContent,
} from "../scripts/lib/module-links.mjs";

const MODULE = "/training/modules/intro-to-azure-load-balancer";

// Trimmed from the real last unit of /training/modules/intro-to-azure-load-balancer (2026-10-16): the
// content ends at the hidden #next-section placeholder, the feedback area comes after it.
const UNIT_PAGE = `<html><body><nav><a href="/en-us/training/">Training</a></nav>
<div id="unit-inner-section" class="section is-uniform position-relative"> <h1 id="module-unit-title" class="margin-right-xxl-desktop">Summary</h1>
<ul> <li>2 minutes</li> </ul>
<p>In this module, you learned about <a href="/en-us/azure/load-balancer/load-balancer-overview?azure-portal=true">Azure Load Balancer</a> &amp; its types.</p>
<h2>Learn more</h2>
<ul>
<li><a href="/en-us/azure/load-balancer/load-balancer-overview?azure-portal=true" data-linktype="absolute-path">What is Azure Load Balancer?</a></li>
<li><a href="/en-us/azure/architecture/guide/technology-choices/load-balancing-overview?azure-portal=true">Load-balancing options</a></li>
<li><a href="/en-us/azure/load-balancer/components?azure-portal=true#frontend">Azure Load Balancer components</a></li>
<li><a href="/en-us/training/modules/intro-to-azure-load-balancer/">Module: Introduction to Azure Load Balancer</a></li>
<li><a href="/en-us/training/modules/configure-network-watcher/">Configure Network Watcher</a></li>
<li><a href="https://github.com/Azure/azure-quickstart-templates#readme">Quickstart templates</a></li>
</ul>
<h2>Learn more with Copilot</h2>
<p>Copilot can help. <a href="https://copilot.microsoft.com/">copilot.microsoft.com</a></p>
<script>var x = '<a href="/en-us/azure/never-this">no</a>';</script>
</div>
<div id="next-section" class="modular-content-container" hidden=""> </div>
<!-- Feedback area -->
<a href="https://github.com/MicrosoftDocs/learn/issues">Edit this page</a>
</body></html>`;

test("decodeText removes tags, decodes entities and collapses whitespace", () => {
  assert.equal(decodeText("<b>A &amp; B</b>\n  it&#39;s &#x27;ok&#x27; &nbsp;done &quot;x&quot; &unknown;"), "A & B it's 'ok' done \"x\" &unknown;");
  assert.equal(decodeText(undefined), "");
  assert.equal(decodeText("&#0; &#99999999;"), "&#0; &#99999999;");
});

test("unitContent runs from the unit section to the hidden next-section placeholder and drops scripts", () => {
  const content = unitContent(UNIT_PAGE);
  assert.ok(content.startsWith('id="unit-inner-section"'));
  assert.ok(content.includes("Load-balancing options"));
  assert.ok(!content.includes("Edit this page"), "the feedback area is after the end marker");
  assert.ok(!content.includes("never-this"), "scripts are removed");
  assert.equal(unitContent("<html>no unit here</html>"), null);
  assert.equal(unitContent('<div id="unit-inner-section">no end marker</div><a href="/x">footer</a>'), null, "no end marker: the footer would leak in");
  assert.equal(unitContent(null), null);
});

test("splitSections gives the lead and one section per h2", () => {
  const sections = splitSections('<p>lead <a href="/a">a</a></p><h2 class="x">Learn more</h2><ul><li><a href="/b">b</a></li></ul><h2>Next &amp; more</h2>tail');
  assert.deepEqual(sections.map((s) => s.section), ["lead", "Learn more", "Next & more"]);
  assert.ok(sections[0].html.includes('href="/a"'));
  assert.ok(sections[1].html.includes('href="/b"'));
  assert.equal(splitSections("no headings").length, 1);
});

test("learnKind tells training, other Learn areas and documentation apart", () => {
  assert.equal(learnKind("/training/modules/x"), "training");
  assert.equal(learnKind("/training/paths/x"), "training");
  assert.equal(learnKind("/credentials/certifications/x"), "learn-other");
  assert.equal(learnKind("/shows/azure"), "learn-other");
  assert.equal(learnKind("/azure/storage/blobs"), "docs");
  assert.equal(learnKind("/entra/identity/users/x"), "docs");
  assert.equal(learnKind("/answers-not-really"), "docs");
});

test("classifyLink canonicalises Learn links and keeps external ones whole", () => {
  assert.deepEqual(classifyLink("/en-us/azure/load-balancer/load-balancer-overview?azure-portal=true", MODULE), { kind: "docs", path: "/azure/load-balancer/load-balancer-overview" });
  assert.deepEqual(classifyLink("https://learn.microsoft.com/azure/Storage/Blobs/?WT.mc_id=x#top", MODULE), { kind: "docs", path: "/azure/storage/blobs" });
  assert.deepEqual(classifyLink("/en-us/training/modules/configure-network-watcher/", MODULE), { kind: "training", path: "/training/modules/configure-network-watcher" });
  assert.deepEqual(classifyLink("/en-us/credentials/certifications/exams/az-104/", MODULE), { kind: "learn-other", path: "/credentials/certifications/exams/az-104" });
  assert.deepEqual(classifyLink("https://github.com/Azure/x?tab=readme#install", MODULE), { kind: "external", url: "https://github.com/Azure/x?tab=readme" });
  assert.deepEqual(classifyLink("https://youtu.be/abc123", MODULE), { kind: "external", url: "https://youtu.be/abc123" });
  assert.deepEqual(classifyLink("../../azure/x", MODULE), { kind: "docs", path: "/azure/x" }, "a relative link resolves against the Learn root");
});

test("classifyLink drops anchors, other schemes, the root and the module itself", () => {
  for (const href of ["", "#section", "mailto:a@b.c", "javascript:void(0)", "tel:123", "ftp://x/y", "https://learn.microsoft.com/", "http://[bad"]) {
    assert.equal(classifyLink(href, MODULE), null, href);
  }
  assert.equal(classifyLink("/en-us/training/modules/intro-to-azure-load-balancer/", MODULE), null);
  assert.equal(classifyLink("/en-us/training/modules/intro-to-azure-load-balancer/3-when-to-use", MODULE), null);
  assert.deepEqual(classifyLink("/en-us/training/modules/intro-to-azure-load-balancer-2/", MODULE), { kind: "training", path: "/training/modules/intro-to-azure-load-balancer-2" }, "a module with a longer slug is another module");
});

test("extractUnitLinks reads a real-shaped last unit: page order, deduped, Copilot section skipped, own module dropped", () => {
  const result = extractUnitLinks(UNIT_PAGE, { modulePath: MODULE });
  assert.equal(result.unitTitle, "Summary");
  assert.deepEqual(
    result.links.map((l) => [l.kind, l.path ?? l.url, l.text, l.section]),
    [
      ["docs", "/azure/load-balancer/load-balancer-overview", "Azure Load Balancer", "lead"],
      ["docs", "/azure/architecture/guide/technology-choices/load-balancing-overview", "Load-balancing options", "Learn more"],
      ["docs", "/azure/load-balancer/components", "Azure Load Balancer components", "Learn more"],
      ["training", "/training/modules/configure-network-watcher", "Configure Network Watcher", "Learn more"],
      ["external", "https://github.com/Azure/azure-quickstart-templates", "Quickstart templates", "Learn more"],
    ],
  );
});

test("extractUnitLinks returns an empty list for a unit without links and null for a page without unit content", () => {
  const empty = extractUnitLinks('<div id="unit-inner-section"><h1 id="module-unit-title">Summary</h1><p>Nothing to read.</p></div><div id="next-section"></div>', { modulePath: MODULE });
  assert.deepEqual(empty, { unitTitle: "Summary", links: [] });
  assert.equal(extractUnitLinks("<html></html>", { modulePath: MODULE }), null);
  const noHref = extractUnitLinks('<div id="unit-inner-section"><a name="x">anchor</a><a href="">e</a></div><div id="next-section"></div>', { modulePath: MODULE });
  assert.deepEqual(noHref.links, []);
});

test("extractUnitLinks skips feedback, knowledge-check and objective sections and caps long text", () => {
  const long = "x".repeat(300);
  const html = `<div id="unit-inner-section"><h1 id="module-unit-title">Summary</h1>
<h2>Check your knowledge</h2><a href="/azure/skip-1">s</a>
<h2>Provide feedback</h2><a href="/azure/skip-2">s</a>
<h2>Additional resources</h2><a href="/azure/keep">${long}</a>
</div><div id="next-section"></div>`;
  const links = extractUnitLinks(html, { modulePath: MODULE }).links;
  assert.deepEqual(links.map((l) => l.path), ["/azure/keep"]);
  assert.equal(links[0].text.length, 200);
});

test("scopeModulePaths: 'all' is the catalog, 'courses' follows course study guides to paths and modules", () => {
  const catalogModules = [
    { uid: "learn.a", path: "/training/modules/a" },
    { uid: "learn.b", path: "/training/modules/b" },
    { uid: "learn.c", path: "/training/modules/c" },
    { uid: "learn.d", path: "/training/modules/d" },
  ];
  assert.deepEqual([...scopeModulePaths({ scope: "all", catalogModules }).paths].sort(), catalogModules.map((m) => m.path));
  const learningPaths = [
    { uid: "learn.path-1", modules: ["/training/modules/a", "/training/modules/b"] },
    { uid: "learn.path-2", modules: ["/training/modules/c"] },
  ];
  const courses = [
    { study_guide: [{ uid: "learn.path-1", type: "learningPath" }, { uid: "learn.d", type: "module" }, { uid: "learn.gone", type: "module" }] },
    { study_guide: [{ uid: "learn.path-1", type: "learningPath" }] },
    {},
  ];
  const moduleUidToPath = new Map(catalogModules.map((m) => [m.uid, m.path]));
  const { paths, unknown } = scopeModulePaths({ scope: "courses", catalogModules, courses, learningPaths, moduleUidToPath });
  assert.deepEqual([...paths].sort(), ["/training/modules/a", "/training/modules/b", "/training/modules/d"]);
  assert.equal(unknown, 1);
});

function catalogModule(slug, sig = "sig-1", units = ["1-introduction", "2-summary"]) {
  return { uid: `learn.${slug}`, path: `/training/modules/${slug}`, unitSig: sig, unitUrls: units.map((u) => `/training/modules/${slug}/${u}`) };
}

test("planHarvest fetches new, then changed, then (full refresh) the oldest harvests, within the cap", () => {
  const catalogModules = [catalogModule("new"), catalogModule("changed", "sig-2"), catalogModule("same"), catalogModule("old-a"), catalogModule("old-b"), catalogModule("outside")];
  const scopePaths = new Set(catalogModules.filter((m) => !m.path.endsWith("outside")).map((m) => m.path));
  const rec = (slug, sig, harvestedAt) => ({ path: `/training/modules/${slug}`, unitSig: sig, unit: "x", links: [], harvestedAt });
  const previous = [rec("changed", "sig-1", "2026-09-01"), rec("same", "sig-1", "2026-10-01"), rec("old-a", "sig-1", "2026-08-01"), rec("old-b", "sig-1", "2026-07-01")];
  const incremental = planHarvest({ catalogModules, scopePaths, previous, fullRefresh: false, maxFetches: 100 });
  assert.deepEqual(incremental.toFetch.map((c) => c.module.path.split("/").pop()), ["new", "changed"]);
  assert.equal(incremental.waiting, 0);
  assert.equal(incremental.toFetch[0].unit, "/training/modules/new/2-summary", "the LAST unit");
  const full = planHarvest({ catalogModules, scopePaths, previous, fullRefresh: true, maxFetches: 100 });
  assert.deepEqual(full.toFetch.map((c) => c.module.path.split("/").pop()), ["new", "changed", "old-b", "old-a", "same"]);
  const capped = planHarvest({ catalogModules, scopePaths, previous, fullRefresh: true, maxFetches: 3 });
  assert.deepEqual(capped.toFetch.map((c) => c.module.path.split("/").pop()), ["new", "changed", "old-b"]);
  assert.equal(capped.waiting, 2);
});

test("planHarvest skips modules without unit URLs or signature and reports them", () => {
  const catalogModules = [catalogModule("ok"), { uid: "learn.nu", path: "/training/modules/nu", unitSig: "s", unitUrls: null }, { uid: "learn.ns", path: "/training/modules/ns", unitUrls: ["/training/modules/ns/1"] }, { uid: "learn.empty", path: "/training/modules/empty", unitSig: "s", unitUrls: [] }];
  const plan = planHarvest({ catalogModules, scopePaths: new Set(catalogModules.map((m) => m.path)), previous: null, fullRefresh: false, maxFetches: 10 });
  assert.deepEqual(plan.toFetch.map((c) => c.module.path), ["/training/modules/ok"]);
  assert.deepEqual(plan.noUnits, ["/training/modules/empty", "/training/modules/ns", "/training/modules/nu"]);
});

test("summarizeRecords counts modules, modules with links and links by kind", () => {
  const records = [
    { links: [{ kind: "docs" }, { kind: "docs" }, { kind: "external" }] },
    { links: [] },
    { links: [{ kind: "training" }] },
  ];
  assert.deepEqual(summarizeRecords(records), { modules: 3, withLinks: 2, links: 4, byKind: { docs: 2, training: 1, "learn-other": 0, external: 1 } });
  assert.deepEqual(summarizeRecords([]), { modules: 0, withLinks: 0, links: 0, byKind: { docs: 0, training: 0, "learn-other": 0, external: 0 } });
});

test("evaluateFailsafes: a healthy run passes and every rule trips on its own", () => {
  const healthy = { scope: "courses", scopeSize: 1400, attempted: 100, failed: 2, layoutFailed: 1, previousWithLinks: 500, nextWithLinks: 520 };
  assert.deepEqual(evaluateFailsafes(healthy), []);
  assert.match(evaluateFailsafes({ ...healthy, scopeSize: 120 })[0], /only 120 modules are in scope "courses" \(floor 300\)/);
  assert.match(evaluateFailsafes({ ...healthy, failed: 12 })[0], /12 of 100 unit pages could not be read/);
  assert.match(evaluateFailsafes({ ...healthy, layoutFailed: 15 })[0], /no unit content: Learn probably changed its page markup/);
  assert.match(evaluateFailsafes({ ...healthy, nextWithLinks: 300 })[0], /only 300 modules have links now, 500 had them before/);
  // small samples never trip the percentage rules
  assert.deepEqual(evaluateFailsafes({ ...healthy, attempted: 10, failed: 5, layoutFailed: 3 }), []);
  assert.deepEqual(evaluateFailsafes({ ...healthy, previousWithLinks: 20, nextWithLinks: 2 }), []);
  assert.deepEqual(evaluateFailsafes({ ...healthy, scope: "all", scopeSize: 3300 }), []);
  assert.equal(evaluateFailsafes({ ...healthy, scope: "all", scopeSize: 1400 }).length, 1);
});

test("breakerTripped needs enough requests and more than half failed", () => {
  assert.equal(breakerTripped({ attempted: 49, failed: 49 }), false);
  assert.equal(breakerTripped({ attempted: 50, failed: 25 }), false);
  assert.equal(breakerTripped({ attempted: 50, failed: 26 }), true);
});

test("buildFile sorts records by code point and stableContent ignores lastChecked only", () => {
  const record = (path) => ({ path, unitSig: "s", unit: "u", links: [] });
  const file = buildFile({ records: [record("/training/modules/b"), record("/training/modules/B"), record("/training/modules/a")], scope: "courses", lastChecked: "2026-10-16T00:00:00.000Z", fullRefreshAt: "2026-10-16" });
  assert.equal(file.schemaVersion, MODULE_LINKS_SCHEMA_VERSION);
  assert.deepEqual(file.modules.map((m) => m.path), ["/training/modules/B", "/training/modules/a", "/training/modules/b"]);
  assert.equal(stableContent(file), stableContent({ ...file, lastChecked: "other" }));
  assert.notEqual(stableContent(file), stableContent({ ...file, scope: "all" }));
  assert.equal(buildFile({ records: [], scope: "all", lastChecked: "x" }).fullRefreshAt, null);
});

test("buildRecord keeps what the run needs per module", () => {
  const record = buildRecord({ module: { path: "/training/modules/m", unitSig: "abc" }, unit: "/training/modules/m/2-summary", extracted: { unitTitle: "Summary", links: [{ kind: "docs", path: "/azure/x", text: "x", section: "Learn more" }] }, today: "2026-10-16" });
  assert.deepEqual(record, { path: "/training/modules/m", unitSig: "abc", unit: "/training/modules/m/2-summary", unitTitle: "Summary", harvestedAt: "2026-10-16", links: [{ kind: "docs", path: "/azure/x", text: "x", section: "Learn more" }] });
});

test("readPrevious accepts no file and a good file and rejects what it cannot read", () => {
  assert.equal(readPrevious(null), null);
  const good = buildFile({ records: [{ path: "/training/modules/a", unitSig: "s", unit: "u", links: [{ kind: "docs", path: "/azure/x" }, { kind: "external", url: "https://x.y/" }] }], scope: "courses", lastChecked: "x" });
  assert.equal(readPrevious(good), good);
  assert.throws(() => readPrevious({ ...good, schemaVersion: 2 }), /schemaVersion 2, expected 1/);
  assert.throws(() => readPrevious({ schemaVersion: 1, modules: {} }), /`modules` is not an array/);
  assert.throws(() => readPrevious({ ...good, modules: [{ path: "/training/modules/a" }] }), /malformed record "\/training\/modules\/a"/);
  assert.throws(() => readPrevious({ ...good, modules: [{ path: "p", unitSig: "s", unit: "u", links: [{ kind: "docs" }] }] }), /malformed record/);
});

test("the limits table is complete", () => {
  for (const key of ["MIN_SCOPE_MODULES", "MAX_FAIL_PCT", "FAIL_MIN_SAMPLE", "BREAKER_MIN", "MAX_LAYOUT_FAIL_PCT", "MIN_KEPT_WITH_LINKS_PCT", "WITH_LINKS_MIN_PREVIOUS", "MAX_FETCHES", "FULL_REFRESH_DAYS", "MAX_PROBES", "RECHECK_DAYS", "MAX_PROBE_UNKNOWN_PCT", "MAX_DROP_PCT"]) {
    assert.ok(key in MODULE_LINKS_LIMITS, key);
  }
});

// ------------------------------------------------------------------------------------------------
// link cleaning
// ------------------------------------------------------------------------------------------------

const link = (path, extra = {}) => ({ kind: "docs", path, text: path.split("/").pop(), section: "Learn more", ...extra });
const rec = (slug, links) => ({ path: `/training/modules/${slug}`, unitSig: "s", unit: "u", links });

test("learnPaths lists the unique Learn targets of the checkable kinds, sorted", () => {
  const records = [
    rec("a", [link("/azure/z"), link("/azure/a"), { kind: "external", url: "https://x.y/", text: "x", section: "s" }, { kind: "training", path: "/training/modules/m", text: "m", section: "s" }]),
    rec("b", [link("/azure/a"), { kind: "learn-other", path: "/credentials/x", text: "c", section: "s" }]),
  ];
  assert.deepEqual(learnPaths(records), ["/azure/a", "/azure/z", "/credentials/x", "/training/modules/m"]);
  assert.deepEqual(learnPaths([]), []);
});

test("decideOffline: the caches settle a valid page and a high-confidence move, everything else needs a probe", () => {
  assert.deepEqual(decideOffline({ verdict: "valid", path: "/azure/a" }), { action: "keep", via: "cache" });
  assert.deepEqual(decideOffline({ verdict: "moved", confidence: "high", path: "/azure/a", redirectsTo: "/azure/b/a" }), { action: "rewrite", to: "/azure/b/a", via: "cache" });
  assert.deepEqual(decideOffline({ verdict: "moved", confidence: "high", path: "/azure/a/x", redirectsTo: "/azure/a" }), { action: "drop", via: "cache" }, "a move to an ancestor is a landing page");
  assert.deepEqual(decideOffline({ verdict: "moved", confidence: "high", path: "/azure/a", redirectsTo: "/previous-versions/azure/a" }), { action: "drop", via: "cache" });
  assert.equal(decideOffline({ verdict: "moved", confidence: "low", path: "/azure/a", redirectsTo: "/azure/b/a" }), null);
  assert.equal(decideOffline({ verdict: "moved", confidence: "high", path: "/azure/a", redirectsTo: null }), null);
  assert.equal(decideOffline({ verdict: "broken", path: "/azure/a" }), null);
  assert.equal(decideOffline({ verdict: "unverifiable", path: "/azure/a" }), null);
  assert.equal(decideOffline(undefined), null);
});

test("decideProbe turns a live outcome into keep, rewrite, drop or unverified", () => {
  assert.deepEqual(decideProbe("/azure/a", { verdict: "ok" }), { action: "keep", via: "probe" });
  assert.deepEqual(decideProbe("/azure/a", { verdict: "moved", redirectsTo: "/azure/b/a" }), { action: "rewrite", to: "/azure/b/a", via: "probe" });
  assert.deepEqual(decideProbe("/azure/a/x", { verdict: "moved", redirectsTo: "/azure" }), { action: "drop", via: "probe" });
  assert.deepEqual(decideProbe("/azure/a", { verdict: "moved", redirectsTo: null }), { action: "drop", via: "probe" });
  assert.deepEqual(decideProbe("/training/modules/m", { verdict: "broken", redirectsTo: "/azure/x" }), { action: "drop", via: "probe" });
  assert.deepEqual(decideProbe("/azure/a", { verdict: "unknown" }), { action: "unverified", via: "probe" });
  assert.deepEqual(decideProbe("/azure/a", undefined), { action: "unverified", via: "probe" });
});

test("planProbes skips targets confirmed within the window, checks never-checked ones first and respects the cap", () => {
  const records = [
    rec("a", [link("/azure/fresh", { checked: "2026-10-01" }), link("/azure/old", { checked: "2026-08-01" }), link("/azure/never"), link("/azure/flagged", { checked: "2026-10-04", unverified: true })]),
  ];
  const paths = ["/azure/fresh", "/azure/old", "/azure/never", "/azure/flagged"];
  const plan = planProbes({ records, paths, today: "2026-10-05", recheckDays: 30, maxProbes: 10 });
  assert.deepEqual(plan.fresh, ["/azure/fresh"]);
  assert.deepEqual(plan.toProbe, ["/azure/flagged", "/azure/never", "/azure/old"], "unverified counts as never confirmed; never-checked first, then the oldest");
  assert.deepEqual(plan.waiting, []);
  const capped = planProbes({ records, paths, today: "2026-10-05", recheckDays: 30, maxProbes: 1 });
  assert.deepEqual(capped.toProbe, ["/azure/flagged"]);
  assert.deepEqual(capped.waiting, ["/azure/never", "/azure/old"]);
  // the newest confirmation among several links of the same target counts
  const several = [rec("a", [link("/azure/x", { checked: "2026-08-01" })]), rec("b", [link("/azure/x", { checked: "2026-10-01" })])];
  assert.deepEqual(planProbes({ records: several, paths: ["/azure/x"], today: "2026-10-05", recheckDays: 30, maxProbes: 5 }).fresh, ["/azure/x"]);
});

test("applyDecisions rewrites, drops, flags and merges links with a fixed key order and leaves external links alone", () => {
  const external = { kind: "external", url: "https://github.com/x", text: "x", section: "Learn more" };
  const records = [
    rec("a", [link("/azure/moved"), link("/azure/gone"), link("/azure/kept"), link("/azure/slow"), external, external, link("/azure/other-old"), link("/azure/dest")]),
    rec("b", [link("/azure/moved", { was: "/azure/first-old", checked: "2026-09-01" })]),
  ];
  const decisions = new Map([
    ["/azure/moved", { action: "rewrite", to: "/azure/dest", via: "probe" }],
    ["/azure/other-old", { action: "rewrite", to: "/azure/dest", via: "cache" }],
    ["/azure/gone", { action: "drop", via: "probe" }],
    ["/azure/kept", { action: "keep", via: "probe" }],
    ["/azure/slow", { action: "unverified", via: "probe" }],
  ]);
  const { records: out, counts, droppedPaths, rewrittenPaths } = applyDecisions({ records, decisions, today: "2026-10-16" });
  assert.deepEqual(out[0].links, [
    { kind: "docs", path: "/azure/dest", text: "moved", section: "Learn more", was: "/azure/moved", checked: "2026-10-16" },
    { kind: "docs", path: "/azure/kept", text: "kept", section: "Learn more", checked: "2026-10-16" },
    { kind: "docs", path: "/azure/slow", text: "slow", section: "Learn more", unverified: true },
    external,
  ]);
  assert.deepEqual(Object.keys(out[0].links[0]), ["kind", "path", "text", "section", "was", "checked"]);
  assert.deepEqual(out[1].links, [{ kind: "docs", path: "/azure/dest", text: "moved", section: "Learn more", was: "/azure/first-old", checked: "2026-10-16" }], "the first `was` is kept");
  assert.deepEqual(counts, { kept: 2, rewritten: 3, dropped: 1, unverified: 1 });
  assert.deepEqual(droppedPaths, ["/azure/gone"]);
  assert.deepEqual(rewrittenPaths, ["/azure/moved", "/azure/other-old"]);
});

test("applyDecisions: a link without a decision stays as the caches left it, `fresh` keeps its date, a rewrite can change the kind", () => {
  const records = [rec("a", [link("/azure/plain", { checked: "2026-09-20", unverified: true }), link("/azure/fresh", { checked: "2026-10-01" }), link("/azure/to-training")])];
  const decisions = new Map([
    ["/azure/fresh", { action: "keep", via: "fresh" }],
    ["/azure/to-training", { action: "rewrite", to: "/training/modules/learn-it", via: "cache" }],
  ]);
  const { records: out } = applyDecisions({ records, decisions, today: "2026-10-16" });
  assert.deepEqual(out[0].links, [
    { kind: "docs", path: "/azure/plain", text: "plain", section: "Learn more" },
    { kind: "docs", path: "/azure/fresh", text: "fresh", section: "Learn more", checked: "2026-10-01" },
    { kind: "training", path: "/training/modules/learn-it", text: "to-training", section: "Learn more", was: "/azure/to-training" },
  ]);
});

test("evaluateFailsafes also judges the live link checks", () => {
  const base = { scope: "courses", scopeSize: 1400, attempted: 0, failed: 0, layoutFailed: 0, previousWithLinks: 0, nextWithLinks: 0 };
  assert.deepEqual(evaluateFailsafes({ ...base, probed: 100, probeUnknown: 10, probeDropped: 20 }), []);
  assert.match(evaluateFailsafes({ ...base, probed: 100, probeUnknown: 25 })[0], /25 of 100 live link checks were inconclusive/);
  assert.match(evaluateFailsafes({ ...base, probed: 100, probeDropped: 40 })[0], /40 of 100 live link checks found the page gone/);
  assert.deepEqual(evaluateFailsafes({ ...base, probed: 10, probeUnknown: 10, probeDropped: 10 }), [], "a small sample never trips");
});
