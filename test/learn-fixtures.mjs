/**
 * Shared fixtures for the Learn sync tests: a tiny fake of the Learn catalog,
 * hierarchy and credentials endpoints that plugs into the injectable `fetchImpl`
 * of scripts/lib/learn-http.mjs. No test using it touches the network or the
 * real data files. (node --test also loads this file as a test file: it declares
 * no tests, which is fine.)
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CATALOG = "https://learn.microsoft.com/api/catalog/";
export const HIERARCHY = "https://learn.microsoft.com/api/hierarchy/modules/";

export function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "learnsync-test-"));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export const silent = { log: () => {}, warn: () => {} };

export function collectLogs() {
  const lines = [];
  return { lines, log: (m) => lines.push(`LOG ${m}`), warn: (m) => lines.push(`WARN ${m}`) };
}

/** Config for a world small enough for tests (allowlist = azure + github + m365). */
export const TEST_CONFIG = {
  allowedCategories: ["azure", "github", "m365"],
  excludedCategories: ["consumer"],
  knownEmptyCategories: [],
  productSubjectHints: { "azure-firewall": ["networking"] },
  customSubjects: { education: "Education" },
};

export const TEST_LIMITS = {
  MIN_MODULES: 1,
  HIERARCHY_MIN_SAMPLE: 5,
  HIERARCHY_EARLY_SAMPLE: 8,
  HIERARCHY_EARLY_FAILURE_PCT: 50,
  MAX_HIERARCHY_FAILURE_PCT: 10,
};

export const PRODUCTS = [
  { id: "azure", name: "Azure", children: [{ id: "azure-firewall", name: "Azure Firewall" }, { id: "azure-vm", name: "Azure Virtual Machines" }] },
  { id: "github", name: "GitHub", children: [{ id: "github-actions", name: "GitHub Actions" }] },
  { id: "m365", name: "Microsoft 365", children: [] },
  { id: "consumer", name: "Consumer", children: [] },
  { id: "microsoft-agents", name: "Microsoft Agents", children: [] },
];

export const SUBJECTS = [
  { id: "networking", name: "Networking", children: [] },
  { id: "devops", name: "DevOps", children: [] },
  { id: "databases", name: "Databases", children: [] },
];

/** unit uid -> catalog unit object */
export function unit(uid, title, lastModified = "2026-01-01T00:00:00+00:00") {
  return { uid, type: "unit", title, last_modified: lastModified };
}

/**
 * Builds a catalog API module. `slug` becomes the url; `unitSpecs` is a list of
 * [unitSlug, title] and yields units "<uid>.<unitSlug>" (and the hierarchy urls
 * "<modulePath>/<n>-<unitSlug>/").
 */
export function mod({ uid, slug, title, products = ["azure-vm"], subjects = [], unitSpecs = [["introduction", "Introduction"], ["summary", "Summary"]], lastModified = "2026-02-01T00:00:00+00:00", area = "modules" }) {
  const base = `/en-us/training/${area}/${slug}/`;
  return {
    uid,
    type: "module",
    title: title ?? `Module ${slug}`,
    url: `https://learn.microsoft.com${base}?WT.mc_id=api_CatalogApi`,
    firstUnitUrl: `https://learn.microsoft.com${base}1-${unitSpecs[0]?.[0] ?? "introduction"}/?WT.mc_id=api_CatalogApi`,
    products,
    subjects,
    last_modified: lastModified,
    units: unitSpecs.map(([slugPart]) => `${uid}.${slugPart}`),
  };
}

export function unitsOf(modules, titles = {}) {
  return modules.flatMap((m) => m.units.map((uid) => unit(uid, titles[uid] ?? uid.split(".").pop())));
}

/** hierarchy body for a catalog module: units with real urls (1-based numbering, like Learn). */
export function hierarchyOf(module, { skip = [] } = {}) {
  const path = new URL(module.url).pathname.replace(/^\/en-us/, "");
  let n = 0;
  return {
    parents: [],
    units: module.units.map((uid) => {
      n++;
      while (skip.includes(n)) n++;
      return { uid, type: "unit", title: uid.split(".").pop(), url: `${path}${n}-${uid.split(".").pop()}/` };
    }),
  };
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function withUrl(response, url) {
  Object.defineProperty(response, "url", { value: url });
  return response;
}

/**
 * A fake of every endpoint the Learn syncs use. `state` can be mutated between
 * runs (modules, units, content lists, failures...). Returns { fetchImpl, state,
 * requests } where `requests` lists every URL fetched, in order.
 */
export function makeFakeLearn(initial = {}) {
  const state = {
    products: PRODUCTS,
    subjects: SUBJECTS,
    modules: [],
    units: [],
    hierarchyFor: (module) => hierarchyOf(module),
    // uid -> status code | "timeout" | function(attempt) -> status; for hierarchy requests
    hierarchyFailures: new Map(),
    content: { learningPaths: [], courses: [], certifications: [], exams: [], appliedSkills: [] },
    // path (canonical) -> { status, finalPath?, body? } for study guide / skill page requests
    pages: new Map(),
    truncateModulesTo: null,
    ...initial,
  };
  const requests = [];
  const attempts = new Map();

  async function fetchImpl(input) {
    const url = String(input);
    requests.push(url);
    const parsed = new URL(url);
    if (url.startsWith(CATALOG)) {
      const type = parsed.searchParams.get("type");
      if (type === "products") return jsonResponse({ products: state.products });
      if (type === "subjects") return jsonResponse({ subjects: state.subjects });
      if (type === "modules,units") {
        const modules = state.truncateModulesTo === null ? state.modules : state.modules.slice(0, state.truncateModulesTo);
        return jsonResponse({ modules, units: state.units });
      }
      if (type in state.content) return jsonResponse({ [type]: state.content[type] });
      return new Response("unknown type", { status: 400 });
    }
    if (url.startsWith(HIERARCHY)) {
      const uid = decodeURIComponent(parsed.pathname.slice("/api/hierarchy/modules/".length));
      const n = (attempts.get(uid) ?? 0) + 1;
      attempts.set(uid, n);
      const failure = state.hierarchyFailures.get(uid);
      if (failure !== undefined) {
        const code = typeof failure === "function" ? failure(n) : failure;
        if (code === "timeout") {
          const err = new Error("timed out");
          err.name = "TimeoutError";
          throw err;
        }
        if (code === "bare404") return new Response("<html>Not found</html>", { status: 404 });
        if (code === 404) return new Response(JSON.stringify({ ErrorCode: "module_id_not_found", Retriable: false }), { status: 404 });
        if (code) return new Response(JSON.stringify({ ErrorCode: "x" }), { status: code, headers: code === 429 ? { "retry-after": "1" } : {} });
      }
      const module = state.modules.find((m) => m.uid === uid);
      if (!module) return new Response(JSON.stringify({ ErrorCode: "module_id_not_found", Retriable: false }), { status: 404 });
      return jsonResponse(state.hierarchyFor(module));
    }
    if (parsed.hostname === "learn.microsoft.com") {
      const path = parsed.pathname.replace(/^\/en-us/, "").replace(/\/+$/, "").toLowerCase();
      const page = state.pages.get(path);
      if (!page) return new Response("not found", { status: 404 });
      if (page.throws) {
        const err = new Error(page.throws);
        err.name = "TimeoutError";
        throw err;
      }
      const res = new Response(page.body ?? "<html></html>", { status: page.status ?? 200 });
      return withUrl(res, `https://learn.microsoft.com/en-us${page.finalPath ?? path}`);
    }
    return new Response("unexpected host", { status: 500 });
  }

  return {
    fetchImpl,
    state,
    requests,
    hierarchyRequests: () => requests.filter((u) => u.startsWith(HIERARCHY)),
    clearRequests: () => {
      requests.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// change-file probes: raw answers in the shape of live-probe.mjs rawProbe()
// ---------------------------------------------------------------------------

/** A served page: the probe ended on `finalPath` (HTTP 200); `first` is the status of the first hop (301 for a redirect). */
export const probeServed = (finalPath, { first = 200, title = "A page" } = {}) => ({
  status: 200,
  firstStatus: first,
  finalUrl: `https://learn.microsoft.com/en-us${finalPath}/`,
  title,
  hops: [],
  offsite: false,
  error: null,
});
export const PROBE_NOT_FOUND = { status: 404, firstStatus: 404, finalUrl: "https://learn.microsoft.com/en-us/x/", title: "404", hops: [], offsite: false, error: null };
/** Rate limited / unreachable: no usable response (transient, never classifies anything). */
export const PROBE_BLOCKED = { status: null, firstStatus: null, finalUrl: null, title: "", hops: [], offsite: false, error: "no response after retries" };

/**
 * A stub for the injectable change-file probe: `answers` maps a canonical path to a raw answer (or a function
 * of the path), anything else is "blocked". `probe.calls` lists every path asked, in order.
 */
export function makeProbe(answers = {}, fallback = PROBE_BLOCKED) {
  const calls = [];
  const probe = async (path) => {
    calls.push(path);
    const answer = answers[path];
    return typeof answer === "function" ? answer(path) : answer ?? fallback;
  };
  probe.calls = calls;
  return probe;
}

/** A standard small world: 4 in-scope modules (one with a "$" uid and one outside /training/modules), 1 out of scope. */
export function standardWorld() {
  const modules = [
    mod({ uid: "learn.azure.vm-basics", slug: "vm-basics", products: ["azure-vm"], subjects: ["devops"] }),
    mod({ uid: "learn.azure.firewall-intro", slug: "firewall-intro", products: ["azure-firewall"], unitSpecs: [["introduction", "Introduction"], ["rules", "Rules"], ["summary", "Summary"]] }),
    mod({ uid: "$learn.become-contributor", slug: "become-contributor", products: ["github-actions"] }),
    mod({ uid: "learn.saas-foundations", slug: "saas-foundations", products: ["m365"], area: "saas" }),
    mod({ uid: "learn.consumer.games", slug: "games", products: ["consumer"] }),
  ];
  return { modules, units: unitsOf(modules) };
}
