/**
 * Planning and reconciliation for the docs sync. Pure: no I/O, no network, no
 * clock (the caller passes `today`). scripts/docs-catalog-sync.mjs is a thin
 * wrapper that reads the files, runs the probes this module asks for and
 * writes what this module returns.
 *
 *   plan(...)       what to do this run: which pages to fetch (changed first,
 *                   then new, within the cap), which records to re-verify,
 *                   which previously known URLs fell out of the sitemaps and
 *                   must be probed, which quarantined URLs to re-check.
 *   reconcile(...)  fold the probe results back into the catalog, the index,
 *                   the quarantine list, the redirect ledger and the status
 *                   heartbeat. Anything a probe did not answer (never started,
 *                   transient failure) keeps its previous data.
 *
 * Identity: every learn.microsoft.com page is keyed by its canonical path
 * (canonical.mjs). Catalog records keep their legacy `url`, spelled the way the
 * sitemap spells it.
 */

import { canonicalPath, byCodePoint } from "./canonical.mjs";
import { DEFAULT_SCOPES, scopeClass } from "./docs-scope.mjs";
import { daysBetween } from "./docs-sitemaps.mjs";
import { maxLastmod } from "./docs-index.mjs";
import { updateLedger } from "./docs-redirects.mjs";
import { cleanTitle } from "./docs-helpers.mjs";
import { isNoIndex, parseHeadMeta, recordFromHead } from "./sitemap-helpers.mjs";

export const LEARN_ORIGIN = "https://learn.microsoft.com";

export const DEFAULT_CAPS = {
  maxPageFetches: 6000, // new + changed pages fetched per run
  maxMissingChecks: 2000, // fell-out-of-the-sitemaps URLs probed per run
  verifyPerRun: 2000, // oldest-checked catalog records re-probed per run
  maxQuarantineRechecks: 1000, // quarantined URLs re-checked per run
  changedMinShare: 0.2, // each of changed/new keeps at least this share of the fetch cap when both exist
  redirectRecheckDays: 30, // a sitemap URL known to redirect is not re-fetched sooner than this
};

const byKey = (fn) => (a, b) => byCodePoint(fn(a), fn(b));

/** The "released" sentinel (a record freed from quarantine) is not a real lastmod. */
const indexLastmod = (v) => (v && v !== "released" ? v : null);

const KNOWN_KEYS = new Set(["title", "url", "product", "subproduct", "description", "lastmod", "checked"]);

/** Catalog record with keys in the canonical order; unknown keys are kept after the known ones. */
export function normalizeRecord(rec) {
  const out = { title: rec.title ?? "", url: rec.url, product: rec.product ?? null, subproduct: rec.subproduct ?? null };
  if ("description" in rec) out.description = rec.description;
  if ("lastmod" in rec) out.lastmod = rec.lastmod;
  if ("checked" in rec && rec.checked) out.checked = rec.checked;
  for (const [k, v] of Object.entries(rec)) if (!KNOWN_KEYS.has(k)) out[k] = v;
  return out;
}

/** A quarantined record minus its quarantine bookkeeping and the catalog-only fields. */
function stripQuarantine(q) {
  const { status, firstDetected, lastChecked, lastmod, checked, ...rest } = q;
  return rest;
}

export const learnUrlFor = (path) => `${LEARN_ORIGIN}${path}`;

/** Deterministic 32-bit hash, used to rotate probe order day by day without persisted state. */
export function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ---------------------------------------------------------------------------------------
// Catalog folding
// ---------------------------------------------------------------------------------------

/**
 * Among records that are the same page (same canonical path), the one to keep:
 * the sitemap's own spelling first, then a titled record, one that carries a
 * lastmod, the most recently checked, the newest lastmod, finally the
 * code-point smallest url so the choice is stable.
 */
export function pickWinner(list, rowUrl = null) {
  const score = (r) => [r.url === rowUrl ? 1 : 0, r.title ? 1 : 0, r.lastmod ? 1 : 0];
  return [...list].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sb[i] - sa[i];
    const ca = a.checked || "";
    const cb = b.checked || "";
    if (ca !== cb) return ca < cb ? 1 : -1;
    const la = a.lastmod || "";
    const lb = b.lastmod || "";
    if (la !== lb) return la < lb ? 1 : -1;
    return byCodePoint(a.url, b.url);
  })[0];
}

/**
 * Catalog -> { byPath: Map<path, record> (one per page), git: [records that are
 * not learn.microsoft.com], aliases: duplicates/case variants folded away,
 * outOfScope: records whose path is no longer under LEARN_SCOPE }.
 */
export function foldCatalog(records, rows, scopes = DEFAULT_SCOPES) {
  const groups = new Map();
  const git = [];
  let outOfScope = 0;
  for (const rec of records) {
    const path = typeof rec.url === "string" ? canonicalPath(rec.url) : null;
    if (path === null) {
      git.push(rec);
      continue;
    }
    if (scopeClass(path, scopes) !== "learn") {
      outOfScope++;
      continue;
    }
    const list = groups.get(path);
    if (list) list.push(rec);
    else groups.set(path, [rec]);
  }
  const byPath = new Map();
  let aliases = 0;
  for (const [path, list] of groups) {
    aliases += list.length - 1;
    byPath.set(path, pickWinner(list, rows.get(path)?.url ?? null));
  }
  return { byPath, git, aliases, outOfScope };
}

/** Quarantine file -> Map<key, record>; key is the canonical path (learn) or the url (anything else). */
export function foldInvalid(invalid) {
  const out = new Map();
  for (const q of invalid) {
    if (typeof q?.url !== "string") continue;
    const key = canonicalPath(q.url) ?? q.url;
    const old = out.get(key);
    if (!old) out.set(key, { ...q });
    else {
      // same page quarantined twice (case variants): keep one, earliest detection, latest check
      if (q.firstDetected && (!old.firstDetected || q.firstDetected < old.firstDetected)) old.firstDetected = q.firstDetected;
      if (q.lastChecked && (!old.lastChecked || q.lastChecked > old.lastChecked)) {
        old.lastChecked = q.lastChecked;
        old.status = q.status;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Queue ordering and budgets
// ---------------------------------------------------------------------------------------

/** Freshest sitemap lastmod first (null last), then path, so the order never depends on file order. */
export function orderQueue(items) {
  return [...items].sort((a, b) => {
    const la = a.lastmod || "";
    const lb = b.lastmod || "";
    if (la !== lb) return la < lb ? 1 : -1;
    return byCodePoint(a.path, b.path);
  });
}

/**
 * How many changed and new pages fit the fetch cap. Changed pages are fetched
 * first, but when both kinds exist each keeps at least `minShare` of the cap, so a
 * huge backlog of one kind never starves the other.
 */
export function splitFetchBudget({ cap, changed, fresh, minShare = 0.2 }) {
  if (cap <= 0) return { changed: 0, fresh: 0 };
  if (changed + fresh <= cap) return { changed, fresh };
  const freshReserve = changed > 0 && fresh > 0 ? Math.min(fresh, Math.ceil(cap * minShare)) : 0;
  const changedTake = Math.min(changed, cap - freshReserve);
  const freshTake = Math.min(fresh, cap - changedTake);
  return { changed: changedTake, fresh: freshTake };
}

/**
 * Oldest-checked first. `items` need { path, url, checked }; ties by url.
 * Records that were never checked sort first.
 */
export function orderByChecked(items) {
  return [...items].sort((a, b) => {
    const ca = a.checked || "";
    const cb = b.checked || "";
    if (ca !== cb) return ca < cb ? -1 : 1;
    return byCodePoint(a.url, b.url);
  });
}

/**
 * Which fell-out-of-the-sitemaps candidates to probe. Catalog records go
 * oldest-checked first. Index-only paths have no record (so no `checked`);
 * they rotate by a hash of path+day. While both kinds are waiting, each is
 * guaranteed half the cap (a kind with less than half hands the rest to the
 * other), so neither can starve the other. Candidates are already
 * alias-free (one per canonical path), so aliases never use the budget.
 */
export function selectMissingBatch(candidates, cap, today) {
  const withRecord = orderByChecked(candidates.filter((c) => c.rec).map((c) => ({ ...c, checked: c.rec.checked })));
  const pathOnly = candidates
    .filter((c) => !c.rec)
    .map((c) => ({ c, h: hash32(`${c.path}|${today}`) }))
    .sort((a, b) => a.h - b.h || byCodePoint(a.c.path, b.c.path))
    .map((x) => x.c);
  if (cap <= 0) return { items: [], deferred: [...withRecord.map(stripChecked), ...pathOnly] };
  const takePathOnly = Math.min(pathOnly.length, Math.max(cap - withRecord.length, Math.ceil(cap / 2)));
  const takeRecords = Math.min(withRecord.length, cap - takePathOnly);
  const fillPathOnly = Math.min(pathOnly.length, cap - takeRecords); // records ran short: path-only fills the rest
  const nPath = Math.max(takePathOnly, fillPathOnly);
  const records = withRecord.map(stripChecked);
  return {
    items: [...records.slice(0, takeRecords), ...pathOnly.slice(0, nPath)],
    deferred: [...records.slice(takeRecords), ...pathOnly.slice(nPath)],
  };
}

function stripChecked(c) {
  const { checked, ...rest } = c;
  return rest;
}

// ---------------------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.today                 YYYY-MM-DD
 * @param {object} [input.caps]                see DEFAULT_CAPS
 * @param {Map}    input.previousIndex         path -> lastmod|null (data/docs-urls.txt)
 * @param {Array}  input.catalog               data/docs-catalog.json
 * @param {Array}  input.invalid               data/docs-catalog-invalid.json
 * @param {Array}  input.ledger                normalized data/docs-redirects.json
 * @param {Map}    input.rows                  path -> sitemap row (deduped, both scopes)
 * @param {boolean} input.sitemapOk            false when any sitemap file failed to download
 */
export function plan({ today, caps = {}, previousIndex, catalog, invalid, ledger, rows, sitemapOk, scopes = DEFAULT_SCOPES }) {
  const c = { ...DEFAULT_CAPS, ...caps };
  const folded = foldCatalog(catalog, rows, scopes);
  const invalidByKey = foldInvalid(invalid);
  const known = new Map(folded.byPath); // path -> record (spelled like the sitemap where a row exists)

  const ledgerFresh = new Set(
    ledger.filter((e) => e.lastSeen && daysBetween(e.lastSeen, today) < c.redirectRecheckDays).map((e) => e.from)
  );

  const kept = []; // paths with a record that needs no fetch
  const changed = [];
  const fresh = [];
  const stats = {
    rows: rows.size,
    learnRows: 0,
    indexOnlyRows: 0,
    bootstrapped: 0,
    respelled: 0,
    knownRedirectSkipped: 0,
    quarantinedRows: 0,
    untitledRecords: 0,
    aliasesFolded: folded.aliases,
    outOfScopeRecords: folded.outOfScope,
  };
  for (const rec of known.values()) if (!rec.title) stats.untitledRecords++;

  for (const p of [...rows.keys()].sort(byCodePoint)) {
    const row = rows.get(p);
    if (row.cls === "learn") stats.learnRows++;
    else stats.indexOnlyRows++;
    if (invalidByKey.has(p)) {
      stats.quarantinedRows++; // the quarantine re-check decides; no fetch meanwhile
      continue;
    }
    if (row.cls !== "learn") continue;
    const rec = known.get(p);
    if (!rec) {
      // A sitemap row we saw redirecting recently is a stale row: skip it. But a row that was NOT in
      // the previous index has just (re)appeared, so the redirect claim is stale (reconcile deletes the
      // ledger entry): fetch it now. With no previous index nothing is known about reappearance.
      if (ledgerFresh.has(p) && (previousIndex.size === 0 || previousIndex.has(p))) stats.knownRedirectSkipped++;
      else fresh.push({ kind: "new", path: p, url: row.url, lastmod: row.lastmod });
      continue;
    }
    let r = rec;
    if (rec.url !== row.url) {
      r = { ...rec, url: row.url };
      stats.respelled++;
    }
    if (!r.title) {
      known.set(p, r);
      changed.push({ kind: "changed", path: p, url: row.url, lastmod: row.lastmod, prev: r, reason: "untitled" });
      continue;
    }
    if (!("lastmod" in r)) {
      r = { ...r, lastmod: row.lastmod ?? null }; // first run after the git era: adopt the sitemap's lastmod, no refetch
      stats.bootstrapped++;
      known.set(p, r);
      kept.push(p);
      continue;
    }
    known.set(p, r);
    if (r.lastmod === row.lastmod) kept.push(p);
    else changed.push({ kind: "changed", path: p, url: row.url, lastmod: row.lastmod, prev: r, reason: "lastmod" });
  }

  // --- fetch queue: changed first, then new, within the cap ---
  const orderedChanged = orderQueue(changed);
  const orderedFresh = orderQueue(fresh);
  const take = splitFetchBudget({ cap: c.maxPageFetches, changed: orderedChanged.length, fresh: orderedFresh.length, minShare: c.changedMinShare });
  const fetchItems = [...orderedChanged.slice(0, take.changed), ...orderedFresh.slice(0, take.fresh)];
  const deferredChanged = orderedChanged.slice(take.changed);
  const deferredNew = orderedFresh.slice(take.fresh);

  // --- verification pass: oldest-checked records still in the sitemap ---
  const verifyPool = orderByChecked(kept.map((p) => ({ path: p, url: known.get(p).url, checked: known.get(p).checked, rec: known.get(p) })));
  const verifyItems = c.verifyPerRun > 0 ? verifyPool.slice(0, c.verifyPerRun).map(({ checked, ...rest }) => rest) : [];

  // --- previously known URLs that fell out of the sitemaps ---
  let missingCandidates = [];
  let indexOutOfScope = 0;
  const candidatePaths = new Set([...previousIndex.keys(), ...known.keys()]);
  for (const p of [...candidatePaths].sort(byCodePoint)) {
    if (rows.has(p) || invalidByKey.has(p)) continue;
    if (scopeClass(p, scopes) === null) {
      indexOutOfScope++;
      continue;
    }
    const rec = known.get(p) || null;
    missingCandidates.push({ path: p, url: rec ? rec.url : learnUrlFor(p), rec, prevLastmod: indexLastmod(previousIndex.get(p) ?? rec?.lastmod ?? null) });
  }
  let missing;
  if (!sitemapOk) {
    // A failed sitemap file may hold any of these URLs: removal detection is off, all carried.
    missing = { items: [], deferred: [], carried: missingCandidates };
  } else {
    const batch = selectMissingBatch(missingCandidates, c.maxMissingChecks, today);
    missing = { items: batch.items, deferred: batch.deferred, carried: [] };
  }

  // --- quarantine re-check ---
  const qAll = [...invalidByKey.entries()].map(([key, q]) => ({
    key,
    path: key.startsWith("/") ? key : null,
    external: !key.startsWith("/"),
    url: q.url,
    lastChecked: q.lastChecked || "",
  }));
  qAll.sort((a, b) => (a.lastChecked !== b.lastChecked ? (a.lastChecked < b.lastChecked ? -1 : 1) : byCodePoint(a.url, b.url)));
  const quarantine = {
    items: c.maxQuarantineRechecks > 0 ? qAll.slice(0, c.maxQuarantineRechecks) : [],
    deferred: c.maxQuarantineRechecks > 0 ? qAll.slice(c.maxQuarantineRechecks) : qAll,
  };

  Object.assign(stats, {
    kept: kept.length,
    changed: changed.length,
    new: fresh.length,
    fetchPlanned: fetchItems.length,
    deferredChangedByCap: deferredChanged.length,
    deferredNewByCap: deferredNew.length,
    verifyPlanned: verifyItems.length,
    missingCandidates: missingCandidates.length,
    missingPlanned: missing.items.length,
    indexOutOfScope,
    quarantineRechecks: quarantine.items.length,
  });

  return {
    today,
    sitemapOk,
    rows,
    known,
    git: folded.git,
    invalidByKey,
    fetch: { items: fetchItems, deferredChanged, deferredNew },
    verify: { items: verifyItems },
    missing,
    quarantine,
    previousLedger: ledger,
    stats,
  };
}

// ---------------------------------------------------------------------------------------
// reconcile
// ---------------------------------------------------------------------------------------

/**
 * Folds probe results back into data. `results.<phase>[i]` is the classified
 * probe (docs-redirects.mjs classifyProbe() output, plus `text` for the fetch
 * phase) for `plan.<phase>.items[i]`, or undefined when the item never ran
 * (deadline, circuit breaker): such items keep their previous data.
 *
 * @returns {{ catalog, index, invalid, newlyQuarantined, ledger, status, stats, indexWritten }}
 */
export function reconcile({
  plan: p,
  results = {},
  gitRecords = p.git,
  previousIndex,
  scopes = DEFAULT_SCOPES,
  sitemapFailures = 0,
  degraded = false,
}) {
  const today = p.today;
  const records = new Map(p.known);
  const index = new Map();
  for (const [path, row] of p.rows) index.set(path, row.lastmod ?? null);
  const invalidMap = new Map([...p.invalidByKey].map(([k, v]) => [k, { ...v }]));
  const newlyQuarantined = [];
  const discovered = [];
  const contradicted = new Set();
  const gitFinal = [...gitRecords];
  const s = {
    fetched: 0,
    noindex: 0,
    untitledDropped: 0,
    fetchKeptOnNoTitle: 0,
    newNotFound: 0,
    quarantinedOnFetch: 0,
    movedOnFetch: 0,
    fetchTransient: 0,
    verified: 0,
    quarantinedOnVerify: 0,
    movedOnVerify: 0,
    verifyTransient: 0,
    verifyDeferred: 0,
    missingLive: 0,
    missingMoved: 0,
    missingTransient: 0,
    missingCarried: 0,
    quarantinedOnMissing: 0,
    released: 0,
    quarantineMoved: 0,
    quarantineDeferred: 0,
    deferredChangedRun: 0, // changed pages the run could not refresh (not started, transient)
    deferredMissingRun: 0,
  };

  const quarantine = (key, rec, status) => {
    if (invalidMap.has(key)) return;
    const q = { ...stripQuarantine(rec), status, firstDetected: today, lastChecked: today };
    invalidMap.set(key, q);
    newlyQuarantined.push(q);
  };
  const stub = (path) => ({ title: null, url: learnUrlFor(path), product: null, subproduct: null, description: null });
  const note = (from, r) => discovered.push({ from, to: r.to ?? null, status: r.status });

  // 1. quarantine re-check: restored pages are released, moved ones go to the ledger
  p.quarantine.items.forEach((item, i) => {
    const r = results.quarantine?.[i];
    if (!r) return void s.quarantineDeferred++;
    const q = invalidMap.get(item.key);
    if (!q) return;
    if (r.outcome === "live") {
      invalidMap.delete(item.key);
      s.released++;
      if (item.external) gitFinal.push(stripQuarantine(q));
      else {
        contradicted.add(item.path);
        if (q.title) records.set(item.path, normalizeRecord({ ...stripQuarantine(q), lastmod: "released", checked: today }));
        index.set(item.path, p.rows.get(item.path)?.lastmod ?? null);
      }
    } else if (r.outcome === "moved" && !item.external) {
      invalidMap.delete(item.key);
      s.quarantineMoved++;
      note(item.path, r);
    } else if (r.outcome === "gone") {
      q.status = r.status;
      q.lastChecked = today;
    } else {
      s.quarantineDeferred++;
    }
  });

  // 2. page fetches (changed first, then new)
  p.fetch.items.forEach((item, i) => {
    let r = results.fetch?.[i];
    const isChanged = item.kind === "changed";
    if (!r) return void (isChanged && s.deferredChangedRun++);
    if (r.outcome === "live" && !r.text) r = { outcome: "transient" }; // 200 with an empty/cut-off body: unusable, retry
    switch (r.outcome) {
      case "live": {
        contradicted.add(item.path);
        const head = parseHeadMeta(r.text);
        if (isNoIndex(head.meta)) {
          s.noindex++;
          records.delete(item.path);
          break;
        }
        const rec = recordFromHead(head, item.url, cleanTitle);
        if (rec) {
          records.set(item.path, normalizeRecord({ ...rec, lastmod: item.lastmod, checked: today }));
          s.fetched++;
        } else if (item.prev && item.prev.title) {
          s.fetchKeptOnNoTitle++; // the page lost its title (or the head was unreadable): keep what we had
          s.deferredChangedRun++;
        } else {
          s.untitledDropped++; // no usable title and nothing worth keeping
          records.delete(item.path);
        }
        break;
      }
      case "moved":
        note(item.path, r);
        records.delete(item.path);
        s.movedOnFetch++;
        break;
      case "gone":
        contradicted.add(item.path);
        if (item.prev) {
          quarantine(item.path, item.prev, r.status);
          records.delete(item.path);
          s.quarantinedOnFetch++;
        } else {
          s.newNotFound++; // a brand-new sitemap URL that 404s is sitemap lag, not a removal
        }
        break;
      default:
        s.fetchTransient++;
        if (isChanged) s.deferredChangedRun++;
    }
  });

  // 3. verification pass over catalog records still listed in the sitemaps
  p.verify.items.forEach((item, i) => {
    const r = results.verify?.[i];
    if (!r) return void s.verifyDeferred++;
    switch (r.outcome) {
      case "live":
        contradicted.add(item.path);
        records.set(item.path, normalizeRecord({ ...item.rec, checked: today }));
        s.verified++;
        break;
      case "gone":
        contradicted.add(item.path);
        quarantine(item.path, item.rec, r.status);
        records.delete(item.path);
        s.quarantinedOnVerify++;
        break;
      case "moved":
        note(item.path, r);
        records.delete(item.path); // the sitemap still lists it, so it stays in the index; the new page arrives via its own row
        s.movedOnVerify++;
        break;
      default:
        s.verifyTransient++;
    }
  });

  // 4. URLs that fell out of the sitemaps
  const carry = (c) => index.set(c.path, c.prevLastmod);
  for (const c of p.missing.carried) {
    carry(c);
    s.missingCarried++;
  }
  p.missing.items.forEach((item, i) => {
    const r = results.missing?.[i];
    if (!r) {
      carry(item);
      return void s.deferredMissingRun++;
    }
    switch (r.outcome) {
      case "live":
        // live but not listed in the sitemaps: stays in the index and the catalog with its previous lastmod
        contradicted.add(item.path);
        carry(item);
        if (item.rec) records.set(item.path, normalizeRecord({ ...item.rec, checked: today }));
        s.missingLive++;
        break;
      case "gone":
        contradicted.add(item.path);
        quarantine(item.path, item.rec || stub(item.path), r.status);
        records.delete(item.path);
        s.quarantinedOnMissing++;
        break;
      case "moved":
        note(item.path, r);
        records.delete(item.path);
        s.missingMoved++;
        break;
      default:
        carry(item);
        s.missingTransient++;
        s.deferredMissingRun++;
    }
  });
  for (const item of p.missing.deferred) {
    carry(item);
    s.deferredMissingRun++;
  }

  // 5. assemble
  for (const key of invalidMap.keys()) {
    if (key.startsWith("/")) {
      index.delete(key); // a probe-confirmed 404/410 beats a stale sitemap row
      records.delete(key);
    }
  }
  for (const path of [...index.keys()]) if (scopeClass(path, scopes) === null) index.delete(path);
  for (const path of [...records.keys()]) if (scopeClass(path, scopes) !== "learn") records.delete(path); // e.g. a released record outside LEARN_SCOPE

  const catalog = [...records.values(), ...gitFinal].sort(byKey((r) => r.url));
  const invalid = [...invalidMap.values()].sort(byKey((q) => q.url));

  const ledger = updateLedger({
    previous: p.previousLedger,
    discovered,
    contradicted,
    newIndex: index,
    previousIndex,
    inScope: (path) => scopeClass(path, scopes) !== null,
    today,
  });

  let pendingNew = 0;
  for (const [path, row] of p.rows) if (row.cls === "learn" && index.has(path) && !records.has(path)) pendingNew++;

  const indexWritten = sitemapFailures === 0;
  const deferredChanged = p.fetch.deferredChanged.length + s.deferredChangedRun;
  const deferredMissing = s.deferredMissingRun; // capped, never started and transient probes (already counted above)
  const status = {
    indexUrls: indexWritten ? index.size : previousIndex.size,
    catalogRecords: catalog.length,
    sitemapMaxLastmod: maxLastmod([...p.rows.values()].map((r) => r.lastmod)),
    pendingNew,
    deferredChanged,
    deferredMissing,
    quarantined: invalid.length,
    redirects: ledger.length,
    sitemapFailures,
    complete: sitemapFailures === 0 && deferredChanged === 0 && deferredMissing === 0 && !degraded,
  };

  Object.assign(s, { untitledAfter: catalog.filter((r) => r.url.startsWith(LEARN_ORIGIN) && !r.title).length });
  return { catalog, index, invalid, newlyQuarantined, ledger, status, stats: s, indexWritten };
}
