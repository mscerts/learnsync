import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_CONCURRENCY,
  backoffDelay,
  classifyStatus,
  fetchJson,
  parseRetryAfter,
  request,
  runPool,
} from "../scripts/lib/learn-http.mjs";

const noSleep = async () => {};

function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  };
  return { fetchImpl, calls };
}

const ok = (body = {}) => new Response(JSON.stringify(body), { status: 200 });
const status = (code, headers = {}) => new Response("x", { status: code, headers });

test("parseRetryAfter reads seconds and HTTP dates and rejects garbage", () => {
  assert.equal(parseRetryAfter("7"), 7000);
  assert.equal(parseRetryAfter(" 0 "), 0);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter(""), null);
  assert.equal(parseRetryAfter("soon"), null);
  const now = Date.parse("2026-10-05T10:00:00Z");
  assert.equal(parseRetryAfter("Mon, 05 Oct 2026 10:00:30 GMT", now), 30_000);
  assert.equal(parseRetryAfter("Mon, 05 Oct 2026 09:00:00 GMT", now), 0);
});

test("backoffDelay grows exponentially, is capped, and never undercuts a Retry-After", () => {
  assert.equal(backoffDelay(0, { baseBackoffMs: 1000 }), 1000);
  assert.equal(backoffDelay(3, { baseBackoffMs: 1000 }), 8000);
  assert.equal(backoffDelay(20, { baseBackoffMs: 1000, maxBackoffMs: 5000 }), 5000);
  assert.equal(backoffDelay(0, { baseBackoffMs: 1000, retryAfterMs: 30_000 }), 30_000);
  assert.equal(backoffDelay(0, { baseBackoffMs: 1000, retryAfterMs: 900_000, maxRetryAfterMs: 120_000 }), 120_000);
});

test("classifyStatus separates definitive answers from retryable ones", () => {
  assert.equal(classifyStatus(200), "ok");
  assert.equal(classifyStatus(204), "ok");
  assert.equal(classifyStatus(404), "notFound");
  assert.equal(classifyStatus(410), "notFound");
  for (const code of [408, 429, 500, 502, 503]) assert.equal(classifyStatus(code), "retry");
  for (const code of [400, 401, 403]) assert.equal(classifyStatus(code), "error");
});

test("request retries 429 and 5xx with backoff and returns the eventual 200", async () => {
  const waits = [];
  const { fetchImpl, calls } = scripted([status(429, { "retry-after": "5" }), status(503), ok({ a: 1 })]);
  const result = await request("https://x/y", { fetchImpl, sleepImpl: async (ms) => waits.push(ms), read: "json", baseBackoffMs: 100 });
  assert.equal(result.outcome, "ok");
  assert.deepEqual(result.body, { a: 1 });
  assert.equal(result.attempts, 3);
  assert.equal(calls.length, 3);
  assert.equal(waits[0], 5000, "Retry-After wins over the 100 ms backoff");
  assert.equal(waits[1], 200, "second wait is the exponential step");
});

test("request never retries 404/410/403 and reports them as definitive", async () => {
  for (const [code, outcome] of [[404, "notFound"], [410, "notFound"], [403, "error"]]) {
    const { fetchImpl, calls } = scripted([status(code), ok()]);
    const result = await request("https://x/y", { fetchImpl, sleepImpl: noSleep });
    assert.equal(result.outcome, outcome);
    assert.equal(result.status, code);
    assert.equal(calls.length, 1);
  }
});

test("request gives up as transient after all attempts (429 storm, timeout, network error, bad JSON)", async () => {
  const timeout = Object.assign(new Error("slow"), { name: "TimeoutError" });
  const cases = [
    [[status(429)], "HTTP 429"],
    [[timeout], "timeout"],
    [[new Error("ECONNRESET")], "ECONNRESET"],
    [[new Response("<html>", { status: 200 })], undefined],
  ];
  for (const [responses, expected] of cases) {
    const { fetchImpl, calls } = scripted(responses);
    const result = await request("https://x/y", { fetchImpl, sleepImpl: noSleep, attempts: 3, read: "json" });
    assert.equal(result.outcome, "transient");
    assert.equal(calls.length, 3);
    if (expected) assert.equal(result.error, expected);
  }
});

test("request passes a timeout signal and a User-Agent, follows redirects and reports the final url", async () => {
  const { fetchImpl, calls } = scripted([() => Object.defineProperty(ok(), "url", { value: "https://x/final" })]);
  const result = await request("https://x/start", { fetchImpl, sleepImpl: noSleep, headers: { Accept: "text/html" } });
  assert.equal(result.finalUrl, "https://x/final");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.redirect, "follow");
  assert.match(calls[0].init.headers["User-Agent"], /learnsync/);
  assert.equal(calls[0].init.headers.Accept, "text/html");
});

test("fetchJson throws with the url and the reason when the request does not succeed", async () => {
  const { fetchImpl } = scripted([status(500)]);
  await assert.rejects(fetchJson("https://x/y", { fetchImpl, sleepImpl: noSleep, attempts: 2 }), /Failed to fetch https:\/\/x\/y: HTTP 500/);
  const good = scripted([ok({ fine: true })]);
  assert.deepEqual(await fetchJson("https://x/y", { fetchImpl: good.fetchImpl }), { fine: true });
});

test("runPool keeps results in input order and never exceeds MAX_CONCURRENCY, whatever is asked", async () => {
  let running = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await runPool(
    items,
    async (item) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running--;
      return item * 2;
    },
    { concurrency: 50, delayMs: 0, sleepImpl: noSleep }
  );
  assert.deepEqual(results, items.map((i) => i * 2));
  assert.ok(peak <= MAX_CONCURRENCY && peak >= 2, `peak concurrency ${peak}`);
});

test("runPool pauses delayMs after every item a worker finishes (except the very last) and reports progress", async () => {
  const sleeps = [];
  const progress = [];
  await runPool([1, 2, 3, 4], async () => {}, {
    concurrency: 1,
    delayMs: 500,
    sleepImpl: async (ms) => sleeps.push(ms),
    onProgress: (done, total) => progress.push([done, total]),
    progressEvery: 2,
  });
  assert.deepEqual(sleeps, [500, 500, 500]);
  assert.deepEqual(progress, [[2, 4], [4, 4]]);
  assert.deepEqual(await runPool([], async () => 1, { sleepImpl: noSleep }), []);
});

test("runPool rejects when a worker throws", async () => {
  await assert.rejects(
    runPool([1, 2, 3], async (n) => {
      if (n === 2) throw new Error("boom");
    }, { delayMs: 0, sleepImpl: noSleep }),
    /boom/
  );
});
