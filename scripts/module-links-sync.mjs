#!/usr/bin/env node
/**
 * Harvest the links of the last unit of Microsoft Learn modules ("Summary", "Summary and
 * resources"): mostly curated documentation pages that belong to what the module teaches.
 * Output: data/module-links.json (format and rules in DATA_CONTRACT.md) and the
 * "moduleLinks" section of data/status.json.
 *
 * Usage:
 *   node scripts/module-links-sync.mjs
 *
 * Reads data/learn-catalog.json (unit URLs and unitSig, so run the Learn catalog sync first) and,
 * for the default scope, data/learn-content.json plus the catalog API course list.
 *
 * Environment (all optional):
 *   MODULE_LINKS_SCOPE=courses   "courses" (modules of the official courses, about 1,400) or "all" (every module)
 *   FULL_REFRESH=1               fetch every in-scope module, not only new and changed ones
 *   MODULE_LINKS_MAX_FETCHES=4000   most pages one run fetches
 *   MODULE_LINKS_MAX_FAIL_PCT=10    abort when more of the page requests failed
 *   MODULE_LINKS_FULL_REFRESH_DAYS=30  a full refresh at least this often
 *   MODULE_LINKS_DELAY_MS=1000   pause per worker between pages and between live link checks (3 workers at most)
 *   MODULE_LINKS_MAX_PROBES=3000 most live link checks one run makes (the rest stays `unverified` until next run)
 *   MODULE_LINKS_RECHECK_DAYS=30 a link a live check confirmed is not checked again for this many days
 *   DRY_RUN=1                    fetch and compute everything (live link checks included), write nothing
 *
 * Every Learn link is checked before it is stored: current paths only (a moved page is rewritten, a gone
 * one dropped); see DATA_CONTRACT.md. Also reads data/docs-urls.txt and data/docs-redirects.json.
 *
 * A failsafe abort (too many unreadable pages, Learn changed its markup, the links of far fewer
 * modules than before, mostly inconclusive or mostly "gone" link checks) writes nothing, not even status.json.
 *
 * All logic lives in scripts/lib/module-links*.mjs; this file only wires it to the data directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runModuleLinksSync } from "./lib/module-links-run.mjs";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

runModuleLinksSync({ dataDir }).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
