#!/usr/bin/env node
/**
 * Docs sync: a complete URL index plus a metadata cache of Microsoft Learn
 * documentation pages, built from learn.microsoft.com itself (sitemaps + page
 * <head>), NOT from the MicrosoftDocs/* git repos Microsoft is retiring by the
 * end of December 2026. See DATA_CONTRACT.md for every output file and AGENTS.md
 * for the operational overview.
 *
 * Usage:
 *   node scripts/docs-catalog-sync.mjs
 *   DRY_RUN=1 node scripts/docs-catalog-sync.mjs          # sitemaps + plan only, writes nothing
 *   FULL_DISCOVERY=1 node scripts/docs-catalog-sync.mjs   # re-scan every en-us sitemap family
 *   MAX_PAGE_FETCHES=50000 node scripts/docs-catalog-sync.mjs  # one-off local backfill
 *   SKIP_GIT_SOURCES=1 ...                                  # don't clone github/docs (local testing)
 *   (more knobs: scripts/lib/docs-config.mjs)
 *
 * Outputs under data/: docs-urls.txt (index of every sitemap URL under
 * LEARN_SCOPE + INDEX_ONLY_SCOPE), docs-catalog.json (metadata, LEARN_SCOPE and
 * github/docs only), docs-redirects.json (where moved pages went),
 * docs-catalog-invalid.json (quarantine), docs-sitemap-families.json, status.json.
 *
 * The decision logic lives in scripts/lib/docs-*.mjs (pure, unit-tested);
 * this file only wires the real HTTP client and the github/docs git source
 * into scripts/lib/docs-run.mjs.
 *
 * docs.github.com is NOT a Microsoft Learn repo and isn't covered by the
 * retirement, so it is still read from the open-source github/docs repo via
 * GIT_SOURCES below.
 */

import { execSync } from "node:child_process";
import { readFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { parseFrontmatter, cleanTitle, stripLiquidTags, buildUrl, resolveTarget, repoUrlPrefixes } from "./lib/docs-helpers.mjs";
import { createHttpClient } from "./lib/docs-http.mjs";
import { runDocsSync } from "./lib/docs-run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

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

/**
 * The non-Learn records for this run. With `skip` (SKIP_GIT_SOURCES=1) or when a
 * clone/parse fails, the previous records of that source are carried forward
 * (a failure also marks the run degraded).
 */
async function gitProvider({ previous, skip, log }) {
  const records = [];
  let failed = false;
  for (const repo of GIT_SOURCES) {
    log(`\n${repo.name} (git):`);
    const prefixes = repoUrlPrefixes(repo);
    const carried = previous.filter((e) => prefixes.some((p) => e.url.startsWith(p)));
    if (skip) {
      records.push(...carried);
      log(`  SKIP_GIT_SOURCES=1 -- carried forward ${carried.length} previous entries`);
      continue;
    }
    const before = records.length;
    try {
      processGitSource(repo, records);
    } catch (err) {
      console.error(`  FAILED: ${err.message} -- carrying forward previous entries`);
      records.length = before;
      records.push(...carried);
      failed = true;
    }
  }
  return { records, failed };
}

const { exitCode } = await runDocsSync({ dataDir: join(root, "data"), client: createHttpClient(), git: gitProvider });
process.exitCode = exitCode;
