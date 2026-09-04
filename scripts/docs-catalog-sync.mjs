#!/usr/bin/env node
/**
 * Build a local cache of Microsoft Learn documentation pages (title, url,
 * product, subproduct, description) for AI-assisted content research — the
 * docs-portal equivalent of learn-catalog.json, which only covers training
 * modules.
 *
 * Usage:
 *   node scripts/docs-catalog-sync.mjs
 *
 * Data source: git clone (blobless, sparse, shallow) of each repo in REPOS.
 * Output: data/docs-catalog.json
 *
 * Adding a repo: find its .openpublishing.publish.config.json on GitHub for
 * docsets_to_publish[].build_source_folder, then VERIFY the real live base
 * URL against a sample page fetch. build_output_subfolder is often an
 * internal-only alias, not the public URL segment — confirmed mismatches
 * seen so far: entra-docs ("entra-docs" -> real "entra"), fabric-docs
 * ("fabric-docs" -> real "fabric"), windowsserverdocs
 * ("WindowsServerDocs-VSTS" -> real "windows-server"), and multiple
 * defender-docs docsets (see comments below). Never trust the config
 * literally — spot-check before adding a new repo or docset.
 *
 * Link checking: after building the catalog, every NEW/changed URL (vs. the
 * previous run's file, capped at LINK_CHECK_MAX_NEW per run) is checked,
 * plus a bounded random sample of unchanged existing URLs (to catch
 * upstream drift, e.g. Microsoft renaming or moving a page) — checking all
 * ~75k entries every run isn't feasible, learn.microsoft.com aggressively
 * 429s above ~3 concurrent requests, so a full pass would take 20+ hours.
 * At the current sample size the whole catalog cycles roughly once a year
 * across weekly runs. Only DEFINITIVE failures (HTTP 404/410) are
 * quarantined: the URL is pulled out of docs-catalog.json and appended to
 * docs-catalog-invalid.json instead of failing the run, so dead pages stay
 * out of normal research queries and pile up for a periodic manual/agent
 * triage pass instead of paging on every dead link. Transient outcomes
 * (timeouts, network errors, 5xx, persistent 429) are logged and skipped —
 * the entry stays in the catalog and will get re-sampled on a later run —
 * so a rate-limit burst can't poison the quarantine file with false
 * positives. Every already-quarantined URL is re-checked each run (the list
 * is small, so this is nearly free): a record that now resolves is
 * auto-released back into the catalog, and `lastChecked` is kept truthful
 * on the ones that stay. Only a repo clone/parse failure fails the run
 * (still opens a CI issue).
 *
 * Resilience: if a repo's clone/parse fails, the previous catalog's entries
 * under that repo's URL prefixes are carried forward instead of silently
 * vanishing for a week (which would also make them all count as "new" and
 * blow the link-check budget on the next successful run). A whole-catalog
 * duplicate-URL audit also runs every time (the manual version of this
 * check is how the Dynamics 365 baseUrlPath bug was originally caught):
 * duplicates are deduplicated with a loud warning, and the run fails if
 * they exceed DUPLICATE_URL_FAIL_THRESHOLD (a systemic mapping bug).
 *
 * Newly-quarantined URLs (i.e. broken *this* run, not the pre-existing
 * backlog) also get a Markdown report written to QUARANTINE_REPORT_FILE
 * (data/docs-catalog-invalid.json's newest additions, with an AI-agent
 * research/fix prompt) plus a `new_quarantine_count` line appended to
 * $GITHUB_OUTPUT when running in CI, so the workflow can open an
 * investigate-and-fix issue without re-reporting the same backlog weekly.
 * If a single run quarantines more than QUARANTINE_SURGE_THRESHOLD URLs at
 * once, the report calls that out as a likely rate-limit/network false
 * positive rather than presenting it as N genuinely dead pages.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  cleanTitle,
  stripLiquidTags,
  buildUrl,
  resolveBaseUrlPath,
  shuffleSample,
  findDuplicateUrls,
  repoUrlPrefixes,
  buildQuarantineReport,
} from "./lib/docs-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const OUTPUT_FILE = join(root, "data", "docs-catalog.json");
const INVALID_OUTPUT_FILE = join(root, "data", "docs-catalog-invalid.json"); // quarantined (confirmed-broken) URLs, excluded from OUTPUT_FILE
const MIN_ENTRIES = 20000; // failsafe: abort write if far below expected scale (systemic breakage, not one repo's hiccup)

// Written only when this run quarantines at least one NEW URL (see bottom of file) -- lets
// the CI workflow open a "please investigate" issue without re-reporting the existing
// backlog every week. Override via env var for local testing; defaults to an OS temp path
// so nothing generated ends up inside the repo working tree.
const QUARANTINE_REPORT_FILE = process.env.QUARANTINE_REPORT_FILE || join(tmpdir(), "docs-catalog-quarantine-report.md");

// If a single run quarantines more than this many URLs at once, it's far more likely a
// transient rate-limit/network hiccup against learn.microsoft.com during the link check than
// that many pages genuinely breaking simultaneously (based on the single-digit-per-week norm
// observed so far) -- buildQuarantineReport() calls this out explicitly instead of silently
// asking an agent to individually investigate a possibly-false-positive batch.
const QUARANTINE_SURGE_THRESHOLD = 20;

// More duplicate URLs than this means a systemic REPOS mapping bug (two targets claiming
// the same URL namespace), not a stray upstream collision -- abort instead of publishing
// a catalog full of wrong-but-well-formed URLs. Small counts are deduped with a warning.
const DUPLICATE_URL_FAIL_THRESHOLD = 50;

// Link-check tuning: see header note above for why this can't check everything every run.
const LINK_CHECK_SAMPLE_SIZE = 1500; // random sample of unchanged existing entries per run
const LINK_CHECK_MAX_NEW = 2000; // cap on new/changed URLs checked per run; the spill-over enters the catalog unchecked and gets sampled on later runs
const LINK_CHECK_CONCURRENCY = 3; // learn.microsoft.com 429s aggressively above this
const LINK_CHECK_TIMEOUT_MS = 15000;
const LINK_CHECK_MAX_RETRIES = 4;
const LINK_CHECK_PER_WORKER_DELAY_MS = 500;

// Each entry: one repo, cloned once, walked across one or more docsets
// ("targets"). baseUrlPath is the VERIFIED live URL segment (see header
// note) -- not necessarily the docset's build_output_subfolder.
const REPOS = [
  {
    name: "azure-docs",
    repoUrl: "https://github.com/MicrosoftDocs/azure-docs.git",
    targets: [{ sourceFolder: "articles", baseUrlPath: "azure" }],
  },
  {
    name: "entra-docs",
    repoUrl: "https://github.com/MicrosoftDocs/entra-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "entra" }],
  },
  {
    name: "fabric-docs",
    repoUrl: "https://github.com/MicrosoftDocs/fabric-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "fabric" }],
  },
  {
    name: "sql-docs",
    repoUrl: "https://github.com/MicrosoftDocs/sql-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "sql" }],
  },
  {
    name: "power-platform",
    repoUrl: "https://github.com/MicrosoftDocs/power-platform.git",
    // repo also has a "project-sophia"/ps-docs docset -- unrelated internal project, excluded
    targets: [{ sourceFolder: "power-platform", baseUrlPath: "power-platform" }],
  },
  {
    name: "memdocs",
    repoUrl: "https://github.com/MicrosoftDocs/memdocs.git",
    targets: [
      { sourceFolder: "intune", baseUrlPath: "intune" },
      { sourceFolder: "autopilot", baseUrlPath: "autopilot" },
    ],
  },
  {
    name: "windowsserverdocs",
    repoUrl: "https://github.com/MicrosoftDocs/windowsserverdocs.git",
    targets: [{ sourceFolder: "WindowsServerDocs", baseUrlPath: "windows-server" }],
  },
  {
    name: "defender-docs",
    repoUrl: "https://github.com/MicrosoftDocs/defender-docs.git",
    // repo also has an "advanced-threat-analytics" (ATA) docset -- legacy/retired product, superseded by defender-for-identity, excluded
    targets: [
      { sourceFolder: "defender-endpoint", baseUrlPath: "defender-endpoint" },
      { sourceFolder: "defender-for-cloud-apps", baseUrlPath: "defender-cloud-apps" },
      { sourceFolder: "defender-xdr", baseUrlPath: "defender-xdr" },
      { sourceFolder: "defender-business", baseUrlPath: "defender-business" },
      { sourceFolder: "defender-office-365", baseUrlPath: "defender-office-365" },
      { sourceFolder: "defender-vulnerability-management", baseUrlPath: "defender-vulnerability-management" },
      { sourceFolder: "defender-for-identity", baseUrlPath: "defender-for-identity" },
      { sourceFolder: "defender-for-cloud", baseUrlPath: "azure/defender-for-cloud" },
      { sourceFolder: "sentinel", baseUrlPath: "azure/sentinel" },
      { sourceFolder: "easm", baseUrlPath: "azure/external-attack-surface-management" },
      { sourceFolder: "exposure-management", baseUrlPath: "security-exposure-management" },
      { sourceFolder: "unified-secops-platform", baseUrlPath: "unified-secops-platform" },
      {
        sourceFolder: "defender",
        baseUrlPath: "unified-secops",
        pathMappings: [{ sourcePath: "threat-intelligence", baseUrlPath: "defender/threat-intelligence" }],
      },
      { sourceFolder: "defender-for-iot-azure", baseUrlPath: "azure/defender-for-iot" },
      { sourceFolder: "defender-for-iot", baseUrlPath: "defender-for-iot" },
    ],
  },
  {
    // medium tier: single repo, but narrower in scope than its name implies -- see AGENTS.md
    name: "microsoft-365-docs",
    repoUrl: "https://github.com/MicrosoftDocs/microsoft-365-docs.git",
    targets: [
      { sourceFolder: "microsoft-365", baseUrlPath: "microsoft-365" },
      // canonicalUrl resolves under microsoft-365/copilot, NOT the docset's own "microsoft-365-copilot" alias
      { sourceFolder: "copilot", baseUrlPath: "microsoft-365/copilot" },
    ],
  },
  // hard tier: Dynamics 365, fragmented across many separate repos (one per product area).
  // Almost all collapse to a single target under dynamics365/ -- product-specific folder
  // names (sales/, customer-service/, finance/, supply-chain/, etc.) are already embedded
  // in each repo and become the URL segment directly, same pattern as azure-docs.
  // Excluded as legacy/retired (no current cert relevance, docs frozen or product retired):
  // msftdynamicsgpdocs (Dynamics GP), DynamicsAX2012-technet/-msdn (AX 2012), nav-content
  // (Dynamics NAV, predecessor to Business Central), dynamics365-docs-templates (archived
  // template repo, no content), dynamics-365-supply-chain-insights (stale since 2022,
  // folded into dynamics-365-unified-operations-public), dynamics-365-ai (stale since Nov
  // 2024, superseded by per-app Copilot content). dynamics-365-fraud-protection is excluded
  // too: confirmed via its own docs (includes/deprecation.md) that support ended Feb 3,
  // 2026 and the product is no longer purchasable -- it no longer appears in the live
  // Dynamics 365 documentation hub. dynamics365-industry-solutions has no publish config;
  // it's a community repo, not a docs source.
  {
    name: "dynamics-365-customer-engagement",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-customer-engagement.git",
    targets: [{ sourceFolder: "ce", baseUrlPath: "dynamics365" }],
  },
  {
    name: "dynamics-365-unified-operations-public",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-unified-operations-public.git",
    targets: [{ sourceFolder: "articles", baseUrlPath: "dynamics365" }],
  },
  {
    name: "dynamics365smb-docs",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics365smb-docs.git",
    targets: [{ sourceFolder: "business-central", baseUrlPath: "dynamics365/business-central" }],
  },
  {
    name: "dynamics365smb-devitpro-pb",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics365smb-devitpro-pb.git",
    targets: [{ sourceFolder: "dev-itpro", baseUrlPath: "dynamics365/business-central/dev-itpro" }],
  },
  {
    name: "dynamics-365-project-operations",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-project-operations.git",
    targets: [{ sourceFolder: "articles", baseUrlPath: "dynamics365/project-operations" }],
  },
  {
    name: "dynamics-365-contact-center",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-contact-center.git",
    targets: [{ sourceFolder: "contact-center", baseUrlPath: "dynamics365/contact-center" }],
  },
  {
    // Dynamics 365 Guides and Remote Assist retire Dec 31, 2026 -- still live, revisit after that date
    name: "dynamics-365-mixed-reality",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-mixed-reality.git",
    // real live segment is "mixed-reality", NOT the "mr-docs" folder name
    targets: [{ sourceFolder: "mr-docs", baseUrlPath: "dynamics365/mixed-reality" }],
  },
  {
    name: "dynamics-365-intelligent-order-management",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics-365-intelligent-order-management.git",
    targets: [{ sourceFolder: "topics", baseUrlPath: "dynamics365/intelligent-order-management" }],
  },
  {
    name: "dynamics365-guidance",
    repoUrl: "https://github.com/MicrosoftDocs/dynamics365-guidance.git",
    targets: [{ sourceFolder: "guidance", baseUrlPath: "dynamics365/guidance" }],
  },
  {
    // Copilot extensibility/developer docs (declarative agents, plugins, adaptive cards) --
    // a separate repo from microsoft-365-docs' own copilot/ folder (agent-essentials,
    // copilot-control-system). Both share the microsoft-365/copilot/ URL prefix but with
    // no overlapping subfolders, so no duplicate entries.
    name: "m365copilot-docs",
    repoUrl: "https://github.com/MicrosoftDocs/m365copilot-docs.git",
    targets: [{ sourceFolder: "docs", baseUrlPath: "microsoft-365/copilot/extensibility" }],
  },
  {
    // Different org (github, not MicrosoftDocs), different domain, and a Next.js-based
    // pipeline instead of docfx -- frontmatter uses "intro" instead of "description" and
    // has no ms.service/ms.subservice equivalent, so "product" is derived from the
    // top-level content/ folder name instead (e.g. "actions", "copilot", "codespaces").
    // No locale prefix needed -- docs.github.com/<path> resolves the same as /en/<path>.
    name: "github-docs",
    repoUrl: "https://github.com/github/docs.git",
    domain: "docs.github.com",
    descriptionField: "intro",
    productFromPath: true,
    targets: [{ sourceFolder: "content", baseUrlPath: "" }],
  },
  {
    // Public sync of SupportArticles-docs-pr. Its top-level "support" folder is the
    // entire source for the learn.microsoft.com/troubleshoot/... URL namespace across
    // many products (folder name "support" -> URL segment "troubleshoot", verified via
    // two live pages' original_content_git_url/source_path, e.g.
    // support/azure/private-link/troubleshoot-private-endpoint-connectivity-problems.md
    // -> troubleshoot/azure/private-link/troubleshoot-private-endpoint-connectivity-problems).
    // The repo also has separate top-level Exchange/Microsoft365/Office/Outlook/SharePoint/
    // SkypeForBusiness/Teams/Viva folders -- out of scope for now (those products' admin
    // docs were already confirmed closed in the Docs Catalog Cache notes; revisit
    // separately if their troubleshooting content is wanted too).
    name: "SupportArticles-docs",
    repoUrl: "https://github.com/MicrosoftDocs/SupportArticles-docs.git",
    targets: [{ sourceFolder: "support", baseUrlPath: "troubleshoot" }],
  },
];

const SKIP_DIRS = new Set(["includes", "media", "_themes", "breadcrumb", "archive"]);

// --- Link checking helpers ---

// Outcome classification:
//   ok        -- 2xx/3xx, page resolves.
//   definitive broken (404/410) -- the only outcomes that quarantine a URL.
//   transient -- timeouts, network errors, 5xx, persistent 429, or any other
//                status: logged and skipped, NEVER quarantined (the entry stays
//                in the catalog and gets re-sampled on a later run), so a
//                rate-limit burst can't poison the quarantine file.
async function checkUrlStatus(url) {
  for (let attempt = 0; attempt <= LINK_CHECK_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      clearTimeout(timer);
      if (res.body) res.body.cancel().catch(() => {}); // drain without downloading the full page
      if (res.status === 429 && attempt < LINK_CHECK_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 5000 * Math.pow(2, attempt)));
        continue;
      }
      const ok = res.status >= 200 && res.status < 400;
      const definitivelyBroken = res.status === 404 || res.status === 410;
      return { url, status: res.status, ok, transient: !ok && !definitivelyBroken };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < LINK_CHECK_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return { url, status: null, ok: false, transient: true, error: String(err.message || err) };
    }
  }
}

async function checkUrls(urls) {
  const results = [];
  let idx = 0;
  let done = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < urls.length) {
      const url = urls[idx++];
      results.push(await checkUrlStatus(url));
      done++;
      if (done % 100 === 0 || done === urls.length) {
        console.log(`  Link check progress: ${done}/${urls.length} (${((Date.now() - t0) / 1000).toFixed(0)}s elapsed)`);
      }
      await new Promise((r) => setTimeout(r, LINK_CHECK_PER_WORKER_DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: LINK_CHECK_CONCURRENCY }, () => worker()));
  return results;
}

function loadPreviousEntries() {
  try {
    return JSON.parse(readFileSync(OUTPUT_FILE, "utf-8")); // the OLD file's entries, read before overwriting
  } catch {
    return []; // no previous file (or unreadable) -- treat everything as new
  }
}

function loadInvalidUrls() {
  try {
    const prev = JSON.parse(readFileSync(INVALID_OUTPUT_FILE, "utf-8"));
    return new Map(prev.map((e) => [e.url, e]));
  } catch {
    return new Map(); // no previous file (or unreadable) -- nothing quarantined yet
  }
}

function cloneRepo(repo, targetDir) {
  console.log(`  Cloning ${repo.name} (blobless, sparse, shallow)...`);
  const t0 = Date.now();
  execSync(
    `git clone --filter=blob:none --sparse --depth 1 --no-checkout --quiet ${repo.repoUrl} "${targetDir}"`,
    { stdio: "inherit" }
  );
  const sparsePaths = repo.targets
    .flatMap((t) => [`"${t.sourceFolder}/**/*.md"`, `"${t.sourceFolder}/*.md"`])
    .join(" ");
  execSync(`git sparse-checkout set --no-cone ${sparsePaths}`, { cwd: targetDir, stdio: "inherit" });
  execSync(`git checkout --quiet`, { cwd: targetDir, stdio: "inherit" }); // no branch arg: resolves to each repo's actual default branch (not always "main")
  console.log(`  Clone + checkout took ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function walkMarkdownFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(fullPath, results);
    } else if (entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }
  return results;
}

function processRepo(repo, entries) {
  const domain = repo.domain || "learn.microsoft.com";
  const descriptionField = repo.descriptionField || "description";
  const tmpDir = mkdtempSync(join(tmpdir(), "docs-catalog-"));
  try {
    cloneRepo(repo, tmpDir);
    for (const target of repo.targets) {
      const sourceRoot = join(tmpDir, target.sourceFolder);
      const files = walkMarkdownFiles(sourceRoot);
      let added = 0;
      for (const file of files) {
        const content = readFileSync(file, "utf-8");
        const fm = parseFrontmatter(content);
        if (!fm || !fm.title || /\bNOINDEX\b/i.test(fm.ROBOTS || "")) continue;
        const rel = relative(sourceRoot, file).replace(/\\/g, "/");
        entries.push({
          title: cleanTitle(stripLiquidTags(fm.title) || fm.title),
          url: buildUrl(file, sourceRoot, resolveBaseUrlPath(target, rel), domain),
          product: repo.productFromPath ? rel.split("/")[0] : fm["ms.service"] || null,
          subproduct: repo.productFromPath ? null : fm["ms.subservice"] || null,
          description: stripLiquidTags(fm[descriptionField]),
        });
        added++;
      }
      console.log(`  ${target.sourceFolder}/ -> ${target.baseUrlPath}/ (${added} entries)`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

const entries = [];
const failedRepos = [];

for (const repo of REPOS) {
  console.log(`\n${repo.name}:`);
  try {
    processRepo(repo, entries);
  } catch (err) {
    console.error(`  FAILED: ${err.message}`);
    failedRepos.push(repo.name);
  }
}

console.log(`\nTotal entries: ${entries.length}`);
if (failedRepos.length) console.log(`Repos that failed: ${failedRepos.join(", ")}`);

const previousEntries = loadPreviousEntries(); // the OLD catalog, read before overwriting it
const previousUrls = new Set(previousEntries.map((e) => e.url));
const invalidMap = loadInvalidUrls(); // url -> quarantine record, from the OLD quarantine file

// --- Carry-forward: a failed repo's entries shouldn't silently vanish for a week ---
// Dropping them would also make every one of them count as "new/changed" on the next
// successful run and blow the link-check budget. Carry the previous catalog's entries
// under the failed repo's URL prefixes forward instead (skipping any URL another repo
// already produced this run -- e.g. the Dynamics 365 repos share the dynamics365/ prefix).
if (failedRepos.length) {
  const failedPrefixes = REPOS.filter((r) => failedRepos.includes(r.name)).flatMap(repoUrlPrefixes);
  const currentUrls = new Set(entries.map((e) => e.url));
  const carried = previousEntries.filter(
    (e) => !currentUrls.has(e.url) && failedPrefixes.some((p) => e.url.startsWith(p))
  );
  if (carried.length) {
    console.log(`Carrying forward ${carried.length} entries from the previous catalog for failed repo(s): ${failedRepos.join(", ")}`);
    entries.push(...carried);
  }
}

// --- Duplicate-URL audit: two entries claiming one URL means a wrong REPOS mapping ---
// (The manual version of this check is how the Dynamics 365 baseUrlPath bug was caught.)
const duplicates = findDuplicateUrls(entries);
let dedupedEntries = entries;
if (duplicates.length) {
  console.error(`\nWARNING: ${duplicates.length} URL(s) are claimed by more than one entry:`);
  for (const { url, entries: dupes } of duplicates.slice(0, 20)) {
    console.error(`  ${url}`);
    for (const d of dupes) console.error(`    - "${d.title}" (product: ${d.product})`);
  }
  if (duplicates.length > 20) console.error(`  ...and ${duplicates.length - 20} more.`);
  if (duplicates.length > DUPLICATE_URL_FAIL_THRESHOLD) {
    console.error(
      `Aborting write: ${duplicates.length} duplicate URLs exceeds the threshold of ${DUPLICATE_URL_FAIL_THRESHOLD} -- ` +
        "this looks like a systemic REPOS mapping bug (two targets claiming the same URL namespace), not upstream noise."
    );
    process.exit(1);
  }
  // Small counts: keep the first entry per URL and continue, but leave the warning above in the logs.
  const seen = new Set();
  dedupedEntries = entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
  console.error(`Deduplicated ${entries.length - dedupedEntries.length} entries (kept the first occurrence of each URL).`);
}

if (dedupedEntries.length < MIN_ENTRIES) {
  console.error(`Aborting write: only ${dedupedEntries.length} entries, expected at least ${MIN_ENTRIES}.`);
  process.exit(1);
}

// --- Quarantine re-check: auto-release restored pages, keep lastChecked truthful ---
// The quarantine list is small (tens of records), so re-checking all of it every run is
// nearly free and removes the manual-cleanup step for pages Microsoft restores or that
// were quarantined before the transient-vs-definitive distinction existed.
const today = new Date().toISOString().slice(0, 10);
const releasedUrls = new Set();
if (invalidMap.size) {
  console.log(`\nRe-checking ${invalidMap.size} quarantined URL(s)...`);
  const quarantineResults = await checkUrls([...invalidMap.keys()]);
  for (const r of quarantineResults) {
    const record = invalidMap.get(r.url);
    if (r.ok) {
      invalidMap.delete(r.url);
      releasedUrls.add(r.url);
      console.log(`  RELEASED (now ${r.status}): ${r.url}`);
    } else if (!r.transient) {
      record.status = r.status;
      record.lastChecked = today; // still definitively broken -- keep the record honest
    }
    // transient outcome: leave the record untouched, try again next run
  }
  if (releasedUrls.size) console.log(`  Released ${releasedUrls.size} restored URL(s) back into the catalog.`);
}

// Still-quarantined URLs stay excluded from the catalog; released ones re-enter naturally.
const cleanEntries = dedupedEntries.filter((e) => !invalidMap.has(e.url));
if (dedupedEntries.length !== cleanEntries.length) {
  console.log(`Excluded ${dedupedEntries.length - cleanEntries.length} still-quarantined URL(s) from the catalog.`);
}

// --- Link check: new/changed URLs (capped), plus a random sample of existing ones ---
// Released URLs were just verified OK above -- no need to re-check them as "new".
const newEntries = cleanEntries.filter((e) => !previousUrls.has(e.url) && !releasedUrls.has(e.url));
const cappedNew = newEntries.length > LINK_CHECK_MAX_NEW ? shuffleSample(newEntries, LINK_CHECK_MAX_NEW) : newEntries;
if (cappedNew.length < newEntries.length) {
  console.log(
    `Capping new-URL link checks at ${LINK_CHECK_MAX_NEW} of ${newEntries.length} -- the rest enter the catalog unchecked and get sampled on later runs.`
  );
}
const existingEntries = cleanEntries.filter((e) => previousUrls.has(e.url));
const sampled = shuffleSample(existingEntries, LINK_CHECK_SAMPLE_SIZE);
const toCheck = [...new Map([...cappedNew, ...sampled].map((e) => [e.url, e])).values()];

console.log(
  `\nLink check: ${toCheck.length} URL(s) (${cappedNew.length} new/changed, ${sampled.length} sampled from ${existingEntries.length} existing)...`
);
const linkResults = await checkUrls(toCheck.map((e) => e.url));
const broken = linkResults.filter((r) => !r.ok && !r.transient); // only definitive 404/410 quarantines
const transient = linkResults.filter((r) => !r.ok && r.transient);
if (transient.length) {
  console.warn(`\nLink check: ${transient.length} transient failure(s) (timeout/network/5xx/429) -- NOT quarantined, will re-sample later:`);
  for (const t of transient.slice(0, 10)) console.warn(`  [${t.status ?? t.error ?? "ERR"}] ${t.url}`);
  if (transient.length > 10) console.warn(`  ...and ${transient.length - 10} more.`);
}

let finalEntries = cleanEntries;
const newlyQuarantined = []; // this run's additions only, not the pre-existing backlog -- drives the CI issue below
if (broken.length) {
  const byUrl = new Map(toCheck.map((e) => [e.url, e]));
  const brokenUrls = new Set(broken.map((b) => b.url));
  finalEntries = cleanEntries.filter((e) => !brokenUrls.has(e.url));

  console.error(`\nLink check found ${broken.length} definitively broken URL(s) -- quarantining:`);
  for (const b of broken) {
    const entry = byUrl.get(b.url);
    console.error(`  [${b.status}] ${b.url} -- "${entry.title}"`);
    const record = { ...entry, status: b.status, firstDetected: today, lastChecked: today };
    invalidMap.set(b.url, record);
    newlyQuarantined.push(record);
  }
} else {
  console.log("Link check: all checked URLs resolved OK (or failed only transiently).");
}

// Sort by URL for a deterministic file: stable diffs between refreshes regardless of
// REPOS order or directory-walk order, and duplicate inspection becomes trivial.
finalEntries.sort((a, b) => a.url.localeCompare(b.url));

const serialized = JSON.stringify(finalEntries);
writeFileSync(OUTPUT_FILE, serialized);
console.log(`\nWrote ${OUTPUT_FILE} (${(Buffer.byteLength(serialized) / 1024 / 1024).toFixed(1)} MB, ${finalEntries.length} entries)`);

const invalidSorted = [...invalidMap.values()].sort((a, b) => a.url.localeCompare(b.url));
writeFileSync(INVALID_OUTPUT_FILE, JSON.stringify(invalidSorted, null, 2));
console.log(`Wrote ${INVALID_OUTPUT_FILE} (${invalidSorted.length} quarantined URL(s) total)`);

if (newlyQuarantined.length) {
  writeFileSync(QUARANTINE_REPORT_FILE, buildQuarantineReport(newlyQuarantined, { surgeThreshold: QUARANTINE_SURGE_THRESHOLD }));
  console.log(
    `Wrote ${QUARANTINE_REPORT_FILE} (${newlyQuarantined.length} newly quarantined URL(s), for CI issue creation)`
  );
  // Consumed by the calling workflow to gate "open an investigate-and-fix issue" on this
  // run having found something NEW, instead of re-reporting the existing backlog weekly.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `new_quarantine_count=${newlyQuarantined.length}\n`);
  }
}

if (failedRepos.length) process.exit(1); // only a repo clone/parse failure fails the run now; quarantining is a normal, self-managed outcome
