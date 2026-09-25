/**
 * Pure helper functions for the sitemap-based source in scripts/docs-catalog-sync.mjs.
 * No I/O, no network -- unit-tested in test/sitemap-helpers.test.mjs.
 *
 * Why sitemaps: Microsoft Learn is retiring most public MicrosoftDocs/* documentation
 * repos (announced 2026-09-23, completion expected by end of December 2026). Retired
 * repos become fully invisible, so the old git-clone source stops working. The live
 * site's own sitemaps (learn.microsoft.com/_sitemaps/sitemapindex.xml) list every
 * published page with a per-URL <lastmod>, and every page's <head> carries the same
 * docfx metadata the repo frontmatter used to give us (title, description,
 * ms.service, ms.subservice) -- so the catalog can be rebuilt from Learn itself.
 */

const LEARN_HOST = "learn.microsoft.com";

// --- XML parsing (sitemaps are machine-generated and regular; no XML dependency needed) ---

function decodeXmlText(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseBlocks(xml, tag) {
  const out = [];
  const blockRe = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g");
  let m;
  while ((m = blockRe.exec(xml))) {
    const body = m[1];
    const loc = body.match(/<loc>([\s\S]*?)<\/loc>/);
    if (!loc) continue;
    const lastmod = body.match(/<lastmod>([\s\S]*?)<\/lastmod>/);
    out.push({ loc: decodeXmlText(loc[1]), lastmod: lastmod ? decodeXmlText(lastmod[1]) : null });
  }
  return out;
}

/** <sitemapindex> -> [{ loc, lastmod }] (child sitemap files). */
export function parseSitemapIndex(xml) {
  return parseBlocks(xml, "sitemap");
}

/** <urlset> -> [{ loc, lastmod }] (pages). xhtml:link hreflang alternates are ignored. */
export function parseUrlset(xml) {
  return parseBlocks(xml, "url");
}

export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/.test(xml);
}

/**
 * Learn names its sitemap files <family>_<locale>_<n>.xml, e.g. "dotnet_en-us_12.xml".
 * Returns { family, locale } or null for anything that doesn't follow that pattern.
 */
export function sitemapFamily(loc) {
  const file = loc.split("/").pop() || "";
  const m = file.match(/^(.+)_([a-z]{2}-[a-z]{2,4})_\d+\.xml$/i);
  return m ? { family: m[1], locale: m[2].toLowerCase() } : null;
}

/**
 * Sitemap <loc> -> the catalog's canonical URL shape, or null if it isn't an en-us Learn page.
 * The previous (git-based) catalog stored locale-less, moniker-less URLs without a trailing
 * slash (e.g. https://learn.microsoft.com/azure/key-vault/general/overview) -- keep that
 * exact shape so existing entries match and diffs stay small.
 *   - strips the /en-us locale segment
 *   - strips ?view=<moniker> (the moniker-less URL resolves to the default moniker)
 *   - strips a trailing slash (except the bare domain)
 */
export function normalizeLearnUrl(loc) {
  let u;
  try {
    u = new URL(loc);
  } catch {
    return null;
  }
  if (u.hostname !== LEARN_HOST) return null;
  const segs = u.pathname.split("/").filter(Boolean);
  if (segs[0]?.toLowerCase() !== "en-us") return null;
  segs.shift();
  u.searchParams.delete("view");
  const qs = u.searchParams.toString();
  const path = segs.join("/");
  return `https://${LEARN_HOST}${path ? `/${path}` : ""}${qs ? `?${qs}` : ""}`;
}

/** Path part of a normalized Learn URL, without the leading slash. */
export function learnPath(url) {
  return new URL(url).pathname.replace(/^\/+/, "").replace(/\/+$/, "");
}

/** True if `path` equals `prefix` or sits under it ("azure" matches "azure/x", not "azure-x"). */
export function underPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** In scope = under at least one include prefix and under no exclude prefix. */
export function inScope(url, { include, exclude = [] }) {
  const path = learnPath(url);
  return include.some((p) => underPrefix(path, p)) && !exclude.some((p) => underPrefix(path, p));
}

/** Which include prefix a URL falls under (longest match), for per-scope stats. */
export function scopeOf(url, include) {
  const path = learnPath(url);
  let best = null;
  for (const p of include) if (underPrefix(path, p) && (!best || p.length > best.length)) best = p;
  return best;
}

/**
 * Collapse sitemap rows to one per normalized URL. Several ?view= moniker variants of the
 * same page normalize to one URL; keep the most recent lastmod so a change to any moniker
 * variant still triggers a metadata refresh.
 */
export function dedupeByUrl(rows) {
  const byUrl = new Map();
  for (const r of rows) {
    const prev = byUrl.get(r.url);
    if (!prev || (r.lastmod && (!prev.lastmod || r.lastmod > prev.lastmod))) byUrl.set(r.url, r);
  }
  return byUrl;
}

// --- Page <head> metadata ---

export function decodeHtmlEntities(s) {
  if (s == null) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Extracts <title> and every <meta name|property=... content=...> from an HTML <head>.
 * Attribute order varies between pages, so each <meta> tag is parsed attribute-by-attribute.
 */
export function parseHeadMeta(html) {
  const head = html.split(/<\/head>/i)[0];
  const meta = {};
  const tagRe = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = tagRe.exec(head))) {
    const attrs = {};
    const attrRe = /([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = attrRe.exec(m[1]))) attrs[a[1].toLowerCase()] = a[3] ?? a[4];
    const key = attrs.name ?? attrs.property;
    if (key && attrs.content !== undefined && !(key in meta)) meta[key] = decodeHtmlEntities(attrs.content);
  }
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return { title: title ? decodeHtmlEntities(title[1]).replace(/\s+/g, " ").trim() : null, meta };
}

/** True if the page opts out of indexing -- the git source skipped ROBOTS: NOINDEX too. */
export function isNoIndex(meta) {
  return /\bnoindex\b/i.test(meta.robots || meta["ms.robots"] || "");
}

/**
 * Head metadata -> catalog record, same shape as the git-based source produced.
 * `cleanTitle` is passed in (it lives in docs-helpers.mjs) so it strips " | Microsoft Learn".
 */
export function recordFromHead({ title, meta }, url, cleanTitle) {
  const rawTitle = title || meta["og:title"];
  if (!rawTitle) return null;
  return {
    title: cleanTitle(rawTitle),
    url,
    product: meta["ms.service"] || null,
    subproduct: meta["ms.subservice"] || null,
    description: meta.description || meta["og:description"] || null,
  };
}
