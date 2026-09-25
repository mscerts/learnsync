#!/usr/bin/env node
/**
 * Build a local cache of Microsoft Learn documentation pages (title, url, product,
 * subproduct, description, lastmod) for AI-assisted content research -- the docs-portal
 * equivalent of learn-catalog.json, which only covers training modules.
 *
 * Usage:
 *   node scripts/docs-catalog-sync.mjs
 *   DRY_RUN=1 node scripts/docs-catalog-sync.mjs          # discovery + plan only, writes nothing
 *   FULL_DISCOVERY=1 node scripts/docs-catalog-sync.mjs   # re-scan every en-us sitemap family
 *   MAX_PAGE_FETCHES=50000 node scripts/docs-catalog-sync.mjs  # one-off local backfill
 *   SKIP_GIT_SOURCES=1 ...                                  # don't clone github/docs (local testing)
 *
 * Data source (since 2026-09): learn.microsoft.com itself, NOT MicrosoftDocs/* git repos.
 * Microsoft Learn announced on 2026-09-23 that it is retiring most public documentation
 * repos by the end of December 2026, and a retired repo becomes invisible to the public
 * (clones fail). So:
 *
 *   1. URL discovery: learn.microsoft.com/_sitemaps/sitemapindex.xml -> the en-us child
 *      sitemaps -> every <loc> under the include prefixes in LEARN_SCOPE, each with a
 *      per-URL <lastmod>. Sitemap files are named <family>_<locale>_<n>.xml; which families
 *      contain in-scope URLs is remembered in data/docs-sitemap-families.json so a normal
 *      weekly run only downloads relevant families (plus any family it has never seen).
 *   2. Change detection: a page is (re)fetched only if it's new or its <lastmod> differs
 *      from the lastmod stored on its catalog record. Existing records WITHOUT a lastmod
 *      (everything built by the old git-based script) adopt the sitemap's lastmod on the
 *      first run instead of being refetched, so the migration costs ~0 page fetches.
 *   3. Metadata: for each queued page, GET the HTML and read only the <head>: <title>,
 *      meta description, ms.service, ms.subservice -- the same docfx metadata the repo
 *      frontmatter used to provide. Capped at MAX_PAGE_FETCHES per run; spill-over is
 *      picked up on later runs (changed pages keep their old record meanwhile).
 *   4. Removal detection: a previously cataloged URL that's no longer in any sitemap is
 *      checked live. 404/410 -> quarantined (same model as before). Redirect to another
 *      page -> dropped as "moved" (its new URL arrives via the sitemap). 200 -> kept.
 *
 * docs.github.com is NOT a Microsoft Learn repo and isn't covered by the retirement, so
 * it's still read from the open-source github/docs repo via GIT_SOURCES below.
 *
 * Quarantine model, CI issue report, and $GITHUB_OUTPUT contract are unchanged.
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
  resolveTarget,
  findDuplicateUrls,
  repoUrlPrefixes,
  buildQuarantineReport,
} from "./lib/docs-helpers.mjs";
import {
  parseSitemapIndex,
  parseUrlset,
  isSitemapIndex,
  sitemapFamily,
  normalizeLearnUrl,
  inScope,
  scopeOf,
  dedupeByUrl,
  parseHeadMeta,
  isNoIndex,
  recordFromHead,
} from "./lib/sitemap-helpers.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const OUTPUT_FILE = join(root, "data", "docs-catalog.json");
const INVALID_OUTPUT_FILE = join(root, "data", "docs-catalog-invalid.json");
const FAMILIES_FILE = join(root, "data", "docs-sitemap-families.json");
const QUARANTINE_REPORT_FILE = process.env.QUARANTINE_REPORT_FILE || join(tmpdir(), "docs-catalog-quarantine-report.md");

const DRY_RUN = process.env.DRY_RUN === "1";
const FULL_DISCOVERY = process.env.FULL_DISCOVERY === "1";
const SKIP_GIT_SOURCES = process.env.SKIP_GIT_SOURCES === "1"; // local testing: carry git-sourced entries forward without cloning

const MIN_ENTRIES = 20000; // failsafe: abort write if far below expected scale
const SITEMAP_SANITY_RATIO = 0.5; // abort if sitemaps yield < 50% of the previous catalog's Learn URLs (sitemap outage, not real removals)
const QUARANTINE_SURGE_THRESHOLD = 20;
const DUPLICATE_URL_FAIL_THRESHOLD = 50;

const MAX_PAGE_FETCHES = Number(process.env.MAX_PAGE_FETCHES || 6000); // new/changed pages per run
const MAX_MISSING_CHECKS = Number(process.env.MAX_MISSING_CHECKS || 2000); // dropped-from-sitemap URLs per run
const FETCH_CONCURRENCY = 3; // learn.microsoft.com 429s aggressively above this
const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_RETRIES = 4;
const PER_WORKER_DELAY_MS = 500;
const HEAD_READ_LIMIT_BYTES = 512 * 1024; // stop reading once </head> is seen, or at this cap
const USER_AGENT = "learnsync/2.0 (+https://github.com/mscerts/learnsync; weekly docs metadata cache)";

const SITEMAP_INDEX_URL = "https://learn.microsoft.com/_sitemaps/sitemapindex.xml";
const SITEMAP_LOCALE = "en-us";

// Which learn.microsoft.com paths the catalog covers. The include list is the union of every
// baseUrlPath the old git-based REPOS config published to, so nothing previously cataloged
// falls out of scope. Because it's now prefix-based rather than repo-based, coverage GROWS:
// e.g. all of microsoft-365/ (incl. the admin docs that never had a public repo), all of
// troubleshoot/, and azure/ content published from repos we never cloned
// (architecture center, CAF, WAF, devops). Use `exclude` to trim anything unwanted -- run
// with DRY_RUN=1 first and look at the per-scope counts.
const LEARN_SCOPE = {
  include: [
    "azure",
    "entra",
    "fabric",
    "sql",
    "power-platform",
    "intune",
    "autopilot",
    "windows-server",
    "defender-endpoint",
    "defender-cloud-apps",
    "defender-xdr",
    "defender-business",
    "defender-office-365",
    "defender-vulnerability-management",
    "defender-for-identity",
    "defender-for-iot",
    "defender", // defender/threat-intelligence (pathMappings in the old config)
    "security-exposure-management",
    "unified-secops-platform",
    "unified-secops",
    "microsoft-365",
    "dynamics365",
    "troubleshoot",
  ],
  exclude: [
    // Auto-generated ARM/Bicep resource schema reference -- very large, not article content,
    // and never part of the old catalog. Remove this line if you want it.
    "azure/templates",
  ],
};

// Non-Learn sources that are still git repos and are NOT affected by the MicrosoftDocs retirement.
const GIT_SOURCES = [
  {
    // Different org (github, not MicrosoftDocs), open-source product docs, Next.js pipeline:
    // frontmatter uses "intro" instead of "description" and has no ms.service, so "product"
    // is the top-level content/ folder name. See AGENTS.md.
    name: "github-docs",
    repoUrl: "https://github.com/github/docs.git",
    domain: "docs.github.com",
    descriptionField: "intro",
    productFromPath: true,
    targets: [{ sourceFolder: "content", baseUrlPath: "" }],
  },
];

const SKIP_DIRS = new Set(["includes", "media", "_themes", "breadcrumb", "archive", "zone-pivots", "obj", "v-fake"]);

// ---------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with retries/backoff. Returns { status, finalUrl, text } -- or { status: null, error }
 * on network failure. With headOnly, the body is read only until </head>.
 */
async function httpGet(url, { headOnly = false, accept = "text/html,application/xhtml+xml" } = {}) {
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS * (headOnly ? 1 : 8));
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: accept },
      });
      if ((res.status === 429 || res.status >= 500) && attempt < FETCH_MAX_RETRIES) {
        clearTimeout(timer);
        res.body?.cancel().catch(() => {});
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 5000 * 2 ** attempt);
        continue;
      }
      let text = "";
      if (res.ok && res.body) {
        if (headOnly) {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let bytes = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
            text += decoder.decode(value, { stream: true });
            if (/<\/head>/i.test(text) || bytes > HEAD_READ_LIMIT_BYTES) {
              reader.cancel().catch(() => {});
              break;
            }
          }
        } else {
          text = await res.text();
        }
      } else {
        res.body?.cancel().catch(() => {});
      }
      clearTimeout(timer);
      return { status: res.status, finalUrl: res.url, text };
    } catch (err) {
      clearTimeout(timer);
      if (attempt < FETCH_MAX_RETRIES) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return { status: null, error: String(err.message || err) };
    }
  }
}

/** Runs fn over items with FETCH_CONCURRENCY workers and a per-worker delay. */
async function pool(items, fn, label) {
  const results = new Array(items.length);
  let idx = 0;
  let done = 0;
  const t0 = Date.now();
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
      done++;
      if (done % 250 === 0 || done === items.length) {
        console.log(`  ${label}: ${done}/${items.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
      await sleep(PER_WORKER_DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, items.length) }, worker));
  return results;
}

const isDefinitivelyGone = (status) => status === 404 || status === 410;
const isTransient = (r) => r.status === null || r.status === 429 || r.status >= 500;

// Learn redirects locale-less URLs to /en-us/...; that's not a "move". A move is when the
// final URL normalizes to a different page than the one requested.
function movedTo(requestedUrl, finalUrl) {
  if (!finalUrl) return null;
  const norm = normalizeLearnUrl(finalUrl);
  return norm && norm !== requestedUrl ? norm : null;
}

// Quarantine re-check keeps the old semantics: follow redirects, 2xx/3xx = ok.
async function checkUrlStatus(url) {
  const r = await httpGet(url, { headOnly: true });
  if (r.status === null) return { url, status: null, ok: false, transient: true, error: r.error };
  const ok = r.status >= 200 && r.status < 400;
  return { url, status: r.status, ok, transient: !ok && !isDefinitivelyGone(r.status) };
}

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------
// Source 1: Learn sitemaps
// ---------------------------------------------------------------------------------------

async function discoverSitemapFiles() {
  const files = [];
  const queue = [SITEMAP_INDEX_URL];
  const seen = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await httpGet(url, { accept: "application/xml,text/xml" });
    if (r.status !== 200) throw new Error(`sitemap index ${url} -> ${r.status ?? r.error}`);
    for (const child of parseSitemapIndex(r.text)) {
      const fam = sitemapFamily(child.loc);
      if (fam) {
        if (fam.locale === SITEMAP_LOCALE) files.push({ ...child, ...fam });
      } else if (/index/i.test(child.loc)) {
        queue.push(child.loc); // nested index (not observed as of 2026-09, handled defensively)
      }
    }
  }
  return files;
}

async function collectSitemapUrls(previousFamilies) {
  const files = await discoverSitemapFiles();
  const familyNames = [...new Set(files.map((f) => f.family))];
  const selected = files.filter((f) => FULL_DISCOVERY || previousFamilies[f.family]?.relevant !== false);
  const skippedFamilies = familyNames.filter((n) => !selected.some((f) => f.family === n));
  console.log(
    `  ${files.length} ${SITEMAP_LOCALE} sitemap file(s) in ${familyNames.length} famil(ies); ` +
      `fetching ${selected.length} file(s), skipping ${skippedFamilies.length} famil(ies) known to be out of scope` +
      (FULL_DISCOVERY ? " (FULL_DISCOVERY)" : "")
  );

  const families = {};
  for (const n of familyNames) families[n] = { ...(previousFamilies[n] || {}) };
  const rows = [];
  const failures = [];

  // Sitemap files are big and few; fetch sequentially to stay well clear of 429s.
  let n = 0;
  for (const file of selected) {
    n++;
    const r = await httpGet(file.loc, { accept: "application/xml,text/xml" });
    if (r.status !== 200) {
      failures.push(`${file.loc} -> ${r.status ?? r.error}`);
      continue;
    }
    if (isSitemapIndex(r.text)) continue;
    let inScopeCount = 0;
    for (const { loc, lastmod } of parseUrlset(r.text)) {
      const url = normalizeLearnUrl(loc);
      if (!url || !inScope(url, LEARN_SCOPE)) continue;
      rows.push({ url, lastmod, family: file.family });
      inScopeCount++;
    }
    const fam = families[file.family];
    fam.relevant = Boolean(fam._seenThisRun && fam.relevant) || inScopeCount > 0;
    fam._seenThisRun = true;
    fam.checked = new Date().toISOString().slice(0, 10);
    if (n % 25 === 0 || n === selected.length) console.log(`  sitemaps: ${n}/${selected.length}`);
    await sleep(200);
  }
  for (const f of Object.values(families)) delete f._seenThisRun;
  return { byUrl: dedupeByUrl(rows), families, failures };
}

// ---------------------------------------------------------------------------------------
// Source 2: non-Learn git repos (github/docs only)
// ---------------------------------------------------------------------------------------

function walkMarkdownFiles(dir, results = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) walkMarkdownFiles(fullPath, results);
    else if (entry.name.endsWith(".md")) results.push(fullPath);
  }
  return results;
}

function processGitSource(repo, entries) {
  const domain = repo.domain || "learn.microsoft.com";
  const descriptionField = repo.descriptionField || "description";
  const tmpDir = mkdtempSync(join(tmpdir(), "docs-catalog-"));
  try {
    execSync(`git clone --filter=blob:none --sparse --depth 1 --no-checkout --quiet ${repo.repoUrl} "${tmpDir}"`, { stdio: "inherit" });
    const sparsePaths = repo.targets.flatMap((t) => [`"${t.sourceFolder}/**/*.md"`, `"${t.sourceFolder}/*.md"`]).join(" ");
    execSync(`git sparse-checkout set --no-cone ${sparsePaths}`, { cwd: tmpDir, stdio: "inherit" });
    execSync(`git checkout --quiet`, { cwd: tmpDir, stdio: "inherit" });
    for (const target of repo.targets) {
      const sourceRoot = join(tmpDir, target.sourceFolder);
      let added = 0;
      for (const file of walkMarkdownFiles(sourceRoot)) {
        const fm = parseFrontmatter(readFileSync(file, "utf-8"));
        if (!fm || !fm.title || /\bNOINDEX\b/i.test(fm.ROBOTS || "")) continue;
        const rel = relative(sourceRoot, file).replace(/\\/g, "/");
        const { baseUrlPath, stripPrefix } = resolveTarget(target, rel);
        entries.push({
          title: cleanTitle(stripLiquidTags(fm.title) || fm.title),
          url: buildUrl(file, sourceRoot, baseUrlPath, domain, stripPrefix),
          product: repo.productFromPath ? rel.split("/")[0] : fm["ms.service"] || null,
          subproduct: repo.productFromPath ? null : fm["ms.subservice"] || null,
          description: stripLiquidTags(fm[descriptionField]),
        });
        added++;
      }
      console.log(`  ${target.sourceFolder}/ -> ${domain}/${target.baseUrlPath} (${added} entries)`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10);
const previousEntries = readJson(OUTPUT_FILE, []);
const prevByUrl = new Map(previousEntries.map((e) => [e.url, e]));
const invalidMap = new Map(readJson(INVALID_OUTPUT_FILE, []).map((e) => [e.url, e]));
const previousFamilies = readJson(FAMILIES_FILE, {});
let runFailed = false;

// --- Learn: sitemap discovery -----------------------------------------------------------
console.log("\nLearn sitemaps:");
const { byUrl: sitemapByUrl, families, failures: sitemapFailures } = await collectSitemapUrls(previousFamilies);
console.log(`  ${sitemapByUrl.size} in-scope page URL(s) after normalization/dedupe`);
if (sitemapFailures.length) {
  runFailed = true;
  console.error(`  ${sitemapFailures.length} sitemap file(s) failed -- removal detection is DISABLED this run:`);
  for (const f of sitemapFailures.slice(0, 10)) console.error(`    ${f}`);
}

const isLearn = (e) => e.url.startsWith("https://learn.microsoft.com/");
const previousLearn = previousEntries.filter(isLearn);
if (previousLearn.length && sitemapByUrl.size < previousLearn.length * SITEMAP_SANITY_RATIO) {
  console.error(
    `Aborting: sitemaps yielded ${sitemapByUrl.size} in-scope URLs vs ${previousLearn.length} Learn entries last run ` +
      `(< ${SITEMAP_SANITY_RATIO * 100}%). Looks like a sitemap outage or a format change, not real removals.`
  );
  process.exit(1);
}

// --- Learn: plan ------------------------------------------------------------------------
const kept = []; // unchanged (or bootstrapped) records
const toFetchNew = [];
const toFetchChanged = [];
let bootstrapped = 0;
for (const [url, { lastmod }] of sitemapByUrl) {
  if (invalidMap.has(url)) continue; // quarantine re-check below decides
  const prev = prevByUrl.get(url);
  if (!prev) toFetchNew.push({ url, lastmod });
  else if (!("lastmod" in prev)) {
    kept.push({ ...prev, lastmod }); // first run after migration: adopt, don't refetch
    bootstrapped++;
  } else if (prev.lastmod === lastmod) kept.push(prev);
  else toFetchChanged.push({ url, lastmod, prev });
}
const missing = previousLearn.filter((e) => !sitemapByUrl.has(e.url) && !invalidMap.has(e.url));

const perScope = {};
for (const url of sitemapByUrl.keys()) {
  const s = scopeOf(url, LEARN_SCOPE.include) || "?";
  perScope[s] = (perScope[s] || 0) + 1;
}
console.log("\nPlan:");
console.log(`  kept unchanged:        ${kept.length - bootstrapped}`);
console.log(`  bootstrapped lastmod:  ${bootstrapped}  (old git-built records, adopted without refetch)`);
console.log(`  new pages:             ${toFetchNew.length}`);
console.log(`  changed pages:         ${toFetchChanged.length}`);
console.log(`  missing from sitemap:  ${missing.length}`);
console.log("  in-scope URLs per include prefix:");
for (const [s, c] of Object.entries(perScope).sort((a, b) => b[1] - a[1])) console.log(`    ${s.padEnd(36)} ${c}`);

if (DRY_RUN) {
  console.log("\nDRY_RUN=1 -- nothing fetched or written.");
  process.exit(0);
}

// --- Learn: fetch metadata for new/changed pages (capped) --------------------------------
const queue = [...toFetchNew, ...toFetchChanged];
const fetchNow = queue.slice(0, MAX_PAGE_FETCHES);
const deferred = queue.slice(MAX_PAGE_FETCHES);
if (deferred.length) console.log(`\nCapping page fetches at ${MAX_PAGE_FETCHES}; ${deferred.length} deferred to later runs.`);
for (const d of deferred) if (d.prev) kept.push(d.prev); // changed-but-deferred keeps its OLD lastmod, so it re-queues next run

const learnEntries = [...kept];
const newlyQuarantined = [];
const quarantine = (entry, status) => {
  const record = { ...entry, status, firstDetected: today, lastChecked: today };
  invalidMap.set(entry.url, record);
  newlyQuarantined.push(record);
};
let moved = 0;
let noindex = 0;
let transientFetch = 0;

if (fetchNow.length) {
  console.log(`\nFetching <head> metadata for ${fetchNow.length} page(s)...`);
  const results = await pool(fetchNow, (item) => httpGet(item.url, { headOnly: true }), "pages");
  results.forEach((r, i) => {
    const item = fetchNow[i];
    if (r.status === 200) {
      if (movedTo(item.url, r.finalUrl)) return void moved++;
      const head = parseHeadMeta(r.text);
      if (isNoIndex(head.meta)) return void noindex++;
      const rec = recordFromHead(head, item.url, cleanTitle);
      if (rec) learnEntries.push({ ...rec, lastmod: item.lastmod });
      else if (item.prev) learnEntries.push(item.prev);
    } else if (isDefinitivelyGone(r.status)) {
      if (item.prev) quarantine(item.prev, r.status); // was cataloged and is now gone
      // a brand-new sitemap URL that 404s is sitemap lag -- just don't add it
    } else {
      transientFetch++;
      if (item.prev) learnEntries.push(item.prev); // keep old record, old lastmod -> retried next run
    }
  });
  console.log(`  moved: ${moved}, noindex: ${noindex}, transient: ${transientFetch}`);
}

// --- Learn: removal detection for URLs that fell out of the sitemaps ----------------------
if (missing.length) {
  if (sitemapFailures.length) {
    console.log(`\nCarrying forward ${missing.length} missing-from-sitemap entries unchecked (sitemap fetch failures this run).`);
    learnEntries.push(...missing);
  } else {
    const checkNow = missing.slice(0, MAX_MISSING_CHECKS);
    const later = missing.slice(MAX_MISSING_CHECKS);
    learnEntries.push(...later);
    console.log(`\nChecking ${checkNow.length} URL(s) no longer in any sitemap${later.length ? ` (${later.length} deferred)` : ""}...`);
    const results = await pool(checkNow, (e) => httpGet(e.url, { headOnly: true }), "missing");
    let gone = 0;
    let movedAway = 0;
    let stillLive = 0;
    results.forEach((r, i) => {
      const e = checkNow[i];
      if (isDefinitivelyGone(r.status)) {
        quarantine(e, r.status);
        gone++;
      } else if (r.status === 200 && movedTo(e.url, r.finalUrl)) {
        movedAway++; // redirected to another page; the destination arrives via its own sitemap row
      } else {
        learnEntries.push(e); // 200 on the same page, or transient -- keep
        if (r.status === 200) stillLive++;
      }
    });
    console.log(`  gone (quarantined): ${gone}, moved (dropped): ${movedAway}, still live: ${stillLive}`);
  }
}

// --- Git sources ---------------------------------------------------------------------------
const gitEntries = [];
for (const repo of GIT_SOURCES) {
  console.log(`\n${repo.name} (git):`);
  const before = gitEntries.length;
  if (SKIP_GIT_SOURCES) {
    const prefixes = repoUrlPrefixes(repo);
    gitEntries.push(...previousEntries.filter((e) => prefixes.some((p) => e.url.startsWith(p))));
    console.log(`  SKIP_GIT_SOURCES=1 -- carried forward ${gitEntries.length - before} previous entries`);
    continue;
  }
  try {
    processGitSource(repo, gitEntries);
  } catch (err) {
    console.error(`  FAILED: ${err.message} -- carrying forward previous entries`);
    gitEntries.length = before;
    const prefixes = repoUrlPrefixes(repo);
    gitEntries.push(...previousEntries.filter((e) => prefixes.some((p) => e.url.startsWith(p))));
    runFailed = true;
  }
}

// --- Quarantine re-check (unchanged semantics: auto-release restored pages) ---------------
const previouslyQuarantined = [...invalidMap.keys()].filter((u) => !newlyQuarantined.some((q) => q.url === u));
if (previouslyQuarantined.length) {
  console.log(`\nRe-checking ${previouslyQuarantined.length} previously quarantined URL(s)...`);
  const results = await pool(previouslyQuarantined, checkUrlStatus, "quarantine");
  for (const r of results) {
    const record = invalidMap.get(r.url);
    if (r.ok) {
      invalidMap.delete(r.url);
      const { status, firstDetected, lastChecked, ...entry } = record;
      // Learn pages get a sentinel lastmod so the next run's plan sees a mismatch and refetches them.
      if (isLearn(entry)) learnEntries.push({ ...entry, lastmod: "released" });
      else gitEntries.push(entry);
      console.log(`  RELEASED (now ${r.status}): ${r.url}`);
    } else if (!r.transient) {
      record.status = r.status;
      record.lastChecked = today;
    }
  }
}

// --- Assemble, audit, write ---------------------------------------------------------------
let entries = [...learnEntries, ...gitEntries];
const duplicates = findDuplicateUrls(entries);
if (duplicates.length) {
  console.error(`\nWARNING: ${duplicates.length} duplicate URL(s); keeping the first of each.`);
  for (const { url } of duplicates.slice(0, 10)) console.error(`  ${url}`);
  if (duplicates.length > DUPLICATE_URL_FAIL_THRESHOLD) {
    console.error("Aborting write: duplicate count exceeds threshold -- systemic merge bug.");
    process.exit(1);
  }
  const seen = new Set();
  entries = entries.filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}
entries = entries.filter((e) => !invalidMap.has(e.url));

if (entries.length < MIN_ENTRIES) {
  console.error(`Aborting write: only ${entries.length} entries, expected at least ${MIN_ENTRIES}.`);
  process.exit(1);
}

entries.sort((a, b) => a.url.localeCompare(b.url));
const serialized = JSON.stringify(entries);
writeFileSync(OUTPUT_FILE, serialized);
console.log(`\nWrote ${OUTPUT_FILE} (${(Buffer.byteLength(serialized) / 1024 / 1024).toFixed(1)} MB, ${entries.length} entries)`);

const invalidSorted = [...invalidMap.values()].sort((a, b) => a.url.localeCompare(b.url));
writeFileSync(INVALID_OUTPUT_FILE, JSON.stringify(invalidSorted, null, 2));
console.log(`Wrote ${INVALID_OUTPUT_FILE} (${invalidSorted.length} quarantined URL(s) total)`);

writeFileSync(FAMILIES_FILE, JSON.stringify(Object.fromEntries(Object.entries(families).sort()), null, 2) + "\n");
const relevant = Object.entries(families).filter(([, f]) => f.relevant).map(([n]) => n);
console.log(`Wrote ${FAMILIES_FILE} (${relevant.length} relevant sitemap famil(ies): ${relevant.join(", ")})`);

if (newlyQuarantined.length) {
  writeFileSync(QUARANTINE_REPORT_FILE, buildQuarantineReport(newlyQuarantined, { surgeThreshold: QUARANTINE_SURGE_THRESHOLD }));
  console.log(`Wrote ${QUARANTINE_REPORT_FILE} (${newlyQuarantined.length} newly quarantined URL(s))`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `new_quarantine_count=${newlyQuarantined.length}\n`);
}

if (runFailed) process.exit(1); // sitemap-file or git-source failure; data above was still written with carry-forward
