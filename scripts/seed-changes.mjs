#!/usr/bin/env node
/**
 * Seed data/changes/removed.json and moved.json with links that broke BEFORE the
 * Learn sync started recording changes (see DATA_CONTRACT.md, "change files").
 * A one-off, repeatable tool: a re-run only adds what is new and works off what
 * an earlier run left `unverified`.
 *
 * Usage:
 *   node scripts/seed-changes.mjs [--data <dir>]
 *        [--history <repoDir>[::<fileInRepo>]]...   (repeatable)
 *        [--urls <file.json>] [--max-probes <n>] [--no-probe] [--dry-run]
 *        [--today <YYYY-MM-DD>] [--min-modules <n>]
 *
 * Sources (never guessed):
 *   the current catalog   its tombstones and hierarchyNotFound modules, plus the
 *                         tombstones of learn-content.json (always used)
 *   --history             git history of learn-catalog.json. <fileInRepo> defaults
 *                         to data/learn-catalog.json; before the extraction the file
 *                         lived in the hub repo as src/data_files/learn-catalog.json
 *                         (v1 and v2 shapes both work). A module path that some
 *                         snapshot had and the current catalog lacks is a candidate;
 *                         its firstSeen is the date of the first snapshot that lacks
 *                         it, an UPPER BOUND. Give each path the file had, once per
 *                         name (renames are not followed).
 *   --urls                a JSON array of URLs or paths (for example every Learn link a
 *                         site uses). Each is classified by the cache-only validator;
 *                         a non-valid verdict is recorded ONLY if a live probe confirms
 *                         it (evidence "live-probe"). A link the probe finds live is skipped.
 *
 * Options:
 *   --data         data directory (default ./data next to this script)
 *   --max-probes   live probe budget (default 300, env CHANGES_MAX_PROBES); at most 3
 *                  workers, 1 s between probes per worker, same HTTP layer as the syncs
 *   --no-probe     plan only: history and cache candidates are written as `unverified`;
 *                  url-list links are NOT written (nothing confirmed them)
 *   --dry-run      print the plan and counts, write nothing (still probes unless --no-probe)
 *   --today        the run's date (tests)
 *   --min-modules  refuse a current catalog with fewer modules than this (default 3000,
 *                  the sync's floor): a truncated catalog would read every other module as removed
 *
 * Merges into the existing files: known paths keep their entries, docs-family entries are
 * never touched, `sources.learn` (the sync's freshness stamp) is not advanced, and nothing
 * is written when nothing changed. Exit code 1 on any error (nothing is written then).
 *
 * Re-running is safe: classified entries are not probed again (the sync re-verifies them),
 * `unverified` ones are worked off first, oldest firstSeen first. A candidate that a probe
 * finds live (Learn still serves a module the catalog API dropped) is recorded nowhere, so
 * each run asks about it again; the report counts those as "not recorded".
 */

import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readChangesLimits } from "./lib/changes.mjs";
import { isIsoDate } from "./lib/learn-helpers.mjs";
import { LIMITS } from "./lib/learn-config.mjs";
import { formatSeedReport, parseHistorySpec, runSeed } from "./lib/seed-changes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function wholeNumber(flag, text) {
  if (!/^\d+$/.test(text)) throw new Error(`${flag} must be a non-negative integer, got ${JSON.stringify(text)}`);
  return Number(text);
}

export function parseArgs(argv) {
  const opts = {
    data: join(root, "data"),
    histories: [],
    urls: null,
    maxProbes: null,
    noProbe: false,
    dryRun: false,
    today: null,
    minModules: LIMITS.MIN_MODULES,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--data") opts.data = value();
    else if (a === "--history") opts.histories.push(parseHistorySpec(value()));
    else if (a === "--urls") opts.urls = value();
    else if (a === "--max-probes") opts.maxProbes = wholeNumber(a, value());
    else if (a === "--no-probe") opts.noProbe = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--today") {
      opts.today = value();
      if (!isIsoDate(opts.today)) throw new Error(`--today must be YYYY-MM-DD, got ${JSON.stringify(opts.today)}`);
    } else if (a === "--min-modules") opts.minModules = wholeNumber(a, value());
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = await runSeed({
    dataDir: opts.data,
    histories: opts.histories,
    urlsFile: opts.urls,
    maxProbes: opts.maxProbes ?? readChangesLimits(process.env).maxProbes,
    noProbe: opts.noProbe,
    dryRun: opts.dryRun,
    today: opts.today ?? undefined,
    minModules: opts.minModules,
  });
  console.log(formatSeedReport(report).join("\n"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
