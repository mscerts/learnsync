/**
 * The links a documentation page puts in its article, and what the page says about itself: the topic type
 * (`ms.topic`: concept-article, how-to, overview ...), the product (`ms.service`, `ms.subservice`) and the folder
 * of the table of contents it sits in (`toc_rel`, which joins data/docs-toc.json). The links are the ones Microsoft's
 * writers chose to point to from the article text and from its "Related content" list, so they are context for
 * "which pages belong with this one". Pure logic (no I/O, no network); the command line is
 * scripts/docs-page-links.mjs.
 *
 * What a page looks like (checked on real pages): `<main data-bi-name="content">` holds the article, which starts
 * at the `<h1>` and ends at the `ms--inline-notifications` placeholder; the in-page table of contents, the
 * feedback area and the footer come before or after it. Links are `<a href data-linktype="relative-path |
 * absolute-path | external | self-bookmark">`. A relative href is relative to the page URL as if the page were a
 * file in its folder ("concept-learn-about-groups", "../identity/users/x"). Every `<h2>` names a section; the
 * name is stored with each link ("Prerequisites", "Related content").
 */

import { canonicalPath, LEARN_HOST } from "./canonical.mjs";
import { decodeText } from "./module-links.mjs";

/** Sections of an article that are page furniture, not content the writers curated. */
export const SKIP_SECTION = /feedback|in this article|additional resources/i;

const MAX_TEXT = 200;

/** The `content` of `<meta name="...">`, decoded; null when the page has none. */
export function metaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const forward = new RegExp(`<meta\\s+[^>]*name="${escaped}"[^>]*content="([^"]*)"`, "i").exec(html);
  const backward = new RegExp(`<meta\\s+[^>]*content="([^"]*)"[^>]*name="${escaped}"`, "i").exec(html);
  const value = forward?.[1] ?? backward?.[1];
  return value === undefined ? null : decodeText(value);
}

/** The article HTML: after the first `</h1>` up to the inline-notifications placeholder (else the end of `<main>`). Null when the layout is not the known one. */
export function articleHtml(html) {
  if (typeof html !== "string") return null;
  const h1End = html.search(/<\/h1>/i);
  if (h1End < 0) return null;
  const rest = html.slice(h1End + 5);
  const marker = rest.indexOf('id="ms--inline-notifications"');
  if (marker >= 0) return rest.slice(0, rest.lastIndexOf("<div", marker) >= 0 ? rest.lastIndexOf("<div", marker) : marker);
  const mainEnd = rest.search(/<\/main>/i);
  return mainEnd >= 0 ? rest.slice(0, mainEnd) : null;
}

/** The folder of the table of contents a page uses: `toc_rel` resolved against the page ("toc.json" -> "/entra/fundamentals"). */
export function tocFolderOf(pagePath, tocRel) {
  if (!tocRel) return null;
  let url;
  try {
    url = new URL(tocRel, `https://${LEARN_HOST}${pagePath}`);
  } catch {
    return null;
  }
  const path = canonicalPath(url.pathname);
  return path ? path.replace(/\/toc\.json$/, "") || "/" : null;
}

/** A link of the article as a Learn path, or null (external, an anchor of the page itself, mailto, a page's own address). */
export function linkTarget(href, pagePath) {
  if (typeof href !== "string" || href.trim() === "" || href.startsWith("#")) return null;
  let url;
  try {
    url = new URL(decodeText(href), `https://${LEARN_HOST}/en-us${pagePath}`);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== LEARN_HOST) return null;
  const path = canonicalPath(url.pathname);
  return path && path !== pagePath ? path : null;
}

/**
 * Everything a page says: `{ title, topic, service, subservice, date, toc, links }`, `links` in the order of the article as
 * `[{ path, text, section }]`, one per path and section, the section "lead" for the text before the first `<h2>`.
 * Null when the page does not look like an article (no `<h1>`, no end of the article): a changed layout must not
 * pass for "no links".
 */
export function extractPageLinks(html, { path }) {
  const article = articleHtml(html);
  if (article === null) return null;
  const links = [];
  const seen = new Set();
  let section = "lead";
  const token = /<h2\b[^>]*>([\s\S]*?)<\/h2>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of article.matchAll(token)) {
    if (match[1] !== undefined) {
      section = decodeText(match[1]) || "lead";
      continue;
    }
    if (SKIP_SECTION.test(section)) continue;
    const attrs = match[2];
    if (/data-linktype="(external|self-bookmark)"/i.test(attrs)) continue;
    const target = linkTarget(/href="([^"]*)"/i.exec(attrs)?.[1], path);
    if (!target) continue;
    const text = decodeText(match[3]).slice(0, MAX_TEXT);
    if (!text) continue;
    const key = `${target}\t${section}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push({ path: target, text, section });
  }
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  return {
    title: h1 ? decodeText(h1) : null,
    topic: metaContent(html, "ms.topic"),
    service: metaContent(html, "ms.service"),
    subservice: metaContent(html, "ms.subservice"),
    date: metaContent(html, "ms.date")?.slice(0, 10) ?? null,
    toc: tocFolderOf(path, metaContent(html, "toc_rel")),
    links,
  };
}
