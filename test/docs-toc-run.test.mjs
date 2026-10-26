import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FailsafeAbort } from "../scripts/lib/learn-io.mjs";
import { runDocsTocSync, familiesInScope } from "../scripts/lib/docs-toc-run.mjs";
import { collectLogs, makeTempDir, removeDir } from "./learn-fixtures.mjs";

const noSleep = async () => {};
const D1 = new Date("2026-10-05T07:00:00.000Z");
const D2 = new Date("2026-10-12T07:00:00.000Z");
const D3 = new Date("2026-11-20T07:00:00.000Z");
const BASE = "https://learn.microsoft.com/en-us";

// folder /entra/fundamentals has a toc; /entra/identity/users has one; /entra/identity has none (a real fact of Learn);
// /azure/vm has one; /azure/tiny has two pages only
const PAGES = [
  ...["a", "b", "c"].map((n) => `/entra/fundamentals/${n}`),
  ...["x", "y", "z"].map((n) => `/entra/identity/users/${n}`),
  ...["p", "q", "r"].map((n) => `/entra/identity/${n}`),
  ...["v1", "v2", "v3"].map((n) => `/azure/vm/${n}`),
  "/azure/tiny/t1",
  "/azure/tiny/t2",
  "/other/site/s1",
  "/other/site/s2",
  "/other/site/s3",
];

const tocOf = (items) => ({ items });
const TOCS = new Map([
  ["/entra/fundamentals", tocOf([{ href: "./", toc_title: "Home" }, { toc_title: "Groups", children: [{ href: "a", toc_title: "A" }, { href: "b", toc_title: "B" }] }])],
  ["/entra/identity/users", tocOf([{ toc_title: "Users", children: [{ href: "x", toc_title: "X" }, { href: "../../fundamentals/a", toc_title: "A elsewhere" }] }])],
  ["/azure/vm", tocOf([{ toc_title: "VMs", children: [{ href: "v1", toc_title: "1" }, { href: "v2", toc_title: "2" }] }])],
]);

function setup({ families = { entra: { relevant: true }, azure: { relevant: true }, other: { relevant: false } } } = {}) {
  const dir = makeTempDir();
  writeFileSync(join(dir, "docs-urls.txt"), PAGES.map((p) => `${p}\t2026-10-01\n`).join(""));
  writeFileSync(join(dir, "docs-sitemap-families.json"), JSON.stringify(families));
  const answers = new Map(TOCS); // dir -> toc | http status | Error | raw text
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const folder = url.replace(BASE, "").replace(/\/toc\.json$/, "");
    const answer = answers.get(folder);
    if (answer instanceof Error) throw answer;
    if (answer === undefined) return new Response("<html>not found</html>", { status: 404 });
    if (typeof answer === "number") return new Response("", { status: answer });
    if (typeof answer === "string") return new Response(answer, { status: 200 });
    return new Response(JSON.stringify(answer), { status: 200 });
  };
  const out = collectLogs();
  const run = (over = {}) =>
    runDocsTocSync({
      dataDir: dir,
      env: {},
      now: D1,
      fetchImpl,
      sleepImpl: noSleep,
      delayMs: 0,
      log: out.log,
      warn: out.warn,
      httpOptions: { attempts: 1, baseBackoffMs: 1 },
      limits: { FAIL_MIN_SAMPLE: 2, PAGES_MIN_PREVIOUS: 1, BREAKER_MIN: 1000 },
      ...over,
    });
  const file = () => JSON.parse(readFileSync(join(dir, "docs-toc.json"), "utf8"));
  const status = () => JSON.parse(readFileSync(join(dir, "status.json"), "utf8"));
  return { dir, answers, calls, out, run, file, status, cleanup: () => removeDir(dir) };
}

test("the families in scope: the env list, else the relevant families of the sitemap pass, else every family", () => {
  assert.deepEqual(familiesInScope({ env: { DOCS_TOC_FAMILIES: " Entra, /azure " }, familiesFile: {} }), { families: new Set(["entra", "azure"]), scope: "azure,entra" });
  assert.deepEqual(familiesInScope({ env: {}, familiesFile: { a: { relevant: true }, b: { relevant: false } } }), { families: new Set(["a"]), scope: "relevant" });
  assert.deepEqual(familiesInScope({ env: {}, familiesFile: null }), { families: null, scope: "all" });
});

test("a first run asks every folder with enough pages in a relevant family, keeps the tocs, remembers the folders without one", async () => {
  const t = setup();
  try {
    const summary = await t.run();
    assert.equal(summary.written, true);
    const file = t.file();
    assert.equal(file.schemaVersion, 1);
    assert.equal(file.scope, "relevant");
    assert.deepEqual(file.tocs.map((x) => x.path), ["/azure/vm", "/entra/fundamentals", "/entra/identity/users"]);
    assert.deepEqual(Object.keys(file.noToc), ["/entra/identity"], "a folder without toc.json is remembered");
    assert.equal(file.noToc["/entra/identity"], "2026-10-05");
    const users = file.tocs.find((x) => x.path === "/entra/identity/users");
    assert.deepEqual(users.groups, [{ title: ["Users"], landing: null, pages: ["/entra/identity/users/x", "/entra/fundamentals/a"] }]);
    // /azure/tiny has two pages, /other is not a relevant family: neither was asked
    const asked = t.calls.map((c) => c.replace(BASE, ""));
    assert.ok(!asked.some((c) => c.startsWith("/azure/tiny") || c.startsWith("/other")), asked.join(","));
    assert.equal(t.status().docsToc.tocs, 3);
    assert.equal(t.status().docsToc.noToc, 1);
    assert.equal(t.status().docsToc.scope, "relevant");
  } finally {
    t.cleanup();
  }
});

test("a quiet second run refreshes the known tocs only and writes nothing new: same file but for the heartbeat", async () => {
  const t = setup();
  try {
    await t.run();
    const before = readFileSync(join(t.dir, "docs-toc.json"), "utf8");
    t.calls.length = 0;
    const summary = await t.run({ now: D2 });
    assert.equal(summary.written, false, "nothing changed");
    assert.equal(readFileSync(join(t.dir, "docs-toc.json"), "utf8"), before);
    const asked = t.calls.map((c) => c.replace(BASE, "").replace("/toc.json", "")).sort();
    assert.deepEqual(asked, ["/azure/vm", "/entra/fundamentals", "/entra/identity/users"], "the folder without a toc is not asked again within 28 days");
    assert.equal(t.status().docsToc.tocs, 3, "the heartbeat is written on every good run");
  } finally {
    t.cleanup();
  }
});

test("a changed toc replaces its record (a new since day and signature); a toc that is gone, a new folder and an answer that is due are all handled", async () => {
  const t = setup();
  try {
    await t.run();
    const oldSig = t.file().tocs.find((x) => x.path === "/azure/vm").sig;
    // /azure/vm changes, /entra/identity/users disappears, /entra/identity grows a toc
    t.answers.set("/azure/vm", tocOf([{ toc_title: "VMs", children: [{ href: "v1", toc_title: "1" }, { href: "v3", toc_title: "3" }] }]));
    t.answers.delete("/entra/identity/users");
    t.answers.set("/entra/identity", tocOf([{ toc_title: "Identity", children: [{ href: "p", toc_title: "P" }] }]));
    const summary = await t.run({ now: D3 });
    assert.equal(summary.written, true);
    const file = t.file();
    const vm = file.tocs.find((x) => x.path === "/azure/vm");
    assert.notEqual(vm.sig, oldSig);
    assert.equal(vm.since, "2026-11-20");
    assert.deepEqual(vm.groups[0].pages, ["/azure/vm/v1", "/azure/vm/v3"]);
    assert.equal(file.tocs.find((x) => x.path === "/entra/fundamentals").since, "2026-10-05", "an unchanged toc keeps its day");
    assert.ok(!file.tocs.some((x) => x.path === "/entra/identity/users"), "a toc that answers 404 now is gone");
    assert.equal(file.noToc["/entra/identity/users"], "2026-11-20");
    assert.ok(file.tocs.some((x) => x.path === "/entra/identity"), "the folder that had none now has one");
    assert.ok(!("/entra/identity" in file.noToc));
  } finally {
    t.cleanup();
  }
});

test("a request that fails keeps what the folder had and is asked again next run; the failure is counted", async () => {
  const t = setup();
  try {
    await t.run();
    t.answers.set("/azure/vm", 503);
    const summary = await t.run({ now: D2, limits: { FAIL_MIN_SAMPLE: 100, BREAKER_MIN: 1000 } });
    assert.equal(summary.failed, 1);
    assert.ok(t.file().tocs.some((x) => x.path === "/azure/vm"), "the old record stays");
    assert.equal(t.status().docsToc.failed, 1);
  } finally {
    t.cleanup();
  }
});

test("failsafe: too many failed requests abort the run and write nothing, not even the heartbeat", async () => {
  const t = setup();
  try {
    t.answers.set("/azure/vm", 503);
    t.answers.set("/entra/fundamentals", 503);
    await assert.rejects(t.run(), (err) => err instanceof FailsafeAbort && /requests failed/.test(err.message));
    assert.equal(existsSync(join(t.dir, "docs-toc.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
  } finally {
    t.cleanup();
  }
});

test("failsafe: answers that are HTTP 200 but JSON without a toc tree (Learn changed the format) abort the run", async () => {
  const t = setup();
  try {
    for (const dir of ["/azure/vm", "/entra/fundamentals", "/entra/identity/users"]) t.answers.set(dir, { navigation: [] });
    await assert.rejects(t.run(), (err) => err instanceof FailsafeAbort && /not a table of contents/.test(err.message));
    assert.equal(existsSync(join(t.dir, "docs-toc.json")), false);
  } finally {
    t.cleanup();
  }
});

test("failsafe: an HTML page where a toc should be (a sign-in or error page with status 200) counts as a failed request and aborts the run", async () => {
  const t = setup();
  try {
    for (const dir of ["/azure/vm", "/entra/fundamentals", "/entra/identity/users"]) t.answers.set(dir, "<html>a sign-in page</html>");
    await assert.rejects(t.run(), (err) => err instanceof FailsafeAbort && /requests failed/.test(err.message));
    assert.equal(existsSync(join(t.dir, "docs-toc.json")), false);
  } finally {
    t.cleanup();
  }
});

test("failsafe: far fewer pages in a group than before abort the run", async () => {
  const t = setup();
  try {
    await t.run();
    for (const dir of ["/azure/vm", "/entra/fundamentals"]) t.answers.set(dir, tocOf([]));
    t.answers.set("/entra/identity/users", tocOf([{ toc_title: "Users", children: [{ href: "x", toc_title: "X" }] }]));
    await assert.rejects(t.run({ now: D2 }), (err) => err instanceof FailsafeAbort && /pages are in a sidebar group now/.test(err.message));
  } finally {
    t.cleanup();
  }
});

test("DOCS_TOC_FAMILIES limits the run to those families, and a different scope starts from scratch", async () => {
  const t = setup();
  try {
    await t.run({ env: { DOCS_TOC_FAMILIES: "azure" } });
    assert.deepEqual(t.file().tocs.map((x) => x.path), ["/azure/vm"]);
    assert.equal(t.file().scope, "azure");
    t.calls.length = 0;
    await t.run({ env: {}, now: D2 });
    assert.deepEqual(t.file().tocs.map((x) => x.path), ["/azure/vm", "/entra/fundamentals", "/entra/identity/users"], "the other scope is built from scratch");
    assert.equal(t.calls.length, 4, "every folder is asked: nothing of the old scope is reused");
  } finally {
    t.cleanup();
  }
});

test("DOCS_TOC_MAX_PROBES bounds the folders asked for the first time; the rest waits and the heartbeat says how many", async () => {
  const t = setup();
  try {
    const summary = await t.run({ env: { DOCS_TOC_MAX_PROBES: "2" } });
    assert.equal(summary.asked, 2);
    assert.equal(summary.waiting, 2);
    assert.equal(t.status().docsToc.waiting, 2);
  } finally {
    t.cleanup();
  }
});

test("DRY_RUN asks and computes but writes nothing; a missing or empty docs index stops the run before any request", async () => {
  const t = setup();
  try {
    const summary = await t.run({ env: { DRY_RUN: "1" } });
    assert.equal(summary.written, false);
    assert.equal(existsSync(join(t.dir, "docs-toc.json")), false);
    assert.equal(existsSync(join(t.dir, "status.json")), false);
    writeFileSync(join(t.dir, "docs-urls.txt"), "");
    t.calls.length = 0;
    await assert.rejects(t.run(), /docs-urls\.txt is empty/);
    assert.equal(t.calls.length, 0);
  } finally {
    t.cleanup();
  }
});
