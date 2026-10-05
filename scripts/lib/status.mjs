/**
 * data/status.json heartbeat shared by both syncs. See DATA_CONTRACT.md.
 * Each sync owns one section ("learn" or "docs") and replaces it wholesale on
 * EVERY run, even when its data files did not change, so the file is proof that
 * a run finished and says how fresh the data is.
 */

import { readFileSync, writeFileSync } from "node:fs";

export const STATUS_SCHEMA_VERSION = 1;

export function readStatus(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** Pure: returns the next status object with `section` replaced. */
export function withSection(status, section, data, { now = new Date(), runId = null } = {}) {
  const next = { ...status, schemaVersion: STATUS_SCHEMA_VERSION };
  next[section] = { generatedAt: now.toISOString(), runId, ...data };
  const ordered = { schemaVersion: next.schemaVersion };
  for (const key of ["learn", "docs"]) if (next[key]) ordered[key] = next[key];
  for (const [key, value] of Object.entries(next)) if (!(key in ordered)) ordered[key] = value;
  return ordered;
}

/** Read-merge-write one section of the status file. Returns the written object. */
export function updateStatus(file, section, data, { now = new Date(), env = process.env } = {}) {
  const runId = env.GITHUB_RUN_ID ? String(env.GITHUB_RUN_ID) : null;
  const next = withSection(readStatus(file), section, data, { now, runId });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return next;
}
