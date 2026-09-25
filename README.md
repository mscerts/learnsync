# learnsync

Local, AI-queryable JSON caches of Microsoft Learn content — training modules
and documentation pages — refreshed on a weekly schedule so an AI coding agent
(or a human) can research "everything Microsoft Learn has about product X"
without re-scraping Learn on every question.

[![Learn Catalog Monitor](https://github.com/mscerts/learnsync/actions/workflows/learn-catalog-monitor.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/learn-catalog-monitor.yml)
[![Docs Catalog Monitor](https://github.com/mscerts/learnsync/actions/workflows/docs-catalog-monitor.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/docs-catalog-monitor.yml)
[![CI](https://github.com/mscerts/learnsync/actions/workflows/ci.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Origin

Both sync scripts and their generated caches were originally built inside
[mscerts/hub](https://github.com/mscerts/hub), the Microsoft Certification
Knowledge Hub ([msfthub.com](https://msfthub.com)), to help research official
Microsoft Learn resources for exam study-guide pages. This repo is a
standalone extraction of just that subsystem — the scripts have zero
dependency on the Astro site or anything else in the hub project, so they
live here on their own with their own schedule, issues, and history.

## What's in here

| | Learn Catalog | Docs Catalog |
|---|---|---|
| Covers | Training modules (Learn's `/training/modules/...`) | Documentation pages (`/en-us/<product>/...`) |
| Script | [`scripts/learn-catalog-sync.mjs`](scripts/learn-catalog-sync.mjs) | [`scripts/docs-catalog-sync.mjs`](scripts/docs-catalog-sync.mjs) |
| Data file | [`data/learn-catalog.json`](data/learn-catalog.json) (~3,357 modules) | [`data/docs-catalog.json`](data/docs-catalog.json) (~75,000 pages) + [`data/docs-catalog-invalid.json`](data/docs-catalog-invalid.json) (quarantined dead links) |
| Source    | [`learn.microsoft.com/api/catalog/`](https://learn.microsoft.com/api/catalog/) | Learn's own [sitemaps](https://learn.microsoft.com/_sitemaps/sitemapindex.xml) + changed pages' `<head>` metadata; `git clone` of `github/docs` for docs.github.com |
| Schedule | Mondays 07:00 UTC | Mondays 08:00 UTC |
| Workflow | [`learn-catalog-monitor.yml`](.github/workflows/learn-catalog-monitor.yml) | [`docs-catalog-monitor.yml`](.github/workflows/docs-catalog-monitor.yml) |

Both scripts are plain Node.js ESM with **zero npm dependencies** —
both use the global `fetch`; `docs-catalog-sync.mjs`
additionally shells out to `git`. Neither needs `npm install` to run.

See [AGENTS.md](AGENTS.md) for the full operational detail behind each cache:
category filters, subject-enrichment rules, per-repo URL gotchas, the
automated link-checking/quarantine model, and more.

### Learn Catalog record shape

```json
{
  "uid": "learn.wwl.introduction-development-operations-principles-for-machine-learn",
  "title": "Introduction to DevOps principles for machine learning",
  "url": "https://learn.microsoft.com/training/modules/.../?WT.mc_id=studentamb_165290",
  "categories": ["Azure", "GitHub"],
  "products": ["Azure DevOps", "GitHub", "Machine Learning"],
  "subjects": ["DevOps"],
  "units": ["Introduction", "...", "Summary"]
}
```

### Docs Catalog record shape

```json
{
  "title": "Import SOAP API to Azure API Management",
  "url": "https://learn.microsoft.com/azure/api-management/import-soap-api",
  "product": "azure-api-management",
  "subproduct": null,
  "description": "Learn how to import a SOAP API to Azure API Management as a WSDL specification..."
}
```

A URL whose periodic link check definitively fails (HTTP 404/410 — transient
timeouts/5xx/429 never quarantine) is moved out of `docs-catalog.json`
into `docs-catalog-invalid.json` (same shape, plus `status`, `firstDetected`,
`lastChecked`) instead of failing the sync run. Every quarantined URL is
re-checked on each run: a page Microsoft restores is automatically released
back into the catalog. When a run quarantines a URL
that wasn't already in that backlog, the workflow automatically opens a
GitHub issue with a table of the newly broken URL(s) and a ready-to-use
research/fix prompt for an AI coding agent (see AGENTS.md's
"Investigate-and-fix issue for newly quarantined URLs").

## Running locally

Requires Node.js 22+ (and `git` on `PATH` for the docs catalog sync):

```bash
node scripts/learn-catalog-sync.mjs   # -> data/learn-catalog.json
node scripts/docs-catalog-sync.mjs    # -> data/docs-catalog.json, data/docs-catalog-invalid.json
```

or, equivalently, via the npm scripts in [package.json](package.json):

```bash
npm run sync:learn
npm run sync:docs
npm run sync        # both, in sequence
```

`docs-catalog-sync.mjs` no longer depends on the `MicrosoftDocs/*` repos, which Microsoft
Learn is [retiring by the end of December 2026](https://techcommunity.microsoft.com/blog/skills-hub-blog/changes-to-microsoft-learn%E2%80%99s-public-documentation-repositories/4554909).
It discovers pages from Learn's sitemaps and only fetches pages whose `lastmod` changed.
Flags: `DRY_RUN=1` (plan + per-prefix counts, writes nothing), `FULL_DISCOVERY=1`
(re-scan every sitemap family), `MAX_PAGE_FETCHES=<n>` (per-run cap, default 6000),
`SKIP_GIT_SOURCES=1` (don't clone github/docs).

## Keeping the caches fresh

Each script also runs weekly via GitHub Actions (see the Schedule row above,
or trigger either workflow manually from the **Actions** tab). A successful
run commits the refreshed JSON directly to the default branch (no PR, to keep
this low-friction for a pure data refresh); a failed run opens an issue
instead so it doesn't go unnoticed. The Docs Catalog Monitor additionally
opens an issue whenever it quarantines a newly-broken URL (not on every run —
only when something changes), so the growing quarantine list doesn't just
silently accumulate unnoticed between periodic triage passes. If a single run
quarantines an unusually large batch at once (more than a handful), the issue
calls that out as a likely rate-limit/network false positive rather than
presenting it as that many pages having genuinely broken simultaneously.

## Repo maintenance

A separate [`ci.yml`](.github/workflows/ci.yml) workflow validates script
syntax, runs the unit tests (`npm test`, plain `node:test`, zero
dependencies), lints the workflows with `actionlint`, and validates
issue-template YAML on every push and pull request that
touches them (not on the weekly data-only commits), so a regression is caught
immediately instead of surfacing days later on the next scheduled sync.
All GitHub Actions are pinned to full commit SHAs;
[`dependabot.yml`](.github/dependabot.yml) keeps the pinned GitHub Action
versions current automatically.

## Contributing

Found a miscategorized module, a stale doc page, or a Learn category / docs
repo that should be tracked but isn't? Please [open an issue](https://github.com/mscerts/learnsync/issues/new/choose) —
there are templates for both a sync failure and a data-quality report. For
anything about how the underlying logic works or how to extend it, start with
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © teriaavibes
