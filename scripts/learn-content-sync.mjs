#!/usr/bin/env node
/**
 * Build a local cache of everything in the Microsoft Learn catalog API that is not
 * a module: learning paths, courses, certifications, exams and applied skills,
 * plus a verified list of study guide pages. Together with
 * data/learn-catalog.json it is the validity source for "is this Learn URL still
 * good" (see DATA_CONTRACT.md).
 *
 * Usage:
 *   node scripts/learn-content-sync.mjs
 *
 * Environment (all optional):
 *   MAX_CONTENT_DROP_PCT=20   abort if any list shrinks by more than this
 *   DRY_RUN=1                 fetch and compute everything, write nothing
 *
 * Data sources: https://learn.microsoft.com/api/catalog/?type=<type>&locale=en-us
 *               (one request per type), plus live probes of the study guide pages
 *               and of the applied-skill pages (to read their study guide code).
 * Output: data/learn-content.json, plus the "content" part of the "learn" section
 * of data/status.json
 *
 * All logic lives in scripts/lib/learn-content*.mjs; this file only wires it to
 * the repository's data directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runContentSync } from "./lib/learn-content-run.mjs";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

runContentSync({ dataDir }).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
