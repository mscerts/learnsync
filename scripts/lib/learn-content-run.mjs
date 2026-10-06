/**
 * Orchestrates one run of the content sync (data/learn-content.json, schema v1).
 * All decisions live in the pure modules (learn-content, learn-failsafe); this
 * file only fetches, probes, writes and reports. fetch, sleep, data directory,
 * environment, clock and logger are injectable, which is how
 * test/learn-content-run.test.mjs drives whole runs against a fake API.
 *
 * Order of work (cheapest and most protective first):
 *   1. five catalog requests (one per type) + the module list (uid -> path)
 *   2. build the lists, run the failsafes                    (abort BEFORE probing)
 *   3. probe the study guide of every exam, read every applied-skill page for its
 *      study guide code and probe that guide                 (polite pool)
 *   4. tombstones, assemble, self-validate
 *   5. change files: candidates from previous vs. new content (diffContent), resurrection from the
 *      new data, live probe of what is still unverified              (nothing written yet)
 *   6. write the change files, then the data file if changed, then the heartbeat: the "content"
 *      part of data/status.json is updated even when the data file was unchanged
 *
 * The previous change files are read in step 0 (before the downloads) so a corrupt file fails the
 * run early, and a run that a failsafe aborts (steps 2-4) writes none of the files.
 */

import { join } from "node:path";
import {
  CONTENT_TYPES,
  applyAppliedSkillResults,
  applyExamProbes,
  assertUnique,
  assembleContent,
  buildAppliedSkills,
  buildCertifications,
  buildCourses,
  buildExams,
  buildLearningPaths,
  buildModuleIndex,
  classifyProbe,
  computeContentRemovals,
  contentCounts,
  extractAppliedSkillCode,
  findContentPathCollisions,
  mergeStudyGuides,
  examStudyGuidePath,
  sameContentExceptVolatile,
  skillStudyGuidePath,
  studyGuideProbeUrl,
  validateContentOutput,
} from "./learn-content.mjs";
import { diffContent, writeChanges } from "./changes.mjs";
import { CATALOG_BASE, CONTENT_MIN_COUNTS, LIMITS, MIN_API_MODULES_FOR_RESOLUTION } from "./learn-config.mjs";
import { openChanges, refreshChanges } from "./learn-changes-run.mjs";
import { checkAppliedSkillCodeCoverage, checkContentCounts, checkProbeFailures, checkUnresolvedModules } from "./learn-failsafe.mjs";
import { DEFAULT_DELAY_MS, fetchJson, request, runPool, sleep } from "./learn-http.mjs";
import { dateOfTimestamp, numberFromEnv, utcDate } from "./learn-helpers.mjs";
import { FailsafeAbort, readJsonIfExists, retryLogger, writeJsonAtomic } from "./learn-io.mjs";
import { contributeLearnStatus } from "./learn-status.mjs";
import { readStatus } from "./status.mjs";

const HTML_HEADERS = { Accept: "text/html,application/xhtml+xml" };

/** HTTP 200 on the skill page itself (not a redirect to something else) -> read its code; otherwise "transient"/"notFound". */
export function classifySkillPage(result, expectedPath) {
  const verdict = classifyProbe(result, expectedPath);
  if (verdict.state === "verified") return { page: "ok", code: extractAppliedSkillCode(result.body) };
  if (verdict.state === "absent") return { page: "notFound", code: null };
  // "redirected" means the skill moved: its destination's HTML is another page, so no code is read from it
  return { page: "transient", code: null, detail: verdict.detail };
}

export async function runContentSync(options = {}) {
  const {
    dataDir,
    env = process.env,
    now = new Date(),
    fetchImpl,
    sleepImpl = sleep,
    log = console.log,
    warn = console.warn,
    delayMs = DEFAULT_DELAY_MS,
    // HTML pages are heavier on Learn's edge than JSON APIs: probes pause twice as long per worker
    // (a real run at 500 ms drew a few HTTP 429s, which the backoff absorbed)
    probeDelayMs = delayMs * 2,
    limits: limitOverrides = {},
    minCounts = CONTENT_MIN_COUNTS,
    minResolutionModules = MIN_API_MODULES_FOR_RESOLUTION,
    httpOptions = {},
    // change files: { probe, delayMs, workers, limits } (probe = async (path) => raw probe result; default live-probe.mjs rawProbe)
    changes: changesOptions = {},
  } = options;
  if (!dataDir) throw new Error("runContentSync: dataDir is required");

  const outputFile = join(dataDir, "learn-content.json");
  const catalogFile = join(dataDir, "learn-catalog.json");
  const statusFile = join(dataDir, "status.json");
  const today = utcDate(now);
  const dryRun = env.DRY_RUN === "1";
  const limits = {
    ...LIMITS,
    MAX_CONTENT_DROP_PCT: numberFromEnv(env, "MAX_CONTENT_DROP_PCT", LIMITS.MAX_CONTENT_DROP_PCT, { min: 0, max: 100 }),
    ...limitOverrides,
  };
  const http = { ...(fetchImpl ? { fetchImpl } : {}), sleepImpl, ...httpOptions };

  const previous = readJsonIfExists(outputFile, warn);
  const prevList = (name) => (Array.isArray(previous?.[name]) ? previous[name] : []);
  // 0. the previous change files: a corrupt one (or a typo in CHANGES_*) fails the run here, before anything is downloaded or written
  const changeState = openChanges({ dataDir, env, warn });
  const changeLimits = { ...changeState.limits, ...(changesOptions.limits ?? {}) };

  // 1. downloads ------------------------------------------------------------------
  const api = {};
  for (const { list } of CONTENT_TYPES) {
    log(`Fetching ${list}...`);
    const body = await fetchJson(`${CATALOG_BASE}?type=${list}&locale=en-us`, http);
    if (!Array.isArray(body?.[list])) throw new Error(`Catalog API response for type=${list} has no "${list}" array: the schema probably changed`);
    api[list] = body[list];
    await sleepImpl(delayMs);
  }
  // Same request as the catalog sync: "type=modules" alone omits the "$learn..." module.
  log("Fetching the module list (to resolve learning-path module uids)...");
  const modulesBody = await fetchJson(`${CATALOG_BASE}?type=modules,units&locale=en-us`, { ...http, timeoutMs: 180_000 });
  if (!Array.isArray(modulesBody?.modules)) throw new Error('Catalog API response has no "modules" array: the schema probably changed');
  if (modulesBody.modules.length < minResolutionModules) {
    throw new FailsafeAbort([`the module list has only ${modulesBody.modules.length} modules (floor ${minResolutionModules}): learning-path modules cannot be resolved reliably`]);
  }

  // 2. build + failsafes ----------------------------------------------------------
  const moduleIndex = buildModuleIndex(modulesBody.modules);
  const paths = buildLearningPaths(api.learningPaths, moduleIndex);
  const courses = buildCourses(api.courses);
  const exams = buildExams(api.exams);
  const certifications = buildCertifications(api.certifications, exams.records);
  const skills = buildAppliedSkills(api.appliedSkills);
  const built = { learningPaths: paths, courses, certifications, exams, appliedSkills: skills };
  for (const [list, part] of Object.entries(built)) {
    assertUnique(list, part.records);
    for (const warning of part.warnings) warn(`  WARNING: ${warning}`);
  }

  const currentCounts = Object.fromEntries(Object.entries(built).map(([list, part]) => [list, part.records.length]));
  const previousCounts = previous ? Object.fromEntries(CONTENT_TYPES.map(({ list }) => [list, prevList(list).length])) : null;
  const problems = [
    ...checkContentCounts({ previous: previousCounts, current: currentCounts, maxDropPct: limits.MAX_CONTENT_DROP_PCT, floors: minCounts }),
    ...checkUnresolvedModules({ unresolved: paths.stats.unresolved, total: paths.stats.references, maxPct: limits.MAX_UNRESOLVED_MODULE_PCT }),
  ];
  if (!previous) warn("  no previous data file: relative failsafes (drop %) are skipped, only the floors apply");
  if (problems.length) throw new FailsafeAbort(problems);
  if (paths.stats.unresolved) {
    warn(`  ${paths.stats.unresolved} of ${paths.stats.references} learning-path module references have no module in the catalog (left out): ${paths.stats.unresolvedSamples.map((s) => `${s.learningPath} -> ${s.module}`).slice(0, 3).join("; ")}...`);
  }
  if (certifications.stats.unresolvedExamRefs) warn(`  ${certifications.stats.unresolvedExamRefs} certification exam references are not in the exam list (code taken from the uid)`);

  // 3. probes -----------------------------------------------------------------------
  const probeOptions = (label) => ({ ...http, headers: HTML_HEADERS, onRetry: retryLogger(warn, label) });
  const poolOptions = { delayMs: probeDelayMs, sleepImpl, progressEvery: 50 };

  log(`Probing the study guide of ${exams.records.length} exams...`);
  const examProbes = new Map();
  await runPool(
    exams.records,
    async (exam) => {
      const path = examStudyGuidePath(exam.code);
      const result = await request(studyGuideProbeUrl(path), { ...probeOptions("exam study guide"), read: "none" });
      examProbes.set(exam.code, classifyProbe(result, path));
    },
    { ...poolOptions, onProgress: (done, total) => log(`  exam study guides: ${done}/${total}`) }
  );

  log(`Reading the ${skills.records.length} applied-skill pages for their study guide code...`);
  const skillResults = new Map();
  await runPool(
    skills.records,
    async (skill) => {
      const page = await request(`https://learn.microsoft.com/en-us${skill.path}/`, { ...probeOptions("applied skill page"), read: "text" });
      const outcome = classifySkillPage(page, skill.path);
      let guide = null;
      if (outcome.code) {
        await sleepImpl(probeDelayMs);
        const guidePath = skillStudyGuidePath(outcome.code);
        const probe = await request(studyGuideProbeUrl(guidePath), { ...probeOptions("applied skill study guide"), read: "none" });
        guide = classifyProbe(probe, guidePath).state;
      }
      skillResults.set(skill.uid, { page: outcome.page, code: outcome.code, guide, detail: outcome.detail });
    },
    { ...poolOptions, onProgress: (done, total) => log(`  applied skills: ${done}/${total}`) }
  );

  const examApplied = applyExamProbes({
    exams: exams.records,
    previousExams: prevList("exams"),
    previousGuides: prevList("studyGuides"),
    probes: examProbes,
    today,
  });
  const skillApplied = applyAppliedSkillResults({
    skills: skills.records,
    previousSkills: prevList("appliedSkills"),
    previousGuides: prevList("studyGuides"),
    results: skillResults,
    today,
  });

  const previousSkillsWithCode = prevList("appliedSkills").filter((s) => s.code).length;
  const currentSkillsWithCode = skillApplied.skills.filter((s) => s.code).length;
  const probeProblems = [
    ...checkProbeFailures({ label: "exam study guide", probes: exams.records.length, transient: examApplied.stats.transient, maxPct: limits.MAX_PROBE_FAILURE_PCT, minSample: limits.PROBE_MIN_SAMPLE }),
    ...checkProbeFailures({ label: "applied skill", probes: skills.records.length, transient: skillApplied.stats.transient, maxPct: limits.MAX_PROBE_FAILURE_PCT, minSample: limits.PROBE_MIN_SAMPLE }),
    ...checkAppliedSkillCodeCoverage({ previousWithCode: previousSkillsWithCode, currentWithCode: currentSkillsWithCode, minSharePct: limits.MIN_SKILL_CODE_SHARE_PCT }),
  ];
  if (probeProblems.length) throw new FailsafeAbort(probeProblems);
  if (examApplied.stats.redirected) warn(`  ${examApplied.stats.redirected} exam study guide URLs answer 200 on another path (treated as absent): ${examApplied.stats.redirectedSamples.join("; ")}`);
  if (examApplied.stats.transient || skillApplied.stats.transient) {
    warn(`  transient probe failures kept their previous value: ${examApplied.stats.transient} exams (${examApplied.stats.keptPrevious} kept a guide), ${skillApplied.stats.transient} applied skills`);
  }
  const unverified = [...examApplied.unverified, ...skillApplied.unverified].sort();
  if (unverified.length) warn(`  ${unverified.length} study guides could not be probed and have no previous value (listed in unverifiedStudyGuides): ${unverified.join(", ")}`);

  // 4. tombstones + assembly ----------------------------------------------------------
  const lists = {
    learningPaths: paths.records,
    courses: courses.records,
    certifications: certifications.records,
    exams: examApplied.exams,
    appliedSkills: skillApplied.skills,
  };
  const statusBefore = readStatus(statusFile);
  const seenDates = [dateOfTimestamp(previous?.lastChecked), dateOfTimestamp(statusBefore.learn?.contentGeneratedAt)].filter(Boolean).sort();
  const previousSeenDate = seenDates.length ? seenDates[seenDates.length - 1] : null;
  const removals = computeContentRemovals({
    previous: Object.fromEntries(CONTENT_TYPES.map(({ list }) => [list, prevList(list)])),
    previousRemoved: prevList("removed"),
    current: lists,
    today,
    previousSeenDate,
  });
  const output = assembleContent({
    now,
    lists,
    studyGuides: mergeStudyGuides(examApplied.entries, skillApplied.entries),
    unverifiedStudyGuides: unverified,
    removed: removals.removed,
  });
  const invalid = validateContentOutput(output);
  if (invalid.length) throw new FailsafeAbort(invalid.map((p) => `self-check failed: ${p}`));
  const collisions = findContentPathCollisions(removals.removed, lists);
  if (collisions.length) warn(`  ${collisions.length} tombstone paths are served by a different live entry now: ${collisions.slice(0, 5).map((c) => c.path).join(", ")}`);

  // 5. change files ------------------------------------------------------------------
  // Candidates are diffs against the previous file as read above: a new tombstone, a path that changed under
  // the same uid, and a study guide that a DEFINITIVE probe dropped (a transient failure kept the previous
  // value, so it yields no candidate). The module catalog comes from disk (this week's catalog run wrote it):
  // it decides resurrection of module paths and which paths count as modules for the probe classifier.
  const changeRun = await refreshChanges({
    previous: changeState.previous,
    candidates: diffContent(previous, output),
    catalog: readJsonIfExists(catalogFile, warn),
    content: output,
    now,
    limits: changeLimits,
    probe: changesOptions.probe,
    fetchImpl,
    sleepImpl,
    delayMs: changesOptions.delayMs,
    workers: changesOptions.workers,
    label: "content",
    log,
    warn,
  });

  // 6. write + heartbeat ----------------------------------------------------------------
  const unchanged = sameContentExceptVolatile(previous, output);
  let wrote = false;
  if (dryRun) {
    log("DRY_RUN=1: not writing the data file, the change files or status.json");
  } else {
    // change files first: a crash between the two writes then re-derives the same candidates from the old
    // content next run (applying them again is a no-op), instead of losing the diff for good
    writeChanges(dataDir, changeRun.changes);
    if (unchanged) {
      log(`No content changes vs. ${outputFile} -- skipping write (only lastChecked / study guide check dates would differ).`);
    } else {
      writeJsonAtomic(outputFile, output);
      wrote = true;
      log(`Wrote ${outputFile}`);
    }
  }

  const counts = contentCounts(output);
  if (!dryRun) contributeLearnStatus(statusFile, "content", { content: counts, contentChanges: changeRun.counters }, { now, env });

  log(`  ${JSON.stringify(counts)}`);
  log(
    `  exam study guides: ${examApplied.stats.verified} of ${exams.records.length} exams have one (${examApplied.stats.absent} absent, ${examApplied.stats.redirected} redirected, ${examApplied.stats.transient} transient)`
  );
  log(
    `  applied-skill study guides: ${skillApplied.stats.verified} of ${skills.records.length} skills (${skillApplied.stats.withCode} expose a code, ${skillApplied.stats.withoutCode} do not, ${skillApplied.stats.transient} transient)`
  );
  log(`  removed (tombstones): ${removals.removed.length} (${removals.newlyRemoved} new this run, ${removals.resurrected} came back)`);

  return { wrote, unchanged, dryRun, output, counts, examStats: examApplied.stats, skillStats: skillApplied.stats, removals, changes: changeRun.changes, changesStats: changeRun.stats };
}
