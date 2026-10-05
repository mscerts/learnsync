/**
 * Which learn.microsoft.com paths the docs caches cover. Shared by the docs
 * sync (what to index/fetch) and the validator (which URLs it can answer).
 * See DATA_CONTRACT.md. Pure data: no I/O.
 *
 * LEARN_SCOPE      pages get an index entry (data/docs-urls.txt) AND a metadata
 *                  record (data/docs-catalog.json: title, description, ...).
 * INDEX_ONLY_SCOPE pages get an index entry only (no per-page fetch), so a
 *                  consumer can tell whether a URL still exists without paying
 *                  for metadata of thousands of reference pages. Add a prefix
 *                  here when a consumer (for example the hub) links to a Learn
 *                  product area that is not in LEARN_SCOPE; the validator
 *                  reports every other prefix as `unverifiable`.
 *
 * Prefixes have no leading or trailing slash ("azure" matches /azure and
 * /azure/x, never /azure-x). `exclude` wins over `include`.
 */

export const LEARN_SCOPE = {
  include: [
    "azure",
    "entra",
    "fabric",
    "sql",
    "power-platform",
    "intune",
    "autopilot",
    "windows-server",
    "defender-endpoint",
    "defender-cloud-apps",
    "defender-xdr",
    "defender-business",
    "defender-office-365",
    "defender-vulnerability-management",
    "defender-for-identity",
    "defender-for-iot",
    "defender", // defender/threat-intelligence (pathMappings in the old config)
    "security-exposure-management",
    "unified-secops-platform",
    "unified-secops",
    "microsoft-365",
    "dynamics365",
    "troubleshoot",
  ],
  exclude: [
    // Auto-generated ARM/Bicep resource schema reference -- very large, not
    // article content, and never part of the old catalog.
    "azure/templates",
  ],
};

export const INDEX_ONLY_SCOPE = {
  include: [
    "cli", // Azure CLI reference, linked from the AZ-104 course
    "partner-center", // Partner Center docs (partner designation pages)
    "microsoft-copilot-studio",
    "microsoft-sales-copilot",
    "copilot",
    "agent-framework",
    "services-hub",
    // Product areas behind the certification exams the hub covers. They are
    // large reference areas, so they get an index entry only.
    "power-bi", // PL-300
    "power-apps", // PL-*, AB-410
    "power-automate", // PL-*
    "purview", // SC-401, SC-900
    "microsoftteams", // MS-700
    "viva", // MS-721 and Viva-related content
    "security", // SC-* (Microsoft Security docs)
    "exchange", // MS-102, MD-102
    "sharepoint", // MS-102
  ],
  exclude: [],
};
