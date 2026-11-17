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
