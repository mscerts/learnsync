/**
 * Shared fixtures for the docs sync run tests (docs-run.test.mjs, docs-changes.test.mjs):
 * a fake learn.microsoft.com (sitemaps and pages), a temp data directory and a `run()`
 * that drives runDocsSync with every side effect injected. No test using it touches the
 * network or the real data files. (node --test also loads this file as a test file: it
 * declares no tests, which is fine.)
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalPath } from "../scripts/lib/canonical.mjs";
import { readConfig } from "../scripts/lib/docs-config.mjs";
import { runDocsSync } from "../scripts/lib/docs-run.mjs";
import { SITEMAP_INDEX_URL } from "../scripts/lib/docs-sitemap-pass.mjs";

export const ORIGIN = "https://learn.microsoft.com";

// ---- a fake learn.microsoft.com: sitemaps and pages, no network ---------------------------

export class FakeLearn {
  constructor() {
    this.families = new Map(); // family -> { entries: [[path, lastmod]], fail: status|null }
    this.pages = new Map(); // canonical path -> behaviour
    this.probes = [];
    this.gets = [];
    this.t = Date.parse("2026-10-05T10:00:00Z");
    this.tickMs = 0;
  }
  family(name, entries, fail = null) {
    this.families.set(name, { entries, fail });
  }
  failFamily(name, status = 500) {
    this.families.get(name).fail = status;
  }
  page(path, behaviour) {
    this.pages.set(path, behaviour);
  }
  raw(path, readHead) {
    const b = this.pages.get(path) ?? "live";
    const url = `${ORIGIN}/en-us${path}`;
    const html = (title) => `<html><head><title>${title} | Microsoft Learn</title><meta name="description" content="About ${title}"><meta name="ms.service" content="svc"></head><body/></html>`;
    if (b === "live") return { status: 200, firstStatus: 200, finalUrl: url, hops: [], offsite: false, text: readHead ? html(`Page ${path}`) : "" };
    if (b.title) return { status: 200, firstStatus: 200, finalUrl: url, hops: [], offsite: false, text: readHead ? html(b.title) : "" };
    if (b === "gone") return { status: 404, firstStatus: 404, finalUrl: url, hops: [], offsite: false, text: "" };
    if (b === "transient") return { status: 429, firstStatus: 429, finalUrl: url, hops: [], offsite: false, text: "" };
    if (b.to) return { status: 200, firstStatus: 301, finalUrl: `${ORIGIN}/en-us${b.to}`, hops: [{ status: 301 }], offsite: false, text: readHead ? html("Elsewhere") : "" };
    throw new Error(`bad behaviour ${JSON.stringify(b)}`);
  }
  xml(name) {
    const { entries } = this.families.get(name);
    return `<?xml version="1.0"?><urlset>${entries.map(([p, lm]) => `<url><loc>${ORIGIN}/en-us${p}</loc>${lm ? `<lastmod>${lm}</lastmod>` : ""}</url>`).join("")}</urlset>`;
  }
  client() {
    const learn = this;
    return {
      stats: { requests: 0 },
      async get(url) {
        learn.gets.push(url);
        if (url === SITEMAP_INDEX_URL) {
          const files = [...learn.families.keys()].map((f) => `<sitemap><loc>${ORIGIN}/_sitemaps/${f}_en-us_1.xml</loc></sitemap>`);
          return { status: 200, text: `<sitemapindex>${files.join("")}</sitemapindex>` };
        }
        const m = url.match(/_sitemaps\/(.+)_en-us_1\.xml$/);
        if (m && learn.families.has(m[1])) {
          const f = learn.families.get(m[1]);
          if (f.fail) return { status: f.fail, text: "" };
          return { status: 200, text: learn.xml(m[1]) };
        }
        return { status: 200, text: "" };
      },
      async probe(url, { readHead = false } = {}) {
        learn.t += learn.tickMs;
        const path = canonicalPath(url);
        learn.probes.push({ path, readHead });
        return learn.raw(path, readHead);
      },
    };
  }
}

// ---- harness --------------------------------------------------------------------------------

/** Every file under `dir` as { "relative/path": text }, sorted, subdirectories included. */
function readTree(dir, base = "") {
  const out = {};
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(out, readTree(join(dir, entry.name), rel));
    else out[rel] = readFileSync(join(dir, entry.name), "utf-8");
  }
  return out;
}

export function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), "docs-run-"));
  const data = join(dir, "data");
  mkdirSync(data);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = (name) => join(data, name);
  const read = (name) => readFileSync(file(name), "utf-8");
  const json = (name) => JSON.parse(read(name));
  const snapshot = () => readTree(data);
  return { dir, data, file, read, json, snapshot };
}

/** One run. `when` is the fake "now"; extra env/config overrides go in `opts`. */
export async function run(h, learn, { when = "2026-10-05T10:00:00Z", env = {}, config = {}, ...rest } = {}) {
  learn.probes = [];
  learn.gets = [];
  learn.t = Date.parse(when);
  const reportFile = join(h.dir, "report.md");
  const githubOutput = join(h.dir, "github-output.txt");
  const messages = [];
  const result = await runDocsSync({
    dataDir: h.data,
    client: learn.client(),
    env: {},
    config: { ...readConfig(env), delayMs: 0, reportFile, githubOutput, ...config },
    log: (m) => messages.push(String(m)),
    warn: (m) => messages.push(`WARN ${m}`),
    now: () => new Date(learn.t),
    sleep: async () => {},
    sitemapDelayMs: 0,
    catalogMinAbsolute: 1,
    ...rest,
  });
  return { ...result, messages, reportFile, githubOutput, probes: learn.probes, gets: learn.gets };
}

export const pad = (n) => String(n).padStart(2, "0");
export const stable = (prefix, n, lastmod = "2026-09-01") => Array.from({ length: n }, (_, i) => [`/${prefix}/s${pad(i)}`, lastmod]);

/** A fake Learn with two families of stable pages and one index-only family. */
export function baseLearn() {
  const learn = new FakeLearn();
  learn.family("azure", [...stable("azure", 24), ["/azure/a", "2026-09-20"], ["/azure/b", "2026-09-21"], ["/azure/c", "2026-09-22"]]);
  learn.family("entra", stable("entra", 4));
  learn.family("cli", [["/cli/azure/vm", "2026-09-01"]]);
  return learn;
}

export const readCatalog = (h) => h.json("docs-catalog.json");
export const byPath = (catalog) => new Map(catalog.map((r) => [canonicalPath(r.url), r]));
export const indexLines = (h) => h.read("docs-urls.txt").trimEnd().split("\n");
