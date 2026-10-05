/**
 * Pure transformation logic for data/learn-content.json (schema v1, see
 * DATA_CONTRACT.md): learning paths, courses, certifications, exams, applied
 * skills, study guides and per-type tombstones. No I/O, no network:
 * scripts/lib/learn-content-run.mjs wires it to the real API.
 *
 * Verified against the live catalog API on 2026-10-05
 * (https://learn.microsoft.com/api/catalog/?type=<type>&locale=en-us):
 *   learningPaths  uid, title, url, last_modified, modules[] (module UIDS, e.g.
 *                  "learn.fsharp-first-steps", not urls: resolved through the
 *                  uid -> path map of the modules list)
 *   courses        uid, course_number ("GH-200T00"; EMPTY for the 42 education
 *                  courses, which therefore get code null), title, url
 *   certifications uid, title, url, exams[] (exam uids "exam.<code>")
 *   exams          uid "exam.<code>", display_name ("AZ-104"), title, url
 *   appliedSkills  uid, title ("Microsoft Applied Skills: ..."), url. NO code.
 * Every `url` carries "?WT.mc_id=api_CatalogApi" and an /en-us/ segment, both
 * removed by canonicalPath(). The `study_guide` arrays of the API list learning
 * paths, not study guide pages, so study guides are probed (see below).
 *
 * Study guides:
 *   exams          /credentials/certifications/resources/study-guides/<code>
 *   applied skills /credentials/applied-skills/resources/study-guides/apl-<nnnn>
 * The catalog API exposes no applied-skill code, but every one of the 37 skill
 * pages links its study guide as https://aka.ms/APL<nnnn>-StudyGuide (a 301 to
 * the study guide page), which is the code source used here
 * (extractAppliedSkillCode). A probe only counts when it answers HTTP 200 AND the
 * final canonical path is unchanged; 404/410 is a definitive "no study guide";
 * rate limits, 5xx, timeouts and unexpected statuses are NEVER read as "absent".
 */

import { byCodePoint, canonicalPath } from "./canonical.mjs";
import { isIsoDate } from "./learn-helpers.mjs";

export const CONTENT_SCHEMA_VERSION = 1;

/** list = key in learn-content.json and in the API response; type = value in tombstones. */
export const CONTENT_TYPES = [
  { list: "learningPaths", type: "learningPath", prefix: "/training/paths/" },
  { list: "courses", type: "course", prefix: "/training/courses/" },
  { list: "certifications", type: "certification", prefix: "/credentials/certifications/" },
  { list: "exams", type: "exam", prefix: "/credentials/certifications/" },
  { list: "appliedSkills", type: "appliedSkill", prefix: "/credentials/applied-skills/" },
];

export const EXAM_STUDY_GUIDE_BASE = "/credentials/certifications/resources/study-guides/";
export const SKILL_STUDY_GUIDE_BASE = "/credentials/applied-skills/resources/study-guides/";

const byUid = (a, b) => byCodePoint(a.uid, b.uid);

// ---------------------------------------------------------------------------
// record builders
// ---------------------------------------------------------------------------

/**
 * Shared checks + the fields every record has. Throws on an API anomaly that
 * would make the output ambiguous (missing uid/title, a url that is not a Learn
 * url). A path outside the expected area is NOT fatal (it is kept faithfully and
 * counted in `warnings`) so one odd upstream url cannot block the whole update.
 */
function baseFields(row, { list, prefix }, warnings) {
  if (!row || typeof row.uid !== "string" || !row.uid) throw new Error(`${list}: an entry has no uid`);
  if (typeof row.title !== "string" || !row.title) throw new Error(`${list}: ${row.uid} has no title`);
  const path = canonicalPath(row.url);
  if (!path || path === "/") throw new Error(`${list}: ${row.uid} has no usable Learn url (${JSON.stringify(row.url)})`);
  if (!path.startsWith(prefix)) warnings.push(`${list}: ${row.uid} path ${path} is outside ${prefix}`);
  return { uid: row.uid, title: row.title, path, lastModified: typeof row.last_modified === "string" ? row.last_modified : null };
}

function typeMeta(list) {
  return CONTENT_TYPES.find((t) => t.list === list);
}

/** Lowercase exam code from an API `display_name` ("AZ-104" -> "az-104"). */
export function examCode(displayName) {
  return typeof displayName === "string" ? displayName.trim().toLowerCase() : "";
}

/** "exam.az-104" -> "az-104" (the documented uid scheme; used only for references to exams missing from the exam list). */
export function examCodeFromUid(uid) {
  return typeof uid === "string" ? uid.replace(/^exam\./, "").toLowerCase() : "";
}

/** Map of module uid -> canonical module path over EVERY module the API returns (in scope or not). */
export function buildModuleIndex(apiModules) {
  const index = new Map();
  for (const mod of apiModules) {
    const path = canonicalPath(mod?.url);
    if (typeof mod?.uid === "string" && path) index.set(mod.uid, path);
  }
  return index;
}

export function buildLearningPaths(rows, moduleIndex) {
  const meta = typeMeta("learningPaths");
  const warnings = [];
  const unresolved = [];
  let references = 0;
  const records = rows.map((row) => {
    const base = baseFields(row, meta, warnings);
    const modules = [];
    for (const uid of row.modules ?? []) {
      references++;
      const path = moduleIndex.get(uid);
      if (path) modules.push(path);
      else unresolved.push({ learningPath: row.uid, module: uid });
    }
    return { ...base, modules };
  });
  records.sort(byUid);
  return { records, stats: { references, unresolved: unresolved.length, unresolvedSamples: unresolved.slice(0, 10) }, warnings };
}

export function buildCourses(rows) {
  const meta = typeMeta("courses");
  const warnings = [];
  const records = rows.map((row) => {
    const base = baseFields(row, meta, warnings);
    const code = typeof row.course_number === "string" && row.course_number.trim() ? row.course_number.trim() : null;
    return { uid: base.uid, code, title: base.title, path: base.path, lastModified: base.lastModified };
  });
  records.sort(byUid);
  return { records, stats: { withoutCode: records.filter((r) => r.code === null).length }, warnings };
}

export function buildExams(rows) {
  const meta = typeMeta("exams");
  const warnings = [];
  const records = rows.map((row) => {
    const base = baseFields(row, meta, warnings);
    const code = examCode(row.display_name);
    if (!code) throw new Error(`exams: ${row.uid} has no display_name`);
    return { uid: base.uid, code, title: base.title, path: base.path, lastModified: base.lastModified, studyGuide: null };
  });
  records.sort(byUid);
  const seen = new Set();
  for (const rec of records) {
    if (seen.has(rec.code)) throw new Error(`exams: the code ${rec.code} appears more than once`);
    seen.add(rec.code);
  }
  return { records, stats: {}, warnings };
}

export function buildCertifications(rows, exams) {
  const meta = typeMeta("certifications");
  const warnings = [];
  const codeByUid = new Map(exams.map((e) => [e.uid, e.code]));
  let references = 0;
  let unresolved = 0;
  const records = rows.map((row) => {
    const base = baseFields(row, meta, warnings);
    const codes = [];
    for (const uid of row.exams ?? []) {
      references++;
      let code = codeByUid.get(uid);
      if (!code) {
        unresolved++;
        code = examCodeFromUid(uid);
      }
      if (code && !codes.includes(code)) codes.push(code);
    }
    return { ...base, exams: codes.sort(byCodePoint) };
  });
  records.sort(byUid);
  return { records, stats: { references, unresolvedExamRefs: unresolved }, warnings };
}

export function buildAppliedSkills(rows) {
  const meta = typeMeta("appliedSkills");
  const warnings = [];
  const records = rows.map((row) => {
    const base = baseFields(row, meta, warnings);
    // code / studyGuide are filled in by applyAppliedSkillProbes() (additive fields, see DATA_CONTRACT deviations)
    return { uid: base.uid, title: base.title, path: base.path, lastModified: base.lastModified, code: null, studyGuide: null };
  });
  records.sort(byUid);
  return { records, stats: {}, warnings };
}

/** Throws when one uid occurs twice in a list (the API would be ambiguous), and when two entries share a path. */
export function assertUnique(list, records) {
  const uids = new Set();
  const paths = new Set();
  for (const rec of records) {
    if (uids.has(rec.uid)) throw new Error(`${list}: uid ${rec.uid} appears more than once`);
    if (paths.has(rec.path)) throw new Error(`${list}: path ${rec.path} appears more than once`);
    uids.add(rec.uid);
    paths.add(rec.path);
  }
}

// ---------------------------------------------------------------------------
// study guides
// ---------------------------------------------------------------------------

export function examStudyGuidePath(code) {
  return `${EXAM_STUDY_GUIDE_BASE}${code}`;
}

export function skillStudyGuidePath(code) {
  return `${SKILL_STUDY_GUIDE_BASE}${code}`;
}

/** Live URL probed for a study guide path. */
export function studyGuideProbeUrl(path) {
  return `https://learn.microsoft.com/en-us${path}`;
}

/**
 * request() result -> probe verdict for a page that must live at `expectedPath`.
 *   verified    HTTP 200 and the final canonical path is the expected one
 *   absent      HTTP 404/410 (definitive)
 *   redirected  HTTP 200 but on another path (the page itself is not served here)
 *   transient   anything else: 429/5xx/timeout/network, an unexpected status such
 *               as 403, a missing final url. Never read as "absent".
 */
export function classifyProbe(result, expectedPath) {
  if (result.outcome === "ok") {
    const finalPath = canonicalPath(result.finalUrl);
    if (!finalPath) return { state: "transient", detail: `HTTP ${result.status} with an unreadable final url` };
    if (finalPath === expectedPath) return { state: "verified", detail: "HTTP 200" };
    return { state: "redirected", detail: `HTTP ${result.status} on ${finalPath}` };
  }
  if (result.outcome === "notFound") return { state: "absent", detail: `HTTP ${result.status}` };
  return { state: "transient", detail: result.error ?? result.outcome };
}

/**
 * Applied-skill code from the skill's own page: the anchor
 * https://aka.ms/APL<nnnn>-StudyGuide -> "apl-<nnnn>". Returns null when the page
 * has no such link, and null when it has links to more than one code (ambiguous:
 * never pick one).
 */
export function extractAppliedSkillCode(html) {
  if (typeof html !== "string") return null;
  const codes = new Set();
  for (const match of html.matchAll(/aka\.ms\/apl-?(\d{3,6})-?studyguide/gi)) codes.add(`apl-${match[1]}`);
  return codes.size === 1 ? [...codes][0] : null;
}

/**
 * Applies exam-probe verdicts. probes: Map<code, { state }>.
 * Returns { exams, entries, stats }:
 *   verified   -> studyGuide = path, entry { path, checked: today }
 *   absent / redirected -> studyGuide null, no entry
 *   transient  -> the PREVIOUS value stays (path and its old `checked` date); an
 *                 exam with no previous record has nothing to keep: its path is
 *                 reported as unverified (null here, never "confirmed absent").
 */
export function applyExamProbes({ exams, previousExams = [], previousGuides = [], probes, today }) {
  const previousByUid = new Map(previousExams.map((e) => [e.uid, e]));
  const checkedByPath = new Map(previousGuides.map((g) => [g.path, g.checked]));
  const entries = [];
  const unverified = [];
  const stats = { verified: 0, absent: 0, redirected: 0, transient: 0, keptPrevious: 0, unverified: 0, redirectedSamples: [] };
  const out = exams.map((exam) => {
    const path = examStudyGuidePath(exam.code);
    const verdict = probes.get(exam.code) ?? { state: "transient" };
    const previous = previousByUid.get(exam.uid);
    if (verdict.state === "verified") {
      stats.verified++;
      entries.push({ path, checked: today });
      return { ...exam, studyGuide: path };
    }
    if (verdict.state === "absent") {
      stats.absent++;
      return { ...exam, studyGuide: null };
    }
    if (verdict.state === "redirected") {
      stats.redirected++;
      if (stats.redirectedSamples.length < 10) stats.redirectedSamples.push(`${exam.code}: ${verdict.detail}`);
      return { ...exam, studyGuide: null };
    }
    stats.transient++;
    if (previous) {
      const kept = previous.studyGuide ?? null;
      if (kept) {
        stats.keptPrevious++;
        entries.push({ path: kept, checked: checkedByPath.get(kept) ?? null });
      }
      return { ...exam, studyGuide: kept };
    }
    stats.unverified++;
    unverified.push(path);
    return { ...exam, studyGuide: null };
  });
  return { exams: out, entries, unverified, stats };
}

/**
 * Applies applied-skill results. results: Map<uid, { code: "apl-6500" | null,
 * page: "ok" | "transient" | "notFound", guide: probe state | null }>.
 *   page ok, code found, guide verified -> code + studyGuide set, entry added
 *   page ok, no code                    -> code null, studyGuide null
 *   page ok, code found, guide absent/redirected -> code set, studyGuide null
 *   page transient or guide transient   -> previous code/studyGuide kept (a skill
 *                                          with no previous record is unverified)
 */
export function applyAppliedSkillResults({ skills, previousSkills = [], previousGuides = [], results, today }) {
  const previousByUid = new Map(previousSkills.map((s) => [s.uid, s]));
  const checkedByPath = new Map(previousGuides.map((g) => [g.path, g.checked]));
  const entries = [];
  const unverified = [];
  const stats = { withCode: 0, withoutCode: 0, verified: 0, absent: 0, redirected: 0, transient: 0, keptPrevious: 0, unverified: 0 };
  const out = skills.map((skill) => {
    const result = results.get(skill.uid) ?? { page: "transient", code: null, guide: null };
    const previous = previousByUid.get(skill.uid);
    const keepPrevious = () => {
      stats.transient++;
      if (previous) {
        if (previous.studyGuide) {
          stats.keptPrevious++;
          entries.push({ path: previous.studyGuide, checked: checkedByPath.get(previous.studyGuide) ?? null });
        }
        return { ...skill, code: previous.code ?? null, studyGuide: previous.studyGuide ?? null };
      }
      stats.unverified++;
      if (result.code) unverified.push(skillStudyGuidePath(result.code));
      return { ...skill, code: result.code ?? null, studyGuide: null };
    };
    if (result.page === "transient") return keepPrevious();
    if (result.page === "notFound" || !result.code) {
      stats.withoutCode++;
      return { ...skill, code: null, studyGuide: null };
    }
    stats.withCode++;
    const path = skillStudyGuidePath(result.code);
    if (result.guide === "verified") {
      stats.verified++;
      entries.push({ path, checked: today });
      return { ...skill, code: result.code, studyGuide: path };
    }
    if (result.guide === "absent") {
      stats.absent++;
      return { ...skill, code: result.code, studyGuide: null };
    }
    if (result.guide === "redirected") {
      stats.redirected++;
      return { ...skill, code: result.code, studyGuide: null };
    }
    return keepPrevious();
  });
  return { skills: out, entries, unverified, stats };
}

/** All verified study guides, sorted by path (code point), one entry per path. */
export function mergeStudyGuides(...groups) {
  const byPath = new Map();
  for (const group of groups) for (const entry of group) byPath.set(entry.path, entry);
  return [...byPath.values()].sort((a, b) => byCodePoint(a.path, b.path));
}

// ---------------------------------------------------------------------------
// tombstones
// ---------------------------------------------------------------------------

const byTypeThenUid = (a, b) => byCodePoint(a.type, b.type) || byCodePoint(a.uid, b.uid);

/**
 * Per-type tombstones, same rules as modules: an entry is REMOVED when its uid was
 * in the previous list of that type and is absent from the current API list of
 * that type. Previous tombstones are carried forward and dropped only when the
 * uid is back. previous / current: { [list]: [{ uid, path, title }] }.
 */
export function computeContentRemovals({ previous = {}, previousRemoved = [], current, today, previousSeenDate = null }) {
  const removed = new Map();
  const key = (type, uid) => `${type}\u0000${uid}`;
  const currentUids = {};
  for (const { list, type } of CONTENT_TYPES) currentUids[type] = new Set((current[list] ?? []).map((r) => r.uid));
  let resurrected = 0;
  for (const tomb of previousRemoved) {
    if (!tomb || typeof tomb.uid !== "string" || typeof tomb.type !== "string") continue;
    if (currentUids[tomb.type]?.has(tomb.uid)) {
      resurrected++;
      continue;
    }
    removed.set(key(tomb.type, tomb.uid), {
      type: tomb.type,
      uid: tomb.uid,
      path: tomb.path ?? null,
      title: tomb.title ?? null,
      lastSeen: tomb.lastSeen ?? null,
      removedOn: tomb.removedOn ?? null,
    });
  }
  let newlyRemoved = 0;
  for (const { list, type } of CONTENT_TYPES) {
    for (const rec of previous[list] ?? []) {
      if (!rec || typeof rec.uid !== "string" || currentUids[type].has(rec.uid) || removed.has(key(type, rec.uid))) continue;
      removed.set(key(type, rec.uid), {
        type,
        uid: rec.uid,
        path: rec.path ?? null,
        title: rec.title ?? null,
        lastSeen: previousSeenDate,
        removedOn: today,
      });
      newlyRemoved++;
    }
  }
  return { removed: [...removed.values()].sort(byTypeThenUid), newlyRemoved, resurrected };
}

/** Tombstone paths that a live entry of the same list now occupies (the validator must not call those broken). */
export function findContentPathCollisions(removed, lists) {
  const live = new Set();
  for (const list of Object.values(lists)) for (const rec of list) live.add(rec.path);
  return removed.filter((tomb) => tomb.path && live.has(tomb.path)).map((tomb) => ({ type: tomb.type, uid: tomb.uid, path: tomb.path }));
}

// ---------------------------------------------------------------------------
// assembly, comparison, self-check
// ---------------------------------------------------------------------------

export function assembleContent({ now, lists, studyGuides, unverifiedStudyGuides, removed }) {
  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    lastChecked: now.toISOString(),
    learningPaths: lists.learningPaths,
    courses: lists.courses,
    certifications: lists.certifications,
    exams: lists.exams,
    appliedSkills: lists.appliedSkills,
    studyGuides,
    unverifiedStudyGuides,
    removed,
  };
}

/** Counts per list, the shape of status.learn.content. */
export function contentCounts(output) {
  return {
    learningPaths: output.learningPaths.length,
    courses: output.courses.length,
    certifications: output.certifications.length,
    exams: output.exams.length,
    appliedSkills: output.appliedSkills.length,
    studyGuides: output.studyGuides.length,
  };
}

/**
 * What the "skip the write when nothing changed" comparison looks at: everything
 * except the run timestamp and the `checked` dates of the study guides (they
 * would advance on every run; status.json's generatedAt is the proof of the last
 * probe pass). When anything else changes the file is rewritten with fresh dates.
 */
export function withoutVolatile(output) {
  const { lastChecked, ...rest } = output;
  return { ...rest, studyGuides: (rest.studyGuides ?? []).map((g) => ({ path: g.path })) };
}

export function sameContentExceptVolatile(previous, next) {
  if (!previous || typeof previous !== "object") return false;
  return JSON.stringify(withoutVolatile(previous)) === JSON.stringify(withoutVolatile(next));
}

function isSortedUnique(values) {
  for (let i = 1; i < values.length; i++) if (byCodePoint(values[i - 1], values[i]) >= 0) return false;
  return true;
}

/** Self-check of a finished content file against DATA_CONTRACT.md; [] when valid. */
export function validateContentOutput(output, { maxProblems = 50 } = {}) {
  const problems = [];
  const add = (message) => {
    if (problems.length < maxProblems) problems.push(message);
  };
  if (!output || typeof output !== "object") return ["output is not an object"];
  if (output.schemaVersion !== CONTENT_SCHEMA_VERSION) add(`schemaVersion is ${output.schemaVersion}, expected ${CONTENT_SCHEMA_VERSION}`);
  const livePaths = new Map();
  const guideSet = new Set((output.studyGuides ?? []).map((g) => g.path));
  for (const { list, type } of CONTENT_TYPES) {
    const rows = output[list];
    if (!Array.isArray(rows)) {
      add(`${list} is not an array`);
      continue;
    }
    if (!isSortedUnique(rows.map((r) => r.uid))) add(`${list} is not sorted by uid (code point) or has duplicate uids`);
    const paths = new Set();
    for (const row of rows) {
      const where = `${list} ${row.uid}`;
      if (typeof row.title !== "string" || !row.title) add(`${where}: missing title`);
      if (!row.path || canonicalPath(row.path) !== row.path) add(`${where}: path ${row.path} is not canonical`);
      if (paths.has(row.path)) add(`${where}: duplicate path ${row.path}`);
      paths.add(row.path);
      livePaths.set(`${type}:${row.uid}`, row.path);
      if (row.lastModified !== null && typeof row.lastModified !== "string") add(`${where}: lastModified is neither a string nor null`);
      if (list === "learningPaths" && (!Array.isArray(row.modules) || row.modules.some((m) => canonicalPath(m) !== m))) add(`${where}: modules must be canonical paths`);
      if (list === "courses" && row.code !== null && typeof row.code !== "string") add(`${where}: code is neither a string nor null`);
      if (list === "certifications" && (!Array.isArray(row.exams) || row.exams.some((c) => typeof c !== "string" || c !== c.toLowerCase()))) add(`${where}: exams must be lowercase codes`);
      if (list === "exams") {
        if (typeof row.code !== "string" || row.code !== row.code.toLowerCase() || !row.code) add(`${where}: code must be a lowercase string`);
        if (row.studyGuide !== null && (row.studyGuide !== examStudyGuidePath(row.code) || !guideSet.has(row.studyGuide))) add(`${where}: studyGuide ${row.studyGuide} is not the exam's path or is missing from studyGuides`);
      }
      if (list === "appliedSkills") {
        if (row.code !== null && !/^apl-\d{3,6}$/.test(row.code ?? "")) add(`${where}: bad code ${row.code}`);
        if (row.studyGuide !== null && (row.code === null || row.studyGuide !== skillStudyGuidePath(row.code) || !guideSet.has(row.studyGuide))) add(`${where}: studyGuide ${row.studyGuide} does not match its code or is missing from studyGuides`);
      }
    }
  }
  if (!Array.isArray(output.studyGuides)) add("studyGuides is not an array");
  else {
    if (!isSortedUnique(output.studyGuides.map((g) => g.path))) add("studyGuides is not sorted by path or has duplicates");
    for (const guide of output.studyGuides) {
      if (!guide.path || canonicalPath(guide.path) !== guide.path || !(guide.path.startsWith(EXAM_STUDY_GUIDE_BASE) || guide.path.startsWith(SKILL_STUDY_GUIDE_BASE))) add(`study guide ${guide.path}: not a canonical study guide path`);
      if (guide.checked !== null && !isIsoDate(guide.checked)) add(`study guide ${guide.path}: bad checked date ${guide.checked}`);
    }
  }
  if (!Array.isArray(output.unverifiedStudyGuides) || !isSortedUnique(output.unverifiedStudyGuides)) add("unverifiedStudyGuides must be a sorted array");
  if (!Array.isArray(output.removed)) add("removed is not an array");
  else {
    const typeNames = new Set(CONTENT_TYPES.map((t) => t.type));
    const keys = output.removed.map((t) => `${t.type}\u0000${t.uid}`);
    if (!isSortedUnique(keys)) add("removed is not sorted by type then uid, or has duplicates");
    for (const tomb of output.removed) {
      if (!typeNames.has(tomb.type)) add(`tombstone ${tomb.uid}: unknown type ${tomb.type}`);
      if (!tomb.uid || !tomb.path || canonicalPath(tomb.path) !== tomb.path) add(`tombstone ${tomb.uid}: bad path ${tomb.path}`);
      if (typeof tomb.title !== "string") add(`tombstone ${tomb.uid}: bad title`);
      if (!isIsoDate(tomb.removedOn)) add(`tombstone ${tomb.uid}: bad removedOn ${tomb.removedOn}`);
      if (tomb.lastSeen !== null && !isIsoDate(tomb.lastSeen)) add(`tombstone ${tomb.uid}: bad lastSeen ${tomb.lastSeen}`);
      if (livePaths.has(`${tomb.type}:${tomb.uid}`)) add(`tombstone ${tomb.uid} is also a live ${tomb.type}`);
    }
  }
  return problems;
}
