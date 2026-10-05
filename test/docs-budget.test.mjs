import { test } from "node:test";
import assert from "node:assert/strict";
import { CircuitBreaker, createDeadline, runPool } from "../scripts/lib/docs-budget.mjs";

const noSleep = async () => {};

test("CircuitBreaker trips after N consecutive transient results and stays tripped", () => {
  const b = new CircuitBreaker(3);
  b.record(true);
  b.record(true);
  assert.equal(b.tripped, false);
  b.record(false); // any success resets the streak
  b.record(true);
  b.record(true);
  assert.equal(b.tripped, false);
  b.record(true);
  assert.equal(b.tripped, true);
  b.record(false);
  assert.equal(b.tripped, true, "once tripped it stays tripped for its phase");
});

test("CircuitBreaker with limit 0 never trips", () => {
  const b = new CircuitBreaker(0);
  for (let i = 0; i < 1000; i++) b.record(true);
  assert.equal(b.tripped, false);
});

test("createDeadline: expiry follows the clock, 0 minutes means unlimited", () => {
  let t = 1000;
  const d = createDeadline(2, () => t);
  assert.equal(d.expired(), false);
  t += 119_999;
  assert.equal(d.expired(), false);
  t += 1;
  assert.equal(d.expired(), true);
  assert.equal(d.elapsedSeconds(), 120);
  t = 10 ** 15;
  assert.equal(createDeadline(0, () => t).expired(), false);
});

test("runPool never runs more than `concurrency` workers at once and fills every slot", async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 20 }, (_, i) => i);
  const { results, processed, stoppedBy } = await runPool(
    items,
    async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return n * 2;
    },
    { concurrency: 3, delayMs: 0, sleep: noSleep }
  );
  assert.equal(peak, 3);
  assert.equal(processed, 20);
  assert.equal(stoppedBy, null);
  assert.deepEqual(results, items.map((n) => n * 2), "results stay aligned with the items");
});

test("runPool sleeps `delayMs` after every item in every worker", async () => {
  const sleeps = [];
  await runPool([1, 2, 3, 4], async () => "ok", { concurrency: 2, delayMs: 500, sleep: async (ms) => void sleeps.push(ms) });
  assert.deepEqual(sleeps, [500, 500, 500, 500]);
});

test("runPool stops taking items when the deadline passes; unstarted slots stay undefined", async () => {
  let started = 0;
  const { results, processed, stoppedBy } = await runPool(
    Array.from({ length: 10 }, (_, i) => i),
    async (n) => {
      started++;
      return n;
    },
    { concurrency: 1, delayMs: 0, sleep: noSleep, shouldStop: () => started >= 4 }
  );
  assert.equal(processed, 4);
  assert.equal(stoppedBy, "deadline");
  assert.deepEqual(results.slice(0, 4), [0, 1, 2, 3]);
  for (let i = 4; i < 10; i++) assert.equal(results[i], undefined, `slot ${i} was never run`);
});

test("runPool circuit breaker: a rate-limit storm stops the phase after the limit", async () => {
  let calls = 0;
  const breaker = new CircuitBreaker(5);
  const { results, processed, stoppedBy } = await runPool(
    Array.from({ length: 100 }, (_, i) => i),
    async (n) => {
      calls++;
      return { outcome: n < 2 ? "live" : "transient" };
    },
    { concurrency: 1, delayMs: 0, sleep: noSleep, breaker, isTransient: (r) => r.outcome === "transient" }
  );
  assert.equal(stoppedBy, "breaker");
  assert.equal(breaker.tripped, true);
  assert.equal(processed, 7, "2 live + 5 consecutive transient");
  assert.equal(calls, 7, "no request is made after the breaker tripped");
  assert.equal(results[7], undefined);
});

test("runPool with several workers lets in-flight items finish after a trip, and starts no new ones", async () => {
  const breaker = new CircuitBreaker(3);
  let started = 0;
  const { processed, stoppedBy } = await runPool(
    Array.from({ length: 50 }, (_, i) => i),
    async () => {
      started++;
      await new Promise((r) => setTimeout(r, 1));
      return { outcome: "transient" };
    },
    { concurrency: 3, delayMs: 0, sleep: noSleep, breaker, isTransient: () => true }
  );
  assert.equal(stoppedBy, "breaker");
  assert.ok(processed >= 3 && processed <= 6, `processed ${processed}`);
  assert.equal(started, processed);
});

test("runPool on an empty list is a no-op", async () => {
  const out = await runPool([], async () => 1, { concurrency: 3, sleep: noSleep });
  assert.deepEqual(out, { results: [], processed: 0, stoppedBy: null });
});
