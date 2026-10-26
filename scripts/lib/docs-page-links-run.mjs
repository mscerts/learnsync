/**
 * The page-links tool: fetch documentation pages and extract their links (docs-page-links.mjs). Thin I/O around
 * the pure extraction; every dependency is injectable so the tests need no network.
 */

import { canonicalPath } from "./canonical.mjs";
import { extractPageLinks } from "./docs-page-links.mjs";
import { request, runPool } from "./learn-http.mjs";

/** The pages to read from the command-line arguments or a JSON array: `[{ input, path }]`, `path` null for what is not a Learn URL or path. */
export function pagesOf(args, stdin = "") {
  const inputs = args.length > 0 ? args : stdin.trim() ? JSON.parse(stdin) : [];
  if (!Array.isArray(inputs)) throw new Error("the input must be a JSON array of URLs or paths");
  return inputs.map((input) => ({ input, path: canonicalPath(String(input)) }));
}

/** One result per page, in input order: the extracted page, or `{ path, error }`. */
export async function fetchPageLinks(pages, { delayMs = 1000, fetchImpl, sleepImpl } = {}) {
  const http = { ...(fetchImpl ? { fetchImpl } : {}), ...(sleepImpl ? { sleepImpl } : {}) };
  return runPool(
    pages,
    async ({ input, path }) => {
      if (!path) return { path: String(input), error: "not a learn.microsoft.com URL or path" };
      const result = await request(`https://learn.microsoft.com/en-us${path}`, { ...http, read: "text" });
      if (result.outcome !== "ok") return { path, error: result.error ?? result.outcome };
      const page = extractPageLinks(result.body, { path });
      return page ? { path, ...page } : { path, error: "no article found: the page layout is not the known one" };
    },
    { delayMs, ...(sleepImpl ? { sleepImpl } : {}) },
  );
}
