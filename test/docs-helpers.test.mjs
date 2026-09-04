import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  parseFrontmatter,
  cleanTitle,
  stripLiquidTags,
  buildUrl,
  resolveTarget,
  shuffleSample,
  findDuplicateUrls,
  repoUrlPrefixes,
  buildQuarantineReport,
} from "../scripts/lib/docs-helpers.mjs";

test("parseFrontmatter extracts simple key/value pairs", () => {
  const fm = parseFrontmatter('---\ntitle: Hello World\ndescription: "A quoted description"\nms.service: azure-firewall\n---\n\nBody text');
  assert.equal(fm.title, "Hello World");
  assert.equal(fm.description, "A quoted description");
  assert.equal(fm["ms.service"], "azure-firewall");
});

test("parseFrontmatter handles CRLF line endings and single quotes", () => {
  const fm = parseFrontmatter("---\r\ntitle: 'Single quoted'\r\n---\r\nBody");
  assert.equal(fm.title, "Single quoted");
});

test("parseFrontmatter returns null when there is no frontmatter", () => {
  assert.equal(parseFrontmatter("# Just a heading\n\nNo frontmatter here."), null);
});

test("parseFrontmatter ignores non key/value lines (lists, nested keys)", () => {
  const fm = parseFrontmatter("---\ntitle: T\n  - list item\n---\n");
  assert.equal(fm.title, "T");
  assert.equal(Object.keys(fm).length, 1);
});

test("cleanTitle strips Microsoft Learn/Docs/Azure suffixes", () => {
  assert.equal(cleanTitle("Import SOAP API | Microsoft Learn"), "Import SOAP API");
  assert.equal(cleanTitle("Some Page - Microsoft Docs"), "Some Page");
  assert.equal(cleanTitle("Untouched Title"), "Untouched Title");
});

test("stripLiquidTags resolves product variables to GitHub and strips other tags", () => {
  assert.equal(stripLiquidTags("About {% data variables.product.github %} Actions"), "About GitHub Actions");
  assert.equal(stripLiquidTags("Before {% ifversion fpt %}mid{% endif %} after"), "Before mid after");
  assert.equal(stripLiquidTags(null), null);
  // an all-tag string collapses to null so callers can fall back to the raw value
  assert.equal(stripLiquidTags("{% data variables.copilot.copilot_cli %}"), null);
});

test("buildUrl strips .md and trailing index segments", () => {
  const root = join("/tmp", "repo", "docs");
  assert.equal(
    buildUrl(join(root, "api-management", "import-soap-api.md"), root, "azure", "learn.microsoft.com"),
    "https://learn.microsoft.com/azure/api-management/import-soap-api"
  );
  // index.md is the directory's landing page, not a literal /index segment (bug fixed 2026-09-01)
  assert.equal(
    buildUrl(join(root, "repositories", "index.md"), root, "", "docs.github.com"),
    "https://docs.github.com/repositories"
  );
  // ...but a page merely named foo-index.md must NOT be truncated
  assert.equal(
    buildUrl(join(root, "some-index.md"), root, "azure", "learn.microsoft.com"),
    "https://learn.microsoft.com/azure/some-index"
  );
  // stripPrefix removes the pathMappings sourcePath segment already folded into baseUrlPath,
  // so it doesn't appear twice (double threat-intelligence prefix bug)
  assert.equal(
    buildUrl(
      join(root, "threat-intelligence", "analyst-insights.md"),
      root,
      "defender/threat-intelligence",
      "learn.microsoft.com",
      "threat-intelligence"
    ),
    "https://learn.microsoft.com/defender/threat-intelligence/analyst-insights"
  );
  // a file exactly matching stripPrefix maps to the baseUrlPath landing page itself
  assert.equal(
    buildUrl(join(root, "threat-intelligence.md"), root, "defender/threat-intelligence", "learn.microsoft.com", "threat-intelligence"),
    "https://learn.microsoft.com/defender/threat-intelligence"
  );
});

test("resolveTarget prefers a matching pathMapping over the target default", () => {
  const target = {
    baseUrlPath: "unified-secops",
    pathMappings: [{ sourcePath: "threat-intelligence", baseUrlPath: "defender/threat-intelligence" }],
  };
  assert.deepEqual(resolveTarget(target, "threat-intelligence/overview.md"), {
    baseUrlPath: "defender/threat-intelligence",
    stripPrefix: "threat-intelligence",
  });
  assert.deepEqual(resolveTarget(target, "threat-intelligence"), {
    baseUrlPath: "defender/threat-intelligence",
    stripPrefix: "threat-intelligence",
  });
  assert.deepEqual(resolveTarget(target, "threat-intelligence-other/file.md"), {
    baseUrlPath: "unified-secops",
    stripPrefix: undefined,
  });
  assert.deepEqual(resolveTarget(target, "portal/overview.md"), {
    baseUrlPath: "unified-secops",
    stripPrefix: undefined,
  });
});

test("shuffleSample returns n items without mutating the input", () => {
  const arr = [1, 2, 3, 4, 5];
  const sample = shuffleSample(arr, 3);
  assert.equal(sample.length, 3);
  assert.deepEqual(arr, [1, 2, 3, 4, 5]);
  for (const item of sample) assert.ok(arr.includes(item));
  // asking for more than available returns everything
  assert.equal(shuffleSample(arr, 99).length, 5);
});

test("findDuplicateUrls reports only URLs claimed more than once", () => {
  const entries = [
    { url: "https://a/1", title: "one" },
    { url: "https://a/2", title: "two" },
    { url: "https://a/1", title: "one again" },
  ];
  const dupes = findDuplicateUrls(entries);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].url, "https://a/1");
  assert.equal(dupes[0].entries.length, 2);
  assert.deepEqual(findDuplicateUrls([{ url: "https://a/1" }]), []);
});

test("repoUrlPrefixes covers targets, pathMappings, custom domains, and empty base paths", () => {
  const repo = {
    domain: "docs.github.com",
    targets: [{ sourceFolder: "content", baseUrlPath: "" }],
  };
  assert.deepEqual(repoUrlPrefixes(repo), ["https://docs.github.com/"]);

  const defenderish = {
    targets: [
      { sourceFolder: "sentinel", baseUrlPath: "azure/sentinel" },
      {
        sourceFolder: "defender",
        baseUrlPath: "unified-secops",
        pathMappings: [{ sourcePath: "threat-intelligence", baseUrlPath: "defender/threat-intelligence" }],
      },
    ],
  };
  assert.deepEqual(repoUrlPrefixes(defenderish), [
    "https://learn.microsoft.com/azure/sentinel/",
    "https://learn.microsoft.com/unified-secops/",
    "https://learn.microsoft.com/defender/threat-intelligence/",
  ]);
});

test("buildQuarantineReport escapes table cells and includes the agent prompt", () => {
  const report = buildQuarantineReport([
    { status: 404, url: "https://learn.microsoft.com/azure/x", title: 'Weird | "title"', product: "azure" },
  ]);
  assert.match(report, /# Docs Catalog: 1 newly quarantined URL\(s\)/);
  assert.match(report, /Weird \\\| "title"/);
  assert.match(report, /Prompt for an AI coding agent/);
  assert.doesNotMatch(report, /Surge warning/);
});

test("buildQuarantineReport adds the surge callout above the threshold, run context only", () => {
  const records = Array.from({ length: 25 }, (_, i) => ({
    status: 404,
    url: `https://learn.microsoft.com/azure/page-${i}`,
    title: `Page ${i}`,
    product: "azure",
  }));
  assert.match(buildQuarantineReport(records, { surgeThreshold: 20 }), /Surge warning/);
  assert.doesNotMatch(buildQuarantineReport(records, { context: "backlog", surgeThreshold: 20 }), /Surge warning/);
  assert.match(buildQuarantineReport(records, { context: "backlog" }), /pre-existing quarantined/);
});
