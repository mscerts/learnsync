#!/usr/bin/env node
/**
 * Keep the sidebar groups of the Microsoft Learn documentation: the table of contents (toc.json) of every
 * docs folder, so that the pages that sit in the same group of the sidebar ("Add users and groups > Groups")
 * are known together. Output: data/docs-toc.json (format and rules in DATA_CONTRACT.md) and the "docsToc"
 * section of data/status.json.
 *
 * Usage:
 *   node scripts/docs-toc-sync.mjs
 *
 * Reads data/docs-urls.txt (the folders that hold pages; run the docs catalog sync first) and
 * data/docs-sitemap-families.json (which families are in scope).
 *
 * Environment (all optional):
 *   DOCS_TOC_FAMILIES=entra,azure  only these families (first path segments); default every relevant family
 *   DOCS_TOC_MIN_DIR_PAGES=3     a folder with fewer pages is not asked
 *   DOCS_TOC_MAX_PROBES=6000     most folders one run asks that it has not asked before (the rest waits)
 *   DOCS_TOC_RECHECK_DAYS=28     a folder that answered "no toc.json" is asked again after this many days
 *   DOCS_TOC_MAX_FAIL_PCT=10     abort when more of the requests failed
 *   DOCS_TOC_DELAY_MS=500        pause per worker between requests (3 workers at most)
 *   DRY_RUN=1                    ask and compute everything, write nothing
 *
 * A failsafe abort (too many failed requests, Learn changed the toc format, far fewer pages in a group than
 * before) writes nothing, not even status.json.
 *
 * All logic lives in scripts/lib/docs-toc*.mjs; this file only wires it to the data directory.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDocsTocSync } from "./lib/docs-toc-run.mjs";

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

runDocsTocSync({ dataDir }).catch((err) => {
  console.error(err.message);
  process.exit(1);
});
