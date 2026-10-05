/**
 * Run budgets for the network phases of the docs sync: a bounded worker pool,
 * a per-phase circuit breaker for rate-limit storms and a wall-clock deadline.
 * No network code here; the work function is injected, so everything is
 * testable with fake workers and a fake clock.
 */

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Trips after `limit` CONSECUTIVE transient results (completion order). Any
 * non-transient result resets the streak. Once tripped it stays tripped for
 * the phase it guards.
 */
export class CircuitBreaker {
  constructor(limit) {
    this.limit = limit;
    this.streak = 0;
    this.tripped = false;
  }

  record(isTransient) {
    if (this.tripped) return;
    this.streak = isTransient ? this.streak + 1 : 0;
    if (this.limit > 0 && this.streak >= this.limit) this.tripped = true;
  }
}

/** Wall-clock budget. `minutes <= 0` means unlimited. */
export function createDeadline(minutes, now = Date.now) {
  const startedAt = now();
  const endsAt = minutes > 0 ? startedAt + minutes * 60000 : Infinity;
  return {
    startedAt,
    expired: () => now() >= endsAt,
    elapsedSeconds: () => Math.round((now() - startedAt) / 1000),
  };
}

/**
 * Runs `fn` over `items` with `concurrency` workers and a per-worker delay.
 *
 * Workers stop taking new items as soon as `shouldStop()` is true or the
 * breaker has tripped. Items never started leave their slot `undefined` in
 * `results`, which callers treat as "deferred, keep the old data".
 *
 * Returns { results, processed, stoppedBy } with stoppedBy one of
 * null | "deadline" | "breaker".
 */
export async function runPool(items, fn, opts = {}) {
  const {
    concurrency = 3,
    delayMs = 500,
    sleep = defaultSleep,
    shouldStop = () => false,
    breaker = null,
    isTransient = () => false,
    label = "",
    log = () => {},
    progressEvery = 250,
  } = opts;
  const results = new Array(items.length);
  let next = 0;
  let processed = 0;
  let stoppedBy = null;
  const t0 = Date.now();

  async function worker() {
    while (next < items.length) {
      if (breaker?.tripped) {
        stoppedBy ||= "breaker";
        return;
      }
      if (shouldStop()) {
        stoppedBy ||= "deadline";
        return;
      }
      const i = next++;
      const r = await fn(items[i], i);
      results[i] = r;
      processed++;
      breaker?.record(isTransient(r));
      if (label && (processed % progressEvery === 0 || processed === items.length)) {
        log(`  ${label}: ${processed}/${items.length} (${Math.round((Date.now() - t0) / 1000)}s)`);
      }
      await sleep(delayMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), items.length) }, worker));
  if (!stoppedBy && breaker?.tripped && processed < items.length) stoppedBy = "breaker";
  return { results, processed, stoppedBy };
}
