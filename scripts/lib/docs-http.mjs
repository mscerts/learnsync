/**
 * HTTP layer for the docs sync (the only module that talks to the network).
 * `fetch`, the clock and the sleep function are injected so the retry,
 * cooldown and redirect logic is unit-tested without a network.
 *
 * Learn answers HTTP 429 above roughly 3 concurrent requests, so every request
 * goes through one client that:
 *   - retries 429 / 5xx / network errors with exponential backoff, honouring
 *     Retry-After (capped), and
 *   - shares a cooldown across all workers: when one worker is told to back
 *     off, every worker waits, instead of each one finding the limit alone.
 */

import { LEARN_HOST } from "./canonical.mjs";
import { HTTP_REDIRECT_STATUSES } from "./docs-redirects.mjs";

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Probe URL for a page: always the explicit /en-us/ form, so a probe is one
 * request instead of "302 to /en-us" plus the real one. Accepts a legacy URL
 * (https://learn.microsoft.com/azure/x) or a canonical path (/azure/x).
 */
export function probeUrlFor(urlOrPath) {
  let path = urlOrPath;
  if (/^https?:\/\//i.test(urlOrPath)) {
    const u = new URL(urlOrPath);
    path = u.pathname;
  }
  path = path.replace(/^\/en-us(?=\/|$)/i, "");
  return `https://${LEARN_HOST}/en-us${path === "/" ? "" : path}`;
}

export function createHttpClient(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    now = Date.now,
    userAgent = "learnsync/2.0 (+https://github.com/mscerts/learnsync; docs index + metadata cache)",
    timeoutMs = 15000,
    bigTimeoutMs = 120000,
    maxRetries = 3,
    baseBackoffMs = 2000,
    maxBackoffMs = 60000,
    maxHops = 5,
    headReadLimitBytes = 512 * 1024,
  } = options;

  let cooldownUntil = 0;
  const stats = { requests: 0, retries: 0, rateLimited: 0 };

  async function waitCooldown() {
    const wait = cooldownUntil - now();
    if (wait > 0) await sleep(wait);
  }

  function backoffMs(attempt, retryAfterHeader) {
    const ra = Number(retryAfterHeader);
    const exp = baseBackoffMs * 2 ** attempt;
    return Math.min(maxBackoffMs, ra > 0 ? Math.max(ra * 1000, baseBackoffMs) : exp);
  }

  /**
   * One logical request with retries. readMode: "none" (cancel the body),
   * "head" (read until </head>), "full" (read everything).
   * Returns { status, location, url, text } or { status: null, error }.
   */
  async function request(url, { method = "GET", accept = "text/html,application/xhtml+xml", redirect = "follow", readMode = "none", timeout = timeoutMs } = {}) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      await waitCooldown();
      stats.requests++;
      try {
        const res = await fetchImpl(url, {
          method,
          redirect,
          signal: AbortSignal.timeout(timeout),
          headers: { "User-Agent": userAgent, Accept: accept },
        });
        if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
          res.body?.cancel().catch(() => {});
          const delay = backoffMs(attempt, res.headers.get("retry-after"));
          if (res.status === 429) {
            stats.rateLimited++;
            cooldownUntil = Math.max(cooldownUntil, now() + delay);
          }
          stats.retries++;
          await sleep(delay);
          continue;
        }
        let text = "";
        if (res.ok && res.body && readMode !== "none" && method !== "HEAD") {
          if (readMode === "head") {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let bytes = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              bytes += value.length;
              text += decoder.decode(value, { stream: true });
              if (/<\/head>/i.test(text) || bytes > headReadLimitBytes) {
                reader.cancel().catch(() => {});
                break;
              }
            }
          } else {
            text = await res.text();
          }
        } else {
          res.body?.cancel().catch(() => {});
        }
        return { status: res.status, location: res.headers.get("location"), url: res.url || url, text };
      } catch (err) {
        if (attempt < maxRetries) {
          stats.retries++;
          await sleep(Math.min(maxBackoffMs, baseBackoffMs * (attempt + 1)));
          continue;
        }
        return { status: null, error: String(err?.message || err) };
      }
    }
    return { status: null, error: "retries exhausted" };
  }

  /** Plain GET following redirects (sitemap files, external pages). */
  async function get(url, { accept = "text/html,application/xhtml+xml", headOnly = false, big = false } = {}) {
    const r = await request(url, {
      accept,
      redirect: "follow",
      readMode: headOnly ? "head" : "full",
      timeout: big ? bigTimeoutMs : timeoutMs,
    });
    return r.status === null ? r : { status: r.status, finalUrl: r.url, text: r.text };
  }

  /**
   * Probes a Learn page, following redirects by hand so the first hop's real
   * status and the whole chain are visible.
   *
   * Always GET, never HEAD: Learn answers HEAD differently from GET (observed
   * 2026-10: HEAD returned 200 for a page whose GET redirects to a 404), so a
   * HEAD probe can call a removed page live. A GET whose body is cancelled
   * right after the headers costs about the same.
   *
   *   readHead  true: also read the <head> of the final page (metadata);
   *             false: status and redirect chain only, the body is dropped.
   *
   * Returns { status, firstStatus, finalUrl, hops, offsite, text, error?,
   * tooManyHops? }. `status` is the final response status; off-site
   * destinations are never requested (status = the hop's own status).
   */
  async function probe(url, { readHead = false } = {}) {
    let current = url;
    const hops = [];
    let firstStatus = null;
    for (let i = 0; i <= maxHops; i++) {
      const r = await request(current, { method: "GET", redirect: "manual", readMode: readHead ? "head" : "none" });
      if (r.status === null) return { status: null, firstStatus, finalUrl: current, hops, offsite: false, text: "", error: r.error };
      if (i === 0) firstStatus = r.status;
      if (HTTP_REDIRECT_STATUSES.has(r.status) && r.location) {
        let next;
        try {
          next = new URL(r.location, current);
        } catch {
          return { status: null, firstStatus, finalUrl: current, hops, offsite: false, text: "", error: `bad Location header: ${r.location}` };
        }
        hops.push({ status: r.status, location: next.href });
        if (next.hostname.toLowerCase() !== LEARN_HOST) {
          return { status: r.status, firstStatus, finalUrl: next.href, hops, offsite: true, text: "" };
        }
        current = next.href;
        continue;
      }
      return { status: r.status, firstStatus, finalUrl: current, hops, offsite: false, text: r.text };
    }
    return { status: null, firstStatus, finalUrl: current, hops, offsite: false, text: "", tooManyHops: true, error: "too many redirects" };
  }

  return { get, probe, request, stats };
}
