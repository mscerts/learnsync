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
   (Answered in two small files, `data/changes/removed.json` and `moved.json`, so
   a consumer does not have to read the big caches to find out.)
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
                 "exams": 145, "appliedSkills": 37, "studyGuides": 130 },
    "catalogChanges": { "removed": 7, "moved": 2, "unverified": 1, "newRemoved": 1,
                        "newMoved": 0, "resurrected": 0, "probed": 4 },
    "contentChanges": { "removed": 7, "moved": 2, "unverified": 1, "newRemoved": 0,
                        "newMoved": 0, "resurrected": 0, "probed": 3 }
  },
  "docs": {
    "generatedAt": "2026-10-06T08:41:50.000Z",
    "runId": "123456790",
    "indexUrls": 118000, "catalogRecords": 90000,
    "sitemapMaxLastmod": "2026-10-03",
    "pendingNew": 12000, "deferredChanged": 0, "deferredMissing": 0,
    "quarantined": 3, "redirects": 320, "sitemapFailures": 0, "complete": true,
    "changes": { "removed": 3, "moved": 12 }
  }
}
```

`complete` (docs) is true only when no sitemap file failed and no deferral
remains, i.e. the index is a full picture. A section is replaced wholesale by the
sync that owns it (`scripts/lib/status.mjs`). `runId` is `GITHUB_RUN_ID` or null.

The change-file counters (see "change files" below) sit next to the existing keys,
never replacing them: `removed` of the learn section stays the module tombstone
count. `catalogChanges` and `contentChanges` are what each Learn run reports about
the Learn-family entries of `data/changes/`: `removed` / `moved` = entries now in each
file, `unverified` = removed entries no probe has classified yet, `newRemoved` /
`newMoved` = entries now in that file that were not before this run (a switch from
one file to the other counts in the new file), `resurrected` = entries deleted because
the path is valid again, `probed` = live probes made. Each Learn run replaces only its
own key. `docs.changes` counts the docs-family entries of each file after the run.

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

### `data/changes/removed.json` and `data/changes/moved.json` (change files)

Small indexes of every link learnsync **knows has changed**. They exist so that a
consumer that only asks "did anything I link to break or move?" reads two files
of a few KB instead of the multi-MB caches, and so that the git history of these
two files is a readable changelog. Both syncs write them (each owns its own
`family` of entries); they are committed together with the data and use the
canonical path form. `removed.json` lists links that are gone or that no longer
lead to the same content; `moved.json` lists links that still work through a
redirect to the same kind of page.

```json
{
  "schemaVersion": 1,
  "generatedAt": "ISO (last write)",
  "sources": { "learn": "ISO or null", "docs": "ISO or null" },
  "entries": [ { "path": "/training/modules/x/05-exercise", "kind": "unit", "family": "learn",
                 "outcome": "landing", "to": "/training/modules/x", "title": null,
                 "parent": "/training/modules/x", "firstSeen": "2026-10-05",
                 "lastVerified": "2026-10-05", "evidence": "unit-diff", "status": 301 } ]
}
```

**File header.** `schemaVersion` is 1 (a reader refuses any other value). `generatedAt`
is the timestamp of the last write of the file by any writer. `sources.<family>` is the
`generatedAt` of the sync that last refreshed that family's entries, so a consumer can
judge freshness from the file alone; it is `null` until that sync has written the files
(the seed tool never sets `sources.learn`: a seed run says nothing about whether the
Learn sync runs). `sources.learn` is stamped by whichever Learn run (catalog or
content) wrote last; for the conservative stamp, the older of the two parts, read
`learn.generatedAt` of `data/status.json`. Both files are always written together and
carry the same header after a sync.

**Byte form.** Entries are sorted by `path` in code-point order, the keys of the file
and of every entry are in the order shown here (unknown extra fields of an entry are
kept after the known ones, sorted, so a newer writer's data survives a round trip),
and the text is `JSON.stringify(x, null, 2)` plus a newline. Reading and writing an
unchanged set reproduces the same bytes, and consumers must ignore unknown fields.
A path is in exactly one of the two files; a damaged pair that lists it twice keeps
the more recently verified entry (`removed` wins a tie).

| field | meaning |
|---|---|
| `path` | canonical path of the OLD link |
| `kind` | `module`, `unit`, `learning-path`, `course`, `certification`, `exam`, `applied-skill`, `study-guide`, `docs` |
| `family` | `learn` (catalog API, hierarchy API) or `docs` (sitemaps, docs probes) |
| `outcome` | `removed.json`: `gone`, `landing`, `retired`, `unverified`; `moved.json`: `moved` |
| `to` | destination path. `moved`: where the old link redirects (null only for an off-site move). `landing`/`retired`: where Learn sends visitors instead. Otherwise null |
| `title` | human title when known, else null |
| `parent` | units: the canonical path of their module; else null |
| `firstSeen` | YYYY-MM-DD learnsync first observed the change (a history backfill uses the date of the first snapshot that lacks the path, an upper bound) |
| `lastVerified` | YYYY-MM-DD an authoritative source or a live probe last confirmed this state; null = never |
| `evidence` | what first revealed the change: `tombstone`, `unit-diff`, `hierarchy-not-found`, `rename` (a module or content item kept its uid but its path changed: the OLD path is listed), `quarantine`, `docs-redirect`, `live-probe` (a study guide the content sync's own probe found gone, or a link given to the seed tool that a live probe confirmed), `history` (the seed tool found the path in an older snapshot of `learn-catalog.json`). A later probe that classifies the entry does not overwrite it (`status` and `lastVerified` record the probe) |
| `status` | HTTP status of the FIRST hop of the probe that classified the entry (a `301` for a redirect, even though the destination then answers 200), else null |

Outcomes:

* `gone`: the page answers 404/410, or a soft 404 (a "404 - Content not found" title,
  or a study guide URL that redirects: a study guide that exists is served on its own path).
* `landing`: the old URL still answers 200 but redirects to something that is NOT
  the same content: a generic hub (`/training/browse`, `/credentials/browse`...),
  a strict ancestor, a product root, or a different *kind* of page (a removed
  module that lands on a learning path or a docs page; a removed unit that lands
  on its module's root page; any Learn page that leaves learn.microsoft.com, with
  `to` null). It counts as removed.
* `retired`: docs page redirected under `/previous-versions` or `/archive`.
* `unverified`: an authoritative source says the path no longer exists (module or
  content tombstone, unit missing from the live hierarchy, `hierarchyNotFound`)
  but no probe has classified it yet (probe budget spent, or a transient failure).
  It counts as removed; a consumer may live-confirm it.
* `moved` (the only outcome in `moved.json`): the old URL redirects to the same
  kind of page: module to module, unit to a unit-shaped path (same module with a
  renamed slug, or the same unit under a renamed module), certification to
  certification, learning path to learning path, course to course, applied skill to
  applied skill, exam to exam, docs to docs. Redirecting a *unit* to its module's
  root page is `landing`, not `moved`. A module whose root redirects to one of its
  own units is still the same content: `moved`. A module published outside
  `/training/modules/` (saas, research, azure-databases) is recognised from the
  catalog's module paths (`ctx.modulePaths` of `classifyLearnProbe`); without them
  such a destination reads as `landing`, the conservative side.

A probe that finds the requested path served on its own canonical path (including a
current exam URL that redirects to its certification page, which is how a healthy exam
link behaves) classifies nothing: the path is `live`, and an entry for it is deleted.

Lifecycle (pure functions in `scripts/lib/changes.mjs`, unit tested):

1. **Detect from authoritative sources, never guessed.** Learn family: a new
   module tombstone (`learn-catalog.json` `removed`), a module that is
   `hierarchyNotFound` (every run: a known path is a no-op), a module or content
   item with the same uid whose path changed (`rename`: the old path is the
   candidate), a new content tombstone (`learn-content.json` `removed`), a
   study guide that stopped existing (non-null to null; the sync keeps the previous
   value on a transient failure, so only a definitive probe produces this), and,
   for a module present in both the previous and the new catalog (same canonical
   path) with a trustworthy `unitUrls` on both sides (non-null, non-empty, new list
   not shorter than half of the old one), every old unit URL missing from the new
   list. A module whose path changed is not unit-compared (the `rename` entry and
   the lookup rule cover its units). Docs family: derived each docs run (see below).
2. **Verify with a live probe** (budget `CHANGES_MAX_PROBES` per run, default 300,
   at most 3 workers, at least 500 ms per worker (default pace 1000 ms: real 429s
   occurred at 500), the same HTTP layer and backoff as the syncs; the catalog run and
   the content run each have their own budget and both work through the shared queue
   of every Learn kind): `gone`, `landing` or `moved` as defined above. A transient failure
   (429, 5xx, timeout) never classifies anything: the entry stays `unverified`
   and is retried next run; 40 transient answers in a row stop the run's probing.
   Priority order: unverified entries (oldest `firstSeen` first), `moved` entries
   whose `to` itself changed (the destination is a ledger entry, is covered by a
   module entry, or the caches say it no longer exists), then the entries with the
   oldest `lastVerified` (at most `CHANGES_REVERIFY_PER_RUN`, default 100, so every
   entry is re-confirmed periodically; entries verified today are skipped). The unit
   entries of a module whose own entry is still `unverified` wait in none of these
   tiers: the module's result decides whether it covers them (a probe of each would
   be wasted) or they stand on their own. A run probes in up to three rounds, because
   a result can create work: the units of a module that turned out to be merely
   `moved` are no longer covered by it and are probed in the next round.
3. **Resurrect.** An entry is deleted when its path is valid again: the module is
   back in `modules` with a KNOWN unit list (`unitUrls` not null: a listed module
   whose hierarchy request failed without the API's own `module_id_not_found` has
   no flag but proves nothing about being served, so it deletes no entry), the unit
   is back in `unitUrls`, the content item is back in its list, the docs path is back
   in the index, or a live probe finds the path live on its own canonical path. The
   caches decide without a probe: should both Learn APIs serve a stale snapshot that
   re-lists a removed module, its entry goes and is re-created, with a later
   `firstSeen`, when the removal is seen again.
4. **Collapse.** A `moved` entry whose `to` is itself in `removed.json` (or moved
   again) is re-probed; units of a module that has its own CLASSIFIED `removed` entry
   (`gone`, `landing` or `retired`) are dropped (the module entry covers them, see
   lookup). An `unverified` module entry covers nothing yet: it may be false (the
   module flapped out of an API), and a unit entry dropped under it would never come
   back, since the unit detector only compares modules both catalogs hold. The unit
   entries stay until the module is classified or resurrected.
5. **Retention.** Entries are kept until resurrected (old links keep being wrong
   for as long as anyone links to them). Nothing is dropped because of age.

Learn-family entries are state: the next Learn run reads the previous files. The docs
family is derived from `docs-redirects.json` (`moved` goes to `moved.json`; `landing`
and `retired` go to `removed.json` with that outcome and `to`, evidence
`docs-redirect`) and `docs-catalog-invalid.json` (`gone`, evidence `quarantine`),
and replaces all `family: "docs"` entries on every docs run; it is never probed here.
Quarantine rows whose URL is not on learn.microsoft.com (the docs.github.com git
source) have no canonical path and are skipped, as is a ledger row that cannot be
represented (for example `from` equal to `to`, only possible in a hand-edited ledger),
with a warning.

**Who writes what, and in which order.**

| run | detects | derives / probes | writes |
|---|---|---|---|
| `learn-catalog-sync` | `module` (tombstone, `hierarchyNotFound`, `rename`) and `unit` (`unit-diff`) candidates | live-probes the verification queue (all Learn kinds) | `data/changes/*` first, then `learn-catalog.json`, then `status.json` (`learn.catalogChanges`) |
| `learn-content-sync` | `learning-path`, `course`, `certification`, `exam`, `applied-skill` (tombstone, `rename`) and `study-guide` candidates | live-probes the same queue, its own budget | the same, with `learn-content.json` and `learn.contentChanges` |
| `docs-catalog-sync` | nothing (derived) | replaces every docs-family entry from the final ledger and quarantine | the docs data files, then `data/changes/*`, then `status.json` (`docs.changes`) last |

* The previous files are read at the START of a run, before any request, so a damaged
  one fails the run early. `ChangesFileError`: invalid JSON, a top level that is not an
  object, a `schemaVersion` other than 1 or `entries` that is not an array. A malformed
  ROW inside a valid file is dropped with one warning each (the next write leaves it
  out; a dropped Learn row is not re-detected, detectors only see new changes).
* A run that a failsafe aborts writes nothing, these files and `status.json` included.
  Learn runs write the change files BEFORE their data file: if the process dies between
  the two writes, the next run derives the same candidates from the old data again and
  applying them to a ledger that already holds them changes nothing (the other order
  would lose the diff for good).
* The files are written on every successful run, even when nothing changed: the entries
  stay byte-identical, `generatedAt` and `sources.<family>` move (the contract's promise
  that freshness can be read from the file alone; `status.json` changes on every run too).
  `DRY_RUN=1` still probes (a Learn run) but writes nothing.
* Budgets come from the environment: `CHANGES_MAX_PROBES` (live probes per run, default
  300) and `CHANGES_REVERIFY_PER_RUN` (how many of those may re-confirm the oldest
  recorded entries, default 100). Unset or blank means the default; a value that is set
  but not a non-negative integer (`abc`, `-1`, `1.5`) fails a Learn run (and the seed
  tool) before any request. The docs run does not probe and ignores both. More than 500
  new candidates in one run only log a warning (Learn restructured a lot, or an API
  changed shape); the queue is worked off over several runs.
* A unit removal that coincides with a failed hierarchy request cannot be recorded: the
  old unit list is gone and `unitUrls` becomes null, and nothing is guessed. The validator
  and live probes cover that case.
* The first run after the files are introduced records only genuine diffs against the
  previous data file: tombstones that already exist are not re-reported, and modules that
  were gone long before appear only through the seed tool (below). Modules the catalog
  lists but Learn does not serve (`hierarchyNotFound`) are current state and are
  recorded from the first run on.

**Lookup rule** (`lookupChange(path, index)`): an exact `path` match wins. A path
is also covered by an ancestor entry of `kind: "module"` (a unit of a removed
module is removed; a unit of a moved module probably moved to the same remainder
under `to`, reported with `confidence: "low"`). Docs and other kinds never inherit
from ancestors. A `moved` destination is followed through the ledger (at most 5
hops, cycle safe); if it ends in a removed entry the link counts as removed.
`lookupChange` returns null when nothing is recorded, else `{ state: "removed" | "moved",
outcome, confidence, match: "exact" | "ancestor", entry, final, to, chain, cycle,
truncated, reason }`: `entry` is what the path matched first, `final` the entry that
decided (the same unless a destination was followed), `outcome` that of `final`, `to` the
destination after following the ledger (a moved link: where it goes now, null for an
off-site move; a removed link: the landing page of an EXACT match, null for a link covered
by its module and for a destination that was removed), `chain` the paths walked
(`[link, destination, ...]`). `confidence` is `low` for an inherited move, an
`unverified` entry, a cycle and a truncated chain (`cycle` / `truncated` say which).
A path that the files record nothing about, and anything that is not a Learn URL or an
absolute path, gives null.

**What these files do NOT tell you.** They are not a validity oracle: absence
means "no change recorded", never "valid". A link that was never in a cache
(a typo, a brand-new page, shows, collections, practice assessments, legacy
`/certifications/` paths, credentials support pages) never appears; the
validator and a live probe cover those. A change that happened before learnsync
recorded changes appears only if a history backfill (`scripts/seed-changes.mjs`)
or an operator-supplied URL check found it. Absence is also only as good as the
freshness of the family (`sources.<family>`): a family whose sync has not run for
a while (or never, `null`) says nothing about new changes. A unit removed while
its module's hierarchy request failed is never recorded, and an entry stays
`unverified` until a probe classifies it (it still counts as removed).

#### Reading the change files

* `scripts/check-changes.mjs` (no network, reads only `data/changes/*.json` and
  `data/status.json`, never the big caches; `npm run check:changes -- ...`):

  ```bash
  echo '["https://learn.microsoft.com/training/modules/x/05-exercise/"]' | node scripts/check-changes.mjs
  node scripts/check-changes.mjs https://learn.microsoft.com/training/modules/x/ --all
  node scripts/check-changes.mjs --since 2026-09-01        # changelog view
  ```

  Input: a JSON array (stdin or `--input`) of URLs or absolute paths, strings or objects
  with `url`/`path`, and/or URLs as arguments. Output `{ generatedAt, dataDir, note,
  freshness, warnings, summary, results }`. Each result is `{ url, path, status, outcome,
  to, via, confidence, firstSeen, lastVerified, kind, title, evidence, httpStatus,
  matched, decidedBy, chain, cycle, truncated, reason }`:

  | field | meaning |
  |---|---|
  | `status` | `removed`, `moved` or `none` |
  | `outcome`, `firstSeen`, `lastVerified`, `evidence`, `httpStatus` | of the entry that decided (`decidedBy`); `httpStatus` is the entry's `status` field |
  | `to`, `confidence`, `chain`, `cycle`, `truncated`, `reason` | as `lookupChange` |
  | `via` | `exact` (the link has its own entry) or `ancestor` (its module's entry covers it) |
  | `kind`, `title`, `matched` | of the entry the link matched first (`matched` is its path) |

  Only `removed` and `moved` rows are listed; `--all` adds the `none` rows
  (`{ url, path, status: "none", outcome: null, ..., reason }`, `path` null for a link that
  is not a Learn URL). `summary` counts every input: `{ total, removed, moved, none,
  notLearn }`. **`none` means "no change recorded", never "valid"**: the report's `note`
  says so, and `freshness` / `warnings` say whether the files are fresh enough for "none" to
  mean anything. `freshness` holds `missingFiles`, `error`, `generatedAt`, `sources.<family>`
  (`{ stamp, ageDays, stale }`: a null stamp or one older than `--stale-days`, default 10, is
  stale), `heartbeat` (ages from `status.json`), `entries` and `stale`; every warning is also
  printed to stderr. `--since <YYYY-MM-DD>` lists the entries first seen on or after that date,
  oldest first, under `changes` (`{ path, status, outcome, to, kind, family, title, parent,
  firstSeen, lastVerified, evidence, httpStatus }`) with `summary: { total, removed, moved }`.
  Exit codes: 0 whenever the check ran (a hit does not change it), 2 for a usage error (bad
  flag or date, unreadable or invalid input, missing data directory, no links on a terminal),
  1 when a change file exists but cannot be read (nothing is printed: every link would read
  `none`). Missing change files are not an error: every link reads `none`, with warnings.
* Automations in other repositories can read the two files directly:
  `https://raw.githubusercontent.com/mscerts/learnsync/main/data/changes/removed.json` and
  `.../moved.json`, and import `loadChanges`, `indexChanges`, `lookupChange`, `changesSince`
  and `summarizeChanges` from `scripts/lib/changes.mjs`. Judge freshness from `sources.<family>`.
* The validator (below) attaches the same record to its own `broken` / `moved` verdicts.

#### Seeding the files

`scripts/seed-changes.mjs` (`npm run seed:changes -- ...`) writes changes that happened
BEFORE the Learn sync started recording them. It is a one-off, repeatable maintainer tool: a
re-run only adds what is new and works off what an earlier run left `unverified`.

```bash
node scripts/seed-changes.mjs [--data <dir>] [--history <repoDir>[::<fileInRepo>]]...
     [--urls <file.json>] [--max-probes <n>] [--no-probe] [--dry-run]
     [--today <YYYY-MM-DD>] [--min-modules <n>]
```

Sources, none of them guessed: the current catalog (its tombstones and `hierarchyNotFound`
modules, plus the tombstones of `learn-content.json`; evidence `tombstone` /
`hierarchy-not-found`); `--history` (the git history of `learn-catalog.json`, repeatable, one
`::<fileInRepo>` per historical name of the file because renames are not followed; a module
path that some snapshot had and the current catalog lacks is a candidate, with `firstSeen`
= the date of the first snapshot that lacks it, an UPPER BOUND; evidence `history`); and
`--urls` (a JSON array of links, for example every Learn link a site uses: each is
classified by the cache-only validator and recorded ONLY when a live probe confirms it, evidence
`live-probe`; a link the probe finds live is recorded nowhere, so each run asks again).
Candidates obey the sync's lifecycle, budget (`--max-probes`, default `CHANGES_MAX_PROBES`),
pace and transient handling. `--no-probe` plans only: cache and history candidates are written
as `unverified`, URL-list links are not written. `--dry-run` prints the plan and writes nothing.
The seed merges: known paths keep their entries, docs-family entries are never touched,
`sources.learn` is NOT advanced (a seed run proves nothing about the sync), and nothing is
written when nothing changed. It aborts, writing nothing, when a history snapshot is newer
than the current catalog (a stale data directory) or when the current catalog has fewer than
`--min-modules` modules (default 3000: a truncated catalog would read every other module as
removed); any error exits 1. Only `learn-catalog.json` history is mined; learning paths,
courses and exams are not. Docs-kind links in `--urls` are counted and skipped.

## Validator (`scripts/lib/validate.mjs`, CLI `scripts/validate-urls.mjs`)

`validateUrls(urls, loadData(dataDir))` is pure (no network) and returns
`{ results, freshness, summary }`; `loadData` reads the caches once (a missing file is
recorded in `freshness.missingFiles`, never fatal) and, optionally, the change files.
Result per URL:

```json
{ "url": "...", "path": "/training/modules/x/06-exercise", "kind": "unit",
  "verdict": "valid | broken | moved | unverifiable",
  "reason": "text", "evidence": "learn-catalog | learn-content | docs-urls | docs-redirects | quarantine | tombstone | out-of-scope",
  "confidence": "high | low", "redirectsTo": "/path or null", "suggestion": "absolute URL or null" }
```

(`evidence` is also `missing-data` when a cache file is absent, `scope` for a path outside
every cached scope, and `live-probe` after the live layer.)

Rules (cache only; never guess):

| kind | valid | broken | moved | unverifiable |
|---|---|---|---|---|
| module | in `modules` (not `hierarchyNotFound`) or in `outOfScope` | tombstoned, in neither set, or listed with `hierarchyNotFound` (confidence high) | - | - |
| unit | module valid and path in `unitUrls` | module removed/absent/`hierarchyNotFound`, or module's `unitUrls` lacks it (suggestion = same slug text) | - | `unitUrls` null, or module only in `outOfScope` |
| path / course / applied-skill | in the list | tombstoned or absent | - | - |
| certification | in the list | tombstoned | - | absent (may be a Learn support or program page) |
| exam | in the list | tombstoned | - | absent (the API lists only legacy exams) |
| study-guide (certification or applied-skill) | in `studyGuides` | - | - | absent (probed only for listed exams) |
| docs | in `docs-urls.txt` | in quarantine; or covered prefix and absent from the index (confidence low: sitemaps lag new pages) | in `docs-redirects.json` | prefix outside `LEARN_SCOPE`/`INDEX_ONLY_SCOPE` |
| other | - | - | - | always (credentials support pages, shows, collections, practice assessments, legacy `/certifications/`, `/` ...) |

Modules published outside `/training/modules/` are recognised from the cached
`path` values (a path that is a cached module is a module, a path whose parent
is one is a unit).

`validateUrls` also returns `freshness` (`learnGeneratedAt`, `learnAgeHours`,
`docsGeneratedAt`, `docsAgeHours`, `docsComplete`, `learnCatalogCheckedAt`,
`unitUrlsCached`, `schemaVersion`, `missingFiles`) so a consumer can refuse to flag from
stale data, plus `changes` (`{ available, missingFiles, error, generatedAt, sources:
{ learn, docs } }`, null when the data was not built by `loadData`): whether the change
files could be read and when each family was last refreshed. `missingFiles` keeps meaning
the cache files only.

**Enrichment from the change files** (additive; no verdict rule changes). When
`data/changes/removed.json` / `moved.json` could be read, a result whose verdict is
`broken` or `moved` and whose path the files record (`lookupChange`, the same rules as
above, ancestors of kind `module` included) gets an extra `change` object with the fields
of a `check-changes` result (`status`, `outcome`, `to`, `via`, `confidence`, `firstSeen`,
`lastVerified`, `kind`, `title`, `evidence`, `httpStatus`, `matched`, `decidedBy`,
`chain`, `cycle`, `truncated`, `reason`). Only a record with `confidence: "high"` and a
`to` also fills an EMPTY `redirectsTo` (for a removed link `to` is where Learn sends visitors)
and, for a `moved` record only, an EMPTY `suggestion` (a landing page is not a replacement).
Nothing else changes: `verdict`, `reason`, `evidence`, `confidence`, a `redirectsTo` or
`suggestion` the verdict already has, and `valid` / `unverifiable` verdicts are never
touched, even when a (stale) record exists. A result with no record has no `change` key.
The change files are optional: missing, empty or unreadable files (`freshness.changes`
says which) mean no enrichment, never an error. `scripts/validate-urls.mjs` drops `change`
from a result that `--confirm-live` turned `valid`: a healthy page overrides the record.

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
* change files: a corrupt change file or an invalid `CHANGES_MAX_PROBES` /
  `CHANGES_REVERIFY_PER_RUN` fails a Learn run before any request; a failsafe abort writes
  no change file; 40 transient probe answers in a row stop that run's probing (the entries
  not probed stay as they were and are retried next run). A probe never fails a sync: a
  transient answer only leaves an entry `unverified`.
* The learn section of `status.json` also carries `catalogGeneratedAt`,
  `contentGeneratedAt`, `unitHierarchyNotFound`, `unitUrlsNull`,
  `unitUrlsCarriedForward`, `unusedCategories` and the change counters
  `catalogChanges` / `contentChanges`; its `generatedAt` is the OLDER of the catalog
  and content part stamps. Docs probes are GET requests with `redirect: "manual"` (HEAD and
  GET disagree on the live site).
