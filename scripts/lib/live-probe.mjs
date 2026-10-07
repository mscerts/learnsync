/**
 * Optional live layer for the validator: confirm a cached negative verdict (or
 * probe a class no cache can answer) against learn.microsoft.com. Every verdict
 * it produces is labelled evidence "live-probe". Rate limits, timeouts and 5xx
 * are "unknown" and never change a verdict. See DATA_CONTRACT.md.
 *
 * Learn answers a removed training module with HTTP 200 and a redirect to
 * "Browse all training", to a docs page or to a learning path, so a status code
 * alone is not enough: interpretProbe() looks at the final path and the title.
 */

import { canonicalPath, LEARN_HOST } from "./canonical.mjs";

export const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXAM_PAGE = /^\/credentials\/certifications\/exams\/[^/]+$/;
const CERTIFICATION_PAGE = /^\/credentials\/certifications\/(?!exams$|resources$)[^/]+$/;
const STUDY_GUIDE = /^\/credentials\/(?:certifications|applied-skills)\/resources\/study-guides\/[^/]+$/;

/**
 * Pure: turn one HTTP outcome into { verdict: "ok" | "broken" | "moved" | "unknown",
 * detail, redirectsTo (canonical path or null) }.
 */
export function interpretProbe(requestedPath, { status, finalUrl, title }) {
  if (status == null) return { verdict: "unknown", detail: "no response", redirectsTo: null };
  if (status === 404 || status === 410) return { verdict: "broken", detail: `HTTP ${status}`, redirectsTo: null };
  if (status !== 200) return { verdict: "unknown", detail: `HTTP ${status}`, redirectsTo: null };
  const finalPath = finalUrl ? canonicalPath(finalUrl) : null;
  if (/^404\b|content not found/i.test(title ?? "")) {
    return { verdict: "broken", detail: "HTTP 200 but the page is a not-found page", redirectsTo: null };
  }
  if (/^browse all training/i.test(title ?? "") || finalPath?.startsWith("/training/browse")) {
    return { verdict: "broken", detail: "removed (redirects to Browse all training)", redirectsTo: null };
  }
  if (finalPath && finalPath !== requestedPath) {
    // Learn serves a current exam by redirecting its /exams/<code> URL to the
    // certification page: that is how a healthy exam link behaves.
    if (EXAM_PAGE.test(requestedPath) && CERTIFICATION_PAGE.test(finalPath)) {
      return { verdict: "ok", detail: "", redirectsTo: null };
    }
    // A study guide that does not exist redirects (for example to /credentials/browse).
    if (STUDY_GUIDE.test(requestedPath)) {
      return { verdict: "broken", detail: `study guide does not exist (redirects to ${finalPath})`, redirectsTo: null };
    }
    if (requestedPath.startsWith("/training/modules/") && !finalPath.startsWith("/training/modules/")) {
      return { verdict: "broken", detail: `no longer exists (redirects to ${finalPath})`, redirectsTo: finalPath };
    }
    return { verdict: "moved", detail: `redirects to ${finalPath}`, redirectsTo: finalPath };
  }
  return { verdict: "ok", detail: "", redirectsTo: null };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** One request (no redirect following) with retries and backoff; null when no usable response came back. */
async function fetchHop(url, { retries, timeoutMs, userAgent, fetchImpl, sleepImpl }) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const last = attempt === retries - 1;
    try {
      const res = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": userAgent, Accept: "text/html" },
      });
      if (res.status === 429 || res.status >= 500) {
        res.body?.cancel?.().catch(() => {});
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        if (!last) await sleepImpl(Math.max(retryAfter * 1000, 3000 * (attempt + 1)));
        continue;
      }
      const location = res.headers.get("location");
      let title = "";
      if (res.status === 200) {
        const text = await res.text();
        title = text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
      } else {
        res.body?.cancel?.().catch(() => {});
      }
      return { status: res.status, location, title };
    } catch {
      if (!last) await sleepImpl(1500 * (attempt + 1));
    }
  }
  return null;
}

/**
 * Raw live probe: the HTTP facts about one page, with no interpretation. Redirects
 * are followed by hand so the status of the FIRST hop stays visible (the change
 * files record it). Same headers, retries, backoff and Retry-After handling as
 * probe(). NEVER throws: a network error, a timeout, 429/5xx after every retry and
 * a redirect loop all come back as `status: null` plus an `error` text, which
 * every caller must read as "unknown", never as "gone".
 *
 * Returns { status, firstStatus, finalUrl, title, hops, offsite, error }
 *   status       status of the final response (null = no usable response); for an
 *                off-site hop, the status of that redirect
 *   firstStatus  status of the first response (301/302/... when the URL redirects)
 *   finalUrl     where the chain ended (off-site: the first foreign URL)
 *   title        <title> of a final HTTP 200 page, else ""
 *   hops         [{ status, location }] followed redirects
 *   offsite      true when the chain left learn.microsoft.com (that URL is not requested)
 */
export async function rawProbe(
  path,
  { retries = 5, timeoutMs = 20_000, userAgent = BROWSER_UA, fetchImpl = fetch, sleepImpl = sleep, maxHops = 8 } = {}
) {
  const failed = (error, firstStatus, finalUrl, hops) => ({ status: null, firstStatus, finalUrl, title: "", hops, offsite: false, error });
  let current = `https://${LEARN_HOST}/en-us${path === "/" ? "" : path}/`;
  let firstStatus = null;
  const hops = [];
  try {
    for (let hop = 0; hop <= maxHops; hop++) {
      const res = await fetchHop(current, { retries, timeoutMs, userAgent, fetchImpl, sleepImpl });
      if (!res) return failed("no response after retries", firstStatus, hop === 0 ? null : current, hops);
      if (hop === 0) firstStatus = res.status;
      if (REDIRECT_STATUSES.has(res.status) && res.location) {
        let next;
        try {
          next = new URL(res.location, current);
        } catch {
          return failed(`bad Location header: ${res.location}`, firstStatus, current, hops);
        }
        hops.push({ status: res.status, location: next.href });
        if (next.hostname.toLowerCase() !== LEARN_HOST) {
          return { status: res.status, firstStatus, finalUrl: next.href, title: "", hops, offsite: true, error: null };
        }
        current = next.href;
        continue;
      }
      return { status: res.status, firstStatus, finalUrl: current, title: res.title, hops, offsite: false, error: null };
    }
    return failed("too many redirects", firstStatus, current, hops);
  } catch (err) {
    return failed(String(err?.message || err), firstStatus, null, hops);
  }
}

/** One live probe with retries and backoff. Returns the interpretProbe() shape. */
export async function probe(path, options = {}) {
  const raw = await rawProbe(path, options);
  if (raw.status == null) return { verdict: "unknown", detail: "no response after retries", redirectsTo: null };
  return interpretProbe(path, raw);
}

/** Probe many paths politely (low concurrency, delay between requests). */
export async function probeMany(paths, { concurrency = 3, delayMs = 500, probeImpl = probe } = {}) {
  const out = new Array(paths.length);
  let next = 0;
  async function worker() {
    while (next < paths.length) {
      const i = next++;
      out[i] = await probeImpl(paths[i]);
      await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker));
  return out;
}

/** Pure: fold a live outcome into a cached validator result. */
export function applyProbe(res, outcome) {
  const base = { ...res, cacheVerdict: res.verdict, cacheReason: res.reason };
  const absolute = (p) => (p ? `https://${LEARN_HOST}${p}` : null);
  switch (outcome.verdict) {
    case "ok":
      return {
        ...base,
        verdict: "valid",
        reason: `live check: page is reachable (cache said: ${res.reason})`,
        evidence: "live-probe",
        confidence: "high",
        redirectsTo: null,
        suggestion: null,
      };
    case "broken":
      return {
        ...base,
        verdict: "broken",
        reason: `live check: ${outcome.detail}`,
        evidence: "live-probe",
        confidence: "high",
        redirectsTo: outcome.redirectsTo,
        suggestion: absolute(outcome.redirectsTo) ?? res.suggestion,
      };
    case "moved":
      return {
        ...base,
        verdict: "moved",
        reason: `live check: ${outcome.detail}`,
        evidence: "live-probe",
        confidence: "high",
        redirectsTo: outcome.redirectsTo,
        suggestion: absolute(outcome.redirectsTo),
      };
    default:
      return { ...base, liveNote: `live check inconclusive (${outcome.detail}); cached verdict kept` };
  }
}

/**
 * Re-probe results live. Selects non-valid verdicts (`confirmLive`) and/or
 * unverifiable ones (`probeUnverifiable`); results with no canonical path are skipped.
 */
export async function liveLayer(results, { confirmLive, probeUnverifiable, concurrency, delayMs, probeImpl } = {}) {
  const wanted = (r) =>
    r.path &&
    ((confirmLive && (r.verdict === "broken" || r.verdict === "moved")) || (probeUnverifiable && r.verdict === "unverifiable"));
  const indexes = results.map((r, i) => (wanted(r) ? i : -1)).filter((i) => i >= 0);
  const outcomes = await probeMany(
    indexes.map((i) => results[i].path),
    { concurrency, delayMs, probeImpl }
  );
  const next = results.slice();
  indexes.forEach((i, n) => {
    next[i] = applyProbe(results[i], outcomes[n]);
  });
  return { results: next, probed: indexes.length };
}
