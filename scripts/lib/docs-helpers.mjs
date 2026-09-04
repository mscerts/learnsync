/**
 * Pure helper functions for scripts/docs-catalog-sync.mjs, extracted so they
 * can be unit-tested with node:test (see test/docs-helpers.test.mjs) without
 * running the full sync. No I/O, no network — keep it that way.
 */

import { relative } from "node:path";

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

export function buildUrl(filePath, sourceRoot, baseUrlPath, domain) {
  const rel = relative(sourceRoot, filePath)
    .replace(/\\/g, "/")
    .replace(/\.md$/, "")
    .replace(/(^|\/)index$/, ""); // index.md is a directory's own landing page, not a literal "/index" URL segment
  return baseUrlPath ? `https://${domain}/${baseUrlPath}/${rel}` : `https://${domain}/${rel}`;
}

export function resolveBaseUrlPath(target, relativePath) {
  const mapping = target.pathMappings?.find(
    ({ sourcePath }) => relativePath === sourcePath || relativePath.startsWith(`${sourcePath}/`)
  );
  return mapping?.baseUrlPath || target.baseUrlPath;
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
export function buildQuarantineReport(records, { context = "run", surgeThreshold = 20 } = {}) {
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;

  const escapeCell = (s) => String(s ?? "-").replace(/\|/g, "\\|");
  const table = records
    .map((e) => `| ${escapeCell(e.status)} | ${escapeCell(e.url)} | ${escapeCell(e.title)} | ${escapeCell(e.product)} |`)
    .join("\n");

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
    "## Prompt for an AI coding agent",
    "",
    "You're working in the `mscerts/learnsync` repo. For each URL listed above:",
    "",
    "1. **Diagnose.** Fetch the live page anyway (or search for its likely current",
    "   title/topic) and read its own frontmatter `original_content_git_url` \u2014 it names the",
    "   exact real source repo and file path, which is far more reliable than guessing a",
    "   renamed slug (see AGENTS.md's \"Verification technique for a 404'd cached URL\").",
    "2. **Classify** each URL as one of:",
    "   - **Moved within an already-tracked repo** \u2014 the source file still exists, just",
    "     under a different `sourceFolder`/`baseUrlPath` mapping than `REPOS` in",
    "     `scripts/docs-catalog-sync.mjs` currently assumes. Fix the mapping.",
    "   - **Moved to a new, not-yet-tracked repo** \u2014 Microsoft has split content out of a",
    "     monolithic repo before (e.g. `azure-compute-docs`/`azure-management-docs` splitting",
    "     out of `azure-docs` \u2014 see AGENTS.md). Add a new `REPOS` entry, following the",
    "     \"Adding a repo\" guidance in this script's header comment \u2014 always verify",
    "     `baseUrlPath` against a live page fetch, never trust",
    "     `.openpublishing.publish.config.json` literally.",
    "   - **Genuinely retired/removed** \u2014 the page or product no longer exists anywhere. No",
    "     script change needed; leave its record in `data/docs-catalog-invalid.json` as-is.",
    "3. **Fix the script** for any URL in the first two categories, then run",
    "   `node scripts/docs-catalog-sync.mjs` locally to confirm the fixed URL(s) resolve and",
    "   are no longer quarantined.",
    "4. **Clean up.** Remove the resolved URL's record(s) from",
    "   `data/docs-catalog-invalid.json` (the next scheduled sync won't re-add a URL that now",
    "   passes its link check).",
    "5. **Open a pull request** with the script fix and quarantine cleanup, referencing this",
    "   issue.",
    "",
    "If you're not confident about the right classification or fix for a given URL, don't",
    "guess \u2014 leave a comment on this issue asking for clarification instead of committing a",
    "speculative change.",
    "",
  ].join("\n");
}
