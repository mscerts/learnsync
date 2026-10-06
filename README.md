# learnsync

Caches of Microsoft Learn content, refreshed weekly, that answer two questions:
**"what does Learn have about product X?"** (research) and **"is this
learn.microsoft.com URL still good?"** (validation). Training modules with their
real unit URLs, learning paths, courses, certifications, exams, applied skills,
study guides and documentation pages.

[![Learn Catalog Monitor](https://github.com/mscerts/learnsync/actions/workflows/learn-catalog-monitor.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/learn-catalog-monitor.yml)
[![Docs Catalog Monitor](https://github.com/mscerts/learnsync/actions/workflows/docs-catalog-monitor.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/docs-catalog-monitor.yml)
[![CI](https://github.com/mscerts/learnsync/actions/workflows/ci.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Origin

The sync scripts were built inside [mscerts/hub](https://github.com/mscerts/hub),
the Microsoft Certification Knowledge Hub ([msfthub.com](https://msfthub.com)), to
research official Learn resources for exam study guides. This repo is a standalone
extraction with its own schedule, issues and history. The hub now also uses it as
the validity source for its weekly Learn URL check.

## What's in `data/`

| File | Content | Written by |
|---|---|---|
| `learn-catalog.json` | training modules: metadata, **real unit URLs**, tombstones for removed modules, out-of-scope list | `scripts/learn-catalog-sync.mjs` |
| `learn-content.json` | learning paths, courses, certifications, exams, applied skills, verified study guides, tombstones | `scripts/learn-content-sync.mjs` |
| `docs-urls.txt` | complete index of documentation URLs (every sitemap URL in scope, with lastmod) | `scripts/docs-catalog-sync.mjs` |
| `docs-catalog.json` | documentation page metadata (title, description, product, lastmod, checked) | `scripts/docs-catalog-sync.mjs` |
| `docs-redirects.json` | where moved documentation pages went | `scripts/docs-catalog-sync.mjs` |
| `docs-catalog-invalid.json` | quarantined (confirmed 404/410) documentation URLs | `scripts/docs-catalog-sync.mjs` |
| `changes/removed.json` | links learnsync knows are **gone** or no longer lead to the same content (small: a few KB) | both Learn syncs and the docs sync |
| `changes/moved.json` | links that still work but **moved** (redirect to the same kind of page) | both Learn syncs and the docs sync |
| `status.json` | heartbeat: when each sync last finished and what it saw | both syncs |

Schemas, canonical path form, rules and failsafes: **[DATA_CONTRACT.md](DATA_CONTRACT.md)**.
Operational detail for agents and maintainers: **[AGENTS.md](AGENTS.md)**.

Sources: the Learn [catalog API](https://learn.microsoft.com/api/catalog/), the Learn
[hierarchy API](https://learn.microsoft.com/api/hierarchy/modules/learn.wwl.foundry-sdk?locale=en-us)
(real unit URLs), Learn's own [sitemaps](https://learn.microsoft.com/_sitemaps/sitemapindex.xml)
and `github/docs` for docs.github.com. All scripts are plain Node 22 ESM with no
npm dependencies.

## Validating URLs

```bash
echo '["https://learn.microsoft.com/training/modules/foundry-sdk/06-exercise/"]' \
  | node scripts/validate-urls.mjs
node scripts/validate-urls.mjs --input urls.json --output verdicts.json --confirm-live
```

Each URL gets a verdict (`valid`, `broken`, `moved`, `unverifiable`) with the evidence it
rests on, from the caches only (no network) unless you add the live flags
(`--confirm-live` re-probes negative verdicts, `--probe-unverifiable` probes page kinds no
cache covers; those verdicts are labelled `live-probe`). Anything the data cannot know is
`unverifiable`, never guessed. When the change files exist, a broken or moved result also
carries a `change` record (where the link went, since when). See the validator section of
[AGENTS.md](AGENTS.md).

## Reading the change files

`data/changes/removed.json` and `moved.json` list every link learnsync **knows has changed**,
so an automation can ask "did anything I link to break or move?" from two small files instead
of the multi-MB caches (and `git log -p data/changes/` reads as a changelog). Raw files:

- <https://raw.githubusercontent.com/mscerts/learnsync/main/data/changes/removed.json>
- <https://raw.githubusercontent.com/mscerts/learnsync/main/data/changes/moved.json>

Each has `{ schemaVersion, generatedAt, sources: { learn, docs }, entries: [...] }`, where
`sources.<family>` says when that family's entries were last refreshed. Or ask the CLI, which
reads only those two files and `status.json`:

```bash
echo '["https://learn.microsoft.com/training/modules/foundry-sdk/06-exercise/"]' | node scripts/check-changes.mjs
node scripts/check-changes.mjs https://learn.microsoft.com/training/modules/foundry-sdk/ --all
node scripts/check-changes.mjs --since 2026-09-01      # what changed recently
```

Each link gets `status` `removed`, `moved` or `none`, with `outcome`, `to` (where it went),
`confidence`, `firstSeen` and `lastVerified`. **`none` means "no change recorded", not
"valid"**: a link that was never in a learnsync cache, or that broke before changes were
recorded, also reads `none`. The output's `freshness` and `warnings` say whether the files are
fresh enough for that to mean anything; use the validator above for an actual verdict. Exit
code 0 whenever the check ran, 2 for a usage error, 1 when a change file is unreadable.
Field-by-field details, the lookup rules and how the files are seeded and kept up to date are
in [DATA_CONTRACT.md](DATA_CONTRACT.md) and [AGENTS.md](AGENTS.md).

## Running locally

Requires Node.js 22+ (and `git` on `PATH` for the github/docs source):

```bash
npm run sync:learn     # learn-catalog.json + learn-content.json + data/changes/ (a full unit refresh takes ~13 min)
npm run sync:docs      # docs index, catalog, redirects, quarantine, docs entries of data/changes/
DRY_RUN=1 node scripts/docs-catalog-sync.mjs   # plan only, writes nothing
npm run seed:changes -- --dry-run --no-probe   # plan the one-off seed of data/changes/ (see AGENTS.md)
npm test               # offline unit tests
```

Rate limits: Learn answers HTTP 429 above about three concurrent requests, so the syncs
use at most three workers with backoff. Do not loosen that for a one-off run.

## Keeping the caches fresh

Both syncs run weekly on GitHub Actions (Mondays; GitHub often starts scheduled runs hours
late) or on demand from the **Actions** tab. They share one queue so they never push at the
same time, and commit through a push-with-retry script. A run that passes its failsafes
commits the refreshed data and `status.json` (the heartbeat consumers read); a run that fails
a failsafe writes nothing and opens (or comments on) one issue. Newly quarantined
documentation URLs open a separate `data` issue. If the repository secret `HUB_DISPATCH_TOKEN`
is set, each successful sync also tells mscerts/hub to run its Learn URL check immediately.

## Repo maintenance

`ci.yml` runs on pushes and pull requests that touch scripts, tests, workflows or issue
templates: syntax checks, the unit tests, a smoke run of the change-file CLI, `actionlint` and
the issue-template YAML check. All
GitHub Actions are pinned to full commit SHAs and kept current by Dependabot.

## Contributing

Found a miscategorized module, a stale doc page, or a Learn category / docs prefix that should
be tracked but isn't? Please [open an issue](https://github.com/mscerts/learnsync/issues/new/choose).
For anything about how the logic works or how to extend it, start with [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © teriaavibes
