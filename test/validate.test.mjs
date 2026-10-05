import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadData, validateUrls, classifyPath, scopeFor, suggestUnit, freshness } from "../scripts/lib/validate.mjs";
import { interpretProbe, applyProbe, liveLayer, probeMany } from "../scripts/lib/live-probe.mjs";
import { parseArgs } from "../scripts/validate-urls.mjs";

const NOW = Date.parse("2026-10-06T12:00:00Z");

function fixture({ withUnits = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "validate-"));
  const w = (name, body) => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  w("learn-catalog.json", {
    schemaVersion: 2,
    lastChecked: "2026-10-06T07:00:00Z",
    modules: [
      {
        uid: "learn.wwl.foundry-sdk",
        path: "/training/modules/foundry-sdk",
        url: "https://learn.microsoft.com/training/modules/foundry-sdk/?WT.mc_id=studentamb_165290",
        units: ["Introduction", "Exercise"],
        unitUrls: withUnits ? ["/training/modules/foundry-sdk/01-introduction", "/training/modules/foundry-sdk/06-exercise"] : undefined,
      },
      {
        uid: "learn.x.nounits",
        path: "/training/modules/nounits",
        url: "https://learn.microsoft.com/training/modules/nounits/",
        units: ["A"],
        unitUrls: null,
      },
      {
        uid: "learn.x.notserved",
        path: "/training/modules/notserved",
        url: "https://learn.microsoft.com/training/modules/notserved/",
        units: ["A"],
        unitUrls: null,
        hierarchyNotFound: true,
      },
      {
        uid: "learn.x.saas",
        path: "/training/saas/some-module",
        url: "https://learn.microsoft.com/training/saas/some-module/",
        units: ["Intro"],
        unitUrls: withUnits ? ["/training/saas/some-module/1-intro"] : undefined,
      },
    ],
    removed: [{ uid: "learn.x.gone", path: "/training/modules/gone", title: "Gone", lastSeen: "2026-09-14", removedOn: "2026-09-21" }],
    outOfScope: ["/training/modules/minecraft-thing"],
  });
  w("learn-content.json", {
    schemaVersion: 1,
    learningPaths: [{ path: "/training/paths/develop-generative-ai-apps" }],
    courses: [{ path: "/training/courses/gh-200t00" }],
    certifications: [{ path: "/credentials/certifications/azure-administrator" }],
    exams: [{ path: "/credentials/certifications/exams/az-104" }],
    appliedSkills: [{ path: "/credentials/applied-skills/create-an-ai-agent" }],
    studyGuides: [{ path: "/credentials/certifications/resources/study-guides/az-104" }],
    removed: [{ type: "course", path: "/training/courses/az-204t00", removedOn: "2026-08-31" }],
  });
  w("docs-urls.txt", "/azure/key-vault/general/overview\t2026-09-01\n/azure/virtual-machines/sizes/overview\t-\n/cli/azure/what-is-azure-cli\t2026-08-01\n");
  w("docs-redirects.json", [
    { from: "/azure/virtual-machines/sizes", to: "/azure/virtual-machines/sizes/overview", kind: "moved", status: 301, firstSeen: "2026-09-28", lastSeen: "2026-10-05" },
    { from: "/azure/old-offsite", to: null, kind: "retired", status: 301, firstSeen: "2026-09-28", lastSeen: "2026-10-05" },
  ]);
  w("docs-catalog-invalid.json", [{ title: "Dead", url: "https://learn.microsoft.com/azure/dead-page", status: 404, firstDetected: "2026-09-28", lastChecked: "2026-10-05" }]);
  w("status.json", {
    schemaVersion: 1,
    learn: { generatedAt: "2026-10-06T07:30:00.000Z" },
    docs: { generatedAt: "2026-10-06T08:40:00.000Z", complete: true },
  });
  return dir;
}

const check = (data, url) => validateUrls([url], data).results[0];

test("modules: valid, removed (tombstone), out of scope, absent", () => {
  const data = loadData(fixture());
  assert.equal(check(data, "https://learn.microsoft.com/en-us/training/modules/foundry-sdk/?WT.mc_id=x").verdict, "valid");
  const gone = check(data, "https://learn.microsoft.com/training/modules/gone/");
  assert.equal(gone.verdict, "broken");
  assert.equal(gone.evidence, "tombstone");
  assert.match(gone.reason, /2026-09-21/);
  const oos = check(data, "https://learn.microsoft.com/training/modules/minecraft-thing");
  assert.equal(oos.verdict, "valid");
  assert.equal(oos.evidence, "out-of-scope");
  const absent = check(data, "https://learn.microsoft.com/training/modules/never-existed");
  assert.equal(absent.verdict, "broken");
  assert.equal(absent.confidence, "high");
});

test("units: valid, dead slug gets a suggestion, removed or absent module, uncached units", () => {
  const data = loadData(fixture());
  assert.equal(check(data, "https://learn.microsoft.com/training/modules/foundry-sdk/06-exercise/?WT.mc_id=x").verdict, "valid");
  const dead = check(data, "https://learn.microsoft.com/training/modules/foundry-sdk/6-exercise/");
  assert.equal(dead.verdict, "broken");
  assert.equal(dead.suggestion, "https://learn.microsoft.com/training/modules/foundry-sdk/06-exercise");
  const removedModule = check(data, "https://learn.microsoft.com/training/modules/gone/3-exercise");
  assert.equal(removedModule.verdict, "broken");
  assert.match(removedModule.reason, /unit's module/);
  assert.equal(check(data, "https://learn.microsoft.com/training/modules/nounits/1-x").verdict, "unverifiable");
  assert.equal(check(data, "https://learn.microsoft.com/training/modules/minecraft-thing/1-x").verdict, "unverifiable");
  assert.equal(check(data, "https://learn.microsoft.com/training/modules/never-existed/1-x").verdict, "broken");
});

test("modules the catalog lists but Learn does not serve, and modules outside /training/modules/", () => {
  const data = loadData(fixture());
  const notServed = check(data, "https://learn.microsoft.com/training/modules/notserved/");
  assert.equal(notServed.verdict, "broken");
  assert.match(notServed.reason, /does not serve it/);
  const unitOfNotServed = check(data, "https://learn.microsoft.com/training/modules/notserved/1-a");
  assert.equal(unitOfNotServed.verdict, "broken");
  assert.equal(check(data, "https://learn.microsoft.com/training/saas/some-module/").verdict, "valid");
  assert.equal(check(data, "https://learn.microsoft.com/training/saas/some-module/1-intro/?WT.mc_id=x").verdict, "valid");
  const dead = check(data, "https://learn.microsoft.com/training/saas/some-module/9-gone");
  assert.equal(dead.verdict, "broken");
  assert.equal(dead.kind, "unit");
  // an unknown /training/<area>/ path stays "other" (unverifiable)
  assert.equal(check(data, "https://learn.microsoft.com/training/saas/unknown-module").verdict, "unverifiable");
});

test("content kinds: paths, courses, exams, applied skills, study guides, certifications", () => {
  const data = loadData(fixture());
  const v = (u) => check(data, `https://learn.microsoft.com${u}`);
  assert.equal(v("/training/paths/develop-generative-ai-apps/").verdict, "valid");
  assert.equal(v("/training/paths/nope").verdict, "broken");
  assert.equal(v("/training/courses/gh-200t00").verdict, "valid");
  const removedCourse = v("/training/courses/az-204t00");
  assert.equal(removedCourse.verdict, "broken");
  assert.equal(removedCourse.evidence, "tombstone");
  assert.equal(v("/credentials/certifications/exams/az-104").verdict, "valid");
  // the catalog API lists only legacy exams, so an unlisted exam is unknown, not broken
  assert.equal(v("/credentials/certifications/exams/zz-999").verdict, "unverifiable");
  assert.match(v("/credentials/certifications/exams/zz-999").reason, /legacy exams/);
  assert.equal(v("/credentials/applied-skills/create-an-ai-agent").verdict, "valid");
  assert.equal(v("/credentials/applied-skills/missing-skill").confidence, "high");
  assert.equal(v("/credentials/certifications/resources/study-guides/az-104").verdict, "valid");
  assert.equal(v("/credentials/certifications/resources/study-guides/ab-100").verdict, "unverifiable");
  assert.equal(v("/credentials/applied-skills/resources/study-guides/apl-6500").verdict, "unverifiable");
  assert.equal(classifyPath("/credentials/applied-skills/resources/study-guides/apl-6500").kind, "study-guide");
  assert.equal(v("/credentials/certifications/azure-administrator").verdict, "valid");
  // a support page under /credentials/certifications/ is not in the catalog: unknown, not broken
  assert.equal(v("/credentials/certifications/schedule-through-pearson-vue").verdict, "unverifiable");
});

test("docs: index, redirect ledger, quarantine, scope", () => {
  const data = loadData(fixture());
  const v = (u) => check(data, `https://learn.microsoft.com${u}`);
  assert.equal(v("/azure/key-vault/general/overview").verdict, "valid");
  assert.equal(v("/en-us/AZURE/Key-Vault/general/overview/").verdict, "valid");
  const moved = v("/azure/virtual-machines/sizes");
  assert.equal(moved.verdict, "moved");
  assert.equal(moved.redirectsTo, "/azure/virtual-machines/sizes/overview");
  assert.equal(moved.suggestion, "https://learn.microsoft.com/azure/virtual-machines/sizes/overview");
  const offsite = v("/azure/old-offsite");
  assert.equal(offsite.verdict, "moved");
  assert.equal(offsite.suggestion, null);
  assert.equal(v("/azure/dead-page").verdict, "broken");
  assert.equal(v("/azure/dead-page").evidence, "quarantine");
  const absent = v("/azure/never-published");
  assert.equal(absent.verdict, "broken");
  assert.equal(absent.confidence, "low");
  assert.equal(v("/cli/azure/what-is-azure-cli").verdict, "valid"); // index-only scope
  assert.equal(v("/cli/azure/not-there").verdict, "broken");
  assert.equal(v("/azure/templates/foo").verdict, "unverifiable"); // excluded
  const outside = v("/powershell/scripting/overview");
  assert.equal(outside.verdict, "unverifiable");
  assert.match(outside.reason, /\/powershell/);
});

test("uncovered kinds are unverifiable with a reason, never guessed", () => {
  const data = loadData(fixture());
  const v = (u) => check(data, u);
  assert.match(v("https://learn.microsoft.com/credentials/certifications/exams/az-104/practice/assessment?assessment-type=practice&assessmentId=35").reason, /practice assessments/);
  assert.match(v("https://learn.microsoft.com/shows/exam-readiness-zone/x").reason, /shows/);
  assert.match(v("https://learn.microsoft.com/certifications/exams/dp-100/practice/assessment").reason, /legacy/);
  assert.equal(v("https://learn.microsoft.com/collections/abc").verdict, "unverifiable");
  assert.equal(v("https://example.com/azure/foo").verdict, "unverifiable");
  assert.equal(v("https://example.com/azure/foo").kind, "other");
  assert.equal(validateUrls([{ url: "https://learn.microsoft.com/azure/key-vault/general/overview" }], data).results[0].verdict, "valid");
});

test("missing cache files make that class unverifiable instead of broken", () => {
  const data = loadData(mkdtempSync(join(tmpdir(), "empty-")));
  assert.ok(data.missing.includes("learn-catalog.json"));
  for (const url of [
    "https://learn.microsoft.com/training/modules/x",
    "https://learn.microsoft.com/training/modules/x/1-y",
    "https://learn.microsoft.com/training/paths/x",
    "https://learn.microsoft.com/azure/x",
  ]) {
    const r = check(data, url);
    assert.equal(r.verdict, "unverifiable", url);
    assert.equal(r.evidence, "missing-data");
  }
});

test("freshness reports heartbeat ages and unit coverage", () => {
  const data = loadData(fixture());
  const f = freshness(data, NOW);
  assert.equal(f.learnAgeHours, 4.5);
  assert.equal(f.docsAgeHours, 3.3);
  assert.equal(f.docsComplete, true);
  assert.equal(f.unitUrlsCached, true);
  assert.equal(f.schemaVersion, 2);
  const none = freshness(loadData(fixture({ withUnits: false })), NOW);
  assert.equal(none.unitUrlsCached, false);
  const { summary } = validateUrls(
    ["https://learn.microsoft.com/azure/key-vault/general/overview", "https://learn.microsoft.com/azure/nope-x"],
    data
  );
  assert.deepEqual(summary.byVerdict, { valid: 1, broken: 1 });
  assert.deepEqual(summary.byKind.docs, { valid: 1, broken: 1 });
});

test("classification and scope helpers", () => {
  assert.deepEqual(classifyPath("/training/modules/a/b"), { kind: "unit", module: "a", unit: "b" });
  assert.equal(classifyPath("/training/modules/a/b/c").kind, "other");
  assert.equal(classifyPath("/azure/x").kind, "docs");
  assert.equal(scopeFor("/azure/x"), "learn");
  assert.equal(scopeFor("/cli/azure/x"), "index-only");
  assert.equal(scopeFor("/azure/templates/x"), "excluded");
  assert.equal(scopeFor("/powershell/x"), null);
  assert.equal(suggestUnit("14-exercise-add", ["/training/modules/m/exercise-add"]), "exercise-add");
  assert.equal(suggestUnit("nothing", ["/training/modules/m/summary"]), null);
});

test("interpretProbe understands soft 404s, moves and transient failures", () => {
  const req = "/training/modules/gone";
  assert.equal(interpretProbe(req, { status: null }).verdict, "unknown");
  assert.equal(interpretProbe(req, { status: 429 }).verdict, "unknown");
  assert.equal(interpretProbe(req, { status: 404 }).verdict, "broken");
  assert.equal(interpretProbe(req, { status: 200, title: "404 - Content not found", finalUrl: "https://learn.microsoft.com/en-us/x" }).verdict, "broken");
  assert.match(interpretProbe(req, { status: 200, title: "Browse all training - Training", finalUrl: "https://learn.microsoft.com/en-us/training/browse/" }).detail, /Browse all training/);
  const toDocs = interpretProbe(req, { status: 200, title: "Docs", finalUrl: "https://learn.microsoft.com/en-us/azure/azure-resource-manager/" });
  assert.equal(toDocs.verdict, "broken");
  assert.equal(toDocs.redirectsTo, "/azure/azure-resource-manager");
  const moved = interpretProbe("/azure/old", { status: 200, title: "New", finalUrl: "https://learn.microsoft.com/en-us/azure/new" });
  assert.equal(moved.verdict, "moved");
  assert.equal(moved.redirectsTo, "/azure/new");
  assert.equal(interpretProbe("/azure/a", { status: 200, title: "A", finalUrl: "https://learn.microsoft.com/en-us/AZURE/a/" }).verdict, "ok");
  // a current exam URL redirects to its certification page: healthy
  assert.equal(
    interpretProbe("/credentials/certifications/exams/az-104", { status: 200, title: "Azure Administrator", finalUrl: "https://learn.microsoft.com/en-us/credentials/certifications/azure-administrator/" }).verdict,
    "ok"
  );
  // ... but an exam page that lands anywhere else has moved
  assert.equal(
    interpretProbe("/credentials/certifications/exams/az-104", { status: 200, title: "Browse", finalUrl: "https://learn.microsoft.com/en-us/credentials/browse/" }).verdict,
    "moved"
  );
  // a study guide that redirects does not exist
  const guide = interpretProbe("/credentials/certifications/resources/study-guides/70-480", { status: 200, title: "Browse", finalUrl: "https://learn.microsoft.com/en-us/credentials/browse/" });
  assert.equal(guide.verdict, "broken");
  assert.match(guide.detail, /study guide does not exist/);
  assert.equal(
    interpretProbe("/credentials/certifications/resources/study-guides/az-104", { status: 200, title: "Study guide", finalUrl: "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104/" }).verdict,
    "ok"
  );
});

test("applyProbe and liveLayer fold live outcomes into cached verdicts", async () => {
  const cached = { url: "u", path: "/azure/x", kind: "docs", verdict: "broken", reason: "page is absent", evidence: "docs-urls", confidence: "low", redirectsTo: null, suggestion: null };
  assert.equal(applyProbe(cached, { verdict: "ok", detail: "", redirectsTo: null }).verdict, "valid");
  assert.equal(applyProbe(cached, { verdict: "ok", detail: "", redirectsTo: null }).evidence, "live-probe");
  const moved = applyProbe(cached, { verdict: "moved", detail: "redirects to /azure/y", redirectsTo: "/azure/y" });
  assert.equal(moved.verdict, "moved");
  assert.equal(moved.suggestion, "https://learn.microsoft.com/azure/y");
  const kept = applyProbe(cached, { verdict: "unknown", detail: "HTTP 429", redirectsTo: null });
  assert.equal(kept.verdict, "broken");
  assert.match(kept.liveNote, /inconclusive/);

  const results = [
    cached,
    { ...cached, path: "/azure/ok", verdict: "valid" },
    { ...cached, path: "/shows/x", verdict: "unverifiable" },
    { ...cached, path: null, verdict: "unverifiable" },
  ];
  const probed = [];
  const probeImpl = async (p) => {
    probed.push(p);
    return { verdict: "broken", detail: "HTTP 404", redirectsTo: null };
  };
  const a = await liveLayer(results, { confirmLive: true, probeImpl, delayMs: 0 });
  assert.deepEqual(probed, ["/azure/x"]);
  assert.equal(a.probed, 1);
  assert.equal(a.results[1].verdict, "valid");
  const b = await liveLayer(results, { confirmLive: true, probeUnverifiable: true, probeImpl, delayMs: 0 });
  assert.equal(b.probed, 2);
  const none = await liveLayer(results, { probeImpl, delayMs: 0 });
  assert.equal(none.probed, 0);
  assert.deepEqual(await probeMany([], { probeImpl, delayMs: 0 }), []);
});

test("CLI: argument parsing and a cache-only run", () => {
  assert.deepEqual(parseArgs(["--confirm-live", "--concurrency", "2"]).confirmLive, true);
  assert.equal(parseArgs(["--concurrency", "2"]).concurrency, 2);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseArgs(["--data"]), /needs a value/);

  const dir = fixture();
  const input = join(dir, "in.json");
  writeFileSync(input, JSON.stringify(["https://learn.microsoft.com/training/modules/foundry-sdk/6-exercise/", "https://learn.microsoft.com/azure/key-vault/general/overview"]));
  const script = fileURLToPath(new URL("../scripts/validate-urls.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--data", dir, "--input", input], { encoding: "utf-8" });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.summary.total, 2);
  assert.deepEqual(out.summary.byVerdict, { broken: 1, valid: 1 });
  assert.equal(out.probed, 0);
  assert.equal(out.results[0].suggestion, "https://learn.microsoft.com/training/modules/foundry-sdk/06-exercise");
});
