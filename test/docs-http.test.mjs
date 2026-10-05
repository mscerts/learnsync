import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttpClient, probeUrlFor } from "../scripts/lib/docs-http.mjs";

/** Fake fetch from a queue of responses per URL (a function gets the call index). */
function fakeFetch(script) {
  const calls = [];
  const counters = new Map();
  const impl = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect, signal: init.signal });
    const n = counters.get(url) || 0;
    counters.set(url, n + 1);
    const entry = script[url];
    if (!entry) throw new Error(`unexpected fetch ${url}`);
    const item = Array.isArray(entry) ? entry[Math.min(n, entry.length - 1)] : entry;
    const r = typeof item === "function" ? item(n) : item;
    if (r instanceof Error) throw r;
    return new Response(r.body ?? null, { status: r.status, headers: r.headers || {} });
  };
  return { impl, calls };
}

function clock() {
  const state = { t: 0, sleeps: [] };
  return {
    state,
    now: () => state.t,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.t += ms;
    },
  };
}

const BASE = "https://learn.microsoft.com";

test("probeUrlFor always asks for the explicit en-us form", () => {
  assert.equal(probeUrlFor("https://learn.microsoft.com/azure/x"), `${BASE}/en-us/azure/x`);
  assert.equal(probeUrlFor("https://learn.microsoft.com/azure/Key-Vault/x?view=a#f"), `${BASE}/en-us/azure/Key-Vault/x`);
  assert.equal(probeUrlFor("/azure/x"), `${BASE}/en-us/azure/x`);
  assert.equal(probeUrlFor("/en-us/azure/x"), `${BASE}/en-us/azure/x`);
  assert.equal(probeUrlFor("/"), `${BASE}/en-us`);
});

test("probe always uses GET (never HEAD) and never follows redirects itself", async () => {
  const { impl, calls } = fakeFetch({ [`${BASE}/en-us/azure/x`]: { status: 200, body: "<html><head><title>T</title></head><body>b</body></html>" } });
  const c = clock();
  const client = createHttpClient({ fetchImpl: impl, sleep: c.sleep, now: c.now });
  for (const readHead of [false, true]) {
    const r = await client.probe(`${BASE}/en-us/azure/x`, { readHead });
    assert.equal(r.status, 200);
  }
  assert.deepEqual(calls.map((x) => x.method), ["GET", "GET"]);
  assert.ok(calls.every((x) => x.redirect === "manual"));
  assert.ok(calls.every((x) => x.signal instanceof AbortSignal), "every request has a timeout signal");
});

test("probe reports the first hop's real status and the end of the chain", async () => {
  const { impl, calls } = fakeFetch({
    [`${BASE}/en-us/azure/old`]: { status: 301, headers: { location: "/en-us/azure/mid" } },
    [`${BASE}/en-us/azure/mid`]: { status: 302, headers: { location: `${BASE}/en-us/azure/new` } },
    [`${BASE}/en-us/azure/new`]: { status: 200, body: "<html><head><title>New</title></head></html>" },
  });
  const client = createHttpClient({ fetchImpl: impl, sleep: async () => {} });
  const r = await client.probe(`${BASE}/en-us/azure/old`, { readHead: true });
  assert.equal(r.status, 200);
  assert.equal(r.firstStatus, 301);
  assert.equal(r.finalUrl, `${BASE}/en-us/azure/new`);
  assert.deepEqual(r.hops.map((h) => h.status), [301, 302]);
  assert.match(r.text, /<title>New<\/title>/);
  assert.equal(calls.length, 3);
});

test("probe: a redirect that ends in a 404 keeps both statuses", async () => {
  const { impl } = fakeFetch({
    [`${BASE}/en-us/d/x`]: { status: 301, headers: { location: "/en-us/t/y" } },
    [`${BASE}/en-us/t/y`]: { status: 404 },
  });
  const client = createHttpClient({ fetchImpl: impl, sleep: async () => {} });
  const r = await client.probe(`${BASE}/en-us/d/x`);
  assert.equal(r.status, 404);
  assert.equal(r.firstStatus, 301);
});

test("probe never requests an off-site destination", async () => {
  const { impl, calls } = fakeFetch({ [`${BASE}/en-us/azure/old`]: { status: 301, headers: { location: "https://example.com/elsewhere" } } });
  const client = createHttpClient({ fetchImpl: impl, sleep: async () => {} });
  const r = await client.probe(`${BASE}/en-us/azure/old`);
  assert.equal(r.offsite, true);
  assert.equal(r.status, 301);
  assert.equal(r.finalUrl, "https://example.com/elsewhere");
  assert.equal(calls.length, 1);
});

test("probe gives up on a redirect loop instead of hanging", async () => {
  const { impl } = fakeFetch({
    [`${BASE}/en-us/a`]: { status: 301, headers: { location: "/en-us/b" } },
    [`${BASE}/en-us/b`]: { status: 301, headers: { location: "/en-us/a" } },
  });
  const client = createHttpClient({ fetchImpl: impl, sleep: async () => {}, maxHops: 4 });
  const r = await client.probe(`${BASE}/en-us/a`);
  assert.equal(r.status, null);
  assert.equal(r.tooManyHops, true);
});

test("429 is retried after Retry-After, and the cooldown is shared by every worker", async () => {
  const c = clock();
  const { impl, calls } = fakeFetch({
    [`${BASE}/en-us/a`]: [{ status: 429, headers: { "retry-after": "7" } }, { status: 200 }],
    [`${BASE}/en-us/b`]: { status: 200 },
  });
  const client = createHttpClient({ fetchImpl: impl, sleep: c.sleep, now: c.now, baseBackoffMs: 1000 });
  const a = await client.probe(`${BASE}/en-us/a`);
  assert.equal(a.status, 200);
  assert.ok(c.state.sleeps.some((ms) => ms >= 7000), `slept ${c.state.sleeps}`);
  assert.equal(client.stats.rateLimited, 1);
  assert.equal(client.stats.retries, 1);
  // a later request starts only after the shared cooldown ended: the clock moved past it already
  const before = calls.length;
  await client.probe(`${BASE}/en-us/b`);
  assert.equal(calls.length, before + 1);
});

test("a worker that starts during another worker's cooldown waits for it", async () => {
  const c = clock();
  let cooldownSeen = null;
  const { impl } = fakeFetch({
    [`${BASE}/en-us/a`]: [{ status: 429, headers: { "retry-after": "10" } }, { status: 200 }],
    [`${BASE}/en-us/b`]: () => {
      cooldownSeen = c.state.t;
      return { status: 200 };
    },
  });
  const client = createHttpClient({ fetchImpl: impl, sleep: c.sleep, now: c.now, baseBackoffMs: 1000 });
  // worker A is rate limited at t=0 -> cooldown until t=10000; worker B asks right after
  const pa = client.probe(`${BASE}/en-us/a`);
  await Promise.resolve();
  await Promise.resolve();
  const pb = client.probe(`${BASE}/en-us/b`);
  await Promise.all([pa, pb]);
  assert.ok(cooldownSeen >= 10000, `B went out at t=${cooldownSeen}, before the cooldown ended`);
});

test("5xx and network errors are retried with backoff, then reported (never thrown)", async () => {
  const c = clock();
  const { impl, calls } = fakeFetch({
    [`${BASE}/en-us/e500`]: { status: 503 },
    [`${BASE}/en-us/neterr`]: new Error("socket hang up"),
  });
  const client = createHttpClient({ fetchImpl: impl, sleep: c.sleep, now: c.now, maxRetries: 2, baseBackoffMs: 100 });
  const r500 = await client.probe(`${BASE}/en-us/e500`);
  assert.equal(r500.status, 503);
  assert.equal(calls.filter((x) => x.url.endsWith("e500")).length, 3, "initial try + 2 retries");
  const rErr = await client.probe(`${BASE}/en-us/neterr`);
  assert.equal(rErr.status, null);
  assert.match(rErr.error, /socket hang up/);
  assert.equal(calls.filter((x) => x.url.endsWith("neterr")).length, 3);
});

test("readHead stops reading at </head>", async () => {
  const html = "<html><head><title>T</title></head><body>" + "x".repeat(200000) + "</body></html>";
  const chunks = html.match(/[\s\S]{1,4000}/g); // a real response arrives in many chunks
  let sent = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (sent >= chunks.length) controller.close();
      else controller.enqueue(new TextEncoder().encode(chunks[sent++]));
    },
  });
  const { impl } = fakeFetch({ [`${BASE}/en-us/big`]: [{ status: 200, body }, { status: 200, body: html }] });
  const client = createHttpClient({ fetchImpl: impl, sleep: async () => {} });
  const r = await client.probe(`${BASE}/en-us/big`, { readHead: true });
  assert.ok(r.text.includes("</head>"));
  assert.ok(r.text.length < html.length);
  assert.ok(sent < chunks.length, "stopped pulling the stream");
  const none = await client.probe(`${BASE}/en-us/big`, { readHead: false });
  assert.equal(none.text, "");
});

test("get follows redirects and returns the body (sitemap files)", async () => {
  const { impl } = fakeFetch({ [`${BASE}/_sitemaps/x.xml`]: { status: 200, body: "<urlset></urlset>" } });
  const client = createHttpClient({ fetchImpl: impl, sleep: async () => {} });
  const r = await client.get(`${BASE}/_sitemaps/x.xml`, { accept: "application/xml", big: true });
  assert.equal(r.status, 200);
  assert.equal(r.text, "<urlset></urlset>");
});
