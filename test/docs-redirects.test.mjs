import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRedirect, classifyProbe, normalizeLedger, updateLedger } from "../scripts/lib/docs-redirects.mjs";

test("classifyRedirect: moved, landing and retired", () => {
  // same content elsewhere
  assert.equal(classifyRedirect("/azure/active-directory/whatis", "/entra/fundamentals/what-is-entra"), "moved");
  assert.equal(classifyRedirect("/azure/a", "/azure/b"), "moved");
  // strict ancestor of the source = landing
  assert.equal(classifyRedirect("/azure/old/deep/page", "/azure/old"), "landing");
  assert.equal(classifyRedirect("/azure/old/page", "/azure"), "landing");
  // generic hubs and one-segment product roots = landing
  assert.equal(classifyRedirect("/azure/x", "/"), "landing");
  assert.equal(classifyRedirect("/azure/x", "/training/browse"), "landing");
  assert.equal(classifyRedirect("/azure/synapse-analytics/x", "/fabric"), "landing");
  // archives = retired, even when the archive path is also deeper than the source
  assert.equal(classifyRedirect("/azure/old", "/previous-versions/azure/old"), "retired");
  assert.equal(classifyRedirect("/azure/old", "/previous-versions"), "retired");
  assert.equal(classifyRedirect("/azure/old", "/archive/x"), "retired");
  // off-site destination: moved with no `to`
  assert.equal(classifyRedirect("/azure/old", null), "moved");
  // a prefix match must respect segment boundaries: /azure/ab is not an ancestor of /azure/abc/x
  assert.equal(classifyRedirect("/azure/abc/x", "/azure/ab"), "moved");
});

test("classifyProbe: live, gone, moved, transient", () => {
  const live = classifyProbe({ status: 200, firstStatus: 200, finalUrl: "https://learn.microsoft.com/en-us/azure/Foo" }, "/azure/foo");
  assert.deepEqual(live, { outcome: "live", status: 200 });
  // the locale/case/query/trailing-slash redirects Learn does on every request are not moves
  assert.equal(classifyProbe({ status: 200, firstStatus: 301, finalUrl: "https://learn.microsoft.com/en-us/cli/azure/vm?view=azure-cli-latest" }, "/cli/azure/vm").outcome, "live");

  assert.deepEqual(classifyProbe({ status: 404, firstStatus: 404, finalUrl: "x" }, "/azure/foo"), { outcome: "gone", status: 404 });
  assert.equal(classifyProbe({ status: 410, finalUrl: "x" }, "/azure/foo").outcome, "gone");
  // a redirect that ends in a 404 is gone too (the page the user would land on does not exist)
  assert.equal(classifyProbe({ status: 404, firstStatus: 301, finalUrl: "https://learn.microsoft.com/en-us/troubleshoot/x" }, "/dynamics365/x").outcome, "gone");

  const moved = classifyProbe({ status: 200, firstStatus: 301, finalUrl: "https://learn.microsoft.com/en-us/entra/what-is" }, "/azure/active-directory/what-is");
  assert.deepEqual(moved, { outcome: "moved", status: 301, to: "/entra/what-is", kind: "moved" });
  const landing = classifyProbe({ status: 200, firstStatus: 302, finalUrl: "https://learn.microsoft.com/en-us/azure/" }, "/azure/old/page");
  assert.equal(landing.kind, "landing");
  assert.equal(landing.status, 302);
  const retired = classifyProbe({ status: 200, firstStatus: 301, finalUrl: "https://learn.microsoft.com/en-us/previous-versions/azure/old" }, "/azure/old");
  assert.equal(retired.kind, "retired");

  const offsite = classifyProbe({ status: 301, firstStatus: 301, offsite: true, finalUrl: "https://example.com/x" }, "/azure/old");
  assert.deepEqual(offsite, { outcome: "moved", status: 301, to: null, kind: "moved" });

  for (const bad of [
    null,
    { status: null, error: "timeout" },
    { status: 429, finalUrl: "x" },
    { status: 503, finalUrl: "x" },
    { status: 403, finalUrl: "x" },
    { status: 200, tooManyHops: true, finalUrl: "x" },
    { status: 200, finalUrl: "not a url" },
  ]) {
    assert.equal(classifyProbe(bad, "/azure/foo").outcome, "transient", JSON.stringify(bad));
  }
});

test("normalizeLedger keeps well-formed rows, canonicalizes and sorts by code point", () => {
  const out = normalizeLedger([
    { from: "/Azure/B/", to: "/azure/c", kind: "moved", status: 301, firstSeen: "2026-09-01", lastSeen: "2026-09-02" },
    { from: "/azure/a", to: null, kind: "bogus", status: "x", firstSeen: "2026-09-01" },
    { from: "/azure/b", to: "/azure/d", kind: "moved", status: 302, firstSeen: "2026-09-01", lastSeen: "2026-10-01" }, // same page, newer wins
    { from: "relative/path", to: "/azure/x" },
    { to: "/azure/x" },
    { from: "/", to: "/azure" },
    null,
  ]);
  assert.deepEqual(out.map((e) => e.from), ["/azure/a", "/azure/b"]);
  assert.equal(out[0].kind, "moved"); // unknown kind re-derived
  assert.equal(out[0].status, null);
  assert.equal(out[0].lastSeen, "2026-09-01");
  assert.equal(out[1].to, "/azure/d");
  assert.deepEqual(normalizeLedger("nope"), []);
});

const day = "2026-10-05";
const entry = (from, to, firstSeen = "2026-09-01", lastSeen = "2026-09-20") => ({ from, to, kind: "moved", status: 301, firstSeen, lastSeen });

test("updateLedger records discoveries and keeps firstSeen across runs", () => {
  const out = updateLedger({
    previous: [entry("/azure/old", "/azure/new")],
    discovered: [
      { from: "/azure/old", to: "/azure/newer", status: 308 },
      { from: "/azure/fresh", to: "/azure/deep", status: 302 },
    ],
    newIndex: new Map(),
    previousIndex: new Map([["/azure/other", null]]),
    today: day,
  });
  const byFrom = new Map(out.map((e) => [e.from, e]));
  assert.deepEqual(byFrom.get("/azure/old"), { from: "/azure/old", to: "/azure/newer", kind: "moved", status: 308, firstSeen: "2026-09-01", lastSeen: day });
  assert.deepEqual(byFrom.get("/azure/fresh"), { from: "/azure/fresh", to: "/azure/deep", kind: "moved", status: 302, firstSeen: day, lastSeen: day });
  assert.deepEqual(out.map((e) => e.from), ["/azure/fresh", "/azure/old"]);
});

test("updateLedger classifies every discovery, off-site ones with to null", () => {
  const out = updateLedger({
    previous: [],
    discovered: [
      { from: "/azure/a/deep", to: "/azure/a", status: 301 },
      { from: "/azure/b", to: "/previous-versions/azure/b", status: 301 },
      { from: "/azure/c", to: null, status: 302 },
    ],
    newIndex: new Map(),
    previousIndex: new Map(),
    today: day,
  });
  assert.deepEqual(out.map((e) => [e.from, e.kind, e.to]), [
    ["/azure/a/deep", "landing", "/azure/a"],
    ["/azure/b", "retired", "/previous-versions/azure/b"],
    ["/azure/c", "moved", null],
  ]);
});

test("updateLedger deletes an entry when its `from` reappears in the index", () => {
  const out = updateLedger({
    previous: [entry("/azure/back", "/azure/x"), entry("/azure/gone", "/azure/y"), entry("/azure/stale-row", "/azure/z")],
    discovered: [],
    // /azure/back is new in the index; /azure/stale-row was in the sitemap all along
    newIndex: new Map([["/azure/back", null], ["/azure/stale-row", null], ["/azure/unrelated", null]]),
    previousIndex: new Map([["/azure/stale-row", null], ["/azure/unrelated", null]]),
    today: day,
  });
  assert.deepEqual(out.map((e) => e.from), ["/azure/gone", "/azure/stale-row"]);
});

test("updateLedger: with no previous index nothing counts as reappeared", () => {
  const out = updateLedger({
    previous: [entry("/azure/a", "/azure/x")],
    discovered: [],
    newIndex: new Map([["/azure/a", null]]),
    previousIndex: new Map(),
    today: day,
  });
  assert.deepEqual(out.map((e) => e.from), ["/azure/a"]);
});

test("updateLedger drops entries a probe contradicted and entries outside the scope", () => {
  const out = updateLedger({
    previous: [entry("/azure/live-now", "/azure/x"), entry("/azure/gone-now", "/azure/y"), entry("/other/old", "/other/new"), entry("/azure/kept", "/azure/k")],
    discovered: [],
    contradicted: new Set(["/azure/live-now", "/azure/gone-now"]),
    newIndex: new Map(),
    previousIndex: new Map([["/azure/seed", null]]),
    inScope: (p) => p.startsWith("/azure"),
    today: day,
  });
  assert.deepEqual(out.map((e) => e.from), ["/azure/kept"]);
});

test("updateLedger ignores a discovery whose destination equals its source", () => {
  const out = updateLedger({ previous: [], discovered: [{ from: "/azure/a", to: "/azure/a", status: 301 }], newIndex: new Map(), previousIndex: new Map(), today: day });
  assert.deepEqual(out, []);
});
