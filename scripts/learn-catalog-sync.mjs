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
 *   DRY_RUN=1               fetch and compute everything, write nothing
 *
 * Data sources: https://learn.microsoft.com/api/catalog/ and
 *               https://learn.microsoft.com/api/hierarchy/modules/<uid>
 * Output: data/learn-catalog.json, plus the "learn" section of data/status.json
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
