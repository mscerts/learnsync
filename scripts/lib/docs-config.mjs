/**
 * Environment configuration of the docs sync. Pure: takes the env object.
 *
 *   DRY_RUN=1                 discovery + plan only, writes nothing
 *   FULL_DISCOVERY=1          download every en-us sitemap family
 *   SKIP_GIT_SOURCES=1        do not clone github/docs; carry its entries forward
 *   MAX_PAGE_FETCHES          new + changed pages fetched per run        (6000)
 *   MAX_MISSING_CHECKS        fell-out-of-the-sitemaps URLs probed       (2000)
 *   VERIFY_PER_RUN            oldest-checked records re-probed per run   (2000)
 *   MAX_QUARANTINE_RECHECKS   quarantined URLs re-checked per run        (1000)
 *   MAX_RUNTIME_MINUTES       wall-clock budget of the fetch phases      (90, 0 = unlimited)
 *   CONSECUTIVE_TRANSIENT_LIMIT  transient failures in a row that stop a phase (40, 0 = off)
 *   QUARANTINE_REPORT_FILE    where the quarantine issue body is written
 *
 * A value that is set but not a non-negative integer is an error, not a silent
 * fall back to the default: a typo in a workflow must not quietly change a budget.
 */

export const FETCH_CONCURRENCY = 3; // learn.microsoft.com answers 429 above this
export const PER_WORKER_DELAY_MS = 500;
export const SITEMAP_DELAY_MS = 200;
export const SITEMAP_RECHECK_DAYS = 28;
export const SITEMAP_MAX_RECHECKS_PER_RUN = 25;
export const QUARANTINE_SURGE_THRESHOLD = 20;

export const DEFAULT_LIMITS = {
  maxPageFetches: 6000,
  maxMissingChecks: 2000,
  verifyPerRun: 2000,
  maxQuarantineRechecks: 1000,
  maxRuntimeMinutes: 90,
  consecutiveTransientLimit: 40,
};

function intFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return fallback;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  const n = Number(text);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is too large: ${JSON.stringify(raw)}`);
  return n;
}

export function readConfig(env = process.env) {
  return {
    dryRun: env.DRY_RUN === "1",
    fullDiscovery: env.FULL_DISCOVERY === "1",
    skipGitSources: env.SKIP_GIT_SOURCES === "1",
    caps: {
      maxPageFetches: intFrom(env, "MAX_PAGE_FETCHES", DEFAULT_LIMITS.maxPageFetches),
      maxMissingChecks: intFrom(env, "MAX_MISSING_CHECKS", DEFAULT_LIMITS.maxMissingChecks),
      verifyPerRun: intFrom(env, "VERIFY_PER_RUN", DEFAULT_LIMITS.verifyPerRun),
      maxQuarantineRechecks: intFrom(env, "MAX_QUARANTINE_RECHECKS", DEFAULT_LIMITS.maxQuarantineRechecks),
    },
    maxRuntimeMinutes: intFrom(env, "MAX_RUNTIME_MINUTES", DEFAULT_LIMITS.maxRuntimeMinutes),
    consecutiveTransientLimit: intFrom(env, "CONSECUTIVE_TRANSIENT_LIMIT", DEFAULT_LIMITS.consecutiveTransientLimit),
    concurrency: FETCH_CONCURRENCY,
    delayMs: PER_WORKER_DELAY_MS,
    reportFile: env.QUARANTINE_REPORT_FILE || null,
    githubOutput: env.GITHUB_OUTPUT || null,
  };
}
