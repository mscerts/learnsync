/**
 * The cleaning step of the module-links run: check where every Learn link of the harvested records
 * points and rewrite or drop what is stale. The rules are in module-links.mjs ("Link cleaning");
 * this file only wires them to the validator (caches) and the live probe, both injectable.
 */

import { decideOffline, decideProbe, applyDecisions, learnPaths, planProbes } from "./module-links.mjs";
import { runPool, sleep } from "./learn-http.mjs";
import { interpretProbe, rawProbe } from "./live-probe.mjs";

const CHUNK = 50;

/**
 * One live check of a Learn path: live-probe.mjs `probe()` with one addition. Learn answers a page it
 * removed with a redirect to a marketing site (azure.microsoft.com, microsoft.com), which the stock
 * probe calls "unknown" (HTTP 301); for a link cache that means the Learn page is gone.
 * Returns { verdict: ok|broken|moved|unknown, detail, redirectsTo }.
 */
export async function probeLink(path, options = {}) {
  const raw = await rawProbe(path, options);
  if (raw.offsite && raw.finalUrl) {
    let host = "another site";
    try {
      host = new URL(raw.finalUrl).host;
    } catch {
      // keep the generic wording
    }
    return { verdict: "broken", detail: `redirects off Learn to ${host}`, redirectsTo: null };
  }
  if (raw.status == null) return { verdict: "unknown", detail: "no response after retries", redirectsTo: null };
  return interpretProbe(path, raw);
}

/**
 * records     the harvested records
 * validate    (paths) => Map(path -> validator result), cache-only (validateUrls over the loaded data)
 * probeImpl   async (path) => { verdict: ok|broken|moved|unknown, redirectsTo } (default: probeLink above)
 * Returns { records, stats, broke }: `broke` is true when the live checks were inconclusive in more than
 * half of the first requests (a dead site): the rest was not probed and counts as unverified.
 */
export async function cleanRecords({
  records,
  validate,
  probeImpl = probeLink,
  today,
  maxProbes,
  recheckDays,
  delayMs,
  breakerMin = 50,
  sleepImpl = sleep,
  log = () => {},
}) {
  const paths = learnPaths(records);
  const verdicts = validate(paths);
  const decisions = new Map();
  const undecided = [];
  for (const path of paths) {
    const decision = decideOffline(verdicts.get(path));
    if (decision) decisions.set(path, decision);
    else undecided.push(path);
  }
  const plan = planProbes({ records, paths: undecided, today, recheckDays, maxProbes });
  for (const path of plan.fresh) decisions.set(path, { action: "keep", via: "fresh" });
  for (const path of plan.waiting) decisions.set(path, { action: "unverified", via: "budget" });

  log(`Link cleaning: ${paths.length} Learn targets, ${paths.length - undecided.length} settled by the caches, ${plan.fresh.length} confirmed recently, ${plan.toProbe.length} to check live${plan.waiting.length ? `, ${plan.waiting.length} waiting for the next run` : ""}.`);

  let probed = 0;
  let unknown = 0;
  let dropped = 0;
  let broke = false;
  for (let from = 0; from < plan.toProbe.length; from += CHUNK) {
    const chunk = broke ? [] : plan.toProbe.slice(from, from + CHUNK);
    if (broke) {
      for (const path of plan.toProbe.slice(from)) decisions.set(path, { action: "unverified", via: "breaker" });
      break;
    }
    const outcomes = await runPool(chunk, (path) => probeImpl(path), { delayMs, sleepImpl });
    chunk.forEach((path, i) => {
      const decision = decideProbe(path, outcomes[i]);
      decisions.set(path, decision);
      probed++;
      if (decision.action === "unverified") unknown++;
      if (decision.action === "drop") dropped++;
    });
    log(`  ${probed} of ${plan.toProbe.length} live checks done`);
    if (probed >= breakerMin && unknown * 2 > probed) broke = true;
  }

  const applied = applyDecisions({ records, decisions, today });
  return {
    records: applied.records,
    broke,
    stats: {
      targets: paths.length,
      settledByCaches: paths.length - undecided.length,
      fresh: plan.fresh.length,
      probed,
      probeUnknown: unknown,
      probeDropped: dropped,
      waiting: plan.waiting.length,
      links: applied.counts,
      rewrittenPaths: applied.rewrittenPaths.length,
      droppedPaths: applied.droppedPaths.length,
    },
  };
}
