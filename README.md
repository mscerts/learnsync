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
`unverifiable`, never guessed. See the validator section of [AGENTS.md](AGENTS.md).

## Running locally

Requires Node.js 22+ (and `git` on `PATH` for the github/docs source):

```bash
npm run sync:learn     # learn-catalog.json + learn-content.json  (a full unit refresh takes ~13 min)
npm run sync:docs      # docs index, catalog, redirects, quarantine
DRY_RUN=1 node scripts/docs-catalog-sync.mjs   # plan only, writes nothing
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
templates: syntax checks, the unit tests, `actionlint` and the issue-template YAML check. All
GitHub Actions are pinned to full commit SHAs and kept current by Dependabot.

## Contributing

Found a miscategorized module, a stale doc page, or a Learn category / docs prefix that should
be tracked but isn't? Please [open an issue](https://github.com/mscerts/learnsync/issues/new/choose).
For anything about how the logic works or how to extend it, start with [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © teriaavibes
