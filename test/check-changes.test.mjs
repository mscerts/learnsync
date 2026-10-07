import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { emptyChanges, writeChanges } from "../scripts/lib/changes.mjs";
import {
  DEFAULT_STALE_DAYS,
  NONE_MEANS,
  UsageError,
  buildReport,
  changelog,
  changesFreshness,
  checkLinks,
  freshnessWarnings,
  parseLinks,
  readStatusFile,
} from "../scripts/lib/check-changes.mjs";
import { loadChangeLedger } from "../scripts/lib/validate.mjs";
import { USAGE, parseArgs, runCli } from "../scripts/check-changes.mjs";

// scripts/check-changes.mjs reads data/changes/removed.json and moved.json (and data/status.json for
// freshness) and nothing else. The library behind the files has its own tests (changes.test.mjs); these
// cover the CLI's reading of them: row shape, "none" never meaning "valid", the changelog view,
// freshness, usage errors and exit codes.

const NOW = Date.parse("2026-10-06T12:00:00Z");
const FRESH = "2026-10-05T07:30:00.000Z";
const script = fileURLToPath(new URL("../scripts/check-changes.mjs", import.meta.url));

/** A complete, valid entry. */
const E = (path, over = {}) => ({
  path,
  kind: "module",
  family: "learn",
  outcome: "gone",
  to: null,
  title: null,
  parent: null,
  firstSeen: "2026-09-21",
  lastVerified: "2026-10-05",
  evidence: "tombstone",
  status: 404,
  ...over,
});

const ENTRIES = {
  removed: [
    E("/training/modules/gone", { outcome: "landing", to: "/training/paths/where-it-went", title: "Gone module", status: 301 }),
    E("/training/modules/dead-unit-module/3-exercise", { kind: "unit", parent: "/training/modules/dead-unit-module", firstSeen: "2026-10-01", evidence: "unit-diff" }),
    E("/credentials/certifications/resources/study-guides/ab-100", { kind: "study-guide", evidence: "live-probe", firstSeen: "2026-10-04", title: null }),
    E("/azure/quarantined", { kind: "docs", family: "docs", evidence: "quarantine", firstSeen: "2026-09-28", lastVerified: "2026-10-05" }),
    E("/training/modules/unsure", { outcome: "unverified", lastVerified: null, firstSeen: "2026-10-05" }),
    E("/training/modules/moved-then-gone", { kind: "module", outcome: "gone", firstSeen: "2026-09-30" }),
  ],
  moved: [
    E("/training/modules/x/05-old", { kind: "unit", outcome: "moved", to: "/training/modules/x/05-new", parent: "/training/modules/x", firstSeen: "2026-10-01", evidence: "unit-diff", status: 301 }),
    E("/training/modules/renamed", { outcome: "moved", to: "/training/modules/renamed-now", firstSeen: "2026-09-25", evidence: "rename", status: 301 }),
    E("/azure/old-page", { kind: "docs", family: "docs", outcome: "moved", to: "/azure/new-page", evidence: "docs-redirect", firstSeen: "2026-09-28", status: 301 }),
    E("/training/modules/chain-start", { outcome: "moved", to: "/training/modules/moved-then-gone", firstSeen: "2026-09-26", evidence: "rename", status: 301 }),
    E("/training/paths/offsite", { kind: "learning-path", outcome: "moved", to: null, firstSeen: "2026-09-27", evidence: "rename", status: 301 }),
  ],
};

/** A data directory with change files (and optionally status.json); `stamps` override the sources. */
function fixture({ entries = ENTRIES, sources = { learn: FRESH, docs: "2026-10-05T08:30:00.000Z" }, status = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-changes-"));
  const changes = emptyChanges();
  for (const file of ["removed", "moved"]) {
    changes[file].generatedAt = FRESH;
    changes[file].sources = { ...sources };
    changes[file].entries = entries[file] ?? [];
  }
  writeChanges(dir, changes);
  if (status !== undefined) writeFileSync(join(dir, "status.json"), JSON.stringify(status));
  return dir;
}

const ledgerOf = (dir) => loadChangeLedger(dir);
const STATUS = { schemaVersion: 1, learn: { generatedAt: "2026-10-06T07:30:00.000Z" }, docs: { generatedAt: "2026-10-06T08:40:00.000Z", complete: true } };

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

test("parseLinks accepts strings and objects with url or path, and names a bad item", () => {
  assert.deepEqual(parseLinks(["https://learn.microsoft.com/a", { url: "https://learn.microsoft.com/b" }, { path: "/c" }]), ["https://learn.microsoft.com/a", "https://learn.microsoft.com/b", "/c"]);
  assert.deepEqual(parseLinks([]), []);
  assert.throws(() => parseLinks({ urls: [] }), UsageError);
  assert.throws(() => parseLinks("https://learn.microsoft.com/a"), /JSON array/);
  assert.throws(() => parseLinks(["ok", 5]), /item 1/);
  assert.throws(() => parseLinks([null]), /item 0/);
  assert.throws(() => parseLinks([{ href: "x" }]), /item 0/);
});

// ---------------------------------------------------------------------------
// link rows
// ---------------------------------------------------------------------------

test("checkLinks: exact hits carry the entry's facts, in input order", () => {
  const rows = checkLinks(
    [
      "https://learn.microsoft.com/en-us/training/modules/gone/?WT.mc_id=x#top",
      "/training/modules/x/05-old",
      "https://learn.microsoft.com/credentials/certifications/resources/study-guides/ab-100",
      "https://learn.microsoft.com/azure/old-page/",
    ],
    ledgerOf(fixture())
  );
  assert.deepEqual(rows.map((r) => [r.path, r.status, r.outcome, r.to, r.via]), [
    ["/training/modules/gone", "removed", "landing", "/training/paths/where-it-went", "exact"],
    ["/training/modules/x/05-old", "moved", "moved", "/training/modules/x/05-new", "exact"],
    ["/credentials/certifications/resources/study-guides/ab-100", "removed", "gone", null, "exact"],
    ["/azure/old-page", "moved", "moved", "/azure/new-page", "exact"],
  ]);
  const [gone, unit] = rows;
  assert.equal(gone.url, "https://learn.microsoft.com/en-us/training/modules/gone/?WT.mc_id=x#top"); // the input, untouched
  assert.equal(gone.confidence, "high");
  assert.equal(gone.firstSeen, "2026-09-21");
  assert.equal(gone.lastVerified, "2026-10-05");
  assert.equal(gone.kind, "module");
  assert.equal(gone.title, "Gone module");
  assert.equal(gone.evidence, "tombstone");
  assert.equal(gone.httpStatus, 301);
  assert.equal(gone.matched, "/training/modules/gone");
  assert.equal(gone.decidedBy, "/training/modules/gone");
  assert.deepEqual(gone.chain, ["/training/modules/gone"]);
  assert.equal(gone.cycle, false);
  assert.equal(gone.truncated, false);
  assert.match(gone.reason, /was removed \[landing\]/);
  assert.deepEqual(unit.chain, ["/training/modules/x/05-old", "/training/modules/x/05-new"]);
  assert.equal(unit.kind, "unit");
});

test("checkLinks: a unit of a removed module is removed through its module (via ancestor); a unit of a moved module is a low-confidence move", () => {
  const ledger = ledgerOf(fixture());
  const [removedUnit, movedUnit, sibling] = checkLinks(
    ["/training/modules/gone/7-exercise", "/training/modules/renamed/2-unit", "/training/modules/never-heard-of/1-x"],
    ledger
  );
  assert.equal(removedUnit.status, "removed");
  assert.equal(removedUnit.via, "ancestor");
  assert.equal(removedUnit.matched, "/training/modules/gone");
  assert.equal(removedUnit.to, null); // the landing page is only reported for the removed link itself
  assert.equal(removedUnit.confidence, "high");
  assert.equal(movedUnit.status, "moved");
  assert.equal(movedUnit.via, "ancestor");
  assert.equal(movedUnit.confidence, "low");
  assert.equal(movedUnit.to, "/training/modules/renamed-now/2-unit");
  assert.equal(sibling.status, "none");
});

test("checkLinks: a move whose destination was removed counts as removed, an unverified entry is low confidence", () => {
  const ledger = ledgerOf(fixture());
  const [chained, unsure, offsite] = checkLinks(["/training/modules/chain-start", "/training/modules/unsure", "/training/paths/offsite"], ledger);
  assert.equal(chained.status, "removed");
  assert.equal(chained.outcome, "gone");
  assert.deepEqual(chained.chain, ["/training/modules/chain-start", "/training/modules/moved-then-gone"]);
  assert.equal(chained.matched, "/training/modules/chain-start");
  assert.equal(chained.decidedBy, "/training/modules/moved-then-gone");
  assert.equal(chained.firstSeen, "2026-09-30"); // the deciding entry's
  assert.equal(unsure.status, "removed");
  assert.equal(unsure.outcome, "unverified");
  assert.equal(unsure.confidence, "low");
  assert.equal(unsure.lastVerified, null);
  assert.equal(offsite.status, "moved");
  assert.equal(offsite.to, null);
});

test('checkLinks: "none" rows say nothing was recorded, never that the link is valid', () => {
  const rows = checkLinks(["https://learn.microsoft.com/azure/key-vault/general/overview", "https://example.com/azure/x", "not a url", "/", "/azure/quarantined/child"], ledgerOf(fixture()));
  for (const row of rows) {
    assert.equal(row.status, "none", row.url);
    assert.equal(row.outcome, null);
    assert.equal(row.to, null);
    assert.equal(row.confidence, null);
    assert.equal(row.firstSeen, null);
    assert.ok(!("verdict" in row), "a none row carries no validity verdict");
  }
  assert.match(rows[0].reason, /no change recorded/);
  assert.match(rows[0].reason, /not a validity verdict/);
  assert.equal(rows[0].path, "/azure/key-vault/general/overview");
  assert.equal(rows[1].path, null);
  assert.match(rows[1].reason, /not a learn\.microsoft\.com URL/);
  assert.equal(rows[2].path, null);
  // docs pages never inherit from an ancestor entry
  assert.equal(rows[4].status, "none");
  assert.match(NONE_MEANS, /NO CHANGE IS RECORDED/);
  assert.match(NONE_MEANS, /does not mean the link is valid/);
});

test("checkLinks without change files reads every link as none", () => {
  const ledger = loadChangeLedger(mkdtempSync(join(tmpdir(), "check-changes-empty-")));
  assert.equal(ledger.available, false);
  assert.deepEqual(checkLinks(["/training/modules/gone"], ledger).map((r) => r.status), ["none"]);
  assert.deepEqual(checkLinks(["/training/modules/gone"], null).map((r) => r.status), ["none"]);
});

// ---------------------------------------------------------------------------
// changelog
// ---------------------------------------------------------------------------

test("changelog lists entries first seen on or after the date, oldest first, with the same vocabulary", () => {
  const ledger = ledgerOf(fixture());
  const all = changelog(ledger, "2026-01-01");
  assert.equal(all.length, ENTRIES.removed.length + ENTRIES.moved.length);
  const dates = all.map((c) => c.firstSeen);
  assert.deepEqual(dates, [...dates].sort());
  const recent = changelog(ledger, "2026-10-01");
  assert.deepEqual(
    recent.map((c) => [c.firstSeen, c.path, c.status]),
    [
      ["2026-10-01", "/training/modules/dead-unit-module/3-exercise", "removed"],
      ["2026-10-01", "/training/modules/x/05-old", "moved"],
      ["2026-10-04", "/credentials/certifications/resources/study-guides/ab-100", "removed"],
      ["2026-10-05", "/training/modules/unsure", "removed"],
    ]
  );
  const moved = recent.find((c) => c.status === "moved");
  assert.deepEqual(Object.keys(moved), ["path", "status", "outcome", "to", "kind", "family", "title", "parent", "firstSeen", "lastVerified", "evidence", "httpStatus"]);
  assert.equal(moved.httpStatus, 301);
  assert.equal(moved.outcome, "moved");
  assert.deepEqual(changelog(ledger, "2026-12-31"), []);
  assert.deepEqual(changelog(loadChangeLedger(mkdtempSync(join(tmpdir(), "check-changes-empty-"))), "2026-01-01"), []);
  assert.throws(() => changelog(ledger, "yesterday"), RangeError);
});

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

test("changesFreshness: fresh files, the limit is judged on the exact age", () => {
  const dir = fixture({ status: STATUS });
  const f = changesFreshness({ ledger: ledgerOf(dir), status: readStatusFile(dir), now: NOW });
  assert.equal(f.stale, false);
  assert.deepEqual(f.missingFiles, []);
  assert.equal(f.error, null);
  assert.equal(f.generatedAt, FRESH);
  assert.deepEqual(f.sources.learn, { stamp: FRESH, ageDays: 1.2, stale: false });
  assert.equal(f.sources.docs.stamp, "2026-10-05T08:30:00.000Z");
  assert.deepEqual(f.entries, { removed: ENTRIES.removed.length, moved: ENTRIES.moved.length });
  assert.equal(f.staleAfterDays, DEFAULT_STALE_DAYS);
  assert.deepEqual(f.heartbeat, {
    found: true,
    learnGeneratedAt: "2026-10-06T07:30:00.000Z",
    learnAgeHours: 4.5,
    docsGeneratedAt: "2026-10-06T08:40:00.000Z",
    docsAgeHours: 3.3,
    docsComplete: true,
  });
  assert.deepEqual(freshnessWarnings(f), []);

  // exactly at the limit is fresh, a moment later is stale
  const learnAt = Date.parse(FRESH);
  const atLimit = changesFreshness({ ledger: ledgerOf(dir), now: learnAt + 10 * 86_400_000 });
  assert.equal(atLimit.sources.learn.stale, false);
  const past = changesFreshness({ ledger: ledgerOf(dir), now: learnAt + 10 * 86_400_000 + 1 });
  assert.equal(past.sources.learn.stale, true);
  assert.equal(past.stale, true);
  assert.equal(changesFreshness({ ledger: ledgerOf(dir), now: learnAt + 10 * 86_400_000 + 1, staleDays: 30 }).sources.learn.stale, false);
});

test("changesFreshness: a null stamp, an old stamp and a missing file are stale and explained", () => {
  const neverLearn = fixture({ sources: { learn: null, docs: FRESH } });
  const a = changesFreshness({ ledger: ledgerOf(neverLearn), now: NOW });
  assert.equal(a.sources.learn.stale, true);
  assert.equal(a.sources.learn.stamp, null);
  assert.equal(a.sources.learn.ageDays, null);
  assert.equal(a.sources.docs.stale, false);
  assert.equal(a.stale, true);
  assert.match(freshnessWarnings(a).join("\n"), /no Learn refresh stamp \(sources\.learn is null\).*"none" says nothing about Learn links/);

  const old = changesFreshness({ ledger: ledgerOf(fixture({ sources: { learn: "2026-09-01T00:00:00.000Z", docs: FRESH } })), now: NOW });
  assert.equal(old.sources.learn.stale, true);
  assert.match(freshnessWarnings(old).join("\n"), /Learn entries were last refreshed 2026-09-01 \(35 days ago, limit 10\)/);

  // the older of the two files' stamps wins
  const dir = fixture();
  const movedFile = join(dir, "changes", "moved.json");
  const moved = JSON.parse(readFileSync(movedFile, "utf-8"));
  moved.sources.learn = "2026-09-20T00:00:00.000Z";
  writeFileSync(movedFile, JSON.stringify(moved));
  assert.equal(changesFreshness({ ledger: ledgerOf(dir), now: NOW }).sources.learn.stamp, "2026-09-20T00:00:00.000Z");

  const empty = mkdtempSync(join(tmpdir(), "check-changes-empty-"));
  const missing = changesFreshness({ ledger: loadChangeLedger(empty), status: null, now: NOW });
  assert.deepEqual(missing.missingFiles, ["removed.json", "moved.json"]);
  assert.equal(missing.stale, true);
  assert.equal(missing.generatedAt, null);
  assert.deepEqual(missing.entries, { removed: 0, moved: 0 });
  const text = freshnessWarnings(missing).join("\n");
  assert.match(text, /missing under data\/changes\/: removed\.json, moved\.json.*every link reads none/);
  assert.match(text, /data\/status\.json is missing/);
  assert.equal(freshnessWarnings(missing).length, 2, "no separate stamp warnings when both files are missing");

  assert.match(freshnessWarnings(changesFreshness({ ledger: ledgerOf(fixture()), status: { docs: { complete: false } }, now: NOW })).join("\n"), /docs index was incomplete/);
});

test("changesFreshness: only one change file missing is reported and counted as stale", () => {
  const dir = fixture();
  const ledger = ledgerOf(dir);
  assert.deepEqual(ledger.missingFiles, []);
  const alone = mkdtempSync(join(tmpdir(), "check-changes-one-"));
  mkdirSync(join(alone, "changes"));
  writeFileSync(join(alone, "changes", "moved.json"), readFileSync(join(dir, "changes", "moved.json")));
  const one = loadChangeLedger(alone);
  assert.equal(one.available, true);
  assert.deepEqual(one.missingFiles, ["removed.json"]);
  const f = changesFreshness({ ledger: one, now: NOW });
  assert.equal(f.stale, true);
  assert.match(freshnessWarnings(f).join("\n"), /removed\.json.*its entries are absent/);
  assert.equal(checkLinks(["/training/modules/x/05-old"], one)[0].status, "moved");
});

// ---------------------------------------------------------------------------
// reports
// ---------------------------------------------------------------------------

test("buildReport (links): only removed and moved rows are listed, --all adds the none rows, the summary counts everything", () => {
  const dir = fixture({ status: STATUS });
  const links = ["/training/modules/gone", "/azure/healthy", "/training/modules/x/05-old", "https://example.com/z", "/azure/also-fine"];
  const base = { dataDir: dir, ledger: ledgerOf(dir), status: readStatusFile(dir), links, now: NOW };
  const hits = buildReport(base);
  assert.deepEqual(hits.results.map((r) => r.path), ["/training/modules/gone", "/training/modules/x/05-old"]);
  assert.deepEqual(hits.summary, { total: 5, removed: 1, moved: 1, none: 3, notLearn: 1 });
  assert.equal(hits.note, NONE_MEANS);
  assert.equal(hits.generatedAt, "2026-10-06T12:00:00.000Z");
  assert.equal(hits.dataDir, dir);
  assert.deepEqual(hits.warnings, []);
  assert.equal(hits.freshness.stale, false);
  assert.ok(!("changes" in hits) && !("since" in hits));

  const all = buildReport({ ...base, all: true });
  assert.deepEqual(all.results.map((r) => r.status), ["removed", "none", "moved", "none", "none"]);
  assert.deepEqual(all.summary, hits.summary);

  const nothing = buildReport({ ...base, links: [] });
  assert.deepEqual(nothing.results, []);
  assert.deepEqual(nothing.summary, { total: 0, removed: 0, moved: 0, none: 0, notLearn: 0 });
});

test("buildReport (since): the changelog view, which says a missing entry is not a statement of validity", () => {
  const dir = fixture({ status: STATUS });
  const report = buildReport({ dataDir: dir, ledger: ledgerOf(dir), status: readStatusFile(dir), since: "2026-10-01", links: ["/ignored"], now: NOW });
  assert.equal(report.since, "2026-10-01");
  assert.deepEqual(report.summary, { total: 4, removed: 3, moved: 1 });
  assert.equal(report.changes.length, 4);
  assert.ok(!("results" in report));
  assert.match(report.note, /not a statement that it is valid/);
  assert.ok(report.freshness && Array.isArray(report.warnings));
  assert.throws(() => buildReport({ dataDir: dir, ledger: ledgerOf(dir), since: "last week" }), UsageError);
});

// ---------------------------------------------------------------------------
// CLI: arguments
// ---------------------------------------------------------------------------

test("parseArgs: defaults, links as arguments, and every usage error", () => {
  const d = parseArgs([]);
  assert.equal(d.all, false);
  assert.equal(d.since, null);
  assert.equal(d.input, null);
  assert.equal(d.staleDays, DEFAULT_STALE_DAYS);
  assert.deepEqual(d.links, []);
  assert.match(d.data.replace(/\\/g, "/"), /\/data$/);

  const o = parseArgs(["https://learn.microsoft.com/a", "/b", "--all", "--input", "in.json", "--data", "d", "--output", "o.json", "--stale-days", "3", "--now", "2026-10-06T00:00:00Z"]);
  assert.deepEqual(o.links, ["https://learn.microsoft.com/a", "/b"]);
  assert.equal(o.all, true);
  assert.equal(o.input, "in.json");
  assert.equal(o.data, "d");
  assert.equal(o.output, "o.json");
  assert.equal(o.staleDays, 3);
  assert.equal(o.now, Date.parse("2026-10-06T00:00:00Z"));
  assert.equal(parseArgs(["--since", "2026-09-01"]).since, "2026-09-01");
  assert.equal(parseArgs(["-h"]).help, true);
  assert.equal(parseArgs(["--help"]).help, true);

  for (const [argv, pattern] of [
    [["--nope"], /unknown argument: --nope/],
    [["--data"], /--data needs a value/],
    [["--input"], /--input needs a value/],
    [["--since"], /--since needs a value/],
    [["--since", "2026-13-40"], /--since must be a date/],
    [["--since", "yesterday"], /--since must be a date/],
    [["--stale-days", "-1"], /--stale-days must be a non-negative integer/],
    [["--stale-days", "1.5"], /--stale-days must be a non-negative integer/],
    [["--now", "soon"], /--now must be an ISO/],
    [["--since", "2026-09-01", "/a"], /cannot be combined/],
    [["--since", "2026-09-01", "--input", "x.json"], /cannot be combined/],
    [["--since", "2026-09-01", "--all"], /cannot be combined/],
  ]) {
    assert.throws(() => parseArgs(argv), (err) => err instanceof UsageError && pattern.test(err.message), argv.join(" "));
  }
});

// ---------------------------------------------------------------------------
// CLI: runCli with injected I/O
// ---------------------------------------------------------------------------

function cli(argv, { stdin = null, tty = false } = {}) {
  const out = [];
  const err = [];
  let reads = 0;
  const code = runCli(argv, {
    readStdin: () => {
      reads++;
      if (stdin === null) throw new Error("stdin is closed");
      return stdin;
    },
    stdinIsTTY: tty,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  const text = out.join("");
  return {
    code,
    out: text,
    err: err.join("\n"),
    get json() {
      return JSON.parse(text);
    },
    reads,
  };
}

test("runCli: JSON on stdin, hits only, exit 0; --all adds none rows; hits never change the exit code", () => {
  const dir = fixture({ status: STATUS });
  const stdin = JSON.stringify(["https://learn.microsoft.com/training/modules/gone", { url: "https://learn.microsoft.com/azure/healthy" }, "/training/modules/x/05-old"]);
  const r = cli(["--data", dir, "--now", "2026-10-06T12:00:00Z"], { stdin });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.results.map((x) => x.status), ["removed", "moved"]);
  assert.equal(r.json.summary.none, 1);
  assert.equal(r.err, "");
  assert.equal(r.json.note, NONE_MEANS);
  const all = cli(["--data", dir, "--all", "--now", "2026-10-06T12:00:00Z"], { stdin });
  assert.deepEqual(all.json.results.map((x) => x.status), ["removed", "none", "moved"]);
  // nothing recorded for any of them is still exit 0
  const clean = cli(["--data", dir, "--now", "2026-10-06T12:00:00Z"], { stdin: '["/azure/a"]' });
  assert.equal(clean.code, 0);
  assert.deepEqual(clean.json.results, []);
  assert.equal(clean.json.summary.none, 1);
});

test("runCli: links as arguments do not read stdin, and combine with --input", () => {
  const dir = fixture({ status: STATUS });
  const input = join(dir, "in.json");
  writeFileSync(input, JSON.stringify(["/training/modules/x/05-old"]));
  const r = cli(["--data", dir, "/training/modules/gone", "--input", input, "--now", "2026-10-06T12:00:00Z"], { stdin: "[]" });
  assert.equal(r.code, 0);
  assert.equal(r.reads, 0);
  assert.deepEqual(r.json.results.map((x) => x.path), ["/training/modules/gone", "/training/modules/x/05-old"]);
  const args = cli(["--data", dir, "/training/modules/gone"], { tty: true });
  assert.equal(args.code, 0);
  assert.equal(args.json.results.length, 1);
  assert.equal(args.reads, 0);
});

test("runCli: --since never touches stdin", () => {
  const dir = fixture({ status: STATUS });
  const r = cli(["--data", dir, "--since", "2026-10-01", "--now", "2026-10-06T12:00:00Z"], { tty: true });
  assert.equal(r.code, 0);
  assert.equal(r.reads, 0);
  assert.equal(r.json.since, "2026-10-01");
  assert.equal(r.json.changes.length, 4);
});

test("runCli: --output writes the report to a file and prints nothing to stdout", () => {
  const dir = fixture({ status: STATUS });
  const target = join(dir, "report.json");
  const r = cli(["--data", dir, "--since", "2026-10-01", "--output", target, "--now", "2026-10-06T12:00:00Z"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, "");
  assert.equal(JSON.parse(readFileSync(target, "utf-8")).changes.length, 4);
  const bad = cli(["--data", dir, "--since", "2026-10-01", "--output", join(dir, "no", "such", "dir", "r.json")]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /cannot write --output/);
});

test("runCli: --help prints the usage, which says what none means", () => {
  const r = cli(["--help"]);
  assert.equal(r.code, 0);
  assert.equal(r.out, USAGE);
  assert.match(r.out, /"none" means NO CHANGE IS RECORDED/);
  assert.match(r.out, /does NOT mean the link is valid/);
  assert.match(r.out, /--since/);
});

test("runCli: usage errors exit 2 with a message and print nothing to stdout", () => {
  const dir = fixture();
  const input = join(dir, "bad.json");
  writeFileSync(input, "{not json");
  for (const [argv, opts, pattern] of [
    [["--bogus"], {}, /unknown argument/],
    [["--data", dir], { tty: true }, /no links/],
    [["--data", dir], { stdin: "{not json" }, /not valid JSON/],
    [["--data", dir], { stdin: '{"a":1}' }, /JSON array/],
    [["--data", dir], { stdin: "[1]" }, /item 0/],
    [["--data", dir], {}, /cannot read stdin/],
    [["--data", dir, "--input", join(dir, "missing.json")], {}, /cannot read --input/],
    [["--data", dir, "--input", input], {}, /not valid JSON/],
    [["--data", join(dir, "nope"), "/a"], {}, /data directory not found/],
    [["--data", dir, "--since", "2026-99-99"], {}, /--since must be a date/],
  ]) {
    const r = cli(argv, opts);
    assert.equal(r.code, 2, argv.join(" "));
    assert.equal(r.out, "");
    assert.match(r.err, pattern, argv.join(" "));
    assert.match(r.err, /--help/);
  }
});

test("runCli: change files that exist but cannot be read exit 1 and print no report", () => {
  for (const [name, body, pattern] of [
    ["removed.json", "{ truncated", /not valid JSON/],
    ["moved.json", JSON.stringify({ schemaVersion: 2, entries: [] }), /unsupported schemaVersion/],
    ["removed.json", JSON.stringify({ schemaVersion: 1, entries: {} }), /`entries` is not an array/],
    ["moved.json", "[]", /top level is not an object/],
  ]) {
    const dir = fixture();
    writeFileSync(join(dir, "changes", name), body);
    const r = cli(["--data", dir, "/training/modules/gone"]);
    assert.equal(r.code, 1, name);
    assert.equal(r.out, "", "no report: every link would read none");
    assert.match(r.err, pattern);
    assert.match(r.err, /cannot read the change files/);
  }
});

test("runCli: missing change files are not an error: every link reads none and the warnings say why", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-changes-empty-"));
  const r = cli(["--data", dir, "--all", "--now", "2026-10-06T12:00:00Z"], { stdin: '["/training/modules/gone"]' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.json.results.map((x) => x.status), ["none"]);
  assert.equal(r.json.freshness.stale, true);
  assert.deepEqual(r.json.freshness.missingFiles, ["removed.json", "moved.json"]);
  assert.match(r.json.warnings.join("\n"), /every link reads none/);
  assert.match(r.err, /warning: change file\(s\) missing/);
  const since = cli(["--data", dir, "--since", "2026-01-01"]);
  assert.equal(since.code, 0);
  assert.deepEqual(since.json.changes, []);
});

test("runCli: stale freshness is warned about on stderr and in the report, but the check still runs", () => {
  const dir = fixture({ sources: { learn: "2026-09-01T00:00:00.000Z", docs: FRESH }, status: STATUS });
  const r = cli(["--data", dir, "--now", "2026-10-06T12:00:00Z", "/training/modules/gone"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.freshness.stale, true);
  assert.equal(r.json.results.length, 1);
  assert.match(r.err, /warning: the Learn entries were last refreshed 2026-09-01/);
  const lenient = cli(["--data", dir, "--now", "2026-10-06T12:00:00Z", "--stale-days", "60", "/training/modules/gone"]);
  assert.equal(lenient.json.freshness.stale, false);
  assert.equal(lenient.err.includes("Learn entries"), false);
});

test("runCli: rows the reader dropped and paths listed in both files are reported as warnings", () => {
  const dir = fixture({ status: STATUS });
  const removedFile = join(dir, "changes", "removed.json");
  const removed = JSON.parse(readFileSync(removedFile, "utf-8"));
  removed.entries.push({ path: "/training/modules/hand-edited", kind: "nonsense", outcome: "gone", firstSeen: "2026-09-01", evidence: "tombstone" });
  removed.entries.push(E("/training/modules/x/05-old", { kind: "unit", lastVerified: "2026-01-01" })); // also in moved.json, but verified earlier
  writeFileSync(removedFile, JSON.stringify(removed));
  const r = cli(["--data", dir, "--now", "2026-10-06T12:00:00Z", "/training/modules/x/05-old"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.results[0].status, "moved", "the more recently verified claim wins");
  const text = r.json.warnings.join("\n");
  assert.match(text, /dropped a malformed row \(unknown kind "nonsense"\)/);
  assert.match(text, /list \/training\/modules\/x\/05-old twice/);
  assert.match(r.err, /warning: .*dropped a malformed row/);
});

test("runCli never reads the big caches: damaged learn-catalog.json and docs-catalog.json do not matter", () => {
  const dir = fixture({ status: STATUS });
  for (const name of ["learn-catalog.json", "learn-content.json", "docs-catalog.json", "docs-urls.txt", "docs-redirects.json"]) {
    writeFileSync(join(dir, name), "this is not json and would break any reader of the caches");
  }
  const r = cli(["--data", dir, "--now", "2026-10-06T12:00:00Z", "/training/modules/gone"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.results[0].status, "removed");
});

// ---------------------------------------------------------------------------
// the real process
// ---------------------------------------------------------------------------

test("process: stdin in, JSON out, exit 0 on hits; exit 2 on a usage error; exit 1 on unreadable change files", () => {
  const dir = fixture({ status: STATUS });
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], { encoding: "utf-8", input });
  const hit = run(["--data", dir, "--now", "2026-10-06T12:00:00Z"], '["https://learn.microsoft.com/training/modules/gone/","https://learn.microsoft.com/azure/x"]');
  assert.equal(hit.status, 0, hit.stderr);
  const out = JSON.parse(hit.stdout);
  assert.deepEqual(out.results.map((r) => [r.path, r.status]), [["/training/modules/gone", "removed"]]);
  assert.equal(out.summary.none, 1);
  assert.equal(hit.stderr, "");

  const usage = run(["--data", dir, "--since", "nope"], "");
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /--since must be a date/);

  const garbage = run(["--data", dir], "not json at all");
  assert.equal(garbage.status, 2);

  const help = run(["--help"], "");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /NO CHANGE IS RECORDED/);

  writeFileSync(join(dir, "changes", "removed.json"), "{ broken");
  const broken = run(["--data", dir], '["/training/modules/gone"]');
  assert.equal(broken.status, 1);
  assert.equal(broken.stdout, "");
  assert.match(broken.stderr, /cannot read the change files/);
});
