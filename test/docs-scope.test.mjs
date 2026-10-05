import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCOPES, includePrefixOf, inIndexScope, scopeClass, scopeSignature } from "../scripts/lib/docs-scope.mjs";
import { INDEX_ONLY_SCOPE, LEARN_SCOPE } from "../scripts/lib/scope.mjs";

test("the real scopes do not overlap and exclusions are declared where they apply", () => {
  const lower = (list) => list.map((p) => p.toLowerCase());
  const overlap = lower(LEARN_SCOPE.include).filter((p) => lower(INDEX_ONLY_SCOPE.include).includes(p));
  assert.deepEqual(overlap, []);
  for (const p of [...LEARN_SCOPE.include, ...INDEX_ONLY_SCOPE.include]) {
    assert.ok(!p.startsWith("/") && !p.endsWith("/"), `${p} must have no leading/trailing slash`);
  }
});

test("scopeClass: learn, index and uncovered, with segment boundaries", () => {
  assert.equal(scopeClass("/azure/key-vault/overview"), "learn");
  assert.equal(scopeClass("/azure"), "learn");
  assert.equal(scopeClass("/dynamics365/finance/x"), "learn");
  assert.equal(scopeClass("/cli/azure/vm"), "index");
  assert.equal(scopeClass("/partner-center/x"), "index");
  assert.equal(scopeClass("/azure-x/y"), null); // never a prefix match inside a segment
  assert.equal(scopeClass("/dotnet/api/x"), null);
  assert.equal(scopeClass("/"), null);
  assert.equal(scopeClass("azure/x"), null); // not a canonical path
  assert.equal(scopeClass(null), null);
});

test("scopeClass is case-insensitive (canonical paths are lowercase, include lists may not be)", () => {
  const scopes = { learn: { include: ["Azure"], exclude: ["Azure/Templates"] }, index: { include: ["CLI"], exclude: [] } };
  assert.equal(scopeClass("/azure/x", scopes), "learn");
  assert.equal(scopeClass("/cli/x", scopes), "index");
  assert.equal(scopeClass("/azure/templates/x", scopes), null);
});

test("excluding azure/templates from LEARN_SCOPE leaves it excluded (not index-only)", () => {
  assert.equal(scopeClass("/azure/templates/microsoft.compute/virtualmachines"), null);
  assert.equal(scopeClass("/azure/templatesx/y"), "learn"); // boundary: not the excluded prefix
});

test("an exclude only wins inside its own scope", () => {
  const scopes = { learn: { include: ["azure"], exclude: ["azure/templates"] }, index: { include: ["azure/templates"], exclude: [] } };
  assert.equal(scopeClass("/azure/templates/x", scopes), "index");
  assert.equal(scopeClass("/azure/other", scopes), "learn");
});

test("inIndexScope is true for both classes", () => {
  assert.equal(inIndexScope("/azure/x"), true);
  assert.equal(inIndexScope("/cli/x"), true);
  assert.equal(inIndexScope("/dotnet/x"), false);
});

test("includePrefixOf returns the longest matching prefix and its class", () => {
  assert.deepEqual(includePrefixOf("/defender-endpoint/x"), { prefix: "defender-endpoint", cls: "learn" });
  assert.deepEqual(includePrefixOf("/defender/threat-intelligence/x"), { prefix: "defender", cls: "learn" });
  assert.deepEqual(includePrefixOf("/cli/azure/vm"), { prefix: "cli", cls: "index" });
  assert.equal(includePrefixOf("/dotnet/x"), null);
  const scopes = { learn: { include: ["azure"], exclude: [] }, index: { include: ["azure/foo"], exclude: [] } };
  assert.deepEqual(includePrefixOf("/azure/foo/bar", scopes), { prefix: "azure/foo", cls: "index" });
});

test("scopeSignature changes when either scope changes, not with ordering or case", () => {
  const a = scopeSignature(DEFAULT_SCOPES);
  assert.match(a, /^[0-9a-f]{10}$/);
  assert.equal(scopeSignature({ learn: { include: ["b", "a"], exclude: [] }, index: { include: ["c"] } }), scopeSignature({ learn: { include: ["A", "b"], exclude: [] }, index: { include: ["C"], exclude: [] } }));
  assert.notEqual(a, scopeSignature({ ...DEFAULT_SCOPES, index: { include: [...INDEX_ONLY_SCOPE.include, "new-area"], exclude: [] } }));
  assert.notEqual(a, scopeSignature({ ...DEFAULT_SCOPES, learn: { include: LEARN_SCOPE.include.slice(1), exclude: LEARN_SCOPE.exclude } }));
});
