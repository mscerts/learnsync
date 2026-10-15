import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../scripts/lib/docs-config.mjs";
import {
  QUARANTINE_ISSUE_TITLE,
  buildQuarantineReport,
  parseReportedUrls,
  quarantineUrlsOfIssueBody,
  reportedQuarantineUrls,
  serializeReportedUrls,
  splitReported,
} from "../scripts/lib/docs-helpers.mjs";
import { ORIGIN, baseLearn, harness, run, stable } from "./docs-fixtures.mjs";

// A URL that flips between 404 and live is quarantined again every time it breaks. The issues of the earlier
// quarantines (open or closed) are the memory of what was already reported, so it does not open the same issue again.

const record = (url, extra = {}) => ({ url, status: 404, title: `Title of ${url}`, product: "azure", ...extra });

test("the URLs of a quarantine issue are read from the table the report writes, and nowhere else", () => {
  const body = buildQuarantineReport(
    [
      record(`${ORIGIN}/azure/a`),
      record(`${ORIGIN}/azure/b`, { title: "Pipes | in | titles", product: null }),
      record(`${ORIGIN}/azure/c`, { status: 410 }),
    ],
    { surgeThreshold: 20 }
  );
  assert.deepEqual(quarantineUrlsOfIssueBody(body), [`${ORIGIN}/azure/a`, `${ORIGIN}/azure/b`, `${ORIGIN}/azure/c`]);
  // the pre-existing backlog issue has the same table
  const backlog = buildQuarantineReport([record(`${ORIGIN}/azure/old`)], { context: "backlog" });
  assert.deepEqual(quarantineUrlsOfIssueBody(backlog), [`${ORIGIN}/azure/old`]);
  // prose, the header row and the separator row are not URLs
  assert.deepEqual(quarantineUrlsOfIssueBody("See https://learn.microsoft.com/azure/x for more.\n| Status | URL | Title | Product |\n|---|---|---|---|\n"), []);
  assert.deepEqual(quarantineUrlsOfIssueBody(null), []);
});

test("only quarantine issues count, whatever their state, and every issue that listed a URL is named", () => {
  const body = (urls) => buildQuarantineReport(urls.map((u) => record(u)));
  const issues = [
    { number: 12, title: "Docs Catalog: 2 newly quarantined URL(s) — investigate & fix", body: body([`${ORIGIN}/azure/a`, `${ORIGIN}/azure/b`]), state: "CLOSED" },
    { number: 8, title: "Docs Catalog: 1 newly quarantined URL(s) — investigate & fix", body: body([`${ORIGIN}/azure/a`]), state: "OPEN" },
    { number: 1, title: "Docs Catalog: 39 pre-existing quarantined URL(s) (backlog) - investigate & fix", body: body([`${ORIGIN}/azure/old`]) },
    { number: 9, title: "Microsoft Docs Catalog Sync Failed", body: `| 404 | ${ORIGIN}/azure/not-a-quarantine | x | y |` },
    { number: 30, title: "Something else", body: body([`${ORIGIN}/azure/other`]) },
  ];
  const reported = reportedQuarantineUrls(issues);
  assert.deepEqual([...reported.keys()].sort(), [`${ORIGIN}/azure/a`, `${ORIGIN}/azure/b`, `${ORIGIN}/azure/old`]);
  assert.deepEqual(reported.get(`${ORIGIN}/azure/a`), [8, 12]);
  assert.deepEqual(reported.get(`${ORIGIN}/azure/old`), [1]);
  assert.ok(QUARANTINE_ISSUE_TITLE.test("Docs Catalog: 6 newly quarantined URL(s) — investigate & fix"));
  assert.ok(!QUARANTINE_ISSUE_TITLE.test("Docs Catalog: newly quarantined"));
  assert.equal(reportedQuarantineUrls(undefined).size, 0);
});

test("the file the workflow hands over round-trips, and junk lines are ignored", () => {
  const reported = new Map([
    [`${ORIGIN}/azure/b`, [12]],
    [`${ORIGIN}/azure/a`, [8, 12]],
  ]);
  const text = serializeReportedUrls(reported);
  assert.equal(text, `${ORIGIN}/azure/a\t8,12\n${ORIGIN}/azure/b\t12\n`);
  assert.deepEqual(parseReportedUrls(text), new Map([...reported].sort()));
  assert.equal(serializeReportedUrls(new Map()), "");
  assert.deepEqual(parseReportedUrls("not a url\n\n# comment\n"), new Map());
  assert.deepEqual(parseReportedUrls(`${ORIGIN}/azure/c\n`), new Map([[`${ORIGIN}/azure/c`, []]]));
});

test("newly quarantined records split into those an earlier issue listed and those it did not", () => {
  const a = record(`${ORIGIN}/azure/a`);
  const b = record(`${ORIGIN}/azure/b`);
  const { fresh, repeated } = splitReported([a, b], new Map([[a.url, [8]]]));
  assert.deepEqual(fresh, [b]);
  assert.deepEqual(repeated, [{ record: a, issues: [8] }]);
  assert.deepEqual(splitReported([a], new Map()).fresh, [a]);
});

test("the config reads QUARANTINE_REPORTED_FILE, and it is off by default", () => {
  assert.equal(readConfig({}).reportedUrlsFile, null);
  assert.equal(readConfig({ QUARANTINE_REPORTED_FILE: "/tmp/r.txt" }).reportedUrlsFile, "/tmp/r.txt");
});

// ---- the sync -----------------------------------------------------------------------------------

/** b is quarantined in week 1, released in week 2 and broken again in week 3 (the flip). `config` is handed to the week-3 run. */
async function flip(t, { reported = null, config = {} } = {}) {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn); // week 0
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-10-10"], ["/azure/d", "2026-10-11"]]);
  learn.page("/azure/a", { title: "A version two" });
  learn.page("/azure/b", "gone");
  const w1 = await run(h, learn, { when: "2026-10-12T10:00:00Z" });
  assert.equal(w1.exitCode, 0, w1.messages.join("\n"));
  assert.equal(readFileSync(w1.githubOutput, "utf-8"), "new_quarantine_count=1\n");
  learn.page("/azure/b", "live");
  const w2 = await run(h, learn, { when: "2026-10-19T10:00:00Z" });
  assert.deepEqual(h.json("docs-catalog-invalid.json"), [], "week 2 released it");
  // week 3: it breaks again; the report and the output of the earlier weeks are removed so that only this run's show
  rmSync(w2.reportFile, { force: true });
  rmSync(w2.githubOutput, { force: true });
  learn.page("/azure/b", "gone");
  const reportedFile = join(h.dir, "reported.txt");
  if (reported !== null) writeFileSync(reportedFile, reported);
  const w3 = await run(h, learn, {
    when: "2026-10-26T10:00:00Z",
    config: reported === null ? config : { reportedUrlsFile: reportedFile, ...config },
  });
  return { h, w3 };
}

test("without the list, a URL that breaks again opens the same issue again (what the list prevents)", async (t) => {
  const { h, w3 } = await flip(t);
  assert.equal(w3.exitCode, 0, w3.messages.join("\n"));
  assert.deepEqual(h.json("docs-catalog-invalid.json").map((q) => q.url), [`${ORIGIN}/azure/b`]);
  assert.equal(readFileSync(w3.githubOutput, "utf-8"), "new_quarantine_count=1\n");
  assert.match(readFileSync(w3.reportFile, "utf-8"), /azure\/b/);
});

test("a URL an earlier issue already reported stays quarantined but opens no new issue", async (t) => {
  const { h, w3 } = await flip(t, { reported: `${ORIGIN}/azure/b\t8,12\n` });
  assert.equal(w3.exitCode, 0, w3.messages.join("\n"));
  // still quarantined as usual
  assert.deepEqual(h.json("docs-catalog-invalid.json").map((q) => [q.url, q.status]), [[`${ORIGIN}/azure/b`, 404]]);
  // but nothing to report: no report file and no output, so the workflow opens no issue
  assert.equal(existsSync(w3.reportFile), false);
  assert.equal(existsSync(w3.githubOutput), false);
  const said = w3.messages.join("\n");
  assert.match(said, /Read 1 URL\(s\) that earlier quarantine issues already reported/);
  assert.match(said, /1 newly quarantined URL\(s\) were already reported in issues #8, #12 and are not reported again: .*azure\/b/);
});

test("a URL that no earlier issue listed is still reported, next to one that was", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  learn.family("azure", [...stable("azure", 24), ["/azure/d", "2026-10-11"]]);
  learn.page("/azure/a", "gone");
  learn.page("/azure/b", "gone");
  const reported = join(h.dir, "reported.txt");
  writeFileSync(reported, `${ORIGIN}/azure/b\t8\n`);
  const r = await run(h, learn, { when: "2026-10-12T10:00:00Z", config: { reportedUrlsFile: reported } });
  assert.equal(r.exitCode, 0, r.messages.join("\n"));
  assert.deepEqual(h.json("docs-catalog-invalid.json").map((q) => q.url).sort(), [`${ORIGIN}/azure/a`, `${ORIGIN}/azure/b`]);
  assert.equal(readFileSync(r.githubOutput, "utf-8"), "new_quarantine_count=1\n");
  const report = readFileSync(r.reportFile, "utf-8");
  assert.match(report, /azure\/a/);
  assert.ok(!report.includes("azure/b"), "the repeated URL is left out of the new issue");
});

test("an unreadable list never hides anything: every newly quarantined URL is reported, with a warning", async (t) => {
  const h = harness(t);
  const learn = baseLearn();
  await run(h, learn);
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-10-10"], ["/azure/d", "2026-10-11"]]);
  learn.page("/azure/b", "gone");
  const r = await run(h, learn, {
    when: "2026-10-12T10:00:00Z",
    config: { reportedUrlsFile: join(h.dir, "does-not-exist.txt") },
  });
  assert.equal(r.exitCode, 0, r.messages.join("\n"));
  assert.match(r.messages.join("\n"), /WARN Could not read .*does-not-exist\.txt .*every newly quarantined URL is reported/);
  assert.equal(readFileSync(r.githubOutput, "utf-8"), "new_quarantine_count=1\n");
  assert.match(readFileSync(r.reportFile, "utf-8"), /azure\/b/);
});

// ---- the command line ---------------------------------------------------------------------------

function cli(args, env = {}) {
  return spawnSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "reported-quarantine.mjs"), ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
}

test("reported-quarantine.mjs writes the file from the issues it is given, and fails loudly without writing", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reported-quarantine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const issues = join(dir, "issues.json");
  const out = join(dir, "out.txt");
  writeFileSync(
    issues,
    JSON.stringify([
      { number: 12, title: "Docs Catalog: 1 newly quarantined URL(s) — investigate & fix", body: buildQuarantineReport([record(`${ORIGIN}/azure/b`)]) },
      { number: 3, title: "Unrelated", body: buildQuarantineReport([record(`${ORIGIN}/azure/z`)]) },
    ])
  );
  const ok = cli(["--out", out], { ISSUES_JSON_FILE: issues });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(readFileSync(out, "utf-8"), `${ORIGIN}/azure/b\t12\n`);
  assert.match(ok.stdout, /1 URL\(s\)/);

  const usage = cli([]);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /Usage/);

  const broken = join(dir, "broken.json");
  writeFileSync(broken, "{nope");
  const failed = cli(["--out", join(dir, "never.txt")], { ISSUES_JSON_FILE: broken });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Could not look up the reported URLs/);
  assert.equal(existsSync(join(dir, "never.txt")), false);
});

test("the monitor workflow looks the list up before the sync and hands it over, and a failed lookup does not stop the sync", () => {
  const workflow = readFileSync(join(import.meta.dirname, "..", ".github", "workflows", "docs-catalog-monitor.yml"), "utf-8");
  const lookup = workflow.indexOf("name: Look up the URLs that earlier issues already reported");
  const sync = workflow.indexOf("name: Sync Microsoft docs catalog cache");
  assert.ok(lookup > 0 && sync > lookup, "the lookup comes first");
  const lookupStep = workflow.slice(lookup, sync);
  assert.match(lookupStep, /continue-on-error: true/);
  assert.match(lookupStep, /node scripts\/reported-quarantine\.mjs --out \/tmp\/docs-catalog-reported-urls\.txt/);
  assert.match(lookupStep, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow.slice(sync), /QUARANTINE_REPORTED_FILE: \/tmp\/docs-catalog-reported-urls\.txt/);
  // the token that lists issues is the one the job already has
  assert.match(workflow, /issues: write/);
});
