import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyAppliedSkillResults,
  applyExamProbes,
  assembleContent,
  assertUnique,
  buildAppliedSkills,
  buildCertifications,
  buildCourses,
  buildExams,
  buildLearningPaths,
  buildModuleIndex,
  classifyProbe,
  computeContentRemovals,
  contentCounts,
  examCode,
  examCodeFromUid,
  examStudyGuidePath,
  extractAppliedSkillCode,
  findContentPathCollisions,
  mergeStudyGuides,
  sameContentExceptVolatile,
  skillStudyGuidePath,
  studyGuideProbeUrl,
  validateContentOutput,
} from "../scripts/lib/learn-content.mjs";

const U = (path) => `https://learn.microsoft.com/en-us${path}/?WT.mc_id=api_CatalogApi`;
const TODAY = "2026-10-05";

const apiPath = (uid, slug, extra = {}) => ({ uid, title: `T ${slug}`, url: U(`/training/paths/${slug}`), last_modified: "2026-01-01T00:00:00+00:00", ...extra });
const apiExam = (code, extra = {}) => ({ uid: `exam.${code.toLowerCase()}`, title: `Exam ${code}`, display_name: code, url: U(`/credentials/certifications/exams/${code.toLowerCase()}`), last_modified: "2026-01-01T00:00:00+00:00", ...extra });

test("examCode / examCodeFromUid / buildModuleIndex", () => {
  assert.equal(examCode(" AZ-104 "), "az-104");
  assert.equal(examCode(undefined), "");
  assert.equal(examCodeFromUid("exam.AZ-104"), "az-104");
  const index = buildModuleIndex([{ uid: "m1", url: U("/training/modules/one") }, { uid: "$m2", url: U("/training/modules/two") }, { uid: "bad", url: "https://example.com/x" }, null]);
  assert.deepEqual([...index], [["m1", "/training/modules/one"], ["$m2", "/training/modules/two"]]);
});

test("buildLearningPaths resolves module uids to canonical module paths and reports (never guesses) the unresolved ones", () => {
  const index = new Map([["m1", "/training/modules/one"], ["m2", "/training/saas/two"]]);
  const { records, stats } = buildLearningPaths([apiPath("lp.b", "b", { modules: ["m2", "missing", "m1"] }), apiPath("lp.a", "a", { modules: [] })], index);
  assert.deepEqual(records.map((r) => r.uid), ["lp.a", "lp.b"]);
  assert.deepEqual(records[1], { uid: "lp.b", title: "T b", path: "/training/paths/b", lastModified: "2026-01-01T00:00:00+00:00", modules: ["/training/saas/two", "/training/modules/one"] });
  assert.equal(stats.references, 3);
  assert.equal(stats.unresolved, 1);
  assert.deepEqual(stats.unresolvedSamples, [{ learningPath: "lp.b", module: "missing" }]);
});

test("buildCourses: code is the API course_number, null when empty (education courses have none)", () => {
  const { records, stats } = buildCourses([
    { uid: "course.z", course_number: "GH-200T00", title: "Z", url: U("/training/courses/gh-200t00"), last_modified: "d" },
    { uid: "course.edu.a", course_number: "", title: "A", url: U("/training/courses/a"), last_modified: "d" },
  ]);
  assert.deepEqual(records.map((r) => [r.uid, r.code, r.path]), [["course.edu.a", null, "/training/courses/a"], ["course.z", "GH-200T00", "/training/courses/gh-200t00"]]);
  assert.equal(stats.withoutCode, 1);
});

test("buildExams: code is the lowercase display name, studyGuide starts null, duplicate codes abort", () => {
  const { records } = buildExams([apiExam("MB6-894"), apiExam("AZ-104")]);
  assert.deepEqual(records.map((r) => [r.code, r.studyGuide, r.path]), [["az-104", null, "/credentials/certifications/exams/az-104"], ["mb6-894", null, "/credentials/certifications/exams/mb6-894"]]);
  assert.throws(() => buildExams([apiExam("AZ-104"), { ...apiExam("AZ-104"), uid: "exam.other", url: U("/credentials/certifications/exams/other") }]), /more than once/);
  assert.throws(() => buildExams([{ ...apiExam("AZ-104"), display_name: "" }]), /no display_name/);
});

test("buildCertifications maps exam uids to codes (from the exam list, else from the uid) and counts the fallbacks", () => {
  const { records: exams } = buildExams([apiExam("AZ-104")]);
  const { records, stats } = buildCertifications([{ uid: "certification.x", title: "X", url: U("/credentials/certifications/x"), last_modified: "d", exams: ["exam.az-104", "exam.AZ-999", "exam.az-104"] }], exams);
  assert.deepEqual(records[0].exams, ["az-104", "az-999"]);
  assert.equal(stats.references, 3);
  assert.equal(stats.unresolvedExamRefs, 1);
});

test("buildAppliedSkills starts with code/studyGuide null", () => {
  const { records } = buildAppliedSkills([{ uid: "applied-skill.x", title: "Microsoft Applied Skills: X", url: U("/credentials/applied-skills/x"), last_modified: "d" }]);
  assert.deepEqual(records[0], { uid: "applied-skill.x", title: "Microsoft Applied Skills: X", path: "/credentials/applied-skills/x", lastModified: "d", code: null, studyGuide: null });
});

test("builders abort on API anomalies and warn (not abort) on an unexpected path area", () => {
  assert.throws(() => buildCourses([{ title: "x", url: U("/training/courses/x") }]), /no uid/);
  assert.throws(() => buildCourses([{ uid: "u", url: U("/training/courses/x") }]), /no title/);
  assert.throws(() => buildCourses([{ uid: "u", title: "t", url: "https://example.com/x" }]), /no usable Learn url/);
  assert.throws(() => buildCourses([{ uid: "u", title: "t", url: "https://learn.microsoft.com/" }]), /no usable Learn url/);
  const odd = buildCourses([{ uid: "u", title: "t", url: U("/somewhere/else") }]);
  assert.equal(odd.records[0].path, "/somewhere/else");
  assert.match(odd.warnings[0], /outside \/training\/courses\//);
});

test("assertUnique rejects duplicate uids and duplicate paths", () => {
  assert.throws(() => assertUnique("courses", [{ uid: "a", path: "/p1" }, { uid: "a", path: "/p2" }]), /uid a appears more than once/);
  assert.throws(() => assertUnique("courses", [{ uid: "a", path: "/p" }, { uid: "b", path: "/p" }]), /path \/p appears more than once/);
  assertUnique("courses", [{ uid: "a", path: "/p1" }, { uid: "b", path: "/p2" }]);
});

test("study guide paths and probe url", () => {
  assert.equal(examStudyGuidePath("az-104"), "/credentials/certifications/resources/study-guides/az-104");
  assert.equal(skillStudyGuidePath("apl-6500"), "/credentials/applied-skills/resources/study-guides/apl-6500");
  assert.equal(studyGuideProbeUrl(examStudyGuidePath("az-104")), "https://learn.microsoft.com/en-us/credentials/certifications/resources/study-guides/az-104");
});

test("classifyProbe: verified needs 200 AND an unchanged final path; 404/410 absent; redirect elsewhere is not verified; anything else is transient", () => {
  const path = examStudyGuidePath("az-104");
  const ok = (finalUrl) => ({ outcome: "ok", status: 200, finalUrl });
  assert.equal(classifyProbe(ok(`https://learn.microsoft.com/en-us${path}`), path).state, "verified");
  assert.equal(classifyProbe(ok(`https://learn.microsoft.com/en-us${path.toUpperCase()}/`), path).state, "verified", "case and trailing slash are canonicalised");
  assert.equal(classifyProbe(ok("https://learn.microsoft.com/en-us/credentials/browse"), path).state, "redirected");
  assert.equal(classifyProbe(ok(null), path).state, "transient");
  assert.equal(classifyProbe({ outcome: "notFound", status: 404 }, path).state, "absent");
  assert.equal(classifyProbe({ outcome: "notFound", status: 410 }, path).state, "absent");
  for (const result of [{ outcome: "transient", error: "HTTP 429" }, { outcome: "transient", error: "timeout" }, { outcome: "error", error: "HTTP 403", status: 403 }]) {
    assert.equal(classifyProbe(result, path).state, "transient", JSON.stringify(result));
  }
});

test("extractAppliedSkillCode reads the aka.ms study guide anchor and refuses ambiguity", () => {
  const html = (code) => `<a class="card-title" href="https://aka.ms/${code}-StudyGuide" data-linktype="external">Study guide for Applied Skills</a>`;
  assert.equal(extractAppliedSkillCode(html("APL6500")), "apl-6500");
  assert.equal(extractAppliedSkillCode(html("apl0200")), "apl-0200");
  assert.equal(extractAppliedSkillCode(html("APL-3030")), "apl-3030");
  assert.equal(extractAppliedSkillCode(html("APL6500") + html("APL6500")), "apl-6500", "the same code twice is still one code");
  assert.equal(extractAppliedSkillCode(html("APL6500") + html("APL6501")), null, "two different codes: never pick one");
  assert.equal(extractAppliedSkillCode("<html>no link</html>"), null);
  assert.equal(extractAppliedSkillCode(undefined), null);
  assert.equal(extractAppliedSkillCode("https://aka.ms/AZ104-StudyGuide"), null, "an exam study guide link is not an applied skill code");
});

const exam = (code, uid = `exam.${code}`) => ({ uid, code, title: code, path: `/credentials/certifications/exams/${code}`, lastModified: "d", studyGuide: null });
const probes = (obj) => new Map(Object.entries(obj).map(([code, state]) => [code, { state, detail: state }]));

test("applyExamProbes: verified -> path + entry dated today; absent/redirected -> null; transient keeps the previous value", () => {
  const exams = [exam("a"), exam("b"), exam("c"), exam("d"), exam("e"), exam("f")];
  const previousExams = [
    { ...exam("a"), studyGuide: examStudyGuidePath("a") },
    { ...exam("b"), studyGuide: examStudyGuidePath("b") },
    { ...exam("c"), studyGuide: examStudyGuidePath("c") },
    { ...exam("d"), studyGuide: null },
    // e: no previous record (brand new exam)
  ];
  const previousGuides = ["a", "b", "c"].map((c) => ({ path: examStudyGuidePath(c), checked: "2026-09-01" }));
  const result = applyExamProbes({
    exams,
    previousExams,
    previousGuides,
    probes: probes({ a: "verified", b: "absent", c: "transient", d: "transient", e: "transient", f: "redirected" }),
    today: TODAY,
  });
  const byCode = Object.fromEntries(result.exams.map((e) => [e.code, e.studyGuide]));
  assert.deepEqual(byCode, { a: examStudyGuidePath("a"), b: null, c: examStudyGuidePath("c"), d: null, e: null, f: null });
  assert.deepEqual(result.entries, [{ path: examStudyGuidePath("a"), checked: TODAY }, { path: examStudyGuidePath("c"), checked: "2026-09-01" }], "the kept entry keeps its OLD date: it was not re-verified");
  assert.deepEqual(result.unverified, [examStudyGuidePath("e")], "a new exam whose probe failed is not 'confirmed absent'");
  assert.deepEqual(
    { verified: result.stats.verified, absent: result.stats.absent, redirected: result.stats.redirected, transient: result.stats.transient, keptPrevious: result.stats.keptPrevious, unverified: result.stats.unverified },
    { verified: 1, absent: 1, redirected: 1, transient: 3, keptPrevious: 1, unverified: 1 }
  );
});

test("applyExamProbes: a missing probe result is treated as transient, never as a verdict", () => {
  const result = applyExamProbes({ exams: [exam("a")], previousExams: [{ ...exam("a"), studyGuide: examStudyGuidePath("a") }], previousGuides: [{ path: examStudyGuidePath("a"), checked: "2026-09-01" }], probes: new Map(), today: TODAY });
  assert.equal(result.exams[0].studyGuide, examStudyGuidePath("a"));
});

const skill = (slug) => ({ uid: `applied-skill.${slug}`, title: slug, path: `/credentials/applied-skills/${slug}`, lastModified: "d", code: null, studyGuide: null });
const res = (uid, page, code, guide) => [`applied-skill.${uid}`, { page, code, guide }];

test("applyAppliedSkillResults covers every combination of page and guide outcome", () => {
  const skills = ["ok", "noCode", "gone", "guide404", "guideRedirect", "pageTransient", "guideTransient", "newTransient"].map(skill);
  const previousSkills = [
    { ...skill("pageTransient"), code: "apl-0001", studyGuide: skillStudyGuidePath("apl-0001") },
    { ...skill("guideTransient"), code: "apl-0002", studyGuide: skillStudyGuidePath("apl-0002") },
  ];
  const previousGuides = [{ path: skillStudyGuidePath("apl-0001"), checked: "2026-09-01" }, { path: skillStudyGuidePath("apl-0002"), checked: "2026-09-02" }];
  const results = new Map([
    res("ok", "ok", "apl-1000", "verified"),
    res("noCode", "ok", null, null),
    res("gone", "notFound", null, null),
    res("guide404", "ok", "apl-1001", "absent"),
    res("guideRedirect", "ok", "apl-1002", "redirected"),
    res("pageTransient", "transient", null, null),
    res("guideTransient", "ok", "apl-0002", "transient"),
    res("newTransient", "ok", "apl-1003", "transient"),
  ]);
  const out = applyAppliedSkillResults({ skills, previousSkills, previousGuides, results, today: TODAY });
  const by = Object.fromEntries(out.skills.map((s) => [s.uid.replace("applied-skill.", ""), [s.code, s.studyGuide]]));
  assert.deepEqual(by, {
    ok: ["apl-1000", skillStudyGuidePath("apl-1000")],
    noCode: [null, null],
    gone: [null, null],
    guide404: ["apl-1001", null],
    guideRedirect: ["apl-1002", null],
    pageTransient: ["apl-0001", skillStudyGuidePath("apl-0001")],
    guideTransient: ["apl-0002", skillStudyGuidePath("apl-0002")],
    newTransient: ["apl-1003", null],
  });
  assert.deepEqual(out.entries, [
    { path: skillStudyGuidePath("apl-1000"), checked: TODAY },
    { path: skillStudyGuidePath("apl-0001"), checked: "2026-09-01" },
    { path: skillStudyGuidePath("apl-0002"), checked: "2026-09-02" },
  ]);
  assert.deepEqual(out.unverified, [skillStudyGuidePath("apl-1003")]);
  assert.equal(out.stats.withCode, 5);
  assert.equal(out.stats.withoutCode, 2);
  assert.equal(out.stats.transient, 3);
});

test("mergeStudyGuides sorts by path in code-point order and keeps one entry per path", () => {
  const merged = mergeStudyGuides([{ path: "/b", checked: "x" }, { path: "/B", checked: "x" }], [{ path: "/a", checked: "y" }, { path: "/b", checked: "z" }]);
  assert.deepEqual(merged.map((g) => g.path), ["/B", "/a", "/b"]);
  assert.equal(merged.find((g) => g.path === "/b").checked, "z");
});

const cur = (list) => list.map((uid) => ({ uid, path: `/p/${uid}`, title: uid }));

test("computeContentRemovals: per-type tombstones, carried forward, resurrected, never cross-type", () => {
  const previous = { learningPaths: cur(["lp1", "lp2"]), courses: cur(["c1"]), certifications: [], exams: cur(["e1"]), appliedSkills: cur(["s1"]) };
  const current = { learningPaths: cur(["lp1"]), courses: cur(["c1", "lp2"]), certifications: [], exams: [], appliedSkills: cur(["s1"]) };
  const oldTomb = { type: "exam", uid: "e0", path: "/p/e0", title: "e0", lastSeen: "2026-01-01", removedOn: "2026-02-01" };
  const backTomb = { type: "course", uid: "c9", path: "/p/c9", title: "c9", lastSeen: "2026-01-01", removedOn: "2026-02-01" };
  current.courses.push({ uid: "c9", path: "/p/c9", title: "c9" });
  const r = computeContentRemovals({ previous, previousRemoved: [oldTomb, backTomb], current, today: TODAY, previousSeenDate: "2026-09-28" });
  assert.deepEqual(r.removed.map((t) => `${t.type}:${t.uid}`), ["exam:e0", "exam:e1", "learningPath:lp2"], "lp2 exists as a COURSE uid but was a learning path: still removed as a learning path");
  assert.equal(r.removed.find((t) => t.uid === "e1").removedOn, TODAY);
  assert.equal(r.removed.find((t) => t.uid === "e1").lastSeen, "2026-09-28");
  assert.deepEqual(r.removed.find((t) => t.uid === "e0"), oldTomb);
  assert.equal(r.resurrected, 1);
  assert.equal(r.newlyRemoved, 2);
});

test("findContentPathCollisions", () => {
  const removed = [{ type: "course", uid: "x", path: "/training/courses/a" }, { type: "exam", uid: "y", path: "/credentials/certifications/exams/b" }];
  assert.deepEqual(findContentPathCollisions(removed, { courses: [{ path: "/training/courses/a" }], exams: [] }), [{ type: "course", uid: "x", path: "/training/courses/a" }]);
});

function sampleOutput() {
  const exams = [{ ...exam("az-104"), studyGuide: examStudyGuidePath("az-104") }, exam("az-900")];
  const skills = [{ ...skill("x"), code: "apl-1000", studyGuide: skillStudyGuidePath("apl-1000") }];
  return assembleContent({
    now: new Date("2026-10-05T10:00:00Z"),
    lists: {
      learningPaths: [{ uid: "lp", title: "t", path: "/training/paths/p", lastModified: null, modules: ["/training/modules/m"] }],
      courses: [{ uid: "c", code: null, title: "t", path: "/training/courses/c", lastModified: "d" }],
      certifications: [{ uid: "ce", title: "t", path: "/credentials/certifications/ce", lastModified: "d", exams: ["az-104"] }],
      exams,
      appliedSkills: skills,
    },
    studyGuides: mergeStudyGuides([{ path: examStudyGuidePath("az-104"), checked: TODAY }], [{ path: skillStudyGuidePath("apl-1000"), checked: TODAY }]),
    unverifiedStudyGuides: [],
    removed: [],
  });
}

test("assembleContent produces the contract key order and counts", () => {
  const out = sampleOutput();
  assert.deepEqual(Object.keys(out), ["schemaVersion", "lastChecked", "learningPaths", "courses", "certifications", "exams", "appliedSkills", "studyGuides", "unverifiedStudyGuides", "removed"]);
  assert.deepEqual(contentCounts(out), { learningPaths: 1, courses: 1, certifications: 1, exams: 2, appliedSkills: 1, studyGuides: 2 });
  assert.deepEqual(validateContentOutput(out), []);
});

test("sameContentExceptVolatile ignores lastChecked and the study guides' checked dates only", () => {
  const a = sampleOutput();
  const b = JSON.parse(JSON.stringify(a));
  b.lastChecked = "2027-01-01T00:00:00.000Z";
  b.studyGuides.forEach((g) => (g.checked = "2027-01-01"));
  assert.equal(sameContentExceptVolatile(a, b), true);
  b.exams[1].title = "renamed";
  assert.equal(sameContentExceptVolatile(a, b), false);
  const c = JSON.parse(JSON.stringify(a));
  c.studyGuides.pop();
  assert.equal(sameContentExceptVolatile(a, c), false, "a study guide appearing or disappearing is a real change");
  assert.equal(sameContentExceptVolatile(null, a), false);
});

test("validateContentOutput catches every contract violation", () => {
  const cases = [
    ["schemaVersion", (o) => void (o.schemaVersion = 9), /schemaVersion/],
    ["unsorted exams", (o) => void o.exams.reverse(), /exams is not sorted/],
    ["exam code case", (o) => void (o.exams[0].code = "AZ-104"), /code must be a lowercase string/],
    ["exam studyGuide mismatch", (o) => void (o.exams[0].studyGuide = "/credentials/certifications/resources/study-guides/other"), /studyGuide .* is not the exam's path/],
    ["exam studyGuide not listed", (o) => void (o.exams[1].studyGuide = examStudyGuidePath("az-900")), /missing from studyGuides/],
    ["skill code", (o) => void (o.appliedSkills[0].code = "6500"), /bad code/],
    ["skill guide without code", (o) => void ((o.appliedSkills[0].code = null), (o.appliedSkills[0].studyGuide = skillStudyGuidePath("apl-1000"))), /does not match its code/],
    ["path", (o) => void (o.courses[0].path = "/Training/Courses/C/"), /not canonical/],
    ["duplicate path", (o) => void o.courses.push({ ...o.courses[0], uid: "d" }), /duplicate path/],
    ["lp modules", (o) => void (o.learningPaths[0].modules = ["/Training/Modules/M/"]), /modules must be canonical paths/],
    ["cert exams case", (o) => void (o.certifications[0].exams = ["AZ-104"]), /lowercase codes/],
    ["guide path", (o) => void o.studyGuides.push({ path: "/not/a/guide", checked: TODAY }), /not a canonical study guide path|not sorted/],
    ["guide date", (o) => void (o.studyGuides[0].checked = "yesterday"), /bad checked date/],
    ["unverified type", (o) => void (o.unverifiedStudyGuides = "x"), /unverifiedStudyGuides/],
    ["tombstone type", (o) => void o.removed.push({ type: "mystery", uid: "z", path: "/p/z", title: "z", lastSeen: null, removedOn: TODAY }), /unknown type/],
    ["tombstone live", (o) => void o.removed.push({ type: "course", uid: "c", path: "/p/z", title: "z", lastSeen: null, removedOn: TODAY }), /also a live course/],
    ["tombstone date", (o) => void o.removed.push({ type: "course", uid: "z", path: "/p/z", title: "z", lastSeen: null, removedOn: "x" }), /bad removedOn/],
  ];
  for (const [name, mutate, expected] of cases) {
    const out = JSON.parse(JSON.stringify(sampleOutput()));
    mutate(out);
    const problems = validateContentOutput(out);
    assert.ok(problems.length > 0, `${name}: no problem reported`);
    assert.ok(problems.some((p) => expected.test(p)), `${name}: expected ${expected}, got ${problems.join(" | ")}`);
  }
  assert.deepEqual(validateContentOutput(null), ["output is not an object"]);
});
