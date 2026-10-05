import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LIMITS, FETCH_CONCURRENCY, PER_WORKER_DELAY_MS, readConfig } from "../scripts/lib/docs-config.mjs";

test("readConfig defaults match the documented budgets", () => {
  const c = readConfig({});
  assert.deepEqual(c.caps, { maxPageFetches: 6000, maxMissingChecks: 2000, verifyPerRun: 2000, maxQuarantineRechecks: 1000 });
  assert.equal(c.maxRuntimeMinutes, 90);
  assert.equal(c.consecutiveTransientLimit, 40);
  assert.equal(c.dryRun, false);
  assert.equal(c.fullDiscovery, false);
  assert.equal(c.skipGitSources, false);
  assert.equal(c.reportFile, null);
  assert.equal(c.githubOutput, null);
  assert.equal(c.concurrency, 3);
  assert.equal(FETCH_CONCURRENCY, 3, "Learn rate-limits above 3 concurrent requests");
  assert.ok(PER_WORKER_DELAY_MS >= 500);
  assert.equal(DEFAULT_LIMITS.maxRuntimeMinutes, 90);
});

test("readConfig reads every documented variable", () => {
  const c = readConfig({
    DRY_RUN: "1",
    FULL_DISCOVERY: "1",
    SKIP_GIT_SOURCES: "1",
    MAX_PAGE_FETCHES: "150",
    MAX_MISSING_CHECKS: "60",
    VERIFY_PER_RUN: "0",
    MAX_QUARANTINE_RECHECKS: "5",
    MAX_RUNTIME_MINUTES: "0",
    CONSECUTIVE_TRANSIENT_LIMIT: "7",
    QUARANTINE_REPORT_FILE: "/tmp/r.md",
    GITHUB_OUTPUT: "/tmp/out",
  });
  assert.equal(c.dryRun, true);
  assert.equal(c.fullDiscovery, true);
  assert.equal(c.skipGitSources, true);
  assert.deepEqual(c.caps, { maxPageFetches: 150, maxMissingChecks: 60, verifyPerRun: 0, maxQuarantineRechecks: 5 });
  assert.equal(c.maxRuntimeMinutes, 0);
  assert.equal(c.consecutiveTransientLimit, 7);
  assert.equal(c.reportFile, "/tmp/r.md");
  assert.equal(c.githubOutput, "/tmp/out");
});

test("flags are exactly '1'; empty values fall back to the default", () => {
  assert.equal(readConfig({ DRY_RUN: "true" }).dryRun, false);
  assert.equal(readConfig({ MAX_PAGE_FETCHES: "" }).caps.maxPageFetches, 6000);
  assert.equal(readConfig({ MAX_PAGE_FETCHES: "  " }).caps.maxPageFetches, 6000);
});

test("a malformed number is an error, never a silent default", () => {
  for (const bad of ["abc", "-5", "1.5", "1e3", "12px"]) {
    assert.throws(() => readConfig({ MAX_PAGE_FETCHES: bad }), /MAX_PAGE_FETCHES must be a non-negative integer/, bad);
  }
  assert.throws(() => readConfig({ MAX_RUNTIME_MINUTES: "ninety" }), /MAX_RUNTIME_MINUTES/);
  assert.throws(() => readConfig({ VERIFY_PER_RUN: "99999999999999999999" }), /too large/);
});
