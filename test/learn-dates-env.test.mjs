import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dateOfTimestamp,
  daysBetween,
  isFullRefreshDue,
  isIsoDate,
  numberFromEnv,
  utcDate,
} from "../scripts/lib/learn-helpers.mjs";

test("utcDate / isIsoDate / daysBetween / dateOfTimestamp", () => {
  assert.equal(utcDate(new Date("2026-10-05T23:59:59Z")), "2026-10-05");
  assert.equal(isIsoDate("2026-10-05"), true);
  for (const bad of ["2026-02-30", "2026-13-01", "26-10-05", "2026-10-05T00:00:00Z", "", null, undefined, 20261005]) assert.equal(isIsoDate(bad), false, String(bad));
  assert.equal(daysBetween("2026-09-05", "2026-10-05"), 30);
  assert.equal(daysBetween("2026-10-05", "2026-10-04"), -1);
  assert.equal(dateOfTimestamp("2026-10-05T23:59:59.000Z"), "2026-10-05");
  assert.equal(dateOfTimestamp("nonsense"), null);
  assert.equal(dateOfTimestamp(undefined), null);
});

test("numberFromEnv: unset or empty -> fallback, valid -> number, invalid -> throws (a typo must not disable a failsafe)", () => {
  assert.equal(numberFromEnv({}, "X", 5), 5);
  assert.equal(numberFromEnv({ X: "" }, "X", 5), 5);
  assert.equal(numberFromEnv({ X: "  " }, "X", 5), 5);
  assert.equal(numberFromEnv({ X: "7.5" }, "X", 5), 7.5);
  assert.equal(numberFromEnv(undefined, "X", 5), 5);
  assert.throws(() => numberFromEnv({ X: "abc" }, "X", 5), /Invalid X/);
  assert.throws(() => numberFromEnv({ X: "-1" }, "X", 5, { min: 0 }), /Invalid X/);
  assert.throws(() => numberFromEnv({ X: "101" }, "X", 5, { min: 0, max: 100 }), /Invalid X/);
});

test("isFullRefreshDue: missing, malformed or older than the maximum age -> due", () => {
  assert.equal(isFullRefreshDue(undefined, "2026-10-05", 30), true);
  assert.equal(isFullRefreshDue(null, "2026-10-05", 30), true);
  assert.equal(isFullRefreshDue("garbage", "2026-10-05", 30), true);
  assert.equal(isFullRefreshDue("2026-09-05", "2026-10-05", 30), false, "exactly 30 days is not yet due");
  assert.equal(isFullRefreshDue("2026-09-04", "2026-10-05", 30), true);
  assert.equal(isFullRefreshDue("2026-10-05", "2026-10-05", 30), false);
});
