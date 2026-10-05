/**
 * Scope classification for the docs sync. Pure: no I/O, no network.
 *
 * Works on canonical paths (see canonical.mjs: lowercase, leading slash, no
 * locale/query/trailing slash), so matching is case-insensitive by construction.
 * The two scopes are evaluated independently ("exclude" only wins inside the
 * scope that declares it), so a prefix excluded from LEARN_SCOPE can still be
 * listed in INDEX_ONLY_SCOPE to get an index entry without metadata.
 *
 *   "learn"  -> index entry + metadata record (LEARN_SCOPE)
 *   "index"  -> index entry only (INDEX_ONLY_SCOPE)
 *   null     -> not covered by the docs caches
 */

import { createHash } from "node:crypto";
import { underPrefix } from "./canonical.mjs";
import { LEARN_SCOPE, INDEX_ONLY_SCOPE } from "./scope.mjs";

export const DEFAULT_SCOPES = { learn: LEARN_SCOPE, index: INDEX_ONLY_SCOPE };

function matches(path, scope) {
  return scope.include.some((p) => underPrefix(path, p.toLowerCase())) && !(scope.exclude || []).some((p) => underPrefix(path, p.toLowerCase()));
}

/** "learn" | "index" | null for a canonical path. */
export function scopeClass(path, scopes = DEFAULT_SCOPES) {
  if (typeof path !== "string" || !path.startsWith("/")) return null;
  if (matches(path, scopes.learn)) return "learn";
  if (matches(path, scopes.index)) return "index";
  return null;
}

/** True when the path gets an index entry (either scope). */
export function inIndexScope(path, scopes = DEFAULT_SCOPES) {
  return scopeClass(path, scopes) !== null;
}

/**
 * The include prefix a path falls under, longest match across both scopes, for
 * per-prefix statistics. Returns { prefix, cls } or null.
 */
export function includePrefixOf(path, scopes = DEFAULT_SCOPES) {
  let best = null;
  for (const [cls, scope] of [["learn", scopes.learn], ["index", scopes.index]]) {
    if (!matches(path, scope)) continue;
    for (const p of scope.include) {
      if (underPrefix(path, p.toLowerCase()) && (!best || p.length > best.prefix.length)) best = { prefix: p, cls };
    }
  }
  return best;
}

/**
 * Short stable hash of both scopes. Stored on every sitemap-family memo entry so
 * a scope change (a prefix added to either scope) invalidates stale
 * "relevant: false" answers instead of silently never looking at that family.
 */
export function scopeSignature(scopes = DEFAULT_SCOPES) {
  const norm = (s) => ({
    include: [...s.include].map((x) => x.toLowerCase()).sort(),
    exclude: [...(s.exclude || [])].map((x) => x.toLowerCase()).sort(),
  });
  const payload = JSON.stringify({ learn: norm(scopes.learn), index: norm(scopes.index) });
  return createHash("sha1").update(payload).digest("hex").slice(0, 10);
}
