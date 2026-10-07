/**
 * The docs sync's share of the change files (data/changes/removed.json and
 * moved.json, see DATA_CONTRACT.md). Thin glue around scripts/lib/changes.mjs,
 * which owns the format and the rules; this file only decides WHEN the docs
 * family is derived and written.
 *
 * The docs family has no state and needs no probes of its own: every docs run
 * derives it from the FINAL docs-redirects ledger and the FINAL quarantine list
 * and replaces all `family: "docs"` entries with the result. A page that is
 * restored (released from quarantine, re-indexed so its ledger row is deleted)
 * therefore disappears from the files on the same run. Learn entries pass
 * through untouched.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGES_DIR, CHANGES_FILES, docsChanges, normalizeChangeEntry, replaceFamily, summarizeChanges, writeChanges } from "./changes.mjs";

/**
 * The change set after a docs run. Pure.
 *
 * @param {object} o
 * @param {{removed: object, moved: object}} o.previous  loadChanges() result (any Learn entries ride along)
 * @param {Array}  o.ledger        the run's final, normalized data/docs-redirects.json
 * @param {Array}  o.invalid       the run's final data/docs-catalog-invalid.json
 * @param {string} o.today         YYYY-MM-DD (used only for rows that lack a date)
 * @param {string} o.generatedAt   ISO timestamp, becomes `sources.docs` and `generatedAt`
 * @param {Function} [o.warn]      told about each row that cannot be represented
 * @returns {{ changes: {removed: object, moved: object}, counts: {removed: number, moved: number}, kept: {removed: number, moved: number} }}
 *   counts = docs entries per file after this run; kept = entries of other families left untouched
 */
export function buildDocsChanges({ previous, ledger, invalid, today, generatedAt, warn = () => {} }) {
  const entries = [];
  for (const entry of docsChanges({ redirects: ledger, invalid, today })) {
    // A row a damaged or hand-edited ledger can hold (for example from === to) must not take the whole
    // sync down: say so and leave it out. Everything else is derived, never guessed.
    const file = entry.outcome === "moved" ? "moved" : "removed";
    const ok = normalizeChangeEntry(entry, file, (reason) => warn(`  change files: skipped docs entry ${entry.path} (${reason})`));
    if (ok) entries.push(entry);
  }
  const changes = replaceFamily(previous, "docs", entries, generatedAt);
  const { byFamily } = summarizeChanges(changes);
  return { changes, counts: { ...byFamily.docs }, kept: { ...byFamily.learn } };
}

/** The text of both change files as they are on disk now (null = missing), for "did writing change anything?". */
function readBoth(dataDir) {
  return Object.values(CHANGES_FILES).map((name) => {
    const file = join(dataDir, CHANGES_DIR, name);
    return existsSync(file) ? readFileSync(file, "utf-8") : null;
  });
}

/** Writes both files (creating data/changes/). Returns true when at least one of them now differs from before. */
export function writeDocsChanges(dataDir, changes) {
  const before = readBoth(dataDir);
  writeChanges(dataDir, changes);
  const after = readBoth(dataDir);
  return after.some((text, i) => text !== before[i]);
}
