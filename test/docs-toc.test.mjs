import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DOCS_TOC_LIMITS,
  breakerTripped,
  buildFile,
  buildLookup,
  buildTocRecord,
  countPages,
  directoriesOf,
  evaluateFailsafes,
  parseToc,
  planProbes,
  readPrevious,
  resolveTocHref,
  signatureOf,
  stableContent,
  summarizeTocs,
} from "../scripts/lib/docs-toc.mjs";

// A trimmed copy of the real /entra/fundamentals/toc.json (2026-10-24): a landing page, a group of pages,
// a group with its own landing page and nested groups, a relative link into another folder, an external link.
const ENTRA_TOC = {
  items: [
    { href: "./", toc_title: "Fundamentals documentation" },
    {
      children: [
        { href: "what-is-entra", toc_title: "What is Microsoft Entra?" },
        { href: "entra-admin-center", toc_title: "Microsoft Entra admin center" },
      ],
      expanded: true,
      toc_title: "Overview",
    },
    {
      children: [
        { href: "create-new-tenant", toc_title: "Create a tenant" },
        {
          children: [
            { href: "concept-learn-about-groups", toc_title: "Learn about groups" },
            { href: "how-to-manage-groups", toc_title: "Manage groups" },
            { href: "../identity/users/groups-self-service-management.md", toc_title: "Self-service" },
          ],
          toc_title: "Groups",
        },
        { href: "https://entra.microsoft.com", toc_title: "Admin center (external)" },
      ],
      toc_title: "Add users and groups",
    },
  ],
};

test("a toc href is resolved against the folder of the toc: relative, folder-relative, absolute path, URL; external and anchors are not pages", () => {
  const f = "/entra/fundamentals";
  assert.equal(resolveTocHref("what-is-entra", f), "/entra/fundamentals/what-is-entra");
  assert.equal(resolveTocHref("./", f), "/entra/fundamentals");
  assert.equal(resolveTocHref("../identity/users/", f), "/entra/identity/users");
  assert.equal(resolveTocHref("../identity/users/x.md", f), "/entra/identity/users/x");
  assert.equal(resolveTocHref("sub/index", f), "/entra/fundamentals/sub");
  assert.equal(resolveTocHref("/azure/Storage/Overview", f), "/azure/storage/overview");
  assert.equal(resolveTocHref("https://learn.microsoft.com/en-us/azure/x?view=1#top", f), "/azure/x");
  assert.equal(resolveTocHref("https://entra.microsoft.com", f), null);
  assert.equal(resolveTocHref("mailto:a@b.c", f), null);
  assert.equal(resolveTocHref("#top", f), null);
  assert.equal(resolveTocHref("", f), null);
  assert.equal(resolveTocHref(undefined, f), null);
});

test("a toc tree becomes groups in sidebar order, each with its breadcrumb and the pages directly in it", () => {
  const groups = parseToc(ENTRA_TOC, "/entra/fundamentals");
  assert.deepEqual(groups, [
    { title: [], landing: null, pages: ["/entra/fundamentals"] },
    { title: ["Overview"], landing: null, pages: ["/entra/fundamentals/what-is-entra", "/entra/fundamentals/entra-admin-center"] },
    { title: ["Add users and groups"], landing: null, pages: ["/entra/fundamentals/create-new-tenant"] },
    {
      title: ["Add users and groups", "Groups"],
      landing: null,
      pages: ["/entra/fundamentals/concept-learn-about-groups", "/entra/fundamentals/how-to-manage-groups", "/entra/identity/users/groups-self-service-management"],
    },
  ]);
  assert.equal(countPages(groups), 7);
});

test("a group can have a page of its own, and a group without pages is left out", () => {
  const groups = parseToc(
    {
      items: [
        { toc_title: "Empty", children: [{ toc_title: "External", href: "https://example.com" }] },
        { toc_title: "Users", href: "users/", children: [{ toc_title: "Create", href: "users/create" }] },
      ],
    },
    "/entra/x",
  );
  assert.deepEqual(groups, [{ title: ["Users"], landing: "/entra/x/users", pages: ["/entra/x/users/create"] }]);
});

test("something that is not a toc tree is null, not an empty list", () => {
  assert.equal(parseToc(null, "/x"), null);
  assert.equal(parseToc({}, "/x"), null);
  assert.equal(parseToc({ items: "no" }, "/x"), null);
  assert.deepEqual(parseToc({ items: [] }, "/x"), []);
});

test("a record carries a signature that changes with the groups, and the number of pages", () => {
  const groups = parseToc(ENTRA_TOC, "/entra/fundamentals");
  const record = buildTocRecord({ path: "/entra/fundamentals", groups, since: "2026-10-24" });
  assert.equal(record.pages, 7);
  assert.equal(record.since, "2026-10-24");
  assert.equal(record.sig, signatureOf(groups));
  assert.notEqual(signatureOf(groups), signatureOf([...groups].reverse()));
});

test("the folders that hold pages of the index, with their page counts, for the families in scope", () => {
  const index = new Map([
    ["/azure/vm/overview", null],
    ["/azure/vm/create", null],
    ["/azure/vm/sub/x", null],
    ["/azure", null], // directly under the root: no folder
    ["/other/a/b", null],
  ]);
  assert.deepEqual(directoriesOf(index), [
    { dir: "/azure/vm", pages: 2 },
    { dir: "/azure/vm/sub", pages: 1 },
    { dir: "/other/a", pages: 1 },
  ]);
  assert.deepEqual(directoriesOf(index, { families: new Set(["azure"]) }), [
    { dir: "/azure/vm", pages: 2 },
    { dir: "/azure/vm/sub", pages: 1 },
  ]);
});

test("the plan refreshes known tocs, asks new folders (never asked first, then the oldest answers), skips small folders and fresh answers", () => {
  const directories = [
    { dir: "/a", pages: 10 },
    { dir: "/b", pages: 10 },
    { dir: "/c", pages: 10 },
    { dir: "/d", pages: 10 },
    { dir: "/small", pages: 1 },
    { dir: "/e", pages: 10 },
  ];
  const plan = planProbes({
    directories,
    previousTocs: [{ path: "/a" }, { path: "/gone" }],
    previousNoToc: { "/b": "2026-10-20", "/c": "2026-09-01", "/old": "2026-09-01" },
    today: "2026-10-24",
    recheckDays: 28,
    maxProbes: 10,
    minDirPages: 3,
  });
  assert.deepEqual(plan.refresh, ["/a"]);
  assert.deepEqual(plan.probe, ["/c", "/d", "/e"], "/b was answered 4 days ago, /small is too small");
  assert.deepEqual(plan.dropped, ["/gone", "/old"]);
  assert.equal(plan.waiting, 0);
  const limited = planProbes({ directories, previousTocs: [], previousNoToc: { "/c": "2026-09-01" }, today: "2026-10-24", recheckDays: 28, maxProbes: 2, minDirPages: 3 });
  assert.deepEqual(limited.probe, ["/a", "/b"], "never asked folders go before an old answer");
  assert.equal(limited.waiting, 3);
});

test("the file is sorted by path and carries no derived data; an unreadable or foreign previous file is not built on", () => {
  const file = buildFile({
    tocs: [{ path: "/b", groups: [] }, { path: "/a", groups: [] }],
    noToc: { "/z": "2026-10-01", "/y": "2026-10-02" },
    scope: "relevant",
    lastChecked: "2026-10-24T07:00:00.000Z",
  });
  assert.deepEqual(file.tocs.map((t) => t.path), ["/a", "/b"]);
  assert.deepEqual(Object.keys(file.noToc), ["/y", "/z"]);
  assert.equal(file.schemaVersion, 1);
  assert.equal(readPrevious(null), null);
  assert.equal(readPrevious({ schemaVersion: 2, tocs: [] }), null);
  assert.equal(readPrevious({ schemaVersion: 1, tocs: "x" }), null);
  assert.deepEqual(readPrevious({ schemaVersion: 1, tocs: [{ path: "/a", groups: [] }, { nope: 1 }] }).tocs.length, 1);
  // the timestamp is the only difference between two runs that found the same
  assert.equal(stableContent(file), stableContent({ ...file, lastChecked: "other" }));
});

test("totals count a page once however many groups hold it", () => {
  const tocs = [
    { path: "/a", pages: 3, groups: [{ title: [], landing: null, pages: ["/a/1", "/a/2"] }, { title: ["G"], landing: "/a/1", pages: ["/a/3"] }] },
  ];
  assert.deepEqual(summarizeTocs(tocs), { tocs: 1, groups: 2, pages: 3, uniquePages: 3 });
});

test("failsafes: too many failed requests, a changed format, far fewer pages than before, a dead site", () => {
  const L = { ...DOCS_TOC_LIMITS, FAIL_MIN_SAMPLE: 5, PAGES_MIN_PREVIOUS: 10, BREAKER_MIN: 4 };
  assert.deepEqual(evaluateFailsafes({ attempted: 100, failed: 0, answeredOk: 50, formatFailed: 0, previousPages: 500, nextPages: 500, limits: L }), []);
  assert.match(evaluateFailsafes({ attempted: 100, failed: 11, answeredOk: 50, formatFailed: 0, previousPages: 500, nextPages: 500, limits: L })[0], /11 of 100 requests failed/);
  assert.match(evaluateFailsafes({ attempted: 100, failed: 0, answeredOk: 50, formatFailed: 6, previousPages: 500, nextPages: 500, limits: L })[0], /not a table of contents/);
  assert.match(evaluateFailsafes({ attempted: 100, failed: 0, answeredOk: 50, formatFailed: 0, previousPages: 500, nextPages: 300, limits: L })[0], /only 300 pages/);
  // a small sample proves nothing
  assert.deepEqual(evaluateFailsafes({ attempted: 3, failed: 3, answeredOk: 0, formatFailed: 0, previousPages: 5, nextPages: 0, limits: L }), []);
  assert.equal(breakerTripped({ attempted: 4, failed: 3, limits: L }), true);
  assert.equal(breakerTripped({ attempted: 4, failed: 2, limits: L }), false);
  assert.equal(breakerTripped({ attempted: 3, failed: 3, limits: L }), false);
});

test("the lookup finds the pages of the same group: how-to-manage-groups brings concept-learn-about-groups", () => {
  const groups = parseToc(ENTRA_TOC, "/entra/fundamentals");
  const file = buildFile({
    tocs: [buildTocRecord({ path: "/entra/fundamentals", groups, since: "2026-10-24" })],
    noToc: {},
    scope: "relevant",
    lastChecked: "x",
  });
  const lookup = buildLookup(file);
  assert.deepEqual(lookup.groupsOf("/entra/fundamentals/how-to-manage-groups").map((g) => g.title), [["Add users and groups", "Groups"]]);
  assert.deepEqual(lookup.siblingsOf("/entra/fundamentals/how-to-manage-groups"), [
    "/entra/fundamentals/concept-learn-about-groups",
    "/entra/identity/users/groups-self-service-management",
  ]);
  assert.deepEqual(lookup.groupsOf("/entra/nowhere"), []);
  assert.deepEqual(lookup.siblingsOf("/entra/nowhere"), []);
  // a page that is the landing page of a group has the group's pages as siblings
  const landing = buildLookup({ tocs: [{ path: "/x", groups: [{ title: ["G"], landing: "/x/g", pages: ["/x/g/a", "/x/g/b"] }] }] });
  assert.deepEqual(landing.siblingsOf("/x/g"), ["/x/g/a", "/x/g/b"]);
  assert.deepEqual(landing.siblingsOf("/x/g/a"), ["/x/g", "/x/g/b"]);
  assert.equal(buildLookup(null).pages, 0);
});
