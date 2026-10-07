/**
 * Both Learn scripts report into ONE section ("learn") of data/status.json, which
 * scripts/lib/status.mjs otherwise replaces wholesale. This helper lets each
 * script contribute only its own keys without clobbering the other's:
 *
 *   catalog script -> modules, removed, outOfScope, unitUrlsRefreshedAt, ..., catalogChanges
 *   content script -> content { learningPaths, courses, ... }, contentChanges
 *
 * `catalogChanges` / `contentChanges` are the change-file counters of each run
 * ({ removed, moved, unverified, newRemoved, newMoved, resurrected, probed }, see
 * learn-changes-run.mjs). They are separate objects, one per part, because `removed`
 * already means "module tombstones" at the top level of the section and because each
 * part replaces only its own key, so the two runs never overwrite each other's numbers.
 *
 * Each contribution also stamps `<part>GeneratedAt`. The section's `generatedAt`
 * (what consumers use to refuse stale data) is the OLDER of the two stamps, so a
 * fresh catalog run can never make a stale content set look fresh: the Learn data
 * is only as current as its stalest part.
 */

import { readStatus, updateStatus } from "./status.mjs";

export const PART_STAMP_KEYS = { catalog: "catalogGeneratedAt", content: "contentGeneratedAt" };

// Stable key order inside the section so diffs of status.json stay small no
// matter which script runs first.
const KEY_ORDER = [
  "generatedAt",
  "runId",
  "modules",
  "removed",
  "outOfScope",
  "totalApiModules",
  "unitUrlsRefreshedAt",
  "unitHierarchyRequests",
  "unitHierarchyFailures",
  "unitUrlsNull",
  "unitHierarchyNotFound",
  "unitUrlsCarriedForward",
  "unusedCategories",
  "content",
  "catalogChanges",
  "contentChanges",
  "catalogGeneratedAt",
  "contentGeneratedAt",
];

function orderKeys(data) {
  const ordered = {};
  for (const key of KEY_ORDER) if (key in data) ordered[key] = data[key];
  for (const key of Object.keys(data).sort()) if (!(key in ordered)) ordered[key] = data[key];
  return ordered;
}

/** Pure: the section data (without generatedAt/runId) after `part` contributes `fields` at `now`. */
export function mergeLearnSection(existing, part, fields, now) {
  if (!(part in PART_STAMP_KEYS)) throw new Error(`Unknown learn status part: ${part}`);
  const { generatedAt, runId, ...rest } = existing && typeof existing === "object" ? existing : {};
  return orderKeys({ ...rest, ...fields, [PART_STAMP_KEYS[part]]: now.toISOString() });
}

/** Pure: the oldest valid part stamp in `data`, or `fallback` when there is none. */
export function oldestPartStamp(data, fallback) {
  const times = Object.values(PART_STAMP_KEYS)
    .map((key) => Date.parse(data[key]))
    .filter((time) => !Number.isNaN(time));
  return times.length ? new Date(Math.min(...times)) : fallback;
}

/** Read-merge-write the learn section of the status file. Returns the written status object. */
export function contributeLearnStatus(file, part, fields, { now = new Date(), env = process.env } = {}) {
  const data = mergeLearnSection(readStatus(file).learn, part, fields, now);
  return updateStatus(file, "learn", data, { now: oldestPartStamp(data, now), env });
}
