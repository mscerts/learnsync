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

/** One live probe with retries and backoff. Returns the interpretProbe() shape. */
export async function probe(path, { retries = 5, timeoutMs = 20_000, userAgent = BROWSER_UA, fetchImpl = fetch } = {}) {
  const url = `https://${LEARN_HOST}/en-us${path}/`;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": userAgent, Accept: "text/html" },
      });
      if (res.status === 429 || res.status >= 500) {
        res.body?.cancel?.().catch(() => {});
        const retryAfter = Number(res.headers.get("retry-after")) || 0;
        await sleep(Math.max(retryAfter * 1000, 3000 * (attempt + 1)));
        continue;
      }
      const text = res.status === 200 ? await res.text() : "";
      const title = text.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "";
      return interpretProbe(path, { status: res.status, finalUrl: res.url, title });
    } catch {
      await sleep(1500 * (attempt + 1));
    }
  }
  return { verdict: "unknown", detail: "no response after retries", redirectsTo: null };
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
