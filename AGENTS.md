# Agent Instructions — learnsync

> For AI coding agents (and humans) working on this repository.
> Keep this file updated as the project evolves.

---

## Identity

This repo holds two independent, zero-dependency Node scripts that build local,
AI-queryable JSON caches of Microsoft Learn content (training modules and
documentation pages) for content research. Both were extracted from
[mscerts/hub](https://github.com/mscerts/hub) (the Microsoft Certification
Knowledge Hub, msfthub.com), which originally used them to research content for
its exam study-guide pages. This repo is standalone: the scripts have no
dependency on the Astro site or any other part of the hub project, and the
cache files here are not consumed by anything automatically — they exist for
AI agents and humans to query when doing Microsoft Learn content research.

---

## Project Context

- **Repo:** https://github.com/mscerts/learnsync
- **Origin:** https://github.com/mscerts/hub (`scripts/learn-catalog-sync.mjs`,
  `scripts/docs-catalog-sync.mjs`, and their `src/data_files/*.json` outputs)
- **Stack:** plain Node.js (ESM, no npm dependencies — `learn-catalog-sync.mjs`
  uses only global `fetch`; `docs-catalog-sync.mjs` additionally shells out to
  `git` via `node:child_process`)
- **Node version:** 22+ (matches the GitHub Actions workflows)

## Directory Structure

```
learnsync/
├── scripts/
│   ├── learn-catalog-sync.mjs   # Builds data/learn-catalog.json
│   └── docs-catalog-sync.mjs    # Builds data/docs-catalog.json + data/docs-catalog-invalid.json
├── data/
│   ├── learn-catalog.json       # Cache of MS Learn training modules
│   ├── docs-catalog.json        # Cache of MS Learn docs pages
│   └── docs-catalog-invalid.json# Quarantined (confirmed-broken) docs URLs
└── .github/workflows/
    ├── learn-catalog-monitor.yml
    └── docs-catalog-monitor.yml
```

This is a deliberately flat layout (no `src/`) — the nested `src/data_files/`
path in the sections below only made sense inside the original Astro site and
has already been adjusted to `data/` throughout this file.

---

## Learn Catalog Cache

Local, AI-queryable cache of Microsoft Learn training modules (name, product category, product(s), subjects, unit names), so an agent can find "all modules about product X" without re-scraping Learn each time.

- **Data file:** `data/learn-catalog.json` — not consumed automatically by anything; a pure reference dataset for content research.
- **Script:** `scripts/learn-catalog-sync.mjs` — Node (ESM, zero dependencies, uses global `fetch`). Run with `node scripts/learn-catalog-sync.mjs`.
- **Workflow:** `.github/workflows/learn-catalog-monitor.yml` — runs Monday 07:00 UTC + manual trigger; commits the refreshed file directly (no PR) and opens an issue only if the sync fails.
- **Source:** `https://learn.microsoft.com/api/catalog/` (`type=modules,units,products,subjects`).

### Catalog API shape (important — not obvious from the API itself)
- `?type=products` and `?type=subjects` each return a **flat top-level list where every entry has `parent_uid: null`**; the real hierarchy lives in a `children: [{id, name}]` array on each top-level entry, 2 levels deep. No child id is duplicated under multiple parents.
- A module's `products` array can mix top-level ids (e.g. `github`) and child ids (e.g. `azure-cosmos-db`) from *different* parents in the same module — modules are not confined to one category.
- The `product=<id>` query filter matches **only the literal tag**, not the category hierarchy (filtering `product=azure` excludes a module tagged only `azure-devops`, even though DevOps is a child of Azure). Reliable category classification requires pulling the full unfiltered catalog and resolving each module's product ids against the children map yourself — don't rely on the query filter for "everything in category X".
- `units` is a **separate top-level array** in the catalog response (uid, title, duration, locale, last_modified) — a module only lists ordered unit *uids*; resolve titles via this array instead of fetching each module/unit individually.
- Full unfiltered catalog (as of 2026-08-29): 3,425 modules, 27,557 units, 60 top-level products (220 child products); ~5.5MB modules + ~5.8MB units + ~15KB products, all `locale: en-us` by default.

### Category filter
`ALLOWED_CATEGORIES` in `scripts/learn-catalog-sync.mjs` is an explicit allowlist of top-level product ids (50 of 60). It covers every cert-tracked area (Azure, M365 family, Dynamics 365, Power Platform, GitHub, Fabric, Entra, Sentinel, Defender, Purview, Priva, Security Copilot, Copilot, Intune/MEM, Viva, Teams, agent-365/agent-framework, SQL Server, Windows, SharePoint, Exchange, Industry Solutions, Graph) plus generic dev/productivity categories (.NET, ASP.NET/ASP.NET Core, Visual Studio/VS Code/App Center, Bing, Microsoft Edge, Microsoft Authentication Library, Sysinternals, Windows Server, Microsoft Search, Microsoft Whiteboard, Adaptive Cards, Microsoft Forms, and the standalone Office apps: Excel, Word, PowerPoint, Outlook, OneNote, OneDrive, plus the generic `office` and `m365-ems-advanced-threat-analytics` tags). This keeps 3,357 of 3,425 modules. Only 10 categories remain excluded as not relevant to any tracked content: Consumer, HoloLens, Microsoft MakeCode, Minecraft, Mixed Reality Toolkit, Quantum Development Kit, Surface, Xbox, `ms-website` (a small ~11-module bucket for AppSource/Azure Marketplace/Microsoft Education Center partner-publishing content), and `playwright` (a single Learn module about the open-source Playwright test framework — no Microsoft cert exists for it). Edit the array directly to add/remove a category — no other code changes needed.

### Module record schema
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
- `categories` = resolved top-level parent name(s), restricted to `ALLOWED_CATEGORIES` matches; `products` = every tagged product's display name (parent- or child-level, whichever was tagged), unrestricted.
- `units` are titles only (no uids), in module order; a small number (~120 of ~19,000 as of the initial run) fall back to the raw unit uid because the catalog's `units` array didn't include that uid — a minor upstream data inconsistency, not a bug.
- URLs are normalized the same way as content pages: `/en-us/` stripped, `WT.mc_id` rewritten to `studentamb_165290`.
- Records are sorted by `uid` for stable, minimal diffs between refreshes.

### Subject enrichment
Microsoft's own `subjects` tagging is sparse and inconsistent (as of the 2026-08-29 snapshot, 415 of 3,357 modules have zero subjects at all, down from 638 before enrichment; near-duplicate modules can also be tagged differently — e.g. "Introduction to Azure Firewall" had no "Networking" tag despite being a firewall module, while a similar Firewall module did). `PRODUCT_SUBJECT_HINTS` in `scripts/learn-catalog-sync.mjs` is a deterministic product-id → subject-id table that adds a subject when a module has a well-known, unambiguous product (networking appliances, specific databases, AI services, identity/Defender/Purview products, device management, Power BI/Power Automate/Fabric, containers, Azure DevOps, monitoring/backup, automation/serverless, app-development frameworks, Education) and Microsoft's own tag is missing it. It only **adds** subjects, never removes Microsoft's own tags, and covers ~80 high-confidence product ids — it is not a full content classification of every module, so gaps can still remain for products not in the table (see "Known residual gaps" below).
- **Verified empirically, not just by code review**: cross-checked all 3,357 modules' official `subjects` against the generated cache — 0 violations (every official tag survives; the merge is `new Set(mod.subjects)` + `.add()` only, never `.delete()`/reassignment). Re-run this check after touching the merge logic: fetch `?type=modules,subjects`, resolve each module's raw subject ids to names, and confirm every one is present in that module's cache entry.
- **Custom subjects** (`CUSTOM_SUBJECTS` in the script): ids invented because no official Microsoft Learn subject fits, merged into the same resolution map as official ones so they're indistinguishable in the output format. Currently one: `education` → "Education" (Microsoft Learn's `?type=subjects` taxonomy has no education-related entry at all, yet `m365-education`-tagged modules — K-12/higher-ed content — are a large, clean, consistent cluster: 68 modules, was 93% zero-subject before this tag).
- **Products considered and deliberately rejected** after sampling actual module titles (high-level "% missing" stats looked compelling but the products turned out to be broad co-tags on unrelated content, so adding the hint would have been inaccurate): `power-apps` (Custom app development — diluted by Copilot Studio/AI Builder modules that aren't app-building), `dataverse` (databases — same dilution), `office-sp`/SharePoint (Collaboration — tiny, weak sample), `office-exchange`/Exchange (Communication — sampled modules were actually about Purview/Defender compliance auditing, not messaging), `office-teams`/Teams (Collaboration/Communication — diluted by Power Platform/Copilot extension modules built on top of Teams), `ms-copilot` and `agent-365` (chatbots/generative-ai — used as a broad co-tag across modules that are really about the underlying platform, e.g. "Build a Power Apps canvas app... with Copilot in Power Apps" is a Power Apps module, not a chatbot-building one). Don't re-add these without re-sampling real module titles first — the aggregate gap % alone is not sufficient evidence.
- **Known residual gaps (deliberately left unfixed)**: a per-product zero-subject report (group all modules by product, sort by zero-subject count) shows the bare umbrella tags `Azure` (759 modules, 118 zero — 93 of those have *no other product tag at all*), `Windows`, `windows-11`, `Office 365`, and `Windows Server` are each too heterogeneous for one hint (samples span everything from accessibility to Active Directory to IIS to K-12 classroom content within the same tag). Fixing these would need either fragile title-keyword matching or non-durable per-uid overrides (which would just be silently discarded on the next resync, since the file always regenerates from the live API) — neither meets the bar used for every other entry in this table. Re-derive this report (`group by product → count, zero-subject count`) before investing more time here rather than guessing which products still have gaps.
- Extend the table (grouped by category, values are subject ids from `?type=subjects`, or a new `CUSTOM_SUBJECTS` entry if nothing fits) if you spot another consistent, undiluted gap — sample several real modules with that product before adding a rule, the same way the accepted entries above were checked.

### Failsafe
Script aborts (`process.exit(1)`, nothing written) if fewer than `MIN_MODULES` (2,800) modules match after filtering — signals the catalog API schema likely changed.

### Running locally
```bash
node scripts/learn-catalog-sync.mjs
```

---

## Docs Catalog Cache

Local, AI-queryable cache of Microsoft Learn **documentation** pages (title, url, product, subproduct, description) — the docs-portal sibling of the Learn Catalog Cache above, which only covers training modules. Documentation has no bulk API, so this is built by shallow-cloning each product's public docs repo on GitHub instead.

- **Data file:** `data/docs-catalog.json` — not consumed automatically by anything; a pure reference dataset for content research, same role as `learn-catalog.json`.
- **Script:** `scripts/docs-catalog-sync.mjs` — Node (ESM, zero dependencies, uses `git` via `execSync`). Run with `node scripts/docs-catalog-sync.mjs`.
- **Workflow:** `.github/workflows/docs-catalog-monitor.yml` — runs Monday 08:00 UTC + manual trigger; commits the refreshed file directly (no PR, same pattern as the Learn Catalog workflow) and opens an issue if any repo fails or the sync falls below the failsafe threshold. The commit step runs even if the sync step reports failure (`if: ${{ !cancelled() }}`), so a partial failure (one repo down) still commits the data gathered from the repos that succeeded.
- **Source:** one `git clone --filter=blob:none --sparse --depth 1 --no-checkout` per repo in the `REPOS` array in the script, sequentially (not parallel — clones are fast enough, ~2-30s each, that parallelizing isn't worth the added complexity; matching the Learn Catalog workflow's preference for simple, single-script automation).

### Why git clone instead of an API
Microsoft's Learn Platform API and `/api/catalog/` only cover Modules/Units/Learning Paths/Applied Skills/Certifications/Exams/Instructor-Led Courses — not documentation. Documentation lives in ~dozens of open-source `MicrosoftDocs/*` GitHub repos (CC BY 4.0 content, MIT code, public-contribution repos — safe to cache metadata from). A blobless/sparse/shallow clone avoids the GitHub REST API's rate limits entirely (it uses git's smart HTTP protocol, not `api.github.com`) and is fast: azure-docs (the largest repo used), at 159MB/~15K files with full history, clones and checks out in under 30 seconds when filtered this way.

### Repo config shape and the critical gotcha
Each `REPOS` entry is `{ name, repoUrl, targets: [{ sourceFolder, baseUrlPath }] }`. A repo can have multiple `targets` (multiple docsets sharing one clone) — `defender-docs` has 15. Optional per-repo overrides exist for repos that don't follow the docfx/Microsoft Learn convention: `domain` (default `learn.microsoft.com`), `descriptionField` (default `description`, the frontmatter key to read for the description), and `productFromPath` (derive `product` from the first path segment under `sourceFolder` instead of an `ms.service`-style frontmatter tag). See the `github-docs` section below for the one repo that uses all three.

**`baseUrlPath` must be manually verified against a real live page fetch — never trust a repo's `.openpublishing.publish.config.json` → `docsets_to_publish[].build_output_subfolder` literally.** That value is frequently an internal build alias, not the public URL segment. Confirmed mismatches found while building this cache:
| Repo/docset | `build_output_subfolder` (wrong) | Real live URL base (verified) |
|---|---|---|
| entra-docs | `entra-docs` | `entra` |
| fabric-docs | `fabric-docs` | `fabric` |
| windowsserverdocs | `WindowsServerDocs-VSTS` | `windows-server` |
| defender-docs: sentinel | `sentinel-azure` | `azure/sentinel` (nested under Azure) |
| defender-docs: defender-for-cloud | `defender-for-cloud` | `azure/defender-for-cloud` (nested under Azure) |
| defender-docs: easm | `easm-azure` | `azure/external-attack-surface-management` |
| defender-docs: exposure-management | `exposure-management` | `security-exposure-management` |
| defender-docs: defender-for-identity | `ATP-Docs` (legacy alias) | `defender-for-identity` |
| defender-docs: defender (landing/overview docset) | `defender` | `unified-secops` |
| defender-docs: defender-for-iot / d4iot-azure | `defender-for-iot` / `d4iot-azure` | both publish under `azure/defender-for-iot` |
| microsoft-365-docs: copilot | `microsoft-365-copilot` | `microsoft-365/copilot` (canonicalUrl nests it under the same `microsoft-365/` prefix as the repo's other docset, not a separate top-level path) |

Roughly half of `defender-docs`' docsets needed correction this way, while `defender-endpoint`, `defender-cloud-apps`, `defender-xdr`, `defender-business`, `defender-office-365`, `defender-vulnerability-management`, and `unified-secops-platform` all matched their literal config value. There's no reliable way to predict which case a new repo/docset falls into — always spot-check a sample file's constructed URL with `microsoft_docs_fetch` (or equivalent) before adding it, the same way every repo in the current list was verified. `power-platform` also has an unrelated second docset (`project-sophia`/`ps-docs`) deliberately excluded as out of scope, and `defender-docs`' `advanced-threat-analytics` (ATA) docset is excluded as a legacy/retired product superseded by Defender for Identity.

### Dynamics 365 tier: a shared namespace, not per-repo aliases
Dynamics 365 documentation is fragmented across ~10 separate `MicrosoftDocs/*` repos (one per product area, found via `github.com/orgs/MicrosoftDocs/repositories?q=dynamics`), and most publish under a **shared `dynamics365/` URL namespace** rather than a distinct per-repo segment — each repo's `.openpublishing.publish.config.json` `build_output_subfolder` (e.g. `customer-engagement`, `d365F-O`, `dynamics365-contact-center`, `dynamics-365-order-management`, `dynamics365guidance`) is **never** the real live path.

**The critical distinction is whether the product name survives as a real folder *inside* the sourceFolder, or whether the sourceFolder itself *is* the product** (confirmed live, then re-confirmed by a duplicate-URL audit across the whole generated catalog — see below):
- `dynamics-365-customer-engagement` (`sourceFolder: "ce"`) and `dynamics-365-unified-operations-public` (`sourceFolder: "articles"`) are generic containers holding *multiple* product subfolders (`ce/sales/`, `ce/customer-service/`, `articles/finance/`, `articles/supply-chain/`, etc.) — those subfolder names become the URL segment for free, so `baseUrlPath: "dynamics365"` alone is correct.
- Every other single-product repo uses its product name (or an alias of it) *as* the `sourceFolder` itself (`contact-center`, `mr-docs`, `topics`, `guidance`, `articles`-for-project-operations) — using it as `sourceFolder` strips it from the relative path, so it **must be re-added explicitly** to `baseUrlPath`, e.g. `dynamics365/contact-center`, `dynamics365/guidance`, `dynamics365/project-operations`, `dynamics365/intelligent-order-management`. `dynamics-365-mixed-reality` is the trickiest case: its folder is named `mr-docs`, but the real live segment is `mixed-reality` — folder name and URL segment don't always match, so verify each one, don't infer from the folder name. The Business Central pair follows the same rule: `dynamics365/business-central` (`dynamics365smb-docs`) and `dynamics365/business-central/dev-itpro` (`dynamics365smb-devitpro-pb`, a *separate* repo from `dynamics365smb-docs` despite covering the same product).

**This was originally implemented wrong** for 5 repos (`dynamics-365-project-operations`, `dynamics-365-contact-center`, `dynamics-365-mixed-reality`, `dynamics-365-intelligent-order-management`, `dynamics365-guidance`) — each had `baseUrlPath: "dynamics365"` alone, producing URLs missing the product segment entirely (e.g. `dynamics365/administer/...` instead of `dynamics365/contact-center/administer/...`). It surfaced only because two of the broken URLs happened to collide (`dynamics365/overview` and `dynamics365/whats-new/whats-new-home-page`, each claimed by two different repos' root-level files) and got caught by a **whole-catalog duplicate-URL check** (`Group-Object url | Where Count -gt 1`) — run this check after adding or changing any repo, since a passing `pnpm build` and a plausible-looking entry count do not catch wrong-but-well-formed URLs.

Excluded from this tier as legacy/retired (no current cert relevance, docs frozen or product discontinued): `msftdynamicsgpdocs` (Dynamics GP), `DynamicsAX2012-technet`/`-msdn` (AX 2012), `nav-content` (Dynamics NAV, Business Central's predecessor), `dynamics365-docs-templates` (archived, templates only), `dynamics-365-supply-chain-insights` (stale since 2022, folded into `dynamics-365-unified-operations-public`), `dynamics-365-ai` (stale since Nov 2024, superseded by per-app Copilot content), and **`dynamics-365-fraud-protection`** — confirmed via the repo's own `includes/deprecation.md` that support ended February 3, 2026 and the product is no longer purchasable; it no longer appears in the live Dynamics 365 documentation hub page at all. `dynamics365-industry-solutions` has no `.openpublishing.publish.config.json`; it's a generic community repo, not a docs source. Also note: `dynamics-365-mixed-reality` (Guides and Remote Assist) is included since it's still live, but Microsoft has announced both products retire December 31, 2026 — revisit after that date.

### Branch handling
The script uses a bare `git checkout` (no branch name) after the `--no-checkout` clone, which resolves to each repo's actual default branch automatically — confirmed necessary since not all repos use `main` (`microsoft-365-docs` uses `public`). Do not hardcode a branch name per repo.

### m365copilot-docs and the Purview/Priva dead end
`m365copilot-docs` (Microsoft 365 Copilot **extensibility**/developer docs — declarative agents, plugins, adaptive cards, Agent Builder) is a distinct repo from `microsoft-365-docs`' own `copilot/` folder (which covers agent *governance*: `agent-essentials/`, `copilot-control-system/`). Both share the `microsoft-365/copilot/` URL prefix with no overlapping subfolders (`extensibility/` vs. `agent-essentials/`/`copilot-control-system/`), confirmed via canonicalUrl, so no duplicate entries. Normal docfx repo, no overrides needed beyond `baseUrlPath: "microsoft-365/copilot/extensibility"`.

By contrast, **Purview and Priva were investigated and confirmed to have no public repo**, correcting an earlier assumption that their content was folded into `microsoft-365-docs`' `security/` folder — that folder actually contains only 2 real content files (checked directly, not just repo-searched). A live Purview/Priva page's own frontmatter (`original_content_git_url`) reveals the true source repos are `Purview-pr` and `OfficeDocs-Privacy-pr` — but only the `-pr` (internal/staging) forms exist; the expected public counterparts (`Purview`, `OfficeDocs-Privacy`, dropping the `-pr` suffix per the pattern every other repo in this cache follows) both 404, and neither turns up in an org-wide repo search for "purview", "priva", or "compliance" either. Same closed status as the Office-suite family and Windows client docs — revisit only if Microsoft changes its publishing model.

### github-docs: a different org, domain, and pipeline entirely
`github/docs` (the open-source repo behind docs.github.com, GH-* exam content) is not a MicrosoftDocs/docfx repo at all — it's Next.js + Liquid templating, so it needed three repo-level overrides instead of the usual `baseUrlPath` verification: `domain: "docs.github.com"`, `descriptionField: "intro"` (its frontmatter uses `intro` where docfx repos use `description`), and `productFromPath: true` (there's no `ms.service`-equivalent tag, so `product` is the top-level `content/` folder name, e.g. `actions`, `copilot`, `codespaces`). No locale prefix is needed — `docs.github.com/<path>` resolves the same as `/en/<path>`.

Raw frontmatter text also contains unresolved Liquid tags like `{% data variables.product.github %}` (54% of `intro` values had at least one, sampled against the full repo). A `stripLiquidTags()` helper resolves the handful of common `variables.product.*` tags to "GitHub" and strips any other `{%...%}` tag outright — applied to both `title` and `description` for every repo (harmless no-op for docfx repos, which never contain this syntax). This cleans 99.9% of entries; a small number (3 of 3,741, all product-name tags like `variables.copilot.copilot_cli` with no text around them) fall back to the raw tag in the title so it's never blank — a known, accepted gap, not worth a full per-variable resolution table for 0.08% of entries.

### Entry schema
```json
{
  "title": "Import SOAP API to Azure API Management",
  "url": "https://learn.microsoft.com/azure/api-management/import-soap-api",
  "product": "azure-api-management",
  "subproduct": null,
  "description": "Learn how to import a SOAP API to Azure API Management as a WSDL specification..."
}
```
- `title`/`description`/`product`/`subproduct` come from a file's frontmatter (`title`, `description`, `ms.service`, `ms.subservice`) via a simple line-based parser (not a full YAML parser — would break on multi-line block-scalar values, though none were observed in practice). Files without a parseable `title` are skipped.
- `url` is built from the file's path relative to its target's `sourceFolder`, joined to the verified `baseUrlPath` (see gotcha above) — no `/en-us/`, no `.md` extension.
- Frontmatter is inconsistently tagged across repos: expect a meaningful fraction of entries with `product: null` (varies by repo, roughly a quarter to a third overall) — this mirrors the same sparsity seen in the Learn Catalog's official `subjects` tagging and isn't a bug.
- Confirmed-broken URLs don't stay here — they're moved to the sibling `docs-catalog-invalid.json` quarantine file instead (see Automated link checking below).

### Current scope: easy + medium + Dynamics 365 done (as of 2026-08-30)
Repos are added in tiers of increasing topology complexity — verify and pilot each tier before moving to the next:
- ✅ **Easy tier (done):** one repo each, single or small number of clean docsets — `azure-docs`, `entra-docs`, `fabric-docs`, `sql-docs`, `power-platform`, `memdocs` (Intune + Autopilot), `windowsserverdocs`, `defender-docs` (15 docsets, see table above), `github-docs` (GH-* exam content — the original plan called for this repo but it was initially missed; added later, see dedicated section above). **46,830 entries** (43,089 initial + 3,741 `github-docs`), 13.2 MB before `github-docs`.
- ✅ **Medium tier (done):** `microsoft-365-docs` — a real repo but narrower in scope than its name implies: covers `microsoft-365/` (admin, security, backup, business-premium, frontline, managed-desktop, migration, loop, whiteboard, commerce, lighthouse, bookings, and more — nearly all top-level subfolders, ~20 of them) plus `copilot/` (Agent 365 governance content under `agent-essentials/` and `copilot-control-system/`). It does **not** contain Teams, Viva, Exchange, or SharePoint content despite the repo name. **1,170 entries** (1,006 + 164).
- ✅ **Dynamics 365 (done, part of the former hard tier):** ~10 repos, all resolving to a shared `dynamics365/` namespace — see the dedicated section above for the URL-pattern discovery and exclusions. `dynamics-365-customer-engagement` (4,526), `dynamics-365-unified-operations-public` (5,862), `dynamics365smb-docs` (2,111), `dynamics365smb-devitpro-pb` (5,809), `dynamics-365-project-operations` (878), `dynamics-365-contact-center` (169), `dynamics-365-mixed-reality` (248), `dynamics-365-intelligent-order-management` (83), `dynamics365-guidance` (583). **21,439 entries** added this tier.
- ✅ **AI Business / Copilot extensibility (done):** `m365copilot-docs` — **265 entries**, see dedicated section above. Its sibling products, Purview and Priva, were investigated and confirmed to have no public repo (see same section) — same closed status as Office-suite/Windows client below.
- **Office-suite family — confirmed to have no dedicated repo at all (investigated 2026-08-30):** Teams, Exchange, SharePoint, Outlook, Viva, Word/Excel/PowerPoint, OneDrive, and OneNote admin/end-user documentation has **no clean canonical public GitHub source repo**, unlike every product added so far. Searched exhaustively via `github.com/orgs/MicrosoftDocs/repositories?q=<term>` per product plus direct repo-name guesses; every lead was one of:
  - **Developer-only**, not admin/end-user docs: `msteams-docs` and `Microsoft-teams-docs` (Teams developer platform), `office-developer-exchange-docs`, `office-developer-client-docs`, `office-developer-word-pia-ref-dotnet`, `office-developer-excel-pia-ref-dotnet`, `office-developer-outlook-pia-ref-dotnet`, `office-developer-sharepoint-server-2013-ref-dotnet` (most of these are also legacy/archived, e.g. SharePoint Server 2013).
  - **A narrow utility repo, not general docs**: `OfficeDocs-SharePoint-PowerShell` is a PowerShell cmdlet reference only.
  - **Legacy/archived locale-only content with no unsuffixed canonical repo**: `OfficeDocs-SkypeForBusiness.de-DE` / `-pr.<locale>` (Teams predecessor content), `OfficeDocs-Exchange-Test-pr.<locale>`, `office-shared-outlook.<locale>`, `OfficeDocs-O365SecComp-pr.<locale>` (likely predecessor to security/compliance content, now split across Purview/Priva's own private-only repos — see the `m365copilot-docs` section above) — every one of these is locale-suffixed or `-pr`-suffixed (internal staging) with no plain unsuffixed repo behind it.
  - **Zero matches at all**: Viva, OneDrive, OneNote.
  - Direct guesses for a plain canonical name (`OfficeDocs-SkypeForBusiness`, `OfficeDocs-Exchange`, `OfficeDocs-SharePoint`, `OfficeDocs-Outlook`) all 404.
  - `microsoft-365-docs` itself was double-checked as a fallback (its `microsoft-365/topics/` folder, the one unexplained generic-sounding subfolder) — contains only 2 meta-articles about a "topics" system migration, not Teams/Exchange/SharePoint/Outlook content.
  
  **Conclusion: this tier is closed, not merely deferred.** These products' admin docs likely use a different, non-public-contribution authoring pipeline than the ~20 repos already integrated. Re-check only if Microsoft changes its publishing model for these products.
- **Also confirmed to have no dedicated repo:** Windows client IT-pro/admin docs (11 `windows*` repos found, all developer/driver/API-reference-focused — genuinely no admin-docs repo exists) and Agent 365 (no standalone repo — content lives inside `microsoft-365-docs`' `copilot/` folder and likely `entra-docs`, both already in scope).
- ✅ **SupportArticles-docs (done, added 2026-08-31):** the entire `learn.microsoft.com/troubleshoot/...` URL namespace across many products is **not** part of `azure-docs` or any other already-integrated repo — it's a dedicated repo, `MicrosoftDocs/SupportArticles-docs` (public sync of `SupportArticles-docs-pr`). Its top-level `support` folder is the source for `troubleshoot/...` (folder name `support` → URL segment `troubleshoot`, verified via two live pages' `original_content_git_url`/`source_path`, e.g. `support/azure/private-link/troubleshoot-private-endpoint-connectivity-problems.md` → `troubleshoot/azure/private-link/troubleshoot-private-endpoint-connectivity-problems`). **6,272 entries.** The repo also has separate top-level `Exchange`/`Microsoft365`/`Office`/`Outlook`/`SharePoint`/`SkypeForBusiness`/`Teams`/`Viva` folders — deliberately left out of scope for now (those products' general admin docs were already confirmed closed above; their troubleshooting content specifically hasn't been evaluated — revisit separately if wanted).
- **Discovered gap, not yet fixed (2026-08-31):** Microsoft has been splitting content out of the monolithic `azure-docs` repo into topic-specific repos — confirmed via a live page's `original_content_git_url` that VM Scale Sets content (e.g. `virtual-machine-scale-sets-orchestration-modes`) now lives in `MicrosoftDocs/azure-compute-docs` (public form of `azure-compute-docs-pr`), not `azure-docs` anymore, and Azure portal content (`azure-portal-overview`) lives in `MicrosoftDocs/azure-management-docs`. This means some `azure/*` URLs our cache treats as "covered by azure-docs" are actually stale/missing because the source file moved to one of these split-out repos. Scope and severity (how much of `azure-docs` has migrated, which other topic repos exist) hasn't been investigated — needs its own dedicated pass before adding these repos, not a quick add.
- **Verification technique for a 404'd cached URL:** fetch the live page anyway (or search for its likely current title/topic) and read its own frontmatter `original_content_git_url` — it names the exact real source repo and file path, which is far more reliable than guessing a renamed slug.
- ✅ **`fabric-docs` available again (2026-09-02):** `MicrosoftDocs/fabric-docs` is accessible and remains configured in `REPOS` with `sourceFolder: "docs"` and the verified live `baseUrlPath: "fabric"`. The next catalog sync ingests its documentation under `https://learn.microsoft.com/fabric/...`.
- **`index.md` URL bug, fixed 2026-09-01:** `buildUrl()` only stripped the `.md` extension, leaving a literal `/index` path segment for any directory-landing-page file named `index.md` (e.g. `content/repositories/.../index.md` → wrongly became `.../index` instead of `.../`). Caught by the automated link check below — 8 of 9 broken URLs in the very first checked run were this exact pattern, all in `github-docs` (the only integrated repo that uses this filename convention; docfx-based repos don't). Fixed by stripping a trailing `(^|/)index$` segment in `buildUrl()` after the `.md` strip.
- **Defender for IoT namespace migration (fixed 2026-09-02):** content from the `defender-for-iot` source folder publishes under `defender-for-iot/`, while `defender-for-iot-azure` remains under `azure/defender-for-iot/`. Keep the targets separate; mapping both folders to the Azure prefix emits stale URLs.
- **Final total: 74,806 entries.** Easy/Medium/Dynamics 365/AI Business/SupportArticles-docs tiers are done; Office-suite family and Windows client/Agent 365 confirmed closed; the `azure-compute-docs`/`azure-management-docs` split is a known, deliberately-deferred gap (see above).

### Failsafe
Script aborts (`process.exit(1)`, nothing written) if total entries across all repos fall below `MIN_ENTRIES` (20,000) — signals systemic breakage (e.g., the git clone technique stops working), as opposed to one repo having a transient issue.

### Automated link checking (added 2026-08-31; quarantine model added 2026-09-01)
The sync script verifies URLs after building the catalog, not just their pattern-correctness — this is how the `SupportArticles-docs` gap above and several stale renamed pages were originally caught, so it's built into every run rather than a one-off manual pass:
- **Every new/changed URL** (present in this run's output but not in the previous `docs-catalog.json`) is checked in full — this is the highest-value signal since it catches a wrong `baseUrlPath`/target mapping (like the Dynamics 365 bug) immediately, on the exact run that introduced it.
- **A random sample of unchanged existing URLs** (`LINK_CHECK_SAMPLE_SIZE`, currently 1,500 per run) is also checked, to catch upstream drift (Microsoft renaming/moving/retiring a page) even when our own script didn't change. At this sample size the full ~75k-entry catalog cycles roughly once a year across weekly runs — not immediate, but sustainable within `learn.microsoft.com`'s rate limits (see below).
- **Checking all ~75k entries every run isn't feasible**: `learn.microsoft.com` returns HTTP 429 aggressively above ~3 concurrent requests (confirmed by trial — concurrency 12 made almost every request fail with 429; concurrency 3 with a 500ms per-worker delay and exponential backoff on 429 works reliably). A full pass at that safe rate would take 20+ hours.
- **Confirmed-broken URLs are quarantined, not reported as a failure**: any URL that fails the check is pulled out of `docs-catalog.json` and appended to `data/docs-catalog-invalid.json` (same shape as a normal entry, plus `status`, `firstDetected`, `lastChecked`). This keeps dead pages out of normal research queries against the main catalog. A quarantined URL stays excluded from the catalog and is skipped in future checks (no wasted re-check budget on a known-bad URL) until its record is manually removed from `docs-catalog-invalid.json` — the intended workflow is to let the list accumulate, then periodically ask an agent to work through it: find each page's replacement or root cause, fix it at the source, and delete the resolved record(s).
- Only a genuine repo clone/parse failure (`failedRepos`) fails the run/opens a CI issue now — a growing quarantine list is an expected, self-managed steady state, not a build failure.
- This is separate from mscerts/hub's own `lychee`-based link checker, which validates internal links in that site's *built output*; this repo's link checking validates external Microsoft Learn URLs in *this cache*, which the site doesn't consume directly.

### Investigate-and-fix issue for newly quarantined URLs (added 2026-09-04)
Every quarantined URL still needs a human/agent to eventually figure out *why* it broke and, if possible, fix the underlying `REPOS` mapping — the quarantine model above only stops it from polluting the main catalog. Instead of relying on someone periodically remembering to check `docs-catalog-invalid.json` for a manual/agent triage pass, the sync script and workflow now automatically open a GitHub issue whenever a run quarantines a URL that wasn't already in the backlog:
- **Trigger scope is "new this run" only, not "any backlog exists"**: `newlyQuarantined` in `scripts/docs-catalog-sync.mjs` tracks only the URLs that failed *this run's* link check (i.e. `broken`, not the full `invalidMap`). This deliberately avoids re-opening/re-notifying about the same pre-existing backlog on every single weekly run — an issue is only created when something *changes* (a URL that was passing last run now fails).
- **Report generation:** when `newlyQuarantined.length > 0`, the script calls `buildQuarantineReport()` and writes the result to `QUARANTINE_REPORT_FILE` (env var, defaults to `<os tmpdir>/docs-catalog-quarantine-report.md` — the workflow pins it to `/tmp/docs-catalog-quarantine-report.md` explicitly so the later step can read a known path). It also appends `new_quarantine_count=<N>` to `$GITHUB_OUTPUT` when running in CI (no-op locally, since that env var is only set by the Actions runner).
- **Report content:** a Markdown table of the newly broken URL(s) (status, url, title, product) plus a **"Prompt for an AI coding agent"** section that walks through the same diagnostic playbook as the "Verification technique for a 404'd cached URL" note above (fetch the live page/search for it, read `original_content_git_url` in its frontmatter), classifies the fix into one of three buckets (moved within a tracked repo → fix the `baseUrlPath`/target mapping; moved to an untracked repo → add a new `REPOS` entry, same "Adding a repo" verification discipline as always; genuinely retired → no script change, leave it quarantined), and explicitly tells the agent **not to guess** — ask for clarification instead of committing a speculative fix — if the right classification isn't clear.
- **Workflow wiring:** `.github/workflows/docs-catalog-monitor.yml`'s sync step has `id: sync`; a new `Create issue for newly quarantined URLs` step runs `if: ${{ !cancelled() && steps.sync.outputs.new_quarantine_count != '' }}` and opens the issue via `peter-evans/create-issue-from-file@v6` with `labels: data`, same label as the human-facing "Data Quality / Coverage Issue" template, since both cover the same `docs-catalog-invalid.json` quarantine surface. The condition checks for an *empty* string, not `'0'`, because the script only ever appends to `$GITHUB_OUTPUT` when there's something new to report — when nothing new is quarantined, the output key doesn't exist at all, so `steps.sync.outputs.new_quarantine_count` resolves to `''`, not `'0'`.
- **Verified manually** (2026-09-04): ran `buildQuarantineReport()` standalone against synthetic records (including a title with quotes and a URL/status with a literal `|`, to confirm table-cell escaping holds) and confirmed the rendered Markdown table and prompt section are well-formed.

### Running locally
```bash
node scripts/docs-catalog-sync.mjs
```

