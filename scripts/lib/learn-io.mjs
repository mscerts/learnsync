/**
 * Small I/O helpers shared by the two Learn syncs (scripts/lib/learn-catalog-run.mjs
 * and scripts/lib/learn-content-run.mjs).
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** Thrown when a failsafe trips: nothing was written, the process must exit non-zero. */
export class FailsafeAbort extends Error {
  constructor(problems) {
    super(`Failsafe tripped, nothing written:\n  - ${problems.join("\n  - ")}`);
    this.name = "FailsafeAbort";
    this.problems = problems;
  }
}

/** Parsed JSON file, or null when it does not exist or is unreadable (a warning is printed for the latter). */
export function readJsonIfExists(file, warn = console.warn) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch (err) {
    warn(`  could not read ${file} (${err.message}); treating it as absent`);
    return null;
  }
}

/** Write via a temp file + rename so a crash can never leave a half-written data file. */
export function writeJsonAtomic(file, value) {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  renameSync(temp, file);
}

/** onRetry callback for request(): logs the first 20 retries, then every 100th. */
export function retryLogger(warn, label) {
  let count = 0;
  return ({ url, attempt, error, waitMs }) => {
    count++;
    if (count <= 20 || count % 100 === 0) warn(`  ${label} retry #${count}: attempt ${attempt} of ${url} failed (${error}); waiting ${Math.round(waitMs)} ms`);
  };
}
