#!/usr/bin/env node
/**
 * Validate learn.microsoft.com URLs against the learnsync caches.
 *
 * Usage:
 *   node scripts/validate-urls.mjs --input urls.json [--output verdicts.json]
 *        [--data <dir>] [--confirm-live] [--probe-unverifiable]
 *        [--concurrency 3] [--delay 500]
 *   cat urls.json | node scripts/validate-urls.mjs > verdicts.json
 *
 * Input: a JSON array of URL strings (or objects with a `url` field).
 * Output: { generatedAt, dataDir, freshness, summary, probed, results } (JSON).
 *
 * Cache-only by default (no network). --confirm-live re-probes every
 * broken/moved verdict against learn.microsoft.com and --probe-unverifiable
 * probes the classes no cache can answer; both label their verdicts
 * evidence "live-probe". See DATA_CONTRACT.md.
 *
 * When data/changes/removed.json and moved.json exist, a broken or moved result also
 * carries a `change` object (what those files recorded for the link). A live check
 * that finds the page healthy overrides that record, so `change` is dropped from
 * results the live layer turned `valid`. To ask the change files alone (no caches),
 * use scripts/check-changes.mjs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dropOverriddenChange, loadData, validateUrls, summarize } from "./lib/validate.mjs";
import { liveLayer } from "./lib/live-probe.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function parseArgs(argv) {
  const opts = {
    data: join(root, "data"),
    input: null,
    output: null,
    confirmLive: false,
    probeUnverifiable: false,
    concurrency: 3,
    delay: 500,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--data") opts.data = value();
    else if (a === "--input") opts.input = value();
    else if (a === "--output") opts.output = value();
    else if (a === "--confirm-live") opts.confirmLive = true;
    else if (a === "--probe-unverifiable") opts.probeUnverifiable = true;
    else if (a === "--concurrency") opts.concurrency = Number(value());
    else if (a === "--delay") opts.delay = Number(value());
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const raw = opts.input ? readFileSync(opts.input, "utf-8") : readFileSync(0, "utf-8");
  const urls = JSON.parse(raw);
  if (!Array.isArray(urls)) throw new Error("input must be a JSON array");

  const data = loadData(opts.data);
  let { results, freshness } = validateUrls(urls, data);
  let probed = 0;
  if (opts.confirmLive || opts.probeUnverifiable) {
    const live = await liveLayer(results, {
      confirmLive: opts.confirmLive,
      probeUnverifiable: opts.probeUnverifiable,
      concurrency: opts.concurrency,
      delayMs: opts.delay,
    });
    results = dropOverriddenChange(live.results);
    probed = live.probed;
  }
  const out = {
    generatedAt: new Date().toISOString(),
    dataDir: opts.data,
    freshness,
    summary: summarize(results),
    probed,
    results,
  };
  const text = JSON.stringify(out, null, 2) + "\n";
  if (opts.output) writeFileSync(opts.output, text);
  else process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
