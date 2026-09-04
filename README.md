# learnsync

Local, AI-queryable JSON caches of Microsoft Learn content — training modules
and documentation pages — refreshed on a weekly schedule so an AI coding agent
(or a human) can research "everything Microsoft Learn has about product X"
without re-scraping Learn on every question.

[![Learn Catalog Monitor](https://github.com/mscerts/learnsync/actions/workflows/learn-catalog-monitor.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/learn-catalog-monitor.yml)
[![Docs Catalog Monitor](https://github.com/mscerts/learnsync/actions/workflows/docs-catalog-monitor.yml/badge.svg)](https://github.com/mscerts/learnsync/actions/workflows/docs-catalog-monitor.yml)
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
| Source | [`learn.microsoft.com/api/catalog/`](https://learn.microsoft.com/api/catalog/) | Blobless/sparse/shallow `git clone` of ~30 `MicrosoftDocs/*` GitHub repos |
| Schedule | Mondays 07:00 UTC | Mondays 08:00 UTC |
| Workflow | [`learn-catalog-monitor.yml`](.github/workflows/learn-catalog-monitor.yml) | [`docs-catalog-monitor.yml`](.github/workflows/docs-catalog-monitor.yml) |

Both scripts are plain Node.js ESM with **zero npm dependencies** —
`learn-catalog-sync.mjs` only uses the global `fetch`; `docs-catalog-sync.mjs`
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

A URL that fails its periodic link check is moved out of `docs-catalog.json`
into `docs-catalog-invalid.json` (same shape, plus `status`, `firstDetected`,
`lastChecked`) instead of failing the sync run.

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

`docs-catalog-sync.mjs` clones each configured repo with
`--filter=blob:none --sparse --depth 1`, so it's fast (well under a minute for
all ~30 repos) but still needs outbound network + `git` access.

## Keeping the caches fresh

Each script also runs weekly via GitHub Actions (see the Schedule row above,
or trigger either workflow manually from the **Actions** tab). A successful
run commits the refreshed JSON directly to the default branch (no PR, to keep
this low-friction for a pure data refresh); a failed run opens an issue
instead so it doesn't go unnoticed.

## Contributing

Found a miscategorized module, a stale doc page, or a Learn category / docs
repo that should be tracked but isn't? Please [open an issue](https://github.com/mscerts/learnsync/issues/new/choose) —
there are templates for both a sync failure and a data-quality report. For
anything about how the underlying logic works or how to extend it, start with
[AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE) © teriaavibes
