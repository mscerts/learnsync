#!/usr/bin/env node
/**
 * Build a local cache of Microsoft Learn training modules (name, product
 * category, product(s), subjects, units, REAL unit URLs) for AI-assisted content
 * research and as the validity source for "is this Learn module/unit URL still
 * good" (see DATA_CONTRACT.md).
 *
 * Usage:
 *   node scripts/learn-catalog-sync.mjs
 *
 * Environment (all optional):
 *   FULL_UNIT_REFRESH=1     re-fetch the unit URLs of EVERY module (otherwise only
 *                           modules whose unitSig changed, plus an automatic full
 *                           refresh every 30 days)
 *   MAX_MODULE_DROP_PCT=5   abort if the in-scope module count drops more than this
 *   MAX_API_DROP_PCT=3      abort if the raw API module count drops more than this
 *   CHANGES_MAX_PROBES=300  live probes per run for the change files (removed/moved links)
 *   CHANGES_REVERIFY_PER_RUN=100  of those, how many re-confirm the oldest recorded entries
 *   DRY_RUN=1               fetch and compute everything (change file probes included), write nothing
 *
 * Data sources: https://learn.microsoft.com/api/catalog/ and
 *               https://learn.microsoft.com/api/hierarchy/modules/<uid>
 *               plus live probes of the pages that disappeared (change files only)
 * Output: data/learn-catalog.json, data/changes/removed.json and moved.json (this sync detects
 * the module and unit changes, the content sync the rest; both verify whatever is still
 * unverified), plus the "learn" section of data/status.json. A failsafe abort or a corrupt
 * change file writes nothing.
 *
 * All logic lives in scripts/lib/learn-*.mjs; this file only wires it to the
 * repository's data directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCatalogSync } from "./lib/learn-catalog-run.mjs";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

runCatalogSync({ dataDir }).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
