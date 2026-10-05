/**
 * Network phases of the docs sync, driven by a plan() result: they run the
 * probes plan() asked for under one wall-clock deadline and one circuit
 * breaker per phase, and hand classified results to reconcile().
 *
 *   quarantine  re-check quarantined URLs (restored pages are released)
 *   missing     probe previously known URLs that fell out of the sitemaps
 *   fetch       GET <head> metadata of changed pages, then new pages
 *   verify      re-probe the oldest-checked catalog records
 *
 * Quarantine and missing run first: they keep the index and the quarantine
 * list truthful, which matters more than refreshing metadata. A phase that is
 * cut short (deadline, rate-limit storm) leaves its unstarted items undefined;
 * reconcile() keeps the previous data for those and counts them as deferrals.
 */

import { classifyProbe } from "./docs-redirects.mjs";
import { probeUrlFor } from "./docs-http.mjs";
import { CircuitBreaker, runPool } from "./docs-budget.mjs";

export const PHASES = ["quarantine", "missing", "fetch", "verify"];

/** Classified probe of a Learn page; `readHead` also returns the page <head> as `text`. */
export async function probeLearnPage(client, item, { readHead = false } = {}) {
  const raw = await client.probe(probeUrlFor(item.url), { readHead });
  return { ...classifyProbe(raw, item.path), text: raw.text || "" };
}

/**
 * Quarantine re-check of a non-Learn URL (github/docs entries): follow
 * redirects, 2xx/3xx = live, 404/410 = gone, anything else is transient.
 */
export async function probeExternalPage(client, item) {
  const r = await client.get(item.url, { headOnly: true });
  if (r.status === null || r.status === undefined) return { outcome: "transient", status: null };
  if (r.status === 404 || r.status === 410) return { outcome: "gone", status: r.status };
  if (r.status >= 200 && r.status < 400) return { outcome: "live", status: r.status };
  return { outcome: "transient", status: r.status };
}

const isTransient = (r) => r?.outcome === "transient";

/**
 * @param {object} args
 * @param {object} args.plan        plan() result
 * @param {object} args.client      docs-http client (probe/get)
 * @param {object} args.deadline    docs-budget createDeadline()
 * @param {number} args.breakerLimit consecutive transient results that stop a phase (0 = off)
 * @returns {{ results: object, degraded: boolean, stops: object, requests: object }}
 *   results.<phase>[i] pairs with plan.<phase>.items[i]; undefined = never ran
 *   stops.<phase> is "deadline" | "breaker" when the phase was cut short
 */
export async function runPhases({ plan, client, deadline, breakerLimit = 40, concurrency = 3, delayMs = 500, sleep, log = () => {}, only = PHASES }) {
  const work = {
    quarantine: {
      items: plan.quarantine.items,
      fn: (item) => (item.external ? probeExternalPage(client, item) : probeLearnPage(client, item)),
      label: "quarantine",
    },
    missing: { items: plan.missing.items, fn: (item) => probeLearnPage(client, item), label: "missing" },
    fetch: { items: plan.fetch.items, fn: (item) => probeLearnPage(client, item, { readHead: true }), label: "pages" },
    verify: { items: plan.verify.items, fn: (item) => probeLearnPage(client, item), label: "verify" },
  };
  const results = {};
  const stops = {};
  const requests = {};
  let degraded = false;
  for (const name of PHASES) {
    const { items, fn, label } = work[name];
    results[name] = [];
    if (!only.includes(name) || !items.length) continue;
    log(`\n${name}: ${items.length} item(s)`);
    const breaker = new CircuitBreaker(breakerLimit);
    const { results: out, processed, stoppedBy } = await runPool(items, fn, {
      concurrency,
      delayMs,
      sleep,
      shouldStop: deadline.expired,
      breaker,
      isTransient,
      label,
      log,
    });
    results[name] = out;
    requests[name] = processed;
    if (stoppedBy) {
      stops[name] = stoppedBy;
      if (stoppedBy === "breaker") degraded = true;
      log(
        stoppedBy === "breaker"
          ? `  ${name}: stopped after ${breakerLimit} consecutive transient failures (rate-limit storm?); ${items.length - processed} item(s) deferred`
          : `  ${name}: wall-clock budget exhausted; ${items.length - processed} item(s) deferred`
      );
    }
  }
  return { results, degraded, stops, requests };
}
