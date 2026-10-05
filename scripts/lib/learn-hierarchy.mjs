/**
 * Unit URLs of a module come from the Learn hierarchy API, not from unit uids or
 * positions (a module's live nav can skip numbers, e.g. 1,2,3,5,6). This file
 * holds the pure parts: building the request URL, validating a response against
 * what the catalog says, deciding which modules need a (re-)fetch and merging
 * fetched, reused and carried-forward results. No I/O.
 *
 * Verified live on 2026-10-05:
 *   GET https://learn.microsoft.com/api/hierarchy/modules/<uid>?locale=en-us
 *   -> { parents: [...], units: [{ uid, type, title, url: "/training/modules/x/01-y/", ... }], ... }
 *   * Uids that start with "$" (for example "$learn.become-learn-contributor", the
 *     only one in the catalog) are valid as-is: the "$" is part of the module id.
 *     The API accepts it raw or percent-encoded ("%24learn.become-learn-contributor"),
 *     and does NOT accept the uid without the "$" (HTTP 404). We always send
 *     encodeURIComponent(uid) so the request is well-formed for any uid.
 *   * An unknown module answers HTTP 404 {"ErrorCode":"module_id_not_found",
 *     "Retriable":false}: definitive, never retried, counted as a failure.
 *   * unit uids and order match the catalog's module `units` array 1:1 (also for
 *     the modules whose unit titles are missing from the catalog `units` list).
 */

import { canonicalPath, underPrefix } from "./canonical.mjs";
import { HIERARCHY_BASE } from "./learn-config.mjs";

/** True when an error body is the hierarchy API's definitive "no such module" answer. */
export function isModuleIdNotFound(errorBody) {
  if (typeof errorBody !== "string") return false;
  try {
    return JSON.parse(errorBody)?.ErrorCode === "module_id_not_found";
  } catch {
    return false;
  }
}

export function hierarchyUrl(uid, base = HIERARCHY_BASE) {
  return `${base}${encodeURIComponent(uid)}?locale=en-us`;
}

/**
 * Validates a hierarchy response body for one module.
 * ctx: { modulePath, catalogUnitUids }.
 * Returns { ok: true, unitUrls } or { ok: false, kind: "bad-shape" | "misaligned", reason }.
 * Strict on purpose: an unreadable or inconsistent answer must become `null`
 * (or the previous same-signature value), never a partial guess.
 */
export function parseHierarchy(body, { modulePath, catalogUnitUids }) {
  if (!body || typeof body !== "object" || !Array.isArray(body.units)) {
    return { ok: false, kind: "bad-shape", reason: "response has no units array" };
  }
  const unitUrls = [];
  const hierarchyUids = [];
  for (const unit of body.units) {
    const path = canonicalPath(unit?.url);
    if (!path || !underPrefix(path, modulePath) || path === modulePath) {
      return { ok: false, kind: "bad-shape", reason: `unit url ${JSON.stringify(unit?.url)} is not under ${modulePath}` };
    }
    unitUrls.push(path);
    hierarchyUids.push(unit.uid);
  }
  if (new Set(unitUrls).size !== unitUrls.length) {
    return { ok: false, kind: "bad-shape", reason: "duplicate unit urls in response" };
  }
  if (hierarchyUids.length !== catalogUnitUids.length || hierarchyUids.some((uid, i) => uid !== catalogUnitUids[i])) {
    return {
      ok: false,
      kind: "misaligned",
      reason: `hierarchy lists ${hierarchyUids.length} units, catalog lists ${catalogUnitUids.length} (or their uids/order differ)`,
    };
  }
  return { ok: true, unitUrls };
}

/**
 * request() result from learn-http.mjs (called with captureErrorBody) ->
 * { ok, unitUrls } | { ok: false, kind, reason }.
 *
 * kind "not-found" is reserved for the API's own definitive answer
 * {"ErrorCode":"module_id_not_found","Retriable":false}. Verified live on
 * 2026-10-05 for four modules that the catalog API lists but that are NOT served:
 * the hierarchy API answers module_id_not_found, the module page and its first
 * unit url redirect (HTTP 200) to a learning-path page, and no learning path
 * references them. A bare 404 without that body (a CDN or routing 404) is just
 * "http-error".
 */
export function classifyHierarchy(result, ctx) {
  if (result.outcome === "ok") return parseHierarchy(result.body, ctx);
  if (result.outcome === "notFound") {
    if (isModuleIdNotFound(result.errorBody)) {
      return { ok: false, kind: "not-found", reason: `HTTP ${result.status} module_id_not_found (module unknown to the hierarchy API)` };
    }
    return { ok: false, kind: "http-error", reason: `HTTP ${result.status} without the hierarchy API's module_id_not_found body` };
  }
  if (result.outcome === "transient") return { ok: false, kind: "transient", reason: result.error ?? "transient failure" };
  return { ok: false, kind: "http-error", reason: result.error ?? `HTTP ${result.status}` };
}

/**
 * Whether the previous record's unitUrls can still be trusted for this record:
 * same signature, as many urls as the catalog has units, all under the module's
 * path, and the first one still equals the catalog's firstUnitUrl (a cheap
 * per-run cross-check that catches a stale snapshot the signature missed).
 * Returns null when reusable, otherwise the reason it is not.
 */
export function refreshReason(previous, record, firstUnitPath) {
  if (!previous) return "new";
  if (!Array.isArray(previous.unitUrls)) return "no-unit-urls";
  if (previous.unitSig !== record.unitSig) return "sig-changed";
  if (previous.unitUrls.length !== record.units.length) return "inconsistent";
  for (const url of previous.unitUrls) {
    if (typeof url !== "string" || !underPrefix(url, record.path) || url === record.path) return "inconsistent";
  }
  if (firstUnitPath && previous.unitUrls.length > 0 && previous.unitUrls[0] !== firstUnitPath) return "first-unit-moved";
  return null;
}

/**
 * Which modules need a hierarchy request this run.
 *  fullRefresh  -> all of them (reason "full")
 *  otherwise    -> those whose previous record is missing, has no unitUrls, has a
 *                  different unitSig or fails the consistency checks.
 * Returns { fetchUids, reuseUids, reasons } with reasons counted per cause.
 */
export function planUnitRefresh({ records, meta, previousByUid, fullRefresh }) {
  const fetchUids = [];
  const reuseUids = [];
  const reasons = {};
  for (const record of records) {
    const why = fullRefresh ? "full" : refreshReason(previousByUid.get(record.uid), record, meta.get(record.uid)?.firstUnitPath ?? null);
    if (why) {
      fetchUids.push(record.uid);
      reasons[why] = (reasons[why] ?? 0) + 1;
    } else {
      reuseUids.push(record.uid);
    }
  }
  return { fetchUids, reuseUids, reasons };
}

/**
 * Final unitUrls per module.
 *   reused       previous value, signature unchanged and consistent
 *   fetched ok   the fresh value
 *   fetch failed previous value ONLY if it is still trustworthy (same signature
 *                and consistent), otherwise null -- never an empty guess
 * fetchResults: Map<uid, { ok, unitUrls?, kind?, reason? }>.
 *
 * Also returns `notFoundUids`: the modules the hierarchy API definitively does not
 * know (kind "not-found", see classifyHierarchy). A module that was already
 * flagged last time and now fails TRANSIENTLY keeps its flag (a transient failure
 * says nothing new); a successful or otherwise-definitive answer clears it.
 */
export function resolveUnitUrls({ records, meta, previousByUid, plan, fetchResults }) {
  const unitUrlsByUid = new Map();
  const notFoundUids = new Set();
  const stats = {
    requests: plan.fetchUids.length,
    reused: plan.reuseUids.length,
    fetchedOk: 0,
    failures: 0,
    carriedForward: 0,
    nulls: 0,
    failureKinds: {},
    failureSamples: [],
  };
  const fetched = new Set(plan.fetchUids);
  for (const record of records) {
    const previous = previousByUid.get(record.uid);
    if (!fetched.has(record.uid)) {
      unitUrlsByUid.set(record.uid, previous.unitUrls);
      continue;
    }
    const result = fetchResults.get(record.uid);
    if (result?.ok) {
      stats.fetchedOk++;
      unitUrlsByUid.set(record.uid, result.unitUrls);
      continue;
    }
    stats.failures++;
    const kind = result?.kind ?? "missing-result";
    if (kind === "not-found" || (kind === "transient" && previous?.hierarchyNotFound === true)) notFoundUids.add(record.uid);
    stats.failureKinds[kind] = (stats.failureKinds[kind] ?? 0) + 1;
    if (stats.failureSamples.length < 10) stats.failureSamples.push({ uid: record.uid, kind, reason: result?.reason ?? "no result recorded" });
    if (previous && refreshReason(previous, record, meta.get(record.uid)?.firstUnitPath ?? null) === null) {
      stats.carriedForward++;
      unitUrlsByUid.set(record.uid, previous.unitUrls);
    } else {
      stats.nulls++;
      unitUrlsByUid.set(record.uid, null);
    }
  }
  stats.notFound = notFoundUids.size;
  return { unitUrlsByUid, notFoundUids, stats };
}
