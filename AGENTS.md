# Agent Instructions — learnsync

> For AI coding agents (and humans) working on this repository.
> Keep this file updated as the project evolves. The code is the source of
> truth; `DATA_CONTRACT.md` is the source of truth for the data files.

---

## Identity

learnsync keeps zero-dependency Node 22 scripts that build JSON caches of
Microsoft Learn content, refreshed weekly by GitHub Actions. The caches serve
two purposes:

1. **Research datasets** for AI agents and humans ("everything Learn has about
   product X") without re-scraping Learn.
2. **A validity source**: they answer "is this learn.microsoft.com URL still
   good?" for consumers such as the [mscerts/hub](https://github.com/mscerts/hub)
   Learn URL Check workflow, through the validator in this repo.

It was extracted from mscerts/hub (msfthub.com) and is standalone.

## Read this first: what the data can and cannot say

Absence from a cache is evidence only where the data is complete. Rules a
consumer must follow (the validator implements them; see `DATA_CONTRACT.md`):

- **Modules:** `modules` ∪ `outOfScope` is the complete set of modules the
  catalog API returns, so a module in neither does not exist. `removed` holds
  tombstones (when a module vanished).
- **Units:** only `unitUrls` (real live URLs from the hierarchy API) can say
  whether a unit exists. Unit slugs are not derivable from unit uids or from
  positions (`06-exercise`, `exercise`, `4a-exercise-forall`, `10-quiz` after `8`).
- **Learn removes a module by redirecting it** with HTTP 200 (to "Browse all
  training", to a docs page or to a learning path), not with a 404. A status code
  alone proves nothing.
- **The catalog API's exam list is incomplete.** It holds legacy exams that have
  their own page. Current exams (az-104, pl-300, ...) are absent because
  `/credentials/certifications/exams/<code>` answers 200 after redirecting to the
  owning certification page. An exam or study guide missing from the cache is
  `unverifiable`, never `broken`.
- **Docs:** `docs-urls.txt` (the sitemap index) is the existence list for
  documentation pages; `docs-catalog.json` (metadata) is deliberately partial
  for weeks after a scope change (`pendingNew`). Read the index, not the
  catalog, for "does this page exist". Sitemaps lag new pages by days to weeks
  and moved pages are recorded in `docs-redirects.json`.
- **`status.json` is the heartbeat.** Both syncs write their section on every
  run that passes its failsafes, including runs that change nothing. A failsafe
  abort writes nothing, so a missing/old heartbeat means "no good run".
- Some page kinds have no cache source at all (practice assessments, Learn
  shows, collections, legacy `/certifications/` paths): the validator says
  `unverifiable`; a consumer may probe them live.

---

## Directory structure

```
learnsync/
├── DATA_CONTRACT.md                 # schemas, rules, failsafes (authoritative)
├── scripts/
│   ├── learn-catalog-sync.mjs       # modules + real unit URLs  -> data/learn-catalog.json
│   ├── learn-content-sync.mjs       # paths/courses/certs/exams/skills/study guides -> data/learn-content.json
│   ├── docs-catalog-sync.mjs        # sitemap index + metadata + ledger -> data/docs-*.{txt,json}
│   ├── validate-urls.mjs            # validator CLI (cache-only; optional live layer)
│   ├── commit-data.sh               # commit + push data with rebase/retry (used by the workflows)
│   └── lib/                         # pure, unit-tested logic (no I/O) + small I/O wrappers
│       ├── canonical.mjs  scope.mjs  status.mjs          # shared by everything
│       ├── validate.mjs   live-probe.mjs                  # the validator
│       ├── learn-*.mjs                                    # learn config/build/hierarchy/failsafe/http/run/status/content
│       └── docs-*.mjs  sitemap-helpers.mjs                # docs config/reconcile/redirects/failsafes/budget/phases/run/sitemaps
├── test/                            # node:test, no network, no real data
├── data/
│   ├── learn-catalog.json  learn-content.json
│   ├── docs-urls.txt  docs-catalog.json  docs-redirects.json
│   ├── docs-catalog-invalid.json  docs-sitemap-families.json
│   └── status.json
└── .github/workflows/  learn-catalog-monitor.yml  docs-catalog-monitor.yml  ci.yml
```

Run locally (Node 22+, `git` only for the github/docs source):

```bash
npm run sync:learn      # learn-catalog-sync + learn-content-sync
npm run sync:docs       # docs-catalog-sync (DRY_RUN=1 plans only)
npm test                # everything, offline
echo '["https://learn.microsoft.com/azure/key-vault/general/overview"]' | node scripts/validate-urls.mjs
```

---

## Learn catalog (modules): `scripts/learn-catalog-sync.mjs`

Source: `https://learn.microsoft.com/api/catalog/?type=modules,units` plus the
product and subject taxonomies, and `https://learn.microsoft.com/api/hierarchy/modules/<uid>?locale=en-us`
for real unit URLs. Output: `data/learn-catalog.json` (schema v2, see the
contract). Records sort by uid in code-point order.

### Category filter
`ALLOWED_CATEGORIES` (scripts/lib/learn-config.mjs) is the allowlist of top-level
product ids (50 of 61 today). `EXCLUDED_CATEGORIES` lists the ten deliberately
excluded ones (consumer, hololens, makecode, minecraft, mrtk, ms-website,
playwright, qdk, surface, xbox). A top-level product with modules in neither list
prints a warning and appears in `status.json` as `unusedCategories`, so a new
Microsoft category is never lost silently. `KNOWN_EMPTY_CATEGORIES` are allowlisted
ids that have no modules upstream today (agent-framework, microsoft-search,
microsoft-whiteboard, vs-app-center); the "category has zero modules" failsafe
exempts them only while they were empty in the previous file.
Modules excluded by the filter are listed in `outOfScope` (paths only).

### Real unit URLs
- The catalog API gives unit uids and titles but no unit URLs. The hierarchy API
  returns `units[].url` per module; those canonical paths are stored in
  `unitUrls` (module order). Eight in-scope modules live outside `/training/modules/`
  (`/training/saas/...`, `/training/azure-databases/...`, `/training/research/...`);
  their real paths are recorded faithfully.
- `$` in a uid (for example `$learn.become-learn-contributor`): the API accepts
  the id raw or percent-encoded and answers 404 without the `$`. Requests always
  use `encodeURIComponent(uid)`.
- A response that is not a strict 1:1 match (same unit uids, same order) with
  the catalog is rejected and counted as a failure. Four modules are listed by
  the catalog but the hierarchy API answers `module_id_not_found`; their pages
  redirect to a learning path. They get `hierarchyNotFound: true` (only when the
  API's own `module_id_not_found` body was seen), `unitUrls: null`, and are
  re-requested every run; the flag clears when Learn serves them.
- **Incremental refresh** is keyed on `unitSig` (sha1 of module `last_modified` +
  each unit's `uid:last_modified`). A module is re-fetched when it is new, has no
  `unitUrls`, its signature changed, its stored URLs fail a consistency check, or
  the catalog's first unit disagrees. `FULL_UNIT_REFRESH=1`, or `unitUrlsRefreshedAt`
  older than 30 days, forces a full pass (about 3,400 requests, 13 minutes at 3
  workers). `unitUrlsRefreshedAt` moves only when a full pass really ran.
- A failed module keeps its previous `unitUrls` only if its `unitSig` is
  unchanged; otherwise `null`, never an empty guess.

### Tombstones and out of scope
`removed` = a uid in the previous `modules` and absent from the whole raw API
response now (dated today; `lastSeen` = latest of the previous `lastChecked` and
the status heartbeat). A module that merely left the allowlist goes to `outOfScope`.
Tombstones are append-only and dropped if the uid returns. History before the
first v2 run is unknown, so tombstones start empty.

### Failsafes (a bad run must never replace good data; nothing is written, not even `status.json`)
In-scope module count drops more than `MAX_MODULE_DROP_PCT` (5) versus the previous
file; raw API count drops more than `MAX_API_DROP_PCT` (3; `totalApiModules` is stored);
an allowlisted category has zero modules (except `KNOWN_EMPTY_CATEGORIES`); fewer than
`MIN_MODULES` (3,000); unit-title fallbacks above 5%; more than 10% of hierarchy
requests failed (checked when at least 20 were made; a circuit breaker stops a dead
API after 50 requests when more than half failed). Each is a pure function in
`scripts/lib/learn-failsafe.mjs` with fault-injection tests (the 2,900-module truncation
that used to be committed now aborts).

### Subject enrichment (unchanged)
Microsoft's own `subjects` tagging is sparse. `PRODUCT_SUBJECT_HINTS` (scripts/lib/learn-config.mjs)
adds high-confidence subject ids for products with one obvious, undiluted subject; it
only ever adds, never removes, official tags. Sample real module titles before adding
a rule; the products deliberately NOT mapped (power-apps, dataverse, SharePoint,
Exchange, Teams, ms-copilot, agent-365, bare dotnet/vs/vs-code, the umbrella tags
Azure/Windows/Office 365/Windows Server) were rejected because they are broad co-tags
on unrelated content. `CUSTOM_SUBJECTS` holds invented ids (currently `education`).
The 11 modules whose unit titles fall back to raw uids are listed on every run.

## Learn content: `scripts/learn-content-sync.mjs`

Everything else the catalog API serves, one request per type: learning paths (820),
courses (139), certifications (152), exams (145), applied skills (37), as canonical
paths with `lastModified`, plus tombstones per type and these probes:

- **Study guides.** Every exam in the list is probed at
  `/en-us/credentials/certifications/resources/study-guides/<code>` (HTTP 200 and
  an unchanged final path counts; 404/410 and a redirect elsewhere, for example
  `/credentials/browse` for retired exams, count as absent; 429/5xx/timeouts keep
  the previous value, and an exam never confirmed is listed in `unverifiedStudyGuides`).
- **Applied-skill study guides.** The API has no code for applied skills; every
  skill page links `https://aka.ms/APL<nnnn>-StudyGuide`, which the sync reads
  (code and `studyGuide` fields on the skill) and probes the same way.
- Learning-path `modules[]` are resolved to canonical module paths; references to
  modules not in the catalog are dropped and counted (limit 5%).
- Failsafes: per-type drop above `MAX_CONTENT_DROP_PCT` (20), per-list floors, more
  than 10% transient probes, fewer than half of the known applied-skill codes still
  readable (page layout change), and module list below 3,000.
- Probes run at a 1,000 ms per-worker pace: real 429s occurred at 500 ms.
- The exam-list gap (see above) means 29 of the 145 listed exams have a verified
  study guide today (the rest are retired exams: 404 or a redirect to `/credentials/browse`).

Both learn scripts merge only their own keys into the single `learn` section of
`status.json` (`scripts/lib/learn-status.mjs`); `generatedAt` is the older of the two
part stamps, so a fresh catalog run cannot make stale content look fresh.

---

## Docs catalog: `scripts/docs-catalog-sync.mjs`

Source: Learn's own sitemaps (`learn.microsoft.com/_sitemaps/sitemapindex.xml`),
plus the page `<head>` of changed pages, plus `git clone` of `github/docs` for
docs.github.com (Microsoft is retiring the MicrosoftDocs/* repos by the end of
December 2026; the old git/REPOS design is gone). The script is a thin wrapper over
`scripts/lib/docs-run.mjs` (an injectable pipeline built from the pure modules
`docs-reconcile`, `docs-redirects`, `docs-failsafes`, `docs-budget`, `docs-phases`,
`docs-sitemap-pass`, `docs-sitemaps`, `docs-index`, `docs-config`).

### Scope (`scripts/lib/scope.mjs`)
- `LEARN_SCOPE`: pages get an index entry AND a metadata record (title, description,
  product, subproduct, lastmod, checked) in `docs-catalog.json`.
- `INDEX_ONLY_SCOPE`: index entry only (no per-page fetch), so a consumer can tell
  whether a URL exists without paying for metadata of reference pages: cli, partner-center,
  microsoft-copilot-studio, microsoft-sales-copilot, copilot, agent-framework, services-hub
  and the certification product areas power-bi, power-apps, power-automate, purview,
  microsoftteams, viva, security, exchange, sharepoint.
- **Adding a prefix:** edit `scope.mjs`; the family memo carries a scope signature, so
  the next run re-opens stale `relevant:false` families (one-time download of all ~350
  sitemap files). Run `DRY_RUN=1 node scripts/docs-catalog-sync.mjs` first and read the
  per-prefix counts. Everything else is `unverifiable` in the validator.

### What a run does
1. **Index** (`data/docs-urls.txt`): every in-scope sitemap URL with its lastmod, sorted by
   code point, canonical lowercase paths. Never rewritten when any sitemap file failed
   (a truncated file counts as failed); a live page missing from the sitemaps stays in the
   index with its previous lastmod.
2. **Plan:** new and changed pages (LEARN_SCOPE only), changed first and at least 20% of
   `MAX_PAGE_FETCHES` (6,000) reserved for each kind; `lastmod` drives change detection.
3. **Fetch** `<head>` metadata (GET, concurrency 3, 500 ms per worker, retries/backoff).
   Pages with no usable title or `noindex` get no record (4 untitled Dynamics 365 pages today).
4. **Removal detection** covers the whole index: a URL in the previous index or catalog and
   absent from the sitemaps now is probed (cap `MAX_MISSING_CHECKS`, 2,000; oldest-checked
   first; case variants folded first so aliases never use the budget). 404/410 -> quarantine;
   a redirect to a different canonical path -> `docs-redirects.json`; live -> kept;
   transient -> kept and retried. With any sitemap failure removal detection is off.
5. **Verification pass:** the oldest-`checked` catalog records still in the sitemaps are
   re-probed (`VERIFY_PER_RUN`, 2,000, about 8 minutes; a full cycle of ~85,000 records
   takes ~43 weekly runs; raise it if fresher `checked` dates matter). Live sets
   `checked = today`.
6. **Quarantine** (`docs-catalog-invalid.json`): definitive 404/410 only; re-checked every
   run and released when restored (`MAX_QUARANTINE_RECHECKS`). A new quarantine opens an
   issue (table capped at 100 rows, surge callout above 20).
7. **Status** and files are written atomically and only when content changed; `status.json`
   `docs` is written on every run that passes the failsafes.

All status probes are **GET** (never HEAD: the live site answers HEAD and GET differently
for the same URL) with `redirect: "manual"` so the first hop's real status and the chain's
destination are recorded. `classifyRedirect`: `landing` = destination is a strict ancestor
path, a generic hub or a one-segment product root; `retired` = under `/previous-versions` or
`/archive`; else `moved`.

### Budgets and breakers
`MAX_RUNTIME_MINUTES` (90) stops the fetch phases (everything gathered is still written,
deferrals recorded). `CONSECUTIVE_TRANSIENT_LIMIT` (40) stops a phase during a rate-limit
storm and marks the run degraded (exit 1 AFTER writing). Unstarted items keep their data.

### Failsafes (abort with exit 1, write nothing, not even `status.json`)
New index under 85% of the previous index (`INDEX_SANITY_RATIO`; skipped when a sitemap
file failed; with no previous index the baseline is the catalog's unique Learn paths at
50%); catalog under max(20,000, 60% of the previous catalog); duplicate audit above 50
exact or case-variant groups (a few are deduplicated with a warning); a damaged previous
data file.

### Facts worth remembering
- Learn regenerates sitemap files every one to a few weeks, so detection lags publishing.
- ~125 Learn pages are live but missing from the sitemaps (120/120 probed were live): they
  ride along in the index and are probed in rotation.
- The first run after a scope change backfills metadata for ~5 weeks (`pendingNew`).
- `docs-sitemap-families.json` has an additive `scope` field per family (the scope signature);
  families that were irrelevant are re-checked after 28 days (at most 25 per run).
- **github-docs** (`GIT_SOURCES`) is a different org, domain and pipeline (Next.js + Liquid):
  `domain: docs.github.com`, `descriptionField: intro`, `productFromPath: true`, and
  `stripLiquidTags()` cleans `{% data variables.product.github %}` tags. `buildUrl()` strips
  `index` segments. A failed clone carries the previous entries forward and degrades the run.
  `SKIP_GIT_SOURCES=1` skips it for local runs.

Env knobs: `DRY_RUN=1`, `FULL_DISCOVERY=1`, `MAX_PAGE_FETCHES`, `MAX_MISSING_CHECKS`,
`VERIFY_PER_RUN`, `MAX_RUNTIME_MINUTES`, `CONSECUTIVE_TRANSIENT_LIMIT`,
`MAX_QUARANTINE_RECHECKS`, `SKIP_GIT_SOURCES=1`, `QUARANTINE_REPORT_FILE`.

---

## Validator: `scripts/lib/validate.mjs`, CLI `scripts/validate-urls.mjs`

```bash
node scripts/validate-urls.mjs --input urls.json [--output verdicts.json] [--data data]
     [--confirm-live] [--probe-unverifiable] [--concurrency 3] [--delay 500]
```

Input: JSON array of URLs. Output: `{ generatedAt, dataDir, freshness, summary, probed, results }`.
Each result: `url, path, kind, verdict (valid|broken|moved|unverifiable), reason, evidence,
confidence (high|low), redirectsTo, suggestion`. Cache-only by default (pure, no network);
rules per kind are in `DATA_CONTRACT.md`. Highlights: unit links are checked against `unitUrls`
and a dead slug gets a suggestion with the same slug text; a module with `hierarchyNotFound` is
broken; `/training/<area>/` modules published outside `/training/modules/` are recognised from
the cached paths; a docs page absent from the index but inside a scope is `broken` with
`confidence: low` (sitemaps lag), a page in `docs-redirects.json` is `moved`.

The live layer (`--confirm-live`, `--probe-unverifiable`) re-probes negative verdicts and the
classes no cache covers; results are labelled `evidence: "live-probe"`. `interpretProbe` knows
Learn's quirks: removed modules redirect with 200 (broken), a current exam URL redirecting to
its certification page is healthy, a study guide that redirects does not exist, any other
redirect to a different path is `moved`. Rate limits, timeouts and 5xx never change a verdict.

`freshness` (heartbeat ages, `docsComplete`, `unitUrlsCached`, missing files) lets a consumer
refuse to act on stale data. The hub clones this repo and imports these modules, so code and data
always come from the same commit.

---

## Workflows and CI

- `learn-catalog-monitor.yml` (Mondays 07:17 UTC) runs `npm run sync:learn`; `docs-catalog-monitor.yml`
  (07:43 UTC) runs the docs sync with `MAX_RUNTIME_MINUTES=90`. GitHub starts scheduled runs 6-8 hours
  late, which is why nothing relies on clock times: consumers read `status.json`.
- Both share the concurrency group `learnsync-data` (`cancel-in-progress: false`): they never run at the
  same time and never race on `data/status.json`. Timeouts: learn 60 min (a first or monthly full unit
  refresh is ~15-20 min), docs 120 min.
- Commits go through `scripts/commit-data.sh`: commit, push, and on rejection `pull --rebase --autostash`
  and retry (tested against a real git remote). Data commits include `status.json` every week; that tiny
  diff is the heartbeat.
- Failures open or comment on ONE issue with a stable title (`Microsoft Learn Catalog Sync Failed`,
  `Microsoft Docs Catalog Sync Failed`, label `bug`). Newly quarantined docs URLs open a `data` issue.
- **Optional hub trigger:** if the repository secret `HUB_DISPATCH_TOKEN` (a token that may create
  repository dispatch events on mscerts/hub) is set, each successful sync sends
  `repository_dispatch` `learnsync-synced` to mscerts/hub so its Learn URL Check runs right away.
  Without the secret the step is skipped and the hub runs on its own schedule.
- `ci.yml` (push to main and PRs touching scripts/tests/workflows): `node --check` on every script,
  `bash -n` on `commit-data.sh`, `npm test`, `actionlint` (download script pinned to the commit of
  v1.7.12), YAML check of issue templates (PyYAML pinned), `permissions: contents: read`.
  All actions are pinned to full commit SHAs (Dependabot keeps them current).

## First run after deploying schema v2
- Learn: the first run is a full unit refresh (~3,400 hierarchy requests) and rewrites
  `learn-catalog.json` in code-point order (one large diff, 2.9 MB -> 6.0 MB). Tombstones start empty.
- Docs: the first run re-opens every family (all ~350 sitemap files), builds `docs-urls.txt`,
  folds ~1,300 case-alias records and respells ~660, and starts the metadata backfill
  (~28,700 pages pending, about 5 weekly runs at 6,000 per run).
- Dispatch both workflows once after merging so consumers have data before Monday.

## Conventions
- Pure logic in `scripts/lib/*.mjs` with fixture tests; scripts stay thin. No dependencies.
- Anything written to `data/` is sorted with `byCodePoint`, never `localeCompare`.
- Learn rate limits: at most 3 concurrent requests, 500 ms+ per worker, backoff on 429/5xx
  honouring `Retry-After`, per-request timeouts. Never loosen this for a one-off run.
- Verify a changed mapping or scope against real pages before trusting it; a passing test suite and
  a plausible count do not catch wrong-but-well-formed URLs (that is how the old Dynamics 365 base
  path bug survived).
