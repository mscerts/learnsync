import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath, modulePath, slugText, firstSegment, underPrefix, byCodePoint } from "../scripts/lib/canonical.mjs";
import { withSection, updateStatus, readStatus } from "../scripts/lib/status.mjs";

test("canonicalPath lowercases and strips host, locale, query, fragment and trailing slash", () => {
  assert.equal(
    canonicalPath("https://learn.microsoft.com/en-us/Training/Modules/Foundry-SDK/06-Exercise/?WT.mc_id=x#a"),
    "/training/modules/foundry-sdk/06-exercise"
  );
  assert.equal(canonicalPath("https://learn.microsoft.com/azure/key-vault/general/overview"), "/azure/key-vault/general/overview");
  assert.equal(canonicalPath("/en-us/azure/foo/?view=x"), "/azure/foo");
  assert.equal(canonicalPath("https://learn.microsoft.com/"), "/");
  assert.equal(canonicalPath("https://learn.microsoft.com/en-us"), "/");
  assert.equal(canonicalPath("/training/modules/x/"), "/training/modules/x");
});

test("canonicalPath rejects non-Learn hosts, relative strings and junk", () => {
  assert.equal(canonicalPath("https://docs.github.com/en/actions"), null);
  assert.equal(canonicalPath("azure/foo"), null);
  assert.equal(canonicalPath("not a url"), null);
  assert.equal(canonicalPath(""), null);
  assert.equal(canonicalPath(undefined), null);
});

test("small path helpers", () => {
  assert.equal(modulePath("foundry-sdk"), "/training/modules/foundry-sdk");
  assert.equal(slugText("14-exercise-add"), "exercise-add");
  assert.equal(slugText("5a-lab"), "lab");
  assert.equal(slugText("introduction"), "introduction");
  assert.equal(firstSegment("/azure/foo"), "azure");
  assert.equal(firstSegment("/"), null);
  assert.equal(underPrefix("/azure/foo", "azure"), true);
  assert.equal(underPrefix("/azure", "azure"), true);
  assert.equal(underPrefix("/azure-x/foo", "azure"), false);
  assert.deepEqual(["b", "B", "a"].sort(byCodePoint), ["B", "a", "b"]);
});

test("status sections are replaced wholesale and ordered", () => {
  const now = new Date("2026-10-06T07:00:00Z");
  const a = withSection({}, "docs", { indexUrls: 5 }, { now, runId: "9" });
  const b = withSection(a, "learn", { modules: 3 }, { now, runId: null });
  assert.deepEqual(Object.keys(b), ["schemaVersion", "learn", "docs"]);
  assert.equal(b.docs.runId, "9");
  assert.equal(b.learn.generatedAt, "2026-10-06T07:00:00.000Z");
  const c = withSection(b, "docs", { indexUrls: 6 }, { now, runId: "10" });
  assert.deepEqual(Object.keys(c.docs), ["generatedAt", "runId", "indexUrls"]);
  assert.equal(c.docs.indexUrls, 6);
});

test("updateStatus merges into the file and reads GITHUB_RUN_ID", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"));
  const file = join(dir, "status.json");
  updateStatus(file, "learn", { modules: 1 }, { env: { GITHUB_RUN_ID: 77 } });
  updateStatus(file, "docs", { indexUrls: 2 }, { env: {} });
  const status = readStatus(file);
  assert.equal(status.schemaVersion, 1);
  assert.equal(status.learn.runId, "77");
  assert.equal(status.docs.runId, null);
  assert.equal(JSON.parse(readFileSync(file, "utf-8")).docs.indexUrls, 2);
  assert.deepEqual(readStatus(join(dir, "missing.json")), {});
});
