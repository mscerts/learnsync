/**
 * Probe classification and the redirect ledger (data/docs-redirects.json).
 * See DATA_CONTRACT.md. Pure: no I/O, no network.
 *
 * How redirects are observed: the HTTP layer (docs-http.mjs) requests the
 * page with `redirect: "manual"` and follows hops itself, so the status code
 * of the FIRST hop (301/302/307/308) is the real one and the destination is
 * the end of the chain. Learn redirects a lot without moving anything (adding
 * `/en-us`, a trailing slash, `?view=<moniker>`, different casing); those all
 * canonicalize to the same path as the request and count as "live", not as a
 * move.
 */

import { canonicalPath, byCodePoint, underPrefix } from "./canonical.mjs";

/** Destinations under these prefixes mean "retired into an archive". */
export const RETIRED_PREFIXES = ["/previous-versions", "/archive"];

/**
 * Destinations that are generic hubs, not the page's successor. Redirecting a
 * deep page to one of these means "the page is gone, here is the nearest
 * front door". (Strict ancestors of the source path count as landing pages
 * too; see classifyRedirect.)
 */
export const GENERIC_HUBS = new Set([
  "/",
  "/docs",
  "/training",
  "/training/browse",
  "/credentials",
  "/credentials/browse",
  "/certifications",
  "/search",
  "/samples",
  "/answers",
]);

export const HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Redirect kind for a canonical `from` -> `to` pair (both canonical paths;
 * `to` null = the destination is off-site).
 *   retired  destination under /previous-versions or /archive
 *   landing  destination is a strict ancestor of `from`, a generic hub
 *            (GENERIC_HUBS) or a one-segment product root such as /azure or
 *            /fabric: the page is gone and Learn shows the nearest front door
 *   moved    anything else (same content elsewhere, or off-site)
 */
export function classifyRedirect(from, to) {
  if (to === null || to === undefined) return "moved";
  if (RETIRED_PREFIXES.some((p) => underPrefix(to, p))) return "retired";
  if (to !== from) {
    const strictAncestor = to === "/" || from.startsWith(`${to}/`);
    const productRoot = to.split("/").length === 2; // "/azure" -> ["", "azure"]
    if (strictAncestor || productRoot || GENERIC_HUBS.has(to)) return "landing";
  }
  return "moved";
}

const GONE = new Set([404, 410]);

/**
 * Turns a raw probe result (docs-http.mjs `probe()`) into a verdict.
 *
 * outcome:
 *   live       final 2xx on the same canonical path as the request
 *   gone       final 404/410 (definitive)
 *   moved      final 2xx on a different canonical path, or an off-site hop;
 *              `to` is that canonical path (null off-site), `status` is the
 *              status of the first hop, `kind` is classifyRedirect()
 *   transient  everything else: network error, timeout, 429, 5xx, redirect
 *              loop, any status the cache cannot interpret. Never changes data.
 *
 * `fromPath` must be the canonical path of the requested page.
 */
export function classifyProbe(result, fromPath) {
  if (!result || result.error || result.tooManyHops || result.status === null || result.status === undefined) {
    return { outcome: "transient", status: result?.status ?? null };
  }
  if (result.offsite) {
    return { outcome: "moved", status: result.firstStatus ?? result.status, to: null, kind: classifyRedirect(fromPath, null) };
  }
  const { status } = result;
  if (GONE.has(status)) return { outcome: "gone", status };
  if (status >= 200 && status < 300) {
    const finalPath = canonicalPath(result.finalUrl || "");
    if (finalPath === null) return { outcome: "transient", status };
    if (finalPath === fromPath) return { outcome: "live", status };
    return { outcome: "moved", status: result.firstStatus ?? status, to: finalPath, kind: classifyRedirect(fromPath, finalPath) };
  }
  return { outcome: "transient", status };
}

/** Validates/normalizes a ledger file's content; drops malformed rows. */
export function normalizeLedger(raw) {
  if (!Array.isArray(raw)) return [];
  const byFrom = new Map();
  for (const e of raw) {
    if (!e || typeof e.from !== "string") continue;
    const from = canonicalPath(e.from) ?? null;
    if (!from || from === "/") continue;
    const to = e.to === null || e.to === undefined ? null : canonicalPath(e.to);
    if (e.to !== null && e.to !== undefined && to === null) continue;
    const kind = ["moved", "landing", "retired"].includes(e.kind) ? e.kind : classifyRedirect(from, to);
    const prev = byFrom.get(from);
    const entry = {
      from,
      to,
      kind,
      status: Number.isInteger(e.status) ? e.status : null,
      firstSeen: typeof e.firstSeen === "string" ? e.firstSeen : null,
      lastSeen: typeof e.lastSeen === "string" ? e.lastSeen : typeof e.firstSeen === "string" ? e.firstSeen : null,
    };
    if (!prev || (entry.lastSeen || "") > (prev.lastSeen || "")) byFrom.set(from, entry);
  }
  return [...byFrom.values()].sort((a, b) => byCodePoint(a.from, b.from));
}

/**
 * Ledger after a run. Pure.
 *
 *   previous      normalized ledger from the last run
 *   discovered    [{ from, to, status }] redirects observed by probes this run
 *   contradicted  Set<path> of paths a probe this run found live on their own
 *                 path or gone (404/410): the old "moved" claim is stale
 *   newIndex /    Map<path, lastmod>. An entry is deleted when `from`
 *   previousIndex reappears in the index (absent from the previous index,
 *                 present in the new one). A path that was in the sitemap all
 *                 along and redirects (a stale sitemap row) keeps its entry:
 *                 the index says "the sitemap lists it", the ledger says
 *                 "but it redirects"; consumers check the index first.
 *   inScope       (path) => boolean; entries outside the covered prefixes go
 *   today         YYYY-MM-DD
 *
 * `firstSeen` is kept for as long as a `from` stays in the ledger.
 */
export function updateLedger({ previous, discovered, contradicted = new Set(), newIndex, previousIndex, inScope = () => true, today }) {
  const map = new Map();
  // With no previous index (first run, or the file was deleted to rebuild it)
  // "absent from the previous index" says nothing, so nothing counts as reappeared.
  const haveBaseline = previousIndex.size > 0;
  for (const e of previous) {
    if (!inScope(e.from)) continue;
    const reappeared = haveBaseline && newIndex.has(e.from) && !previousIndex.has(e.from);
    if (reappeared || contradicted.has(e.from)) continue;
    map.set(e.from, e);
  }
  for (const d of discovered) {
    if (!inScope(d.from) || d.from === d.to) continue;
    const old = map.get(d.from);
    map.set(d.from, {
      from: d.from,
      to: d.to,
      kind: classifyRedirect(d.from, d.to),
      status: Number.isInteger(d.status) ? d.status : null,
      firstSeen: old?.firstSeen || today,
      lastSeen: today,
    });
  }
  return [...map.values()].sort((a, b) => byCodePoint(a.from, b.from));
}
