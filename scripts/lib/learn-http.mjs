/**
 * Polite HTTP for the Learn syncs. learn.microsoft.com returns HTTP 429
 * aggressively above ~3 concurrent requests, so every network call goes through
 * here: a per-request timeout, exponential backoff on 429/5xx/network errors that
 * honours Retry-After, definitive answers (404/410) that are never retried, and a
 * worker pool with a hard concurrency cap and a delay per worker.
 *
 * `fetchImpl` and `sleepImpl` are injectable so the unit tests never touch the
 * network and never really wait.
 */

export const USER_AGENT = "learnsync/2.0 (+https://github.com/mscerts/learnsync; Microsoft Learn cache sync)";

/** Hard ceiling: asking the pool for more workers than this is clamped, not obeyed. */
export const MAX_CONCURRENCY = 3;
export const DEFAULT_DELAY_MS = 500;

export const HTTP_DEFAULTS = Object.freeze({
  attempts: 5,
  timeoutMs: 30_000,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
  maxRetryAfterMs: 120_000,
});

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retry-After header (delta-seconds or HTTP date) -> milliseconds, or null when absent/unparseable. */
export function parseRetryAfter(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "") return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const when = Date.parse(text);
  if (Number.isNaN(when)) return null;
  return Math.max(0, when - nowMs);
}

/**
 * Wait before retry number `attemptIndex + 1`: exponential backoff, but never
 * less than the server's Retry-After (itself capped at maxRetryAfterMs).
 */
export function backoffDelay(attemptIndex, opts = {}) {
  const { baseBackoffMs, maxBackoffMs, maxRetryAfterMs, retryAfterMs = null } = { ...HTTP_DEFAULTS, ...opts };
  const exponential = Math.min(maxBackoffMs, baseBackoffMs * 2 ** attemptIndex);
  const retryAfter = retryAfterMs === null ? 0 : Math.min(maxRetryAfterMs, retryAfterMs);
  return Math.max(exponential, retryAfter);
}

/** "ok" | "notFound" (definitive, never retried) | "retry" | "error" (any other status, never retried). */
export function classifyStatus(status) {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 410) return "notFound";
  if (status === 429 || status === 408 || status >= 500) return "retry";
  return "error";
}

async function discard(res) {
  try {
    await res.body?.cancel();
  } catch {
    // body already consumed or closed
  }
}

/** First `limit` characters of an error response body (never throws). */
async function readSnippet(res, limit = 2000) {
  try {
    return (await res.text()).slice(0, limit);
  } catch {
    return null;
  }
}

function describeError(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return String(err?.message || err);
}

/**
 * One logical request with retries. Never throws for HTTP/network problems.
 * Returns { outcome, status, finalUrl, body, errorBody, error, attempts } where outcome is
 *   "ok"        2xx (body read according to `read`: "json" | "text" | "none")
 *   "notFound"  404/410 (definitive, no retry)
 *   "error"     any other status such as 400/401/403 (no retry; caller decides)
 *   "transient" 429/408/5xx, network error, timeout or unreadable body, after all attempts
 * With `captureErrorBody: true` the text of a "notFound"/"error" response is
 * returned as `errorBody` (first 2,000 characters) so the caller can tell a
 * specific API error from a generic 404.
 */
export async function request(url, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    sleepImpl = sleep,
    headers = {},
    read = "none",
    attempts = HTTP_DEFAULTS.attempts,
    timeoutMs = HTTP_DEFAULTS.timeoutMs,
    baseBackoffMs = HTTP_DEFAULTS.baseBackoffMs,
    maxBackoffMs = HTTP_DEFAULTS.maxBackoffMs,
    maxRetryAfterMs = HTTP_DEFAULTS.maxRetryAfterMs,
    onRetry,
    captureErrorBody = false,
  } = options;

  let lastStatus = null;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt++) {
    let retryAfterMs = null;
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": USER_AGENT, ...headers },
      });
      const kind = classifyStatus(res.status);
      if (kind === "ok") {
        let body = null;
        if (read === "json") body = await res.json();
        else if (read === "text") body = await res.text();
        else await discard(res);
        return { outcome: "ok", status: res.status, finalUrl: res.url || url, body, errorBody: null, error: null, attempts: attempt + 1 };
      }
      if (kind === "notFound" || kind === "error") {
        let errorBody = null;
        if (captureErrorBody) errorBody = await readSnippet(res);
        else await discard(res);
        return { outcome: kind, status: res.status, finalUrl: res.url || url, body: null, errorBody, error: `HTTP ${res.status}`, attempts: attempt + 1 };
      }
      await discard(res);
      lastStatus = res.status;
      lastError = `HTTP ${res.status}`;
      retryAfterMs = parseRetryAfter(res.headers?.get?.("retry-after"));
    } catch (err) {
      // network failure, timeout, or a 2xx body that could not be read/parsed
      lastStatus = null;
      lastError = describeError(err);
    }
    if (attempt < attempts - 1) {
      const waitMs = backoffDelay(attempt, { baseBackoffMs, maxBackoffMs, maxRetryAfterMs, retryAfterMs });
      onRetry?.({ url, attempt: attempt + 1, error: lastError, waitMs });
      await sleepImpl(waitMs);
    }
  }
  return { outcome: "transient", status: lastStatus, finalUrl: null, body: null, errorBody: null, error: lastError, attempts };
}

/** GET JSON or throw: for the few mandatory catalog downloads where any failure must abort the run. */
export async function fetchJson(url, options = {}) {
  const result = await request(url, { ...options, read: "json" });
  if (result.outcome !== "ok") {
    throw new Error(`Failed to fetch ${url}: ${result.error ?? result.outcome} (after ${result.attempts} attempt(s))`);
  }
  return result.body;
}

/**
 * Runs `worker(item, index)` over `items` with at most MAX_CONCURRENCY workers
 * (`concurrency` is clamped) and `delayMs` of pause per worker between items.
 * Results come back in input order. A worker that throws rejects the pool.
 */
export async function runPool(items, worker, options = {}) {
  const { concurrency = MAX_CONCURRENCY, delayMs = DEFAULT_DELAY_MS, sleepImpl = sleep, onProgress, progressEvery = 250 } = options;
  const results = new Array(items.length);
  if (items.length === 0) return results;
  const workers = Math.max(1, Math.min(concurrency, MAX_CONCURRENCY, items.length));
  let next = 0;
  let done = 0;

  async function run() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
      done++;
      if (onProgress && (done % progressEvery === 0 || done === items.length)) onProgress(done, items.length);
      if (next < items.length) await sleepImpl(delayMs);
    }
  }

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
