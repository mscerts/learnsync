import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { articleHtml, extractPageLinks, linkTarget, metaContent, tocFolderOf } from "../scripts/lib/docs-page-links.mjs";
import { fetchPageLinks, pagesOf } from "../scripts/lib/docs-page-links-run.mjs";

// A trimmed copy of the real page https://learn.microsoft.com/en-us/entra/fundamentals/how-to-manage-groups (2026-10-24):
// its metas and the article from the <h1> to the inline-notifications placeholder.
const PAGE = readFileSync(new URL("./fixtures/docs-page-how-to-manage-groups.html", import.meta.url), "utf8");
const PATH = "/entra/fundamentals/how-to-manage-groups";

test("what the page says about itself: topic, product, date and the folder of its table of contents", () => {
  const page = extractPageLinks(PAGE, { path: PATH });
  assert.equal(page.title, "Manage Microsoft Entra groups and group membership");
  assert.equal(page.topic, "how-to");
  assert.equal(page.service, "entra");
  assert.equal(page.subservice, "fundamentals");
  assert.equal(page.date, "2026-06-17");
  assert.equal(page.toc, "/entra/fundamentals", "joins data/docs-toc.json");
});

test("the links of the article come in its order with the section they sit in; relative, parent-relative and /en-us/ links all become Learn paths", () => {
  const { links } = extractPageLinks(PAGE, { path: PATH });
  const find = (path, section) => links.find((l) => l.path === path && (!section || l.section === section));
  assert.equal(find("/entra/fundamentals/concept-learn-about-groups", "Related content").text, "Learn about groups and assigning access rights to groups");
  assert.ok(find("/entra/identity/users/groups-self-service-management", "Related content"));
  assert.ok(find("/entra/identity/users/groups-settings-v2-cmdlets", "Related content"));
  assert.ok(find("/entra/fundamentals/create-new-tenant", "Prerequisites"), "a relative link of the same folder");
  assert.ok(find("/entra/identity/role-based-access-control/permissions-reference"), "the anchor is dropped");
  assert.ok(find("/powershell/module/exchange/set-unifiedgroup"), "an /en-us/ absolute path loses the locale");
  assert.ok(find("/entra/id-governance/tenant-governance/cross-tenant-delegated-administration"));
  // the order of the article: prerequisites first, related content last
  assert.equal(links[0].section, "Prerequisites");
  assert.equal(links.at(-1).section, "Related content");
});

test("external links and the page's own address are not links; a path appears once per section", () => {
  const { links } = extractPageLinks(PAGE, { path: PATH });
  assert.ok(!links.some((l) => l.path.includes("microsoft.com")), "entra.microsoft.com and azure.microsoft.com are external");
  assert.ok(!links.some((l) => l.path === PATH));
  const keys = links.map((l) => `${l.path}\t${l.section}`);
  assert.equal(new Set(keys).size, keys.length);
  // the same page linked in two sections is kept in both: the section is part of the context
  const concept = links.filter((l) => l.path === "/entra/fundamentals/concept-learn-about-groups").map((l) => l.section);
  assert.ok(concept.length >= 2);
  assert.ok(concept.includes("Related content"));
});

test("a page that does not look like an article is null, not a page without links", () => {
  assert.equal(extractPageLinks("<html><body><p>sign in</p></body></html>", { path: PATH }), null);
  assert.equal(extractPageLinks("<h1>Title</h1><p>text but no end of the article</p>", { path: PATH }), null);
  assert.equal(extractPageLinks(null, { path: PATH }), null);
  // an end of <main> is enough when the placeholder is gone
  const page = extractPageLinks('<main><h1>T</h1><p><a href="x">X</a></p></main><footer><a href="/azure/elsewhere">no</a></footer>', { path: "/a/b" });
  assert.deepEqual(page.links, [{ path: "/a/x", text: "X", section: "lead" }]);
});

test("page furniture is not curated content: feedback and in-this-article sections are skipped, text before the first heading is 'lead'", () => {
  const page = extractPageLinks(
    '<main><h1>T</h1><p><a href="one">One</a></p><h2>In this article</h2><ul><li><a href="two">Two</a></li></ul><h2>Next steps</h2><p><a href="three" data-linktype="relative-path">Three</a> <a href="#top" data-linktype="self-bookmark">top</a> <a href="https://github.com/x" data-linktype="external">gh</a></p></main>',
    { path: "/a/b" },
  );
  assert.deepEqual(page.links, [
    { path: "/a/one", text: "One", section: "lead" },
    { path: "/a/three", text: "Three", section: "Next steps" },
  ]);
});

test("helpers: the article bounds, a meta in either attribute order, the toc folder, a link target", () => {
  assert.equal(articleHtml("<h1>A</h1>BODY<div id=\"ms--inline-notifications\"></div>AFTER").trim(), "BODY");
  assert.equal(metaContent('<meta name="ms.topic" content="concept-article" />', "ms.topic"), "concept-article");
  assert.equal(metaContent('<meta content="entra" name="ms.service">', "ms.service"), "entra");
  assert.equal(metaContent("<html></html>", "ms.topic"), null);
  assert.equal(tocFolderOf("/entra/identity/users/x", "toc.json"), "/entra/identity/users");
  assert.equal(tocFolderOf("/entra/identity/users/x", "../toc.json"), "/entra/identity");
  assert.equal(tocFolderOf("/a/b", null), null);
  assert.equal(linkTarget("../x/y#frag", "/a/b/c"), "/a/x/y");
  assert.equal(linkTarget("/en-us/azure/z?view=1", "/a/b"), "/azure/z");
  assert.equal(linkTarget("https://learn.microsoft.com/azure/z", "/a/b"), "/azure/z");
  assert.equal(linkTarget("https://example.com/x", "/a/b"), null);
  assert.equal(linkTarget("#x", "/a/b"), null);
  assert.equal(linkTarget("mailto:a@b.c", "/a/b"), null);
  assert.equal(linkTarget("c", "/a/c"), null, "a link to the page itself");
});

test("the tool reads the pages from arguments or a JSON array, and reports what could not be read", async () => {
  assert.deepEqual(pagesOf(["https://learn.microsoft.com/en-us/azure/x", "/azure/y"]).map((p) => p.path), ["/azure/x", "/azure/y"]);
  assert.deepEqual(pagesOf([], '["https://learn.microsoft.com/en-us/azure/x"]').map((p) => p.path), ["/azure/x"]);
  assert.deepEqual(pagesOf([], "").length, 0);
  assert.throws(() => pagesOf([], '{"no":1}'), /JSON array/);
  const fetchImpl = async (url) => {
    if (url.endsWith(PATH)) return new Response(PAGE, { status: 200 });
    if (url.endsWith("/azure/gone")) return new Response("", { status: 404 });
    return new Response("<html>sign in</html>", { status: 200 });
  };
  const out = await fetchPageLinks(pagesOf([PATH, "/azure/gone", "/azure/odd", "https://example.com/x"]), { delayMs: 0, fetchImpl, sleepImpl: async () => {} });
  assert.equal(out[0].path, PATH);
  assert.equal(out[0].topic, "how-to");
  assert.deepEqual(out[1], { path: "/azure/gone", error: "HTTP 404" });
  assert.match(out[2].error, /no article found/);
  assert.match(out[3].error, /not a learn\.microsoft\.com/);
});
