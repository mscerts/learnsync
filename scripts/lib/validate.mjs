/**
 * URL validator over the learnsync caches. See DATA_CONTRACT.md ("Validator").
 *
 * validateUrls() answers "is this learn.microsoft.com URL still good?" from the
 * cached data ONLY (no network): every verdict names the evidence it rests on,
 * and anything the caches cannot know is `unverifiable`, never a guess. The
 * optional live layer (scripts/lib/live-probe.mjs, CLI flags --confirm-live and
 * --probe-unverifiable) is a separate, clearly labelled step on top.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canonicalPath, slugText, firstSegment, underPrefix, LEARN_HOST } from "./canonical.mjs";
import { LEARN_SCOPE, INDEX_ONLY_SCOPE } from "./scope.mjs";

// Learn paths that are not documentation pages (no docs index covers them).
const NON_DOCS_PREFIXES = [
  "/training/",
  "/credentials/",
  "/certifications/",
  "/shows/",
  "/api/",
  "/answers/",
  "/samples/",
  "/collections/",
  "/users/",
  "/assessments/",
  "/search",
  "/previous-versions/",
  "/events/",
  "/community/",
];

const FILES = {
  learn: "learn-catalog.json",
  content: "learn-content.json",
  index: "docs-urls.txt",
  redirects: "docs-redirects.json",
  invalid: "docs-catalog-invalid.json",
  status: "status.json",
};

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

/** Load the cached data once; missing files are recorded, not fatal. */
export function loadData(dataDir) {
  const missing = [];
  const file = (name) => join(dataDir, FILES[name]);
  const need = (name) => {
    if (!existsSync(file(name))) {
      missing.push(FILES[name]);
      return null;
    }
    return file(name);
  };

  const data = { dataDir, missing, status: null, learn: null, content: null, docs: null };

  const statusFile = need("status");
  data.status = statusFile ? readJson(statusFile) : null;

  const learnFile = need("learn");
  const learn = learnFile ? readJson(learnFile) : null;
  if (learn && Array.isArray(learn.modules)) {
    const modules = new Map();
    for (const m of learn.modules) {
      const path = m.path ?? canonicalPath(m.url ?? "");
      if (path) modules.set(path, m);
    }
    data.learn = {
      schemaVersion: learn.schemaVersion ?? 1,
      lastChecked: learn.lastChecked ?? null,
      modules,
      removed: new Map((learn.removed ?? []).map((t) => [t.path, t])),
      outOfScope: new Set(learn.outOfScope ?? []),
      hasUnitUrls: learn.modules.some((m) => Array.isArray(m.unitUrls)),
    };
  }

  const contentFile = need("content");
  const content = contentFile ? readJson(contentFile) : null;
  if (content) {
    const set = (list) => new Set((list ?? []).map((e) => e.path));
    data.content = {
      lastChecked: content.lastChecked ?? null,
      learningPaths: set(content.learningPaths),
      courses: set(content.courses),
      certifications: set(content.certifications),
      exams: set(content.exams),
      appliedSkills: set(content.appliedSkills),
      studyGuides: new Set((content.studyGuides ?? []).map((e) => e.path)),
      removed: new Map((content.removed ?? []).map((t) => [t.path, t])),
    };
  }

  const indexFile = need("index");
  const redirectsFile = need("redirects");
  const invalidFile = need("invalid");
  if (indexFile) {
    const index = new Map();
    for (const line of readFileSync(indexFile, "utf-8").split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      const path = tab === -1 ? line : line.slice(0, tab);
      index.set(path, tab === -1 ? null : line.slice(tab + 1) || null);
    }
    const redirects = new Map();
    for (const r of (redirectsFile ? readJson(redirectsFile) : null) ?? []) redirects.set(r.from, r);
    const quarantine = new Map();
    for (const r of (invalidFile ? readJson(invalidFile) : null) ?? []) {
      const path = canonicalPath(r.url ?? "");
      if (path) quarantine.set(path, r);
    }
    data.docs = { index, redirects, quarantine };
  }
  return data;
}

/** Classify a canonical path. */
export function classifyPath(path) {
  let m;
  if ((m = path.match(/^\/training\/modules\/([^/]+)\/([^/]+)$/))) return { kind: "unit", module: m[1], unit: m[2] };
  if ((m = path.match(/^\/training\/modules\/([^/]+)$/))) return { kind: "module", module: m[1] };
  if (/^\/training\/paths\/[^/]+$/.test(path)) return { kind: "path" };
  if (/^\/training\/courses\/[^/]+$/.test(path)) return { kind: "course" };
  if ((m = path.match(/^\/credentials\/(?:certifications|applied-skills)\/resources\/study-guides\/([^/]+)$/))) {
    return { kind: "study-guide", code: m[1] };
  }
  if ((m = path.match(/^\/credentials\/certifications\/exams\/([^/]+)$/))) return { kind: "exam", code: m[1] };
  if (/^\/credentials\/certifications\/[^/]+$/.test(path)) return { kind: "certification" };
  if (/^\/credentials\/applied-skills\/[^/]+$/.test(path)) return { kind: "applied-skill" };
  if (path === "/" || NON_DOCS_PREFIXES.some((p) => path.startsWith(p))) return { kind: "other" };
  return { kind: "docs" };
}

/** Which scope covers a docs path: "learn", "index-only", "excluded" or null. */
export function scopeFor(path) {
  const hit = (scope) => scope.include.some((p) => underPrefix(path, p));
  const excluded = (scope) => (scope.exclude ?? []).some((p) => underPrefix(path, p));
  if (hit(LEARN_SCOPE)) return excluded(LEARN_SCOPE) ? "excluded" : "learn";
  if (hit(INDEX_ONLY_SCOPE)) return excluded(INDEX_ONLY_SCOPE) ? "excluded" : "index-only";
  return null;
}

/** Live unit path with the same slug text as a dead one (for "update the link to ..."). */
export function suggestUnit(deadSlug, unitPaths) {
  const want = slugText(deadSlug);
  const slugs = unitPaths.map((p) => p.split("/").pop());
  return (
    slugs.find((s) => s === deadSlug) ??
    slugs.find((s) => slugText(s) === want) ??
    slugs.find((s) => s.endsWith(want) || want.endsWith(slugText(s))) ??
    null
  );
}

const absolute = (path) => `https://${LEARN_HOST}${path}`;

function result(base, verdict, reason, evidence, extra = {}) {
  return { ...base, verdict, reason, evidence, confidence: "high", redirectsTo: null, suggestion: null, ...extra };
}

/** The cached module's canonical path (a few modules live outside /training/modules/). */
const modulePathOf = (cls) => cls.modulePath ?? `/training/modules/${cls.module}`;

/**
 * Like classifyPath(), but also recognises modules the catalog publishes outside
 * /training/modules/ (for example /training/saas/<slug>) from the cached paths.
 */
export function classifyWithData(path, data) {
  const cls = classifyPath(path);
  if (cls.kind !== "other" || !data.learn) return cls;
  const modules = data.learn.modules;
  if (modules.has(path)) return { kind: "module", module: path.split("/").pop(), modulePath: path };
  const cut = path.lastIndexOf("/");
  const parent = path.slice(0, cut);
  if (cut > 0 && modules.has(parent)) {
    return { kind: "unit", module: parent.split("/").pop(), modulePath: parent, unit: path.slice(cut + 1) };
  }
  return cls;
}

function validateModule(base, cls, data) {
  const { learn } = data;
  if (!learn) return result(base, "unverifiable", "learn-catalog.json is not available", "missing-data");
  const path = modulePathOf(cls);
  if (learn.modules.has(path)) {
    if (learn.modules.get(path).hierarchyNotFound) {
      return result(base, "broken", "module is listed in the catalog but Learn does not serve it (its page redirects elsewhere)", "learn-catalog");
    }
    return result(base, "valid", "module is in the Learn catalog", "learn-catalog");
  }
  const tomb = learn.removed.get(path);
  if (tomb) {
    return result(base, "broken", `module was removed from Learn (first missing ${tomb.removedOn})`, "tombstone");
  }
  if (learn.outOfScope.has(path)) {
    return result(base, "valid", "module exists but is outside the cached categories", "out-of-scope");
  }
  return result(base, "broken", "module is not in the Learn catalog", "learn-catalog");
}

function validateUnit(base, cls, data) {
  const { learn } = data;
  if (!learn) return result(base, "unverifiable", "learn-catalog.json is not available", "missing-data");
  const modulePath = modulePathOf(cls);
  const rec = learn.modules.get(modulePath);
  if (!rec) {
    const moduleVerdict = validateModule(base, cls, data);
    if (moduleVerdict.verdict === "broken") {
      return { ...moduleVerdict, reason: `unit's module: ${moduleVerdict.reason}` };
    }
    return result(base, "unverifiable", "module is outside the cached categories, so its units are not cached", "out-of-scope");
  }
  if (rec.hierarchyNotFound) {
    return result(base, "broken", "unit's module is listed in the catalog but Learn does not serve it (its page redirects elsewhere)", "learn-catalog");
  }
  if (!Array.isArray(rec.unitUrls)) {
    return result(base, "unverifiable", "unit URLs of this module are not cached (hierarchy unavailable)", "learn-catalog");
  }
  if (rec.unitUrls.includes(base.path)) return result(base, "valid", "unit is in the module's unit list", "learn-catalog");
  const hit = suggestUnit(cls.unit, rec.unitUrls);
  return result(base, "broken", "unit slug does not exist in the module (Microsoft renumbers and renames unit slugs)", "learn-catalog", {
    suggestion: hit ? absolute(`${modulePath}/${hit}`) : null,
  });
}

function validateContent(base, cls, data, listName, label, { absentUnverifiable = null } = {}) {
  const { content } = data;
  if (!content) return result(base, "unverifiable", "learn-content.json is not available", "missing-data");
  if (content[listName].has(base.path)) return result(base, "valid", `${label} is in the Learn catalog`, "learn-content");
  const tomb = content.removed.get(base.path);
  if (tomb) return result(base, "broken", `${label} was removed from Learn (first missing ${tomb.removedOn})`, "tombstone");
  if (absentUnverifiable) return result(base, "unverifiable", absentUnverifiable, "learn-content");
  return result(base, "broken", `${label} is not in the Learn catalog`, "learn-content");
}

// The catalog API lists only legacy exams (current exam URLs answer 200 and
// redirect to their certification page), and study guides are probed only for
// the exams it lists, so for these two kinds absence proves nothing.
const EXAM_ABSENT = "the catalog API lists only legacy exams; current exam pages redirect to their certification page, so absence proves nothing";
const STUDY_GUIDE_ABSENT = "study guides are probed only for exams the catalog lists, so absence proves nothing";

function validateCertification(base, cls, data) {
  const { content } = data;
  if (!content) return result(base, "unverifiable", "learn-content.json is not available", "missing-data");
  if (content.certifications.has(base.path)) {
    return result(base, "valid", "certification is in the Learn catalog", "learn-content");
  }
  const tomb = content.removed.get(base.path);
  if (tomb) return result(base, "broken", `certification was removed from Learn (first missing ${tomb.removedOn})`, "tombstone");
  return result(
    base,
    "unverifiable",
    "not a certification in the catalog; it may be a Learn support or program page",
    "learn-content"
  );
}

function validateDocs(base, cls, data) {
  const { docs } = data;
  const scope = scopeFor(base.path);
  if (!docs) return result(base, "unverifiable", "docs-urls.txt is not available", "missing-data");
  if (docs.index.has(base.path)) return result(base, "valid", "page is in the sitemap index", "docs-urls");
  const red = docs.redirects.get(base.path);
  if (red) {
    const where = red.to ? ` to ${red.to}` : "";
    return result(base, "moved", `page redirects${where} (${red.kind}, since ${red.firstSeen})`, "docs-redirects", {
      redirectsTo: red.to ?? null,
      suggestion: red.to ? absolute(red.to) : null,
    });
  }
  const q = docs.quarantine.get(base.path);
  if (q) return result(base, "broken", `page is quarantined (HTTP ${q.status}, since ${q.firstDetected})`, "quarantine");
  if (scope === "excluded") return result(base, "unverifiable", "path is excluded from the docs index", "scope");
  if (scope === null) {
    return result(base, "unverifiable", `outside the cached docs scope (/${firstSegment(base.path)})`, "scope");
  }
  return result(base, "broken", "page is absent from the sitemap index (sitemaps lag new pages by weeks)", "docs-urls", {
    confidence: "low",
  });
}

const OTHER_REASONS = [
  [/^\/credentials\/certifications\/exams\/[^/]+\/practice/, "practice assessments have no cache source"],
  [/^\/shows\//, "Learn shows have no cache source"],
  [/^\/collections\//, "collections have no cache source"],
  [/^\/certifications\//, "legacy /certifications paths have no cache source"],
];

/** Validate URLs from the loaded data. Pure: no network. */
export function validateUrls(urls, data) {
  const results = urls.map((input) => {
    const url = typeof input === "string" ? input : input.url;
    const path = canonicalPath(url);
    const base = { url, path, kind: null };
    if (!path) {
      return result({ ...base, kind: "other" }, "unverifiable", "not a learn.microsoft.com URL", "scope");
    }
    const cls = classifyWithData(path, data);
    base.kind = cls.kind;
    switch (cls.kind) {
      case "module":
        return validateModule(base, cls, data);
      case "unit":
        return validateUnit(base, cls, data);
      case "path":
        return validateContent(base, cls, data, "learningPaths", "learning path");
      case "course":
        return validateContent(base, cls, data, "courses", "course");
      case "exam":
        return validateContent(base, cls, data, "exams", "exam page", { absentUnverifiable: EXAM_ABSENT });
      case "applied-skill":
        return validateContent(base, cls, data, "appliedSkills", "applied skill");
      case "study-guide":
        return validateContent(base, cls, data, "studyGuides", "study guide", { absentUnverifiable: STUDY_GUIDE_ABSENT });
      case "certification":
        return validateCertification(base, cls, data);
      case "docs":
        return validateDocs(base, cls, data);
      default: {
        const why = OTHER_REASONS.find(([re]) => re.test(path))?.[1] ?? "this kind of page is not covered by any cache";
        return result(base, "unverifiable", why, "scope");
      }
    }
  });
  return { results, freshness: freshness(data), summary: summarize(results) };
}

function ageHours(iso, now) {
  const t = Date.parse(iso ?? "");
  return Number.isNaN(t) ? null : Math.round(((now - t) / 3_600_000) * 10) / 10;
}

/** What a consumer needs to decide whether the data is fresh enough to act on. */
export function freshness(data, now = Date.now()) {
  const s = data.status ?? {};
  return {
    missingFiles: data.missing,
    learnGeneratedAt: s.learn?.generatedAt ?? null,
    learnAgeHours: ageHours(s.learn?.generatedAt, now),
    docsGeneratedAt: s.docs?.generatedAt ?? null,
    docsAgeHours: ageHours(s.docs?.generatedAt, now),
    docsComplete: s.docs?.complete ?? null,
    learnCatalogCheckedAt: data.learn?.lastChecked ?? null,
    unitUrlsCached: data.learn?.hasUnitUrls ?? false,
    schemaVersion: data.learn?.schemaVersion ?? null,
  };
}

export function summarize(results) {
  const byVerdict = {};
  const byKind = {};
  for (const r of results) {
    byVerdict[r.verdict] = (byVerdict[r.verdict] ?? 0) + 1;
    const k = (byKind[r.kind] ??= {});
    k[r.verdict] = (k[r.verdict] ?? 0) + 1;
  }
  return { total: results.length, byVerdict, byKind };
}
