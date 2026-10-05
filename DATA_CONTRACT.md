# learnsync data contract (schema version 2)

This is the authoritative description of every file under `data/` and of the
validator that consumes them. The scripts, the tests and any consumer (for
example the mscerts/hub `Learn URL Check` workflow) must agree with it.

## Why this contract exists

The caches started as research datasets. They are now also the **validity
source** for "is this learn.microsoft.com URL still good?". For that, the data
has to answer, without guessing and without per-consumer live probing:

1. does this exact URL exist right now (modules, **units**, paths, courses,
   certifications, exams, applied skills, study guides, documentation pages)?
2. if it is gone, did it **move** (and where) or was it **removed**, and since when?
3. if the cache cannot know, say so explicitly (`unverifiable`), never guess.
4. is the data **fresh**, and did the sync that produced it actually finish?

## Canonical path form

Every new field/file uses ONE form, produced by `canonicalPath()` in
`scripts/lib/canonical.mjs`: lowercase, no host, no locale segment (`/en-us`),
no query string, no fragment, no trailing slash. Example:
`/training/modules/foundry-sdk/06-exercise`. Consumers must pass URLs through
`canonicalPath()` before comparing. (Legacy `url` fields keep their old shape
for backward compatibility.)

## Files

All JSON is UTF-8, `JSON.stringify(x, null, 2)` unless noted, arrays sorted by a
stable key (plain code-point order, never `localeCompare`).

### `data/status.json` (heartbeat, written by BOTH syncs on EVERY run)

```json
{
  "schemaVersion": 1,
  "learn": {
    "generatedAt": "2026-10-06T07:12:03.000Z",
    "runId": "123456789",
    "modules": 3355, "removed": 76, "outOfScope": 66,
    "unitUrlsRefreshedAt": "2026-10-05",
    "unitHierarchyRequests": 180, "unitHierarchyFailures": 0,
    "content": { "learningPaths": 821, "courses": 139, "certifications": 152,
                 "exams": 145, "appliedSkills": 37, "studyGuides": 130 }
  },
  "docs": {
    "generatedAt": "2026-10-06T08:41:50.000Z",
    "runId": "123456790",
    "indexUrls": 118000, "catalogRecords": 90000,
    "sitemapMaxLastmod": "2026-10-03",
    "pendingNew": 12000, "deferredChanged": 0, "deferredMissing": 0,
    "quarantined": 3, "redirects": 320, "sitemapFailures": 0, "complete": true
  }
}
```

`complete` (docs) is true only when no sitemap file failed and no deferral
remains, i.e. the index is a full picture. A section is replaced wholesale by the
sync that owns it (`scripts/lib/status.mjs`). `runId` is `GITHUB_RUN_ID` or null.

### `data/learn-catalog.json` (modules, v2, additive)

```json
{
  "schemaVersion": 2,
  "lastChecked": "ISO", "sourceApi": "...", "categoryFilter": ["azure", "..."],
  "totalModules": 3355,
  "unitUrlsRefreshedAt": "2026-10-05",
  "modules": [ {
      "uid": "learn.wwl.foundry-sdk",
      "title": "...", "url": "legacy normalized url (unchanged)",
      "path": "/training/modules/foundry-sdk",
      "categories": [], "products": [], "subjects": [],
      "units": ["Introduction", "..."],
      "unitUrls": ["/training/modules/foundry-sdk/01-introduction", "..."],
      "lastModified": "2026-03-18T23:10:00+00:00",
      "unitSig": "sha1 hex"
  } ],
  "removed": [ { "uid": "...", "path": "/training/modules/x", "title": "...",
                 "lastSeen": "2026-09-14", "removedOn": "2026-09-21" } ],
  "outOfScope": [ "/training/modules/some-excluded-module" ]
}
```

* `unitUrls` are the REAL live unit URLs, in module order, from
  `https://learn.microsoft.com/api/hierarchy/modules/<uid>?locale=en-us`
  (`units[].url`). They are NOT derivable from unit uids or positions. `null`
  means the hierarchy could not be read for that module (never an empty guess).
* `units` (titles) and every other pre-existing field keep their meaning.
* `unitSig` = sha1 of `lastModified` + each unit's `uid:last_modified` from the
  catalog API. A module's `unitUrls` are re-fetched only when the signature
  changed, the previous record has no `unitUrls`, or a forced/periodic full
  refresh is due (`FULL_UNIT_REFRESH=1`, or `unitUrlsRefreshedAt` older than 30 days).
* Additive fields beyond the example: `totalApiModules` (raw API module count,
  used by the raw-drop failsafe) and `hierarchyNotFound: true` on the few modules
  the catalog lists but the hierarchy API answers `module_id_not_found` for (their
  pages redirect elsewhere; they have `unitUrls: null` and are re-requested every
  run). A few modules are published outside `/training/modules/`
  (`/training/saas/...`, `/training/azure-databases/...`, `/training/research/...`);
  `path` and `unitUrls` hold their real paths.
* `modules` ∪ `outOfScope` is the COMPLETE set of modules the catalog API
  returned. A module in neither set does not exist upstream.
* `removed` = tombstones: a uid that was in `modules` in the previous run and is
  absent from the whole API response now. Tombstones are append-only, deleted
  only if the uid comes back. A module that merely left the category allowlist
  moves to `outOfScope`, never to `removed`.

### `data/learn-content.json` (new: everything else in the catalog API)

```json
{
  "schemaVersion": 1, "lastChecked": "ISO",
  "learningPaths": [ { "uid": "", "title": "", "path": "/training/paths/x",
                       "lastModified": "", "modules": ["/training/modules/y"] } ],
  "courses": [ { "uid": "", "code": "GH-200T00", "title": "", "path": "/training/courses/gh-200t00", "lastModified": "" } ],
  "certifications": [ { "uid": "", "title": "", "path": "/credentials/certifications/azure-administrator", "lastModified": "", "exams": ["az-104"] } ],
  "exams": [ { "uid": "", "code": "az-104", "title": "", "path": "/credentials/certifications/exams/az-104", "lastModified": "",
               "studyGuide": "/credentials/certifications/resources/study-guides/az-104" } ],
  "appliedSkills": [ { "uid": "", "title": "", "path": "/credentials/applied-skills/x", "lastModified": "" } ],
  "studyGuides": [ { "path": "/credentials/certifications/resources/study-guides/az-104", "checked": "2026-10-05" } ],
  "removed": [ { "type": "learningPath|course|certification|exam|appliedSkill",
                 "uid": "", "path": "", "title": "", "lastSeen": "", "removedOn": "" } ]
}
```

* Source: `https://learn.microsoft.com/api/catalog/?type=learningPaths,courses,certifications,exams,appliedSkills&locale=en-us`
  (one request per type; they are small).
* `exams[].studyGuide` is non-null only when the study guide page was probed
  live (HTTP 200 and final path unchanged) this run; then it is also in
  `studyGuides`. A failed probe (404/410, or a 200 that redirects elsewhere, for
  example `/credentials/browse` for retired exams) sets it to null; a transient
  failure (429/5xx/network) keeps the previous value, and an exam never confirmed
  is listed in the additive top-level `unverifiedStudyGuides`.
* Applied skills carry additive `code` (read from the `aka.ms/APL<nnnn>-StudyGuide`
  link on the skill page; the API has none) and `studyGuide` fields; their guides
  (`/credentials/applied-skills/resources/study-guides/apl-<nnnn>`) share the one
  `studyGuides` list.
* Exam `code` is the lowercase display name (`az-104`, `ab-731`).
* **The catalog API's exam list is incomplete**: it holds legacy exams that have
  their own page. Current exams are absent because
  `/credentials/certifications/exams/<code>` answers 200 after redirecting to the
  owning certification page. Absence of an exam or a study guide therefore proves
  nothing (the validator reports `unverifiable`), and study guides are probed only
  for the exams the API lists.
* Same relative-drop failsafe and tombstone rules as modules, per type.

### `data/docs-urls.txt` (new: complete URL index, plain text)

One line per page: `<canonical path>\t<lastmod or ->`, sorted by code point.
Contains EVERY sitemap URL under `LEARN_SCOPE.include` AND
`INDEX_ONLY_SCOPE.include` (minus excludes), with no page fetches involved, so
it is complete after every successful sitemap pass. `INDEX_ONLY_SCOPE` prefixes
get an index entry but no metadata record in `docs-catalog.json`. A page that is
live but missing from the sitemaps (checked live during removal detection) is
carried in the index with its previous lastmod. Never written when a sitemap
file failed to download (the previous index stays).

### `data/docs-catalog.json` (metadata catalog, unchanged shape)

Array of `{ title, url, product, subproduct, description, lastmod }` plus a new
`checked` (YYYY-MM-DD, last time the record's page was confirmed live). Records
whose canonical path is not in the index and that were not confirmed live are
removed. Case-variant orphans are folded into the sitemap's spelling.

### `data/docs-redirects.json` (new: where moved pages went)

```json
[ { "from": "/azure/old", "to": "/azure/new", "kind": "moved",
    "status": 301, "firstSeen": "2026-09-28", "lastSeen": "2026-10-05" } ]
```

`kind`: `moved` (same content elsewhere), `landing` (destination is a strict
ancestor path or a generic hub page), `retired` (destination under
`/previous-versions/` or a known archive). `to` is null when the destination is
off-site. An entry is deleted when `from` reappears in the index. Produced by the
removal-detection and verification probes (never guessed).

### `data/docs-catalog-invalid.json` (quarantine, unchanged shape)

Definitive 404/410 only. Re-checked every run and released when restored.

### `data/docs-sitemap-families.json`

Unchanged except for an additive `scope` field per family (the scope signature),
so adding a prefix to `LEARN_SCOPE`/`INDEX_ONLY_SCOPE` re-opens stale
`relevant: false` families. Irrelevant families are re-checked after 28 days (at
most 25 per run).

## Validator (`scripts/lib/validate.mjs`, CLI `scripts/validate-urls.mjs`)

`validateUrls(urls, { dataDir, now })` is pure (no network). Result per URL:

```json
{ "url": "...", "path": "/training/modules/x/06-exercise", "kind": "unit",
  "verdict": "valid | broken | moved | unverifiable",
  "reason": "text", "evidence": "learn-catalog | learn-content | docs-urls | docs-redirects | quarantine | tombstone | out-of-scope",
  "confidence": "high | low", "redirectsTo": "/path or null", "suggestion": "absolute URL or null" }
```

Rules (cache only; never guess):

| kind | valid | broken | moved | unverifiable |
|---|---|---|---|---|
| module | in `modules` (not `hierarchyNotFound`) or in `outOfScope` | tombstoned, in neither set, or listed with `hierarchyNotFound` (confidence high) | - | - |
| unit | module valid and path in `unitUrls` | module removed/absent/`hierarchyNotFound`, or module's `unitUrls` lacks it (suggestion = same slug text) | - | `unitUrls` null, or module only in `outOfScope` |
| path / course / applied-skill | in the list | tombstoned or absent | - | - |
| certification | in the list | tombstoned | - | absent (may be a Learn support or program page) |
| exam | in the list | tombstoned | - | absent (the API lists only legacy exams) |
| study-guide (certification or applied-skill) | in `studyGuides` | - | - | absent (probed only for listed exams) |

Modules published outside `/training/modules/` are recognised from the cached
`path` values (a path that is a cached module is a module, a path whose parent
is one is a unit).
| docs | in `docs-urls.txt` | in quarantine; or covered prefix and absent from the index (confidence low: sitemaps lag new pages) | in `docs-redirects.json` | prefix outside `LEARN_SCOPE`/`INDEX_ONLY_SCOPE` |
| other | - | - | - | always (credentials support pages, shows, collections, practice assessments, legacy `/certifications/`, `/` ...) |

`validateUrls` also returns `freshness` (`learn.generatedAt`, `docs.generatedAt`,
`docs.complete`, cache ages) so a consumer can refuse to flag from stale data.

The CLI adds an optional live layer, clearly labelled `evidence: "live-probe"`:
`--confirm-live` re-probes every non-valid verdict (a 200 on the same canonical
path turns it `valid`; a redirect to a different path turns it `moved` with
`redirectsTo`; 404/410 or a soft 404 stays `broken`; a removed Learn module
redirects with HTTP 200 to "Browse all training", a docs page or a learning
path, all of which count as broken/moved) and `--probe-unverifiable` probes the
classes no cache can answer. Two Learn quirks are built in: a current exam URL
that redirects to its certification page is healthy, and a study guide that
redirects (for example to `/credentials/browse`) does not exist. Rate limits,
timeouts and 5xx never change a verdict.

## Failsafes (a bad run must never replace good data)

* learn modules: abort without writing if the in-scope count drops more than
  `MAX_MODULE_DROP_PCT` (5) versus the previous file, if the raw API module count
  drops more than 3%, if an allowlisted category has zero modules, or if more than
  10% of hierarchy requests fail (otherwise failed modules keep their previous `unitUrls`).
* learn content: per type, abort the content write if a list shrinks by more than 20%.
* docs: abort without writing if the sitemap index yields less than 85% of last
  run's index size, if any sitemap file failed (index and catalog carry forward,
  removal detection off), or the duplicate threshold trips.
* both: `status.json` is written even when the data is unchanged; it is the only
  file that proves a run finished. A run that a failsafe aborts writes NOTHING,
  `status.json` included, so a missing or old heartbeat means "no good run".
* The learn section of `status.json` also carries `contentGeneratedAt`,
  `unitHierarchyNotFound`, `unitUrlsNull`, `unitUrlsCarriedForward` and
  `unusedCategories`; its `generatedAt` is the OLDER of the catalog and content
  part stamps. Docs probes are GET requests with `redirect: "manual"` (HEAD and
  GET disagree on the live site).
