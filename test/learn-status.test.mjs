import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { contributeLearnStatus, mergeLearnSection, oldestPartStamp } from "../scripts/lib/learn-status.mjs";
import { updateStatus } from "../scripts/lib/status.mjs";
import { makeTempDir, removeDir } from "./learn-fixtures.mjs";

const T1 = new Date("2026-10-05T07:00:00.000Z");
const T2 = new Date("2026-10-05T08:30:00.000Z");

test("mergeLearnSection keeps the other part's keys, stamps its own, and orders keys stably", () => {
  const first = mergeLearnSection(undefined, "catalog", { modules: 3355, removed: 0, outOfScope: 66 }, T1);
  assert.deepEqual(Object.keys(first), ["modules", "removed", "outOfScope", "catalogGeneratedAt"]);
  const second = mergeLearnSection(first, "content", { content: { exams: 145 } }, T2);
  assert.equal(second.modules, 3355);
  assert.deepEqual(second.content, { exams: 145 });
  assert.equal(second.catalogGeneratedAt, T1.toISOString());
  assert.equal(second.contentGeneratedAt, T2.toISOString());
  assert.deepEqual(Object.keys(second), ["modules", "removed", "outOfScope", "content", "catalogGeneratedAt", "contentGeneratedAt"]);
  assert.throws(() => mergeLearnSection({}, "nope", {}, T1), /Unknown learn status part/);
});

test("mergeLearnSection drops a stale generatedAt/runId of the previous section (the writer re-stamps them)", () => {
  const merged = mergeLearnSection({ generatedAt: "old", runId: "1", modules: 1 }, "catalog", { modules: 2 }, T1);
  assert.equal("generatedAt" in merged, false);
  assert.equal("runId" in merged, false);
  assert.equal(merged.modules, 2);
});

test("oldestPartStamp is the older valid stamp, or the fallback", () => {
  assert.equal(oldestPartStamp({ catalogGeneratedAt: T2.toISOString(), contentGeneratedAt: T1.toISOString() }, T2).toISOString(), T1.toISOString());
  assert.equal(oldestPartStamp({ catalogGeneratedAt: T2.toISOString() }, T1).toISOString(), T2.toISOString());
  assert.equal(oldestPartStamp({ catalogGeneratedAt: "garbage" }, T1).toISOString(), T1.toISOString());
  assert.equal(oldestPartStamp({}, T1).toISOString(), T1.toISOString());
});

test("both scripts contribute to the same learn section without clobbering each other, whichever runs first", () => {
  for (const order of [["catalog", "content"], ["content", "catalog"]]) {
    const dir = makeTempDir();
    try {
      const file = join(dir, "status.json");
      const fields = {
        catalog: { modules: 3355, removed: 2, outOfScope: 66, unitUrlsRefreshedAt: "2026-10-05", unitHierarchyRequests: 3355, unitHierarchyFailures: 0 },
        content: { content: { learningPaths: 820, courses: 139, certifications: 152, exams: 145, appliedSkills: 37, studyGuides: 130 } },
      };
      const env = { GITHUB_RUN_ID: "42" };
      contributeLearnStatus(file, order[0], fields[order[0]], { now: T1, env });
      contributeLearnStatus(file, order[1], fields[order[1]], { now: T2, env });
      const status = JSON.parse(readFileSync(file, "utf-8"));
      assert.equal(status.schemaVersion, 1);
      assert.equal(status.learn.modules, 3355);
      assert.equal(status.learn.removed, 2);
      assert.equal(status.learn.unitUrlsRefreshedAt, "2026-10-05");
      assert.equal(status.learn.content.exams, 145);
      assert.equal(status.learn.runId, "42");
      assert.equal(status.learn.catalogGeneratedAt, order[0] === "catalog" ? T1.toISOString() : T2.toISOString());
      assert.equal(status.learn.generatedAt, T1.toISOString(), "generatedAt is the OLDER part stamp: a fresh part cannot make a stale one look fresh");
    } finally {
      removeDir(dir);
    }
  }
});

test("contributing leaves the docs section and unknown top-level keys alone", () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, "status.json");
    updateStatus(file, "docs", { indexUrls: 100, complete: true }, { now: T1, env: {} });
    contributeLearnStatus(file, "catalog", { modules: 5 }, { now: T2, env: {} });
    const status = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(status.docs, { generatedAt: T1.toISOString(), runId: null, indexUrls: 100, complete: true });
    assert.equal(status.learn.modules, 5);
    assert.deepEqual(Object.keys(status).slice(0, 3), ["schemaVersion", "learn", "docs"]);
  } finally {
    removeDir(dir);
  }
});

test("a corrupt or missing status file is replaced, not fatal", () => {
  const dir = makeTempDir();
  try {
    const file = join(dir, "status.json");
    writeFileSync(file, "{not json");
    contributeLearnStatus(file, "content", { content: { exams: 1 } }, { now: T1, env: {} });
    assert.equal(JSON.parse(readFileSync(file, "utf-8")).learn.content.exams, 1);
  } finally {
    removeDir(dir);
  }
});

test("the change-file counters of each part live under their own key, keep the key order stable and never clobber the other part", () => {
  const counters = (n) => ({ removed: n, moved: 0, unverified: 0, newRemoved: n, newMoved: 0, resurrected: 0, probed: n });
  const catalog = { modules: 3355, removed: 76, outOfScope: 66, catalogChanges: counters(2) };
  const content = { content: { exams: 145 }, contentChanges: counters(1) };
  for (const order of [["catalog", "content"], ["content", "catalog"]]) {
    const dir = makeTempDir();
    try {
      const file = join(dir, "status.json");
      const fields = { catalog, content };
      contributeLearnStatus(file, order[0], fields[order[0]], { now: T1, env: {} });
      contributeLearnStatus(file, order[1], fields[order[1]], { now: T2, env: {} });
      const learn = JSON.parse(readFileSync(file, "utf-8")).learn;
      assert.deepEqual(learn.catalogChanges, counters(2));
      assert.deepEqual(learn.contentChanges, counters(1));
      assert.equal(learn.removed, 76, "the top-level `removed` keeps meaning module tombstones");
      assert.deepEqual(Object.keys(learn), ["generatedAt", "runId", "modules", "removed", "outOfScope", "content", "catalogChanges", "contentChanges", "catalogGeneratedAt", "contentGeneratedAt"]);
    } finally {
      removeDir(dir);
    }
  }
});

test("a status file written before the change counters existed stays readable and is extended, not rewritten", () => {
  const first = mergeLearnSection({ modules: 3355, removed: 76, content: { exams: 145 }, catalogGeneratedAt: T1.toISOString(), contentGeneratedAt: T1.toISOString() }, "catalog", { modules: 3356, catalogChanges: { removed: 0 } }, T2);
  assert.equal(first.modules, 3356);
  assert.deepEqual(first.content, { exams: 145 });
  assert.deepEqual(first.catalogChanges, { removed: 0 });
  assert.equal("contentChanges" in first, false);
});
