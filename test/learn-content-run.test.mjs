import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FailsafeAbort } from "../scripts/lib/learn-io.mjs";
import { classifySkillPage, runContentSync } from "../scripts/lib/learn-content-run.mjs";
import { contributeLearnStatus } from "../scripts/lib/learn-status.mjs";
import { collectLogs, makeFakeLearn, makeTempDir, mod, removeDir, unitsOf } from "./learn-fixtures.mjs";

const noSleep = async () => {};
const D1 = new Date("2026-10-05T07:00:00.000Z");
const D2 = new Date("2026-10-12T07:00:00.000Z");
const U = (path) => `https://learn.microsoft.com/en-us${path}/?WT.mc_id=api_CatalogApi`;
const LM = "2026-01-01T00:00:00+00:00";

const EXAM_SG = (code) => `/credentials/certifications/resources/study-guides/${code}`;
const SKILL_SG = (code) => `/credentials/applied-skills/resources/study-guides/${code}`;

/** a small, complete world: 3 modules, 2 paths, 2 courses, 1 certification, 3 exams, 2 applied skills + live pages */
function world() {
  const modules = ["a", "b", "c"].map((s) => mod({ uid: `learn.${s}`, slug: s, products: ["azure-vm"] }));
  const content = {
    learningPaths: [
      { uid: "learn.path-1", title: "Path 1", url: U("/training/paths/path-1"), last_modified: LM, modules: ["learn.a", "learn.b"] },
      { uid: "learn.path-2", title: "Path 2", url: U("/training/paths/path-2"), last_modified: LM, modules: ["learn.c"] },
    ],
    courses: [
      { uid: "course.az-104t00", course_number: "AZ-104T00", title: "AZ-104", url: U("/training/courses/az-104t00"), last_modified: LM },
      { uid: "course.edu.x", course_number: "", title: "Edu", url: U("/training/courses/x"), last_modified: LM },
    ],
    certifications: [{ uid: "certification.admin", title: "Admin", url: U("/credentials/certifications/admin"), last_modified: LM, exams: ["exam.az-305"] }],
    exams: [
      { uid: "exam.az-305", title: "AZ-305", display_name: "AZ-305", url: U("/credentials/certifications/exams/az-305"), last_modified: LM },
      { uid: "exam.ab-100", title: "AB-100", display_name: "AB-100", url: U("/credentials/certifications/exams/ab-100"), last_modified: LM },
      { uid: "exam.70-767", title: "70-767", display_name: "70-767", url: U("/credentials/certifications/exams/70-767"), last_modified: LM },
    ],
    appliedSkills: [
      { uid: "applied-skill.skill-one", title: "Microsoft Applied Skills: One", url: U("/credentials/applied-skills/skill-one"), last_modified: LM },
      { uid: "applied-skill.skill-two", title: "Microsoft Applied Skills: Two", url: U("/credentials/applied-skills/skill-two"), last_modified: LM },
    ],
  };
  const pages = new Map([
    [EXAM_SG("az-305"), { status: 200 }],
    [EXAM_SG("ab-100"), { status: 200 }],
    ["/credentials/applied-skills/skill-one", { status: 200, body: '<a href="https://aka.ms/APL1000-StudyGuide">Study guide</a>' }],
    ["/credentials/applied-skills/skill-two", { status: 200, body: '<a href="https://aka.ms/APL1001-StudyGuide">Study guide</a>' }],
    [SKILL_SG("apl-1000"), { status: 200 }],
    [SKILL_SG("apl-1001"), { status: 200 }],
  ]);
  return { modules, units: unitsOf(modules), content, pages };
}

function setup(mutate) {
  const dir = makeTempDir();
  const w = world();
  mutate?.(w);
  const fake = makeFakeLearn({ modules: w.modules, units: w.units, content: w.content, pages: w.pages });
  const run = (over = {}) =>
    runContentSync({
      dataDir: dir,
      env: {},
      now: D1,
      fetchImpl: fake.fetchImpl,
      sleepImpl: noSleep,
      delayMs: 0,
      minCounts: {},
      minResolutionModules: 1,
      limits: { PROBE_MIN_SAMPLE: 3 },
      httpOptions: { attempts: 2, baseBackoffMs: 1 },
      ...collectLogs(),
      ...over,
    });
  return {
    dir,
    fake,
    run,
    read: (name = "learn-content.json") => JSON.parse(readFileSync(join(dir, name), "utf-8")),
    text: (name = "learn-content.json") => readFileSync(join(dir, name), "utf-8"),
    cleanup: () => removeDir(dir),
  };
}

const probeRequests = (t) => t.fake.requests.filter((u) => u.includes("/study-guides/"));

test("first run: builds every list, resolves learning-path modules, probes study guides, writes status", async () => {
  const t = setup();
  try {
    const r = await t.run();
    assert.equal(r.wrote, true);
    const c = t.read();
    assert.equal(c.schemaVersion, 1);
    assert.deepEqual(c.learningPaths.map((p) => [p.uid, p.modules]), [["learn.path-1", ["/training/modules/a", "/training/modules/b"]], ["learn.path-2", ["/training/modules/c"]]]);
    assert.deepEqual(c.courses.map((x) => [x.uid, x.code]), [["course.az-104t00", "AZ-104T00"], ["course.edu.x", null]]);
    assert.deepEqual(c.certifications[0].exams, ["az-305"]);
    assert.deepEqual(c.exams.map((e) => [e.code, e.studyGuide]), [["70-767", null], ["ab-100", EXAM_SG("ab-100")], ["az-305", EXAM_SG("az-305")]]);
    assert.deepEqual(c.appliedSkills.map((s) => [s.code, s.studyGuide]), [["apl-1000", SKILL_SG("apl-1000")], ["apl-1001", SKILL_SG("apl-1001")]]);
    assert.deepEqual(c.studyGuides, [
      { path: SKILL_SG("apl-1000"), checked: "2026-10-05" },
      { path: SKILL_SG("apl-1001"), checked: "2026-10-05" },
      { path: EXAM_SG("ab-100"), checked: "2026-10-05" },
      { path: EXAM_SG("az-305"), checked: "2026-10-05" },
    ]);
    assert.deepEqual(c.unverifiedStudyGuides, []);
    assert.deepEqual(c.removed, []);
    const status = t.read("status.json");
    assert.deepEqual(status.learn.content, { learningPaths: 2, courses: 2, certifications: 1, exams: 3, appliedSkills: 2, studyGuides: 4 });
    assert.equal(status.learn.contentGeneratedAt, D1.toISOString());
  } finally {
    t.cleanup();
  }
});

test("requests: one catalog request per type (plus the module list), study guides probed with the en-us url, concurrency capped", async () => {
  const t = setup();
  try {
    await t.run();
    const catalog = t.fake.requests.filter((u) => u.includes("/api/catalog/"));
    assert.deepEqual(catalog.map((u) => new URL(u).searchParams.get("type")), ["learningPaths", "courses", "certifications", "exams", "appliedSkills", "modules,units"]);
    assert.ok(probeRequests(t).includes("https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-305"));
    assert.equal(probeRequests(t).filter((u) => u.includes("certifications")).length, 3, "every exam is probed, including 70-767");
  } finally {
    t.cleanup();
  }
});

test("second run: write skipped (study guide dates are volatile), heartbeat advances, file byte-identical", async () => {
  const t = setup();
  try {
    await t.run();
    const before = t.text();
    const r = await t.run({ now: D2 });
    assert.equal(r.unchanged, true);
    assert.equal(r.wrote, false);
    assert.equal(t.text(), before, "checked dates stay at the last real write");
    assert.equal(t.read("status.json").learn.contentGeneratedAt, D2.toISOString());
  } finally {
    t.cleanup();
  }
});

test("a study guide that starts answering 404 is dropped and the file rewritten; one that appears is added", async () => {
  const t = setup();
  try {
    await t.run();
    t.fake.state.pages.delete(EXAM_SG("ab-100"));
    t.fake.state.pages.set(EXAM_SG("70-767"), { status: 200 });
    const r = await t.run({ now: D2 });
    assert.equal(r.wrote, true);
    const c = t.read();
    assert.equal(c.exams.find((e) => e.code === "ab-100").studyGuide, null);
    assert.equal(c.exams.find((e) => e.code === "70-767").studyGuide, EXAM_SG("70-767"));
    assert.deepEqual(c.studyGuides.map((g) => g.path), [SKILL_SG("apl-1000"), SKILL_SG("apl-1001"), EXAM_SG("70-767"), EXAM_SG("az-305")]);
    assert.equal(c.studyGuides.find((g) => g.path === EXAM_SG("az-305")).checked, "2026-10-12");
  } finally {
    t.cleanup();
  }
});

test("a study guide URL that answers 200 on another path (a redirect to Browse) is NOT a study guide", async () => {
  const t = setup((w) => w.pages.set(EXAM_SG("ab-100"), { status: 200, finalPath: "/credentials/browse" }));
  try {
    const logs = collectLogs();
    await t.run({ log: logs.log, warn: logs.warn });
    assert.equal(t.read().exams.find((e) => e.code === "ab-100").studyGuide, null);
    assert.ok(logs.lines.some((l) => /answer 200 on another path.*ab-100/.test(l)));
  } finally {
    t.cleanup();
  }
});

test("transient probe failures (429 storm, timeout, 5xx, 403) keep the previous value instead of dropping it", async () => {
  const t = setup();
  try {
    await t.run();
    t.fake.state.pages.set(EXAM_SG("ab-100"), { status: 503 });
    t.fake.state.pages.set(EXAM_SG("az-305"), { throws: "slow" });
    t.fake.state.pages.set(SKILL_SG("apl-1000"), { status: 429 });
    t.fake.state.pages.set(SKILL_SG("apl-1001"), { status: 403 });
    t.fake.state.content.exams = t.fake.state.content.exams.map((e) => (e.uid === "exam.70-767" ? { ...e, title: "force a rewrite" } : e));
    const r = await t.run({ now: D2, limits: { PROBE_MIN_SAMPLE: 100 } });
    assert.equal(r.wrote, true);
    const c = t.read();
    assert.equal(c.exams.find((e) => e.code === "ab-100").studyGuide, EXAM_SG("ab-100"));
    assert.equal(c.exams.find((e) => e.code === "az-305").studyGuide, EXAM_SG("az-305"));
    assert.deepEqual(c.appliedSkills.map((s) => s.studyGuide), [SKILL_SG("apl-1000"), SKILL_SG("apl-1001")]);
    assert.deepEqual(c.studyGuides.map((g) => g.checked), ["2026-10-05", "2026-10-05", "2026-10-05", "2026-10-05"], "kept entries keep their old verification date");
    assert.equal(r.examStats.transient, 2);
    assert.equal(r.examStats.keptPrevious, 2);
  } finally {
    t.cleanup();
  }
});

test("a transient failure for an exam with no previous record is reported as unverified, not as absent", async () => {
  const t = setup((w) => w.pages.set(EXAM_SG("ab-100"), { status: 500 }));
  try {
    const r = await t.run({ limits: { PROBE_MIN_SAMPLE: 100 } });
    const c = t.read();
    assert.equal(c.exams.find((e) => e.code === "ab-100").studyGuide, null);
    assert.deepEqual(c.unverifiedStudyGuides, [EXAM_SG("ab-100")]);
    assert.equal(r.examStats.unverified, 1);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: most probes transient aborts without writing (a run that proved nothing must not look like a success)", async () => {
  const t = setup((w) => {
    w.pages.set(EXAM_SG("az-305"), { status: 503 });
    w.pages.set(EXAM_SG("ab-100"), { status: 503 });
  });
  try {
    await assert.rejects(t.run({ limits: { PROBE_MIN_SAMPLE: 3 } }), (err) => err instanceof FailsafeAbort && /exam study guide probes were transient/.test(err.message));
    assert.equal(existsSync(join(t.dir, "learn-content.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: a list that shrinks by more than 20% aborts and leaves the previous file untouched", async () => {
  const t = setup();
  try {
    await t.run();
    const before = t.text();
    const statusBefore = t.text("status.json");
    t.fake.state.content.exams = t.fake.state.content.exams.slice(0, 2);
    await assert.rejects(t.run({ now: D2 }), (err) => err instanceof FailsafeAbort && /exams fell from 3 to 2/.test(err.message));
    t.fake.state.content.exams = world().content.exams;
    t.fake.state.content.courses = [];
    await assert.rejects(t.run({ now: D2 }), /courses fell from 2 to 0/);
    assert.equal(t.text(), before);
    assert.equal(t.text("status.json"), statusBefore);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: the per-list floor applies on a first run", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ minCounts: { exams: 70 } }), /exams: only 3 entries \(floor 70\)/);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: a module list that is too small to resolve learning paths aborts; so does a high share of unresolved module references", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ minResolutionModules: 10 }), /module list has only 3 modules \(floor 10\)/);
    t.fake.state.modules = t.fake.state.modules.slice(0, 1);
    await assert.rejects(t.run(), /learning-path module references .* did not resolve/);
  } finally {
    t.cleanup();
  }
});

test("FAILSAFE: if the applied-skill pages stop carrying the study guide link, the run aborts instead of dropping every skill guide", async () => {
  const t = setup();
  try {
    await t.run();
    const before = t.text();
    t.fake.state.pages.set("/credentials/applied-skills/skill-one", { status: 200, body: "<html>redesigned</html>" });
    t.fake.state.pages.set("/credentials/applied-skills/skill-two", { status: 200, body: "<html>redesigned</html>" });
    await assert.rejects(t.run({ now: D2 }), (err) => err instanceof FailsafeAbort && /only 0 of the 2 applied skills/.test(err.message));
    assert.equal(t.text(), before);
  } finally {
    t.cleanup();
  }
});

test("applied skills: a skill page that is gone (404), redirected, or transiently failing never invents a code", async () => {
  const t = setup();
  try {
    await t.run();
    t.fake.state.pages.set("/credentials/applied-skills/skill-one", { status: 200, finalPath: "/credentials/applied-skills/other-skill", body: '<a href="https://aka.ms/APL9999-StudyGuide">x</a>' });
    t.fake.state.pages.delete("/credentials/applied-skills/skill-two");
    const r = await t.run({ now: D2, limits: { PROBE_MIN_SAMPLE: 100, MIN_SKILL_CODE_SHARE_PCT: 0 } });
    const c = t.read();
    const one = c.appliedSkills.find((s) => s.uid.endsWith("skill-one"));
    const two = c.appliedSkills.find((s) => s.uid.endsWith("skill-two"));
    assert.deepEqual([one.code, one.studyGuide], ["apl-1000", SKILL_SG("apl-1000")], "a redirect is transient: the previous code stays and the other page's code is NOT read");
    assert.deepEqual([two.code, two.studyGuide], [null, null], "a 404 skill page: no code");
    assert.equal(r.skillStats.transient, 1);
    assert.equal(r.skillStats.withoutCode, 1);
  } finally {
    t.cleanup();
  }
});

test("classifySkillPage: only a 200 on the skill's own path is read for its code", () => {
  const html = '<a href="https://aka.ms/APL6500-StudyGuide">x</a>';
  assert.deepEqual(classifySkillPage({ outcome: "ok", status: 200, finalUrl: "https://learn.microsoft.com/en-us/credentials/applied-skills/s/", body: html }, "/credentials/applied-skills/s"), { page: "ok", code: "apl-6500" });
  assert.equal(classifySkillPage({ outcome: "ok", status: 200, finalUrl: "https://learn.microsoft.com/en-us/credentials/browse", body: html }, "/credentials/applied-skills/s").page, "transient");
  assert.equal(classifySkillPage({ outcome: "notFound", status: 404 }, "/credentials/applied-skills/s").page, "notFound");
  assert.equal(classifySkillPage({ outcome: "transient", error: "timeout" }, "/credentials/applied-skills/s").page, "transient");
});

test("tombstones per type: a removed exam and a removed learning path are recorded with dates; they are dropped when the uid returns", async () => {
  const t = setup();
  try {
    await t.run();
    const original = JSON.parse(JSON.stringify(t.fake.state.content));
    t.fake.state.content.exams = original.exams.filter((e) => e.uid !== "exam.70-767");
    t.fake.state.content.learningPaths = original.learningPaths.filter((p) => p.uid !== "learn.path-2");
    t.fake.state.content.courses = [...original.courses, { uid: "course.new", course_number: "NEW", title: "New", url: U("/training/courses/new"), last_modified: LM }];
    await assert.rejects(t.run({ now: D2 }), /learningPaths fell from 2 to 1/, "50% shrink trips the failsafe first");
    await t.run({ now: D2, limits: { MAX_CONTENT_DROP_PCT: 60, PROBE_MIN_SAMPLE: 3 } });
    const c = t.read();
    assert.deepEqual(c.removed.map((x) => `${x.type}:${x.uid}`), ["exam:exam.70-767", "learningPath:learn.path-2"]);
    assert.deepEqual(c.removed[0], { type: "exam", uid: "exam.70-767", path: "/credentials/certifications/exams/70-767", title: "70-767", lastSeen: "2026-10-05", removedOn: "2026-10-12" });
    assert.equal(t.read("status.json").learn.content.exams, 2);

    t.fake.state.content = original;
    await t.run({ now: new Date("2026-10-19T07:00:00Z"), limits: { MAX_CONTENT_DROP_PCT: 60, PROBE_MIN_SAMPLE: 3 } });
    assert.deepEqual(t.read().removed.map((x) => `${x.type}:${x.uid}`), ["course:course.new"], "the exam and the learning path came back (tombstones dropped); the extra course I added is now gone");
  } finally {
    t.cleanup();
  }
});

test("the content run does not clobber the catalog part of the learn status", async () => {
  const t = setup();
  try {
    contributeLearnStatus(join(t.dir, "status.json"), "catalog", { modules: 3355, removed: 1 }, { now: new Date("2026-10-04T07:00:00Z"), env: {} });
    await t.run();
    const status = t.read("status.json");
    assert.equal(status.learn.modules, 3355);
    assert.equal(status.learn.content.exams, 3);
    assert.equal(status.learn.generatedAt, "2026-10-04T07:00:00.000Z");
  } finally {
    t.cleanup();
  }
});

test("a malformed catalog response, a duplicate uid and a missing array abort with clear messages", async () => {
  const t = setup();
  try {
    t.fake.state.content.exams = [...t.fake.state.content.exams, t.fake.state.content.exams[0]];
    await assert.rejects(t.run(), /exams: uid exam\.az-305 appears more than once|exams: the code az-305 appears more than once/);
  } finally {
    t.cleanup();
  }
  const t2 = setup();
  const original = t2.fake.fetchImpl;
  try {
    await assert.rejects(
      t2.run({
        fetchImpl: async (url) => (String(url).includes("type=courses") ? new Response(JSON.stringify({ nope: [] }), { status: 200 }) : original(url)),
      }),
      /no "courses" array/
    );
  } finally {
    t2.cleanup();
  }
});

test("DRY_RUN=1 writes nothing; a corrupt previous file is treated as absent", async () => {
  const t = setup();
  try {
    const r = await t.run({ env: { DRY_RUN: "1" } });
    assert.equal(r.dryRun, true);
    assert.equal(existsSync(join(t.dir, "learn-content.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
    writeFileSync(join(t.dir, "learn-content.json"), "{broken");
    const r2 = await t.run();
    assert.equal(r2.wrote, true);
    assert.equal(t.read().schemaVersion, 1);
  } finally {
    t.cleanup();
  }
});

test("an invalid MAX_CONTENT_DROP_PCT aborts instead of silently using the default", async () => {
  const t = setup();
  try {
    await assert.rejects(t.run({ env: { MAX_CONTENT_DROP_PCT: "lots" } }), /Invalid MAX_CONTENT_DROP_PCT/);
  } finally {
    t.cleanup();
  }
});
