#!/usr/bin/env node
/**
 * Writes the URLs that earlier quarantine issues of this repository already reported, for the
 * docs sync (QUARANTINE_REPORTED_FILE): a URL that flips between 404 and live is quarantined
 * again each time it breaks and must not open the same issue again.
 *
 *   node scripts/reported-quarantine.mjs --out /tmp/docs-catalog-reported-urls.txt
 *
 * The issue bodies are the memory: every issue titled "Docs Catalog: N newly quarantined URL(s) ..."
 * (open or closed, label data) lists its URLs in a table. Needs the gh CLI and GH_TOKEN.
 *
 * Environment:
 *   GITHUB_REPOSITORY   owner/name (default mscerts/learnsync)
 *   ISSUES_JSON_FILE    tests only: read the issues ([{ number, title, body }]) from this file instead of gh
 *
 * A failing gh call ends the run with exit code 1 and writes nothing: the workflow step is
 * continue-on-error, and without the file the sync reports every newly quarantined URL.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { reportedQuarantineUrls, serializeReportedUrls } from "./lib/docs-helpers.mjs";

const args = process.argv.slice(2);
const at = args.indexOf("--out");
const out = at >= 0 ? args[at + 1] : null;
if (!out) {
  console.error("Usage: node scripts/reported-quarantine.mjs --out <file>");
  process.exit(2);
}

function listIssues() {
  if (process.env.ISSUES_JSON_FILE) return JSON.parse(readFileSync(process.env.ISSUES_JSON_FILE, "utf-8"));
  const text = execFileSync(
    "gh",
    [
      "issue",
      "list",
      "--repo",
      process.env.GITHUB_REPOSITORY || "mscerts/learnsync",
      "--state",
      "all",
      "--label",
      "data",
      "--limit",
      "1000",
      "--json",
      "number,title,body",
    ],
    { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 }
  );
  return JSON.parse(text || "[]");
}

try {
  const reported = reportedQuarantineUrls(listIssues());
  writeFileSync(out, serializeReportedUrls(reported));
  console.log(`Wrote ${out}: ${reported.size} URL(s) that earlier quarantine issues already reported.`);
} catch (err) {
  console.error(`Could not look up the reported URLs: ${err.message}`);
  process.exit(1);
}
