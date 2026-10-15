/**
 * Pure helper functions for scripts/docs-catalog-sync.mjs, extracted so they
 * can be unit-tested with node:test (see test/docs-helpers.test.mjs) without
 * running the full sync. No I/O, no network — keep it that way.
 */

import { relative } from "node:path";
import { canonicalPath } from "./canonical.mjs";

export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const fm = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_.]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    fm[m[1]] = value;
  }
  return fm;
}

export function cleanTitle(title) {
  return title.replace(/\s*[|\-]\s*Microsoft (Docs|Learn|Azure)\s*$/i, "").trim();
}

// github/docs (Next.js/Liquid pipeline, unlike every other docfx-based repo here) embeds
// unresolved template tags like "{% data variables.product.github %}" in raw frontmatter text.
export function stripLiquidTags(text) {
  if (!text) return text;
  const cleaned = text
    .replace(/\{%\s*data\s+variables\.product\.(?:github|prodname_dotcom|prodname_ghe_cloud|prodname_ghe_server)\s*%\}/gi, "GitHub")
    .replace(/\{%[^%]*%\}/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return cleaned || null;
}

export function buildUrl(filePath, sourceRoot, baseUrlPath, domain, stripPrefix) {
  let rel = relative(sourceRoot, filePath)
    .replace(/\\/g, "/")
    .replace(/\.md$/, "")
    .replace(/(^|\/)index$/, ""); // index.md is a directory's own landing page, not a literal "/index" URL segment
  // stripPrefix is the pathMappings sourcePath segment that resolveTarget() already folded
  // into baseUrlPath -- without stripping it here it would appear twice in the final URL
  // (e.g. defender/threat-intelligence/threat-intelligence/analyst-insights).
  if (stripPrefix) {
    rel = rel === stripPrefix ? "" : rel.slice(stripPrefix.length + 1);
  }
  if (!rel) return `https://${domain}/${baseUrlPath}`;
  return baseUrlPath ? `https://${domain}/${baseUrlPath}/${rel}` : `https://${domain}/${rel}`;
}

export function resolveTarget(target, relativePath) {
  const mapping = target.pathMappings?.find(
    ({ sourcePath }) => relativePath === sourcePath || relativePath.startsWith(`${sourcePath}/`)
  );
  return {
    baseUrlPath: mapping?.baseUrlPath || target.baseUrlPath,
    stripPrefix: mapping?.sourcePath,
  };
}

export function shuffleSample(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// Whole-catalog duplicate-URL audit. Two entries claiming the same URL usually means a
// wrong sourceFolder/baseUrlPath mapping in REPOS (this is exactly how the Dynamics 365
// baseUrlPath bug was originally caught, by hand — see AGENTS.md). Returns
// [{ url, entries }] for every URL claimed more than once.
export function findDuplicateUrls(entries) {
  const byUrl = new Map();
  for (const entry of entries) {
    const list = byUrl.get(entry.url);
    if (list) list.push(entry);
    else byUrl.set(entry.url, [entry]);
  }
  return [...byUrl.entries()].filter(([, list]) => list.length > 1).map(([url, list]) => ({ url, entries: list }));
}

/**
 * Identity of a catalog entry for alias detection: the canonical path for
 * learn.microsoft.com URLs (case, locale, query and trailing slash folded
 * away), the lowercased URL for anything else.
 */
export function aliasKey(url) {
  return canonicalPath(url) ?? String(url).toLowerCase();
}

/**
 * Case-insensitive companion of findDuplicateUrls(): groups of entries that are
 * the same page spelled differently (for example /azure/Foo and /azure/foo).
 * Exact repeats are findDuplicateUrls()' job and are not reported here.
 * Returns [{ key, urls, entries }] for every key with at least two distinct URLs.
 */
export function findAliasDuplicates(entries) {
  const byKey = new Map();
  for (const entry of entries) {
    const key = aliasKey(entry.url);
    const list = byKey.get(key);
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  }
  const groups = [];
  for (const [key, list] of byKey) {
    const urls = [...new Set(list.map((e) => e.url))];
    if (urls.length > 1) groups.push({ key, urls, entries: list });
  }
  return groups;
}

// The URL prefixes a repo's targets publish under — used to carry forward the
// previous catalog's entries for a repo whose clone/parse failed this run.
export function repoUrlPrefixes(repo) {
  const domain = repo.domain || "learn.microsoft.com";
  const prefixes = [];
  for (const target of repo.targets) {
    const paths = [target.baseUrlPath, ...(target.pathMappings ?? []).map((m) => m.baseUrlPath)];
    for (const p of paths) {
      prefixes.push(p ? `https://${domain}/${p}/` : `https://${domain}/`);
    }
  }
  return prefixes;
}

// Builds the Markdown body for the "please investigate" issue opened when a run
// quarantines at least one NEW url. Written to QUARANTINE_REPORT_FILE and, in CI,
// handed to peter-evans/create-issue-from-file by the calling workflow.
export const QUARANTINE_REPORT_MAX_ROWS = 100;

export function buildQuarantineReport(records, { context = "run", surgeThreshold = 20, maxRows = QUARANTINE_REPORT_MAX_ROWS } = {}) {
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const escapeCell = (s) => String(s ?? "-").replace(/\|/g, "\\|");
  // A GitHub issue body is capped at 65,536 characters and nobody reads a
  // 5,000-row table: show the first `maxRows` and point at the data file.
  const shown = records.slice(0, maxRows);
  const hidden = records.length - shown.length;
  const table = shown
    .map((e) => `| ${escapeCell(e.status)} | ${escapeCell(e.url)} | ${escapeCell(e.title)} | ${escapeCell(e.product)} |`)
    .join("\n");
  const moreLine = hidden > 0 ? [`_${hidden} more in \`data/docs-catalog-invalid.json\` (not shown here)._`, ""] : [];

  const isSurge = context === "run" && records.length > surgeThreshold;
  const surgeCallout = isSurge
    ? [
        `> \u26a0\ufe0f **Surge warning**: ${records.length} URLs were quarantined in a single run, well`,
        "> above the usual single-digit trickle. This is more likely a transient rate-limit/network",
        "> hiccup against learn.microsoft.com during the link check than that many pages genuinely",
        "> breaking simultaneously. **Spot-check 3-5 of them by fetching the URL directly before",
        "> working through the full list below** -- if they resolve fine now, this was very likely a",
        "> false positive; consider re-running the sync instead of investigating each one",
        "> individually.",
        "",
      ]
    : [];

  const introLines =
    context === "run"
      ? [
          `This week's \`docs-catalog-sync.mjs\` run found ${records.length} URL(s) that used to`,
          "resolve but now fail their link check. They've been moved out of `data/docs-catalog.json`",
          "into `data/docs-catalog-invalid.json` (the quarantine list) so they don't show up in",
          "normal content-research queries, but *why* they broke hasn't been diagnosed yet.",
        ]
      : [
          `This is a one-time snapshot of the ${records.length} URL(s) already sitting in`,
          "`data/docs-catalog-invalid.json` when the issue-per-newly-broken-URL automation below",
          "was introduced. They predate that automation, so no issue was ever opened for them",
          "individually -- this issue exists purely so the pre-existing backlog doesn't stay",
          "untracked forever.",
        ];

  const heading = context === "run" ? "newly quarantined" : "pre-existing quarantined";

  return [
    `# Docs Catalog: ${records.length} ${heading} URL(s)`,
    "",
    ...surgeCallout,
    ...introLines,
    runUrl ? `\nRun: ${runUrl}\n` : "",
    `## ${context === "run" ? "Newly quarantined" : "Quarantined"} URL(s)`,
    "",
    "| Status | URL | Title | Product |",
    "|---|---|---|---|",
    table,
    "",
    ...moreLine,
    "## Prompt for an AI coding agent",
    "",
    "You're working in the `mscerts/learnsync` repo. For each URL listed above:",
    "",
    "1. **Diagnose.** Search Microsoft Learn for the page's title/topic to find where the",
    "   content lives now (the MicrosoftDocs source repos are being retired, so don't rely",
    "   on `original_content_git_url` pointing at a public repo).",
    "2. **Classify** each URL as one of:",
    "   - **Moved** \u2014 the content lives at a new URL. The next sync will pick the new URL",
    "     up from Learn's sitemaps automatically; nothing to fix in the script. (Redirects the",
    "     sync itself observed are listed in `data/docs-redirects.json`.)",
    "   - **Out of scope** \u2014 the page moved to a URL prefix that is in neither scope in",
    "     `scripts/lib/scope.mjs` (`LEARN_SCOPE` for metadata, `INDEX_ONLY_SCOPE` for index",
    "     entries only). Add the prefix if the content is wanted.",
    "   - **Genuinely retired/removed** \u2014 the page or product no longer exists anywhere. No",
    "     script change needed; leave its record in `data/docs-catalog-invalid.json` as-is.",
    "3. **Fix the script** only for the out-of-scope case, then run",
    "   `DRY_RUN=1 node scripts/docs-catalog-sync.mjs` to confirm the new prefix is picked up.",
    "4. **Clean up.** Remove the resolved URL's record(s) from",
    "   `data/docs-catalog-invalid.json` (or simply let the next scheduled sync do it --",
    "   every quarantined URL is re-checked each run and auto-released once it resolves).",
    "5. **Open a pull request** with the script fix and quarantine cleanup, referencing this",
    "   issue.",
    "",
    "If you're not confident about the right classification or fix for a given URL, don't",
    "guess \u2014 leave a comment on this issue asking for clarification instead of committing a",
    "speculative change.",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// URLs that an earlier quarantine issue already reported
// ---------------------------------------------------------------------------
// A URL that flips between 404 and live is released from the quarantine when it works and
// quarantined again when it breaks again, so it would be "newly quarantined" every time and
// open the same issue again. The workflow therefore writes the URLs the earlier quarantine
// issues (open or closed) listed to a file (scripts/reported-quarantine.mjs, from the issue
// bodies, which are the memory: no new data file) and the sync leaves those out of the issue
// it opens. The URL stays quarantined in data/docs-catalog-invalid.json as usual.

/** The titles of the issues this automation opens, "Docs Catalog: N newly quarantined URL(s) ..." and the one-time backlog. */
export const QUARANTINE_ISSUE_TITLE = /^Docs Catalog: \d+ (?:newly|pre-existing) quarantined URL\(s\)/;

/** The URL of every table row in the body of a quarantine issue: the second cell of `| status | url | title | product |`. */
export function quarantineUrlsOfIssueBody(body) {
  const urls = [];
  for (const line of String(body ?? "").split(/\r?\n/)) {
    const m = line.match(/^\|\s*[^|]*?\s*\|\s*(https?:\/\/[^\s|]+)\s*\|/);
    if (m) urls.push(m[1]);
  }
  return urls;
}

/** A Map of URL -> the numbers of the quarantine issues that listed it, from a list of { number, title, body } issues of any state. */
export function reportedQuarantineUrls(issues) {
  const reported = new Map();
  for (const issue of issues ?? []) {
    if (!QUARANTINE_ISSUE_TITLE.test(String(issue.title ?? "").trim())) continue;
    for (const url of quarantineUrlsOfIssueBody(issue.body)) {
      const numbers = reported.get(url) ?? [];
      if (!numbers.includes(issue.number)) numbers.push(issue.number);
      reported.set(url, numbers.sort((a, b) => a - b));
    }
  }
  return reported;
}

/** The file the workflow hands to the sync: one `url<TAB>number,number` line per reported URL, sorted. */
export function serializeReportedUrls(reported) {
  return [...reported.keys()]
    .sort()
    .map((url) => `${url}\t${reported.get(url).join(",")}`)
    .join("\n")
    .concat(reported.size ? "\n" : "");
}

/** The inverse of serializeReportedUrls. A line that is not `url<TAB>numbers` is ignored. */
export function parseReportedUrls(text) {
  const reported = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [url, numbers = ""] = line.split("\t");
    if (!/^https?:\/\//.test(url ?? "")) continue;
    reported.set(
      url,
      numbers
        .split(",")
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0)
    );
  }
  return reported;
}

/** The newly quarantined records an earlier issue did not list (`fresh`) and those it did (`repeated`, with the issue numbers). */
export function splitReported(records, reported) {
  const fresh = [];
  const repeated = [];
  for (const record of records) {
    const issues = reported.get(record.url);
    if (issues) repeated.push({ record, issues });
    else fresh.push(record);
  }
  return { fresh, repeated };
}
