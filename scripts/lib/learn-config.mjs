/**
 * Static configuration for the Learn syncs (scripts/learn-catalog-sync.mjs and
 * scripts/learn-content-sync.mjs). Pure data: no I/O, no network.
 *
 * These tables used to live at the top of scripts/learn-catalog-sync.mjs; they
 * moved here so the pure build logic (scripts/lib/learn-build.mjs) and its unit
 * tests can read the real lists. Edit the arrays directly to add/remove a
 * category or a subject hint -- no other code change is needed.
 */

export const CATALOG_BASE = "https://learn.microsoft.com/api/catalog/";
export const HIERARCHY_BASE = "https://learn.microsoft.com/api/hierarchy/modules/";
export const LEARN_ORIGIN = "https://learn.microsoft.com";

// Top-level Microsoft Learn product categories relevant to certifications
// tracked on this site (see AGENTS.md's per-area exam code mapping). Extend
// this list if a new exam area maps to a Learn product not covered here.
export const ALLOWED_CATEGORIES = [
  "azure",
  "dynamics-365",
  "github",
  "m365",
  "power-platform",
  "fabric",
  "entra",
  "microsoft-sentinel",
  "microsoft-defender",
  "microsoft-purview",
  "priva",
  "security-copilot",
  "ms-copilot",
  "intune",
  "mem",
  "viva",
  "office-365",
  "office-teams",
  "microsoft-teams-phone",
  "agent-365",
  "agent-framework",
  "sql-server",
  "windows",
  "office-sp",
  "office-exchange",
  "industry-solutions",
  "ms-graph",
  "dotnet",
  "office-adaptive-cards",
  "aspnet",
  "aspnet-core",
  "bing",
  "office-excel",
  "m365-ems-advanced-threat-analytics",
  "microsoft-authentication-library",
  "microsoft-edge",
  "office-forms",
  "microsoft-search",
  "microsoft-whiteboard",
  "office",
  "office-onedrive",
  "office-onenote",
  "office-outlook",
  "office-powerpoint",
  "sysinternals",
  "vs",
  "vs-app-center",
  "vs-code",
  "windows-server",
  "office-word",
];

// Microsoft's own `subjects` tagging is sparse and inconsistent (e.g. "Introduction
// to Azure Firewall" has no "Networking" tag even though Firewall is a networking
// product, while a near-duplicate Firewall module does have it). This table adds
// well-known, high-confidence subject ids for specific products when Microsoft's
// tagging misses them. It supplements official subjects, never removes them, and
// only covers products with one obvious, unambiguous subject — it is not a full
// per-module content classification. Values are subject ids (resolved to display
// names the same way official subject tags are).
export const PRODUCT_SUBJECT_HINTS = {
  // Networking
  "azure-application-gateway": ["networking"],
  "azure-bastion": ["networking"],
  "azure-cdn": ["networking"],
  "azure-ddos-protection": ["networking"],
  "azure-dns": ["networking"],
  "azure-expressroute": ["networking"],
  "azure-firewall": ["networking"],
  "azure-firewall-manager": ["networking"],
  "azure-front-door": ["networking"],
  "azure-load-balancer": ["networking"],
  "azure-network-watcher": ["networking"],
  "azure-traffic-manager": ["networking"],
  "azure-virtual-network": ["networking"],
  "azure-virtual-wan": ["networking"],
  "azure-vpn-gateway": ["networking"],
  "azure-web-application-firewall": ["networking"],

  // Databases / data engineering
  "azure-cosmos-db": ["databases"],
  "azure-sql-database": ["databases"],
  "azure-sql-managed-instance": ["databases"],
  "azure-database-mysql": ["databases"],
  "azure-database-postgresql": ["databases"],
  "azure-cache-redis": ["cache"],
  "azure-managed-redis": ["cache"],
  "azure-synapse-analytics": ["data-engineering"],
  "azure-data-factory": ["data-engineering"],
  "azure-databricks": ["data-engineering"],
  "azure-data-lake": ["data-engineering"],
  "azure-data-lake-storage": ["data-engineering"],
  "azure-data-explorer": ["data-engineering"],

  // AI
  "azure-machine-learning": ["machine-learning"],
  "azure-machine-learning-designer": ["machine-learning"],
  "azure-machine-learning-studio": ["machine-learning"],
  "azure-openai": ["generative-ai"],
  "azure-custom-vision": ["machine-learning"],
  "azure-bot-service": ["chatbots"],
  "azure-speech": ["natural-language-processing"],
  "azure-translator-speech": ["natural-language-processing"],
  "azure-translator-text": ["natural-language-processing"],

  // Identity & security
  "entra": ["identity-access"],
  "entra-id": ["identity-access"],
  "entra-id-protection": ["identity-access"],
  "entra-identity-governance": ["identity-access"],
  "entra-permissions-management": ["identity-access"],
  "entra-verified-id": ["identity-access"],
  "entra-workload-identities": ["identity-access"],
  "entra-external-id": ["identity-access"],
  "active-directory": ["identity-access"],
  "azure-key-vault": ["key-management"],
  "microsoft-sentinel": ["threat-protection"],
  "microsoft-defender": ["threat-protection"],
  "m365-defender": ["threat-protection"],
  "defender-endpoint": ["threat-protection"],
  "defender-for-cloud": ["threat-protection"],
  "defender-for-cloud-apps": ["threat-protection"],
  "defender-for-iot": ["threat-protection"],
  "defender-for-threat-intelligence": ["threat-protection"],
  "defender-identity": ["threat-protection"],
  "defender-office365": ["threat-protection"],
  "defender-xdr": ["threat-protection"],
  "azure-information-protection": ["information-protection-governance"],
  "microsoft-purview": ["information-protection-governance", "compliance"],
  "priva": ["compliance"],

  // Device management
  "intune": ["device-management"],

  // Power Platform / data platform (only products with one clear, undiluted
  // subject on manual review — e.g. Power Apps/Dataverse were dropped because
  // they're used as a broad co-tag on many Copilot Studio/AI Builder modules
  // that aren't really about app development or databases)
  "power-bi": ["data-visualization"],
  "power-automate": ["automation"],
  "fabric": ["data-engineering"],

  // Containers & DevOps
  "azure-kubernetes-service": ["containers"],
  "azure-container-instances": ["containers"],
  "azure-container-apps": ["containers"],
  "azure-container-registry": ["containers"],
  "azure-devops": ["devops"],
  "azure-pipelines": ["devops"],
  "azure-boards": ["devops"],
  "azure-repos": ["devops"],
  "azure-artifacts": ["devops"],
  "azure-test-plans": ["devops"],

  // IT management / monitoring
  "azure-backup": ["it-management-monitoring"],
  "azure-site-recovery": ["it-management-monitoring"],
  "azure-monitor": ["it-management-monitoring"],
  "azure-log-analytics": ["it-management-monitoring"],

  // Automation / serverless
  "azure-automation": ["automation"],
  "azure-logic-apps": ["automation"],
  "azure-functions": ["serverless-computing"],

  // App development frameworks (bare "dotnet"/"vs"/"vs-code" were deliberately
  // left unmapped — sampling showed those generic tags span web/desktop/mobile/
  // cloud content with no single fitting subject)
  "aspnet": ["backend-development"],
  "aspnet-core": ["backend-development"],
  "blazor": ["frontend-development"],
  "dotnet-maui": ["mobile-development"],
  "ms-graph": ["backend-development"],

  // Education (Microsoft Learn has no official "Education" subject — see
  // CUSTOM_SUBJECTS below. Sampling confirmed m365-education is a clean,
  // undiluted signal: every module carrying it is genuinely K-12/higher-ed content)
  "m365-education": ["education"],
};

// Subject ids invented for this cache because no official Microsoft Learn
// subject fits (checked the full `?type=subjects` taxonomy — there is no
// education-related entry). Resolved the same way as official subject ids;
// distinguishable only by not appearing in the live `?type=subjects` response.
export const CUSTOM_SUBJECTS = {
  education: "Education",
};

// Top-level product ids that are deliberately NOT in ALLOWED_CATEGORIES because
// no tracked content depends on them. Derived from the live taxonomy on
// 2026-10-05 (61 top-level products): the ten documented exclusions below, each
// with its module count at that time. Together with ALLOWED_CATEGORIES this
// makes the taxonomy classification exhaustive, so a NEW top-level product that
// starts carrying modules is reported as drift (see unusedCategoryIds in
// scripts/lib/learn-build.mjs) instead of being silently left out of scope.
//
// `microsoft-agents` is in the live taxonomy but had zero modules on that date,
// so it is intentionally in neither list: the first module tagged with it will
// raise the drift warning (it is probably relevant to the AI exams).
export const EXCLUDED_CATEGORIES = [
  "consumer", // 13 modules
  "hololens", // 18
  "makecode", // 4
  "minecraft", // 14
  "mrtk", // 10  (Mixed Reality Toolkit)
  "ms-website", // 10  (AppSource / Azure Marketplace / Education Center partner publishing)
  "playwright", // 1   (open-source Playwright test framework, no Microsoft cert)
  "qdk", // 1   (Quantum Development Kit)
  "surface", // 36
  "xbox", // 5
];

// Allowlisted ids that carry ZERO modules upstream today (checked 2026-10-05):
// the allowlist keeps them so modules are picked up the moment they reappear,
// but the "allowlisted category has no modules" failsafe cannot treat them as a
// truncation signal. The failsafe still aborts if any of these had modules in
// the previous data file and has none now, and it warns when one of them gets
// modules again (remove it from this list then).
export const KNOWN_EMPTY_CATEGORIES = [
  "agent-framework",
  "microsoft-search",
  "microsoft-whiteboard",
  "vs-app-center",
];

// Failsafe thresholds and refresh policy. Every threshold that can be tuned for
// a one-off run (for example after Microsoft retires a large batch of content)
// has an environment override, read through numberFromEnv() in learn-helpers.mjs.
export const LIMITS = {
  // Last-resort floor on the in-scope module count (was 2800; the live in-scope
  // size is 3355, so 3000 is ~89% of it). The relative checks below are the
  // primary defence; this only catches a first run or a corrupt previous file.
  MIN_MODULES: 3000,
  // Abort if the in-scope count drops by more than this many percent vs the
  // previous file (env MAX_MODULE_DROP_PCT).
  MAX_MODULE_DROP_PCT: 5,
  // Abort if the RAW API module count (all categories) drops by more than this
  // many percent vs the previous run (env MAX_API_DROP_PCT).
  MAX_API_DROP_PCT: 3,
  // Abort if more than this percentage of unit-title references cannot be
  // resolved from the catalog `units` array (a truncated `units` response makes
  // every title fall back to a uid). Live baseline: 119 of ~27,500 (0.4%).
  MAX_UNIT_FALLBACK_PCT: 5,
  // Abort if more than this percentage of hierarchy requests failed, but only
  // when at least HIERARCHY_MIN_SAMPLE modules were requested: on a tiny
  // incremental run one failure would otherwise be 20-100% and block the whole
  // weekly update, while failed modules already keep their previous unitUrls
  // (same signature) or get null, never a guess.
  MAX_HIERARCHY_FAILURE_PCT: 10,
  HIERARCHY_MIN_SAMPLE: 20,
  // Circuit breaker: after this many completed hierarchy requests, stop the run
  // as soon as the failure share exceeds HIERARCHY_EARLY_FAILURE_PCT (each failed
  // request has already spent its whole retry/backoff budget). The early limit is
  // deliberately far above MAX_HIERARCHY_FAILURE_PCT: modules are requested in uid
  // order, so a handful of deterministic failures can cluster in the first
  // requests and must not abort a run whose overall failure share is small; the
  // breaker is only for a hierarchy API that is down or blocking us.
  HIERARCHY_EARLY_SAMPLE: 50,
  HIERARCHY_EARLY_FAILURE_PCT: 50,
  // unitUrls of every module are re-fetched at least this often even when no
  // signature changed (renamed unit files do not necessarily bump last_modified).
  FULL_REFRESH_DAYS: 30,
  // Content sync: abort the write if any list shrinks by more than this many
  // percent vs the previous file (env MAX_CONTENT_DROP_PCT).
  MAX_CONTENT_DROP_PCT: 20,
  // Content sync: abort if more than this percentage of learning-path module
  // references cannot be resolved to a module path (truncated module list).
  MAX_UNRESOLVED_MODULE_PCT: 5,
  // Content sync: abort if more than this percentage of study guide / applied
  // skill page probes ended transient (429/5xx/timeout), for samples of at least
  // PROBE_MIN_SAMPLE probes. A transient probe keeps the previous value; a run
  // where most probes failed proves nothing.
  MAX_PROBE_FAILURE_PCT: 10,
  PROBE_MIN_SAMPLE: 20,
  // Content sync: abort if fewer than this percentage of the applied skills that
  // had a study guide code last time still expose one (page layout change).
  MIN_SKILL_CODE_SHARE_PCT: 50,
};

// Last-resort floors for the content lists (roughly half the live sizes on
// 2026-10-05: 821 / 139 / 152 / 145 / 37), and for the module list the content
// sync uses to resolve learning-path module uids.
export const CONTENT_MIN_COUNTS = {
  learningPaths: 400,
  courses: 70,
  certifications: 75,
  exams: 70,
  appliedSkills: 15,
};
export const MIN_API_MODULES_FOR_RESOLUTION = 3000;
