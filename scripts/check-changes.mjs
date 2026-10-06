#!/usr/bin/env node
/**
 * Ask learnsync's change files which links changed. Reads ONLY data/changes/removed.json and
 * moved.json (and data/status.json for freshness): never the multi-MB caches, no network.
 *
 * Usage:
 *   node scripts/check-changes.mjs [<url-or-path> ...] [--input <links.json>] [--all]
 *        [--data <dir>] [--output <file>] [--stale-days <n>] [--now <ISO>]
 *   cat links.json | node scripts/check-changes.mjs
 *   node scripts/check-changes.mjs --since <YYYY-MM-DD>        (changelog view)
 *   node scripts/check-changes.mjs --help
 *
 * Input: a JSON array of Learn URLs or absolute paths (strings, or objects with a `url` or `path`
 * field) on stdin or in --input, and/or URLs as arguments. With --since no links are read.
 *
 * Output (JSON, stdout or --output): { generatedAt, dataDir, note, freshness, warnings, summary, results }.
 * Each result is { url, path, status: "removed" | "moved" | "none", outcome, to, via, confidence,
 * firstSeen, lastVerified, ... } (see DATA_CONTRACT.md, "change files"); only removed and moved
 * rows are listed unless --all asks for the "none" rows too. With --since the output lists the
 * entries first seen on or after that date (oldest first) under `changes`.
 *
 * READ THIS: "none" means NO CHANGE IS RECORDED, not that the link is valid. A link that was never
 * in a learnsync cache, or that broke before changes were recorded, also reads none. `freshness`
 * and `warnings` say whether the files are fresh enough for "none" to mean anything.
 *
 * Exit codes: 0 whenever the check ran (hits do not change it), 2 for a usage error (bad flag,
 * unreadable or invalid input), 1 when the change files exist but cannot be read (invalid JSON,
 * unsupported schemaVersion): nothing is printed then, because every link would read "none".
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_STALE_DAYS, UsageError, buildReport, parseLinks, readStatusFile } from "./lib/check-changes.mjs";
import { isIsoDate } from "./lib/learn-helpers.mjs";
import { loadChangeLedger } from "./lib/validate.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const USAGE = `Usage: node scripts/check-changes.mjs [<url-or-path> ...] [options]

Ask learnsync's change files (data/changes/removed.json and moved.json) which links changed.

  <url-or-path>         a learn.microsoft.com URL or absolute path to look up (repeatable)
  --input <file>        JSON array of URLs or paths (default: read stdin when no link is given)
  --all                 also list the links with no recorded change ("none")
  --since <YYYY-MM-DD>  changelog view: entries first seen on or after that date, oldest first
  --data <dir>          data directory (default: ./data next to this script)
  --output <file>       write the JSON report to a file instead of stdout
  --stale-days <n>      a family whose change-file entries were last refreshed more than n days ago
                        is reported stale (default ${DEFAULT_STALE_DAYS})
  --now <ISO>           the clock used for ages and generatedAt (tests, reproducible reports)
  -h, --help            this text

Each result has status "removed", "moved" or "none".
  "none" means NO CHANGE IS RECORDED. It does NOT mean the link is valid: a link that was never
  in a learnsync cache, or that broke before changes were recorded, also reads none.
  Check \`freshness\` and \`warnings\` in the output, and use scripts/validate-urls.mjs for verdicts.

Exit code: 0 when the check ran, 2 for a usage error, 1 when the change files cannot be read.
`;

export function parseArgs(argv) {
  const opts = { data: join(root, "data"), input: null, links: [], all: false, since: null, output: null, staleDays: DEFAULT_STALE_DAYS, now: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--data") opts.data = value();
    else if (a === "--input") opts.input = value();
    else if (a === "--output") opts.output = value();
    else if (a === "--all") opts.all = true;
    else if (a === "--since") {
      opts.since = value();
      if (!isIsoDate(opts.since)) throw new UsageError(`--since must be a date like 2026-09-01, got ${JSON.stringify(opts.since)}`);
    } else if (a === "--stale-days") {
      const text = value();
      if (!/^\d+$/.test(text)) throw new UsageError(`--stale-days must be a non-negative integer, got ${JSON.stringify(text)}`);
      opts.staleDays = Number(text);
    } else if (a === "--now") {
      const text = value();
      if (Number.isNaN(Date.parse(text))) throw new UsageError(`--now must be an ISO date or timestamp, got ${JSON.stringify(text)}`);
      opts.now = Date.parse(text);
    } else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new UsageError(`unknown argument: ${a}`);
    else opts.links.push(a);
  }
  if (opts.since !== null && (opts.links.length || opts.input !== null || opts.all)) {
    throw new UsageError("--since lists the recorded changes and cannot be combined with links, --input or --all");
  }
  return opts;
}

/**
 * The CLI without the process around it: returns the exit code and prints through `io`
 * ({ readStdin, stdinIsTTY, out, err }), so tests drive it without spawning a process.
 */
export function runCli(argv, io) {
  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      io.out(USAGE);
      return 0;
    }
    if (!isDirectory(opts.data)) throw new UsageError(`data directory not found: ${opts.data}`);
    let links = [];
    if (opts.since === null) {
      const raw = readInput(opts, io);
      links = [...opts.links, ...(raw === null ? [] : parseLinks(parseJson(raw)))];
    }
    const readNotes = []; // rows loadChanges dropped, a duplicated path: worth knowing when files were edited by hand
    const ledger = loadChangeLedger(opts.data, { warn: (line) => readNotes.push(line.trim()) });
    if (ledger.error) {
      io.err(`cannot read the change files in ${join(opts.data, "changes")}: ${ledger.error}`);
      return 1;
    }
    const report = buildReport({
      dataDir: opts.data,
      ledger,
      status: readStatusFile(opts.data),
      links,
      since: opts.since,
      all: opts.all,
      now: opts.now ?? Date.now(),
      staleDays: opts.staleDays,
      notes: readNotes,
    });
    for (const warning of report.warnings) io.err(`warning: ${warning}`);
    const text = JSON.stringify(report, null, 2) + "\n";
    if (opts.output) writeOutput(opts.output, text);
    else io.out(text);
    return 0;
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`${err.message}\n(run with --help for usage)`);
    return 2;
  }
}

/** The JSON text of the input: --input file, else stdin unless links were given as arguments (null = none to read). */
function readInput(opts, io) {
  if (opts.input !== null) {
    try {
      return readFileSync(opts.input, "utf-8");
    } catch (err) {
      throw new UsageError(`cannot read --input ${opts.input}: ${err.message}`);
    }
  }
  if (opts.links.length) return null;
  if (io.stdinIsTTY) throw new UsageError("no links: give URLs as arguments, use --input <file>, pipe a JSON array on stdin, or use --since <date>");
  try {
    return io.readStdin();
  } catch (err) {
    throw new UsageError(`cannot read stdin: ${err.message}`);
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function writeOutput(file, text) {
  try {
    writeFileSync(file, text);
  } catch (err) {
    throw new UsageError(`cannot write --output ${file}: ${err.message}`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new UsageError(`the input is not valid JSON (${err.message})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runCli(process.argv.slice(2), {
    readStdin: () => readFileSync(0, "utf-8"),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    out: (text) => process.stdout.write(text),
    err: (text) => console.error(text),
  });
}
