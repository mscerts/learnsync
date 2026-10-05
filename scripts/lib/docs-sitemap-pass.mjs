/**
 * The sitemap stage of the docs sync: discover the en-us sitemap files,
 * download the ones this run needs, and turn them into scoped rows plus the
 * new family memo. The HTTP client is injected, so the whole stage is tested
 * with a fake. Throws only when the sitemap INDEX itself cannot be read (no
 * stage output at all); a failed child file is recorded in `failures` and the
 * caller decides what that means (the docs sync disables removal detection and
 * keeps the previous index).
 */

import { DEFAULT_SCOPES, scopeSignature } from "./docs-scope.mjs";
import { dedupeRows, listSitemapChildren, rowsFromUrlset, selectSitemapFiles, updateFamilies } from "./docs-sitemaps.mjs";
import { isSitemapIndex } from "./sitemap-helpers.mjs";
import { SITEMAP_DELAY_MS, SITEMAP_MAX_RECHECKS_PER_RUN, SITEMAP_RECHECK_DAYS } from "./docs-config.mjs";

export const SITEMAP_INDEX_URL = "https://learn.microsoft.com/_sitemaps/sitemapindex.xml";
export const SITEMAP_LOCALE = "en-us";
const XML_ACCEPT = "application/xml,text/xml";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every en-us child sitemap file listed by the index (nested indexes are followed). */
export async function discoverSitemapFiles(client, { indexUrl = SITEMAP_INDEX_URL, locale = SITEMAP_LOCALE } = {}) {
  const files = [];
  const queue = [indexUrl];
  const seen = new Set();
  while (queue.length) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const r = await client.get(url, { accept: XML_ACCEPT, big: true });
    if (r.status !== 200) throw new Error(`sitemap index ${url} -> ${r.status ?? r.error}`);
    const { files: found, nested } = listSitemapChildren(r.text, locale);
    files.push(...found);
    queue.push(...nested);
  }
  const byLoc = new Map();
  for (const f of files) if (!byLoc.has(f.loc)) byLoc.set(f.loc, f);
  return [...byLoc.values()];
}

/**
 * @returns {{ rows: Map, families: object, failures: string[], files: number,
 *   downloaded: number, skippedFamilies: string[], reasons: object,
 *   segments: Map<string, number>, queryRows: number }}
 *   rows: path -> { url, path, lastmod, family, cls } (one per canonical path, both scopes)
 *   segments: first path segment -> URL count over every downloaded file, in or out of scope
 */
export async function collectSitemaps({
  client,
  memo,
  scopes = DEFAULT_SCOPES,
  today,
  full = false,
  prefer = new Map(),
  log = () => {},
  sleep = defaultSleep,
  delayMs = SITEMAP_DELAY_MS,
  recheckDays = SITEMAP_RECHECK_DAYS,
  maxRechecks = SITEMAP_MAX_RECHECKS_PER_RUN,
  indexUrl = SITEMAP_INDEX_URL,
  locale = SITEMAP_LOCALE,
}) {
  const scopeSig = scopeSignature(scopes);
  const files = await discoverSitemapFiles(client, { indexUrl, locale });
  const familyNames = [...new Set(files.map((f) => f.family))];
  const { selected, skipped, reasons } = selectSitemapFiles(files, memo, { full, scopeSig, today, recheckDays, maxRechecks });
  const reasonCounts = {};
  for (const reason of Object.values(reasons)) reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
  log(
    `  ${files.length} ${locale} sitemap file(s) in ${familyNames.length} famil(ies); fetching ${selected.length} file(s), ` +
      `skipping ${skipped.length} famil(ies) known to be out of scope` +
      (Object.keys(reasonCounts).length ? ` [${Object.entries(reasonCounts).map(([k, v]) => `${v} ${k}`).join(", ")}]` : "")
  );

  const outcomes = new Map(); // family -> { failed, inScope }
  const allRows = [];
  const failures = [];
  const segments = new Map();
  let queryRows = 0;
  let downloaded = 0;

  // Sitemap files are big and few: fetched one at a time, well clear of 429s.
  let n = 0;
  for (const file of selected) {
    n++;
    const o = outcomes.get(file.family) || { failed: 0, inScope: 0 };
    outcomes.set(file.family, o);
    const r = await client.get(file.loc, { accept: XML_ACCEPT, big: true });
    if (r.status !== 200) {
      o.failed++;
      failures.push(`${file.loc} -> ${r.status ?? r.error}`);
    } else if (isSitemapIndex(r.text)) {
      downloaded++; // a nested index inside a child slot: nothing to read, not a failure
    } else if (!/<\/urlset>\s*$/.test(r.text)) {
      o.failed++; // a cut-off download parses "fine" but silently drops URLs
      failures.push(`${file.loc} -> truncated (no closing </urlset>)`);
    } else {
      downloaded++;
      const parsed = rowsFromUrlset(r.text, { family: file.family, scopes, segments });
      queryRows += parsed.queryRows;
      o.inScope += parsed.rows.length;
      for (const row of parsed.rows) allRows.push(row);
    }
    if (n % 25 === 0 || n === selected.length) log(`  sitemaps: ${n}/${selected.length}`);
    await sleep(delayMs);
  }

  return {
    rows: dedupeRows(allRows, prefer),
    families: updateFamilies(memo, familyNames, outcomes, { scopeSig, today }),
    failures,
    files: files.length,
    downloaded,
    skippedFamilies: skipped,
    reasons,
    segments,
    queryRows,
  };
}
