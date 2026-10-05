import { test } from "node:test";
import assert from "node:assert/strict";
import { QUARANTINE_REPORT_MAX_ROWS, buildQuarantineReport } from "../scripts/lib/docs-helpers.mjs";
import { unscopedSegments } from "../scripts/lib/docs-run.mjs";

const records = (n) =>
  Array.from({ length: n }, (_, i) => ({ status: 404, url: `https://learn.microsoft.com/azure/page-${i}`, title: `Page ${i}`, product: "svc" }));

const tableRows = (md) => md.split("\n").filter((l) => /^\| \d{3} \|/.test(l));

test("the quarantine issue table is capped at 100 rows with a pointer to the data file", () => {
  assert.equal(QUARANTINE_REPORT_MAX_ROWS, 100);
  const md = buildQuarantineReport(records(250), { surgeThreshold: 20 });
  assert.equal(tableRows(md).length, 100);
  assert.match(md, /_150 more in `data\/docs-catalog-invalid\.json` \(not shown here\)\._/);
  assert.match(md, /# Docs Catalog: 250 newly quarantined URL\(s\)/, "the heading still counts every URL");
  assert.ok(md.length < 65536, "stays far below GitHub's 65,536 character issue limit");
  // the first rows are the ones shown
  assert.ok(md.includes("page-0"));
  assert.ok(md.includes("page-99"));
  assert.ok(!md.includes("page-100"));
});

test("no 'more' line when everything fits, and the cap is configurable", () => {
  const exact = buildQuarantineReport(records(100), {});
  assert.equal(tableRows(exact).length, 100);
  assert.doesNotMatch(exact, /more in `data/);
  const small = buildQuarantineReport(records(5), {});
  assert.equal(tableRows(small).length, 5);
  const capped = buildQuarantineReport(records(5), { maxRows: 2 });
  assert.equal(tableRows(capped).length, 2);
  assert.match(capped, /_3 more in/);
});

test("the surge callout is kept (run context only) even when the table is truncated", () => {
  const md = buildQuarantineReport(records(250), { surgeThreshold: 20 });
  assert.match(md, /Surge warning/);
  assert.match(md, /250 URLs were quarantined in a single run/);
  assert.doesNotMatch(buildQuarantineReport(records(20), { surgeThreshold: 20 }), /Surge warning/);
  assert.doesNotMatch(buildQuarantineReport(records(250), { context: "snapshot", surgeThreshold: 20 }), /Surge warning/);
});

test("table cells are escaped and missing values shown as a dash", () => {
  const md = buildQuarantineReport([{ status: 404, url: "https://learn.microsoft.com/a|b", title: null, product: undefined }], {});
  assert.ok(md.includes("| 404 | https://learn.microsoft.com/a\\|b | - | - |"));
});

test("the report points at the ledger and both scopes (no stale advice about a single LEARN_SCOPE)", () => {
  const md = buildQuarantineReport(records(1), {});
  assert.match(md, /data\/docs-redirects\.json/);
  assert.match(md, /INDEX_ONLY_SCOPE/);
  assert.match(md, /scripts\/lib\/scope\.mjs/);
});

test("unscopedSegments lists only areas neither scope covers, biggest first", () => {
  const segments = new Map([
    ["azure", 100], // learn
    ["cli", 50], // index only
    ["dotnet", 900],
    ["powershell", 40],
    ["previous-versions", 900],
    ["", 3],
  ]);
  assert.deepEqual(unscopedSegments(segments), [
    ["dotnet", 900],
    ["previous-versions", 900],
    ["powershell", 40],
  ]);
  assert.equal(unscopedSegments(segments, undefined, 1).length, 1);
});
