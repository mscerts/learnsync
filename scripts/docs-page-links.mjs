#!/usr/bin/env node
/**
 * The links of documentation pages and what each page says about itself (topic type, product, sidebar folder).
 * An on-demand tool, not a scheduled sync: it costs one request per page, so nothing is stored; a consumer asks
 * for the few pages it cares about (for example the candidate pages of a study guide task).
 *
 * Usage:
 *   echo '["https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-groups"]' | node scripts/docs-page-links.mjs
 *   node scripts/docs-page-links.mjs /entra/fundamentals/how-to-manage-groups /azure/virtual-network/virtual-networks-overview
 *
 * Input: a JSON array on stdin, or the pages as arguments (a full URL or a path). Output (stdout, JSON):
 *   [{ "path", "title", "topic", "service", "subservice", "date", "toc", "links": [{ "path", "text", "section" }] }]
 * or, for a page that could not be read, { "path", "error" }. `toc` is the folder of the table of contents
 * (a `path` of data/docs-toc.json); `links` are the links of the article in order, learn.microsoft.com only.
 * Exit code 1 when a page could not be read or does not look like an article.
 *
 * Environment: DOCS_PAGE_LINKS_DELAY_MS=1000  pause per worker between pages (3 workers at most).
 *
 * All logic lives in scripts/lib/docs-page-links*.mjs; this file only reads the input and prints the result.
 */

import { fetchPageLinks, pagesOf } from "./lib/docs-page-links-run.mjs";
import { numberFromEnv } from "./lib/learn-helpers.mjs";

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

try {
  const delayMs = numberFromEnv(process.env, "DOCS_PAGE_LINKS_DELAY_MS", 1000, { min: 0, max: 60_000 });
  const args = process.argv.slice(2);
  const pages = pagesOf(args, args.length > 0 ? "" : await readStdin());
  const results = await fetchPageLinks(pages, { delayMs });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  process.exit(results.some((r) => r.error) ? 1 : 0);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
