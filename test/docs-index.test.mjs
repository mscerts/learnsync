import { test } from "node:test";
import assert from "node:assert/strict";
import { maxLastmod, parseIndex, serializeIndex } from "../scripts/lib/docs-index.mjs";

test("serializeIndex: one line per page, sorted by code point, LF, trailing newline", () => {
  const index = new Map([
    ["/azure/b", "2026-10-02"],
    ["/azure/a-b", null],
    ["/azure/a/b", "2026-10-01T10:00:00+00:00"],
    ["/azure/a.b", "2026-09-30"],
    ["/azure/a", "2026-10-03"],
  ]);
  // code-point order: "-" (0x2d) < "." (0x2e) < "/" (0x2f); a prefix sorts before its extensions
  assert.equal(
    serializeIndex(index),
    "/azure/a\t2026-10-03\n/azure/a-b\t-\n/azure/a.b\t2026-09-30\n/azure/a/b\t2026-10-01T10:00:00+00:00\n/azure/b\t2026-10-02\n"
  );
});

test("serializeIndex is independent of insertion order and of the locale", () => {
  const a = serializeIndex(new Map([["/z", "1"], ["/a", "2"], ["/m", null]]));
  const b = serializeIndex(new Map([["/m", null], ["/a", "2"], ["/z", "1"]]));
  assert.equal(a, b);
  assert.equal(serializeIndex(new Map()), "");
});

test("serializeIndex refuses paths that would corrupt the file", () => {
  assert.throws(() => serializeIndex(new Map([["azure/no-slash", null]])), /invalid index path/);
  assert.throws(() => serializeIndex(new Map([["/azure/tab\there", null]])), /invalid index path/);
  assert.throws(() => serializeIndex(new Map([["/azure/new\nline", null]])), /invalid index path/);
  // a lastmod can never break the line structure either
  const text = serializeIndex(new Map([["/a", "2026\t-\n10"]]));
  assert.equal(text.split("\n").length, 2);
});

test("parseIndex round-trips serializeIndex", () => {
  const index = new Map([["/azure/a", "2026-10-01"], ["/azure/b", null], ["/cli/azure/vm", "2026-08-07T00:00:00Z"]]);
  assert.deepEqual(parseIndex(serializeIndex(index)), index);
  assert.equal(parseIndex("").size, 0);
  assert.equal(parseIndex(undefined).size, 0);
  assert.equal(parseIndex("/a\t2026-01-01\r\n/b\t-\r\n").get("/b"), null); // CRLF tolerated
});

test("parseIndex is strict: a malformed file throws instead of shrinking the baseline", () => {
  assert.throws(() => parseIndex("azure/no-slash\t-\n"), /not a canonical path/);
  assert.throws(() => parseIndex("/Azure/Upper\t-\n"), /not a canonical path/);
  assert.throws(() => parseIndex("/a\t-\n/a\t2026-01-01\n"), /repeats \/a/);
  assert.equal(parseIndex("/a\n").get("/a"), null); // a bare path is tolerated as "no lastmod"
});

test("maxLastmod picks the latest day and ignores junk", () => {
  assert.equal(maxLastmod(["2026-10-01T05:00:00Z", "2026-10-03", null, "", "garbage", "2026-09-30"]), "2026-10-03");
  assert.equal(maxLastmod([null, undefined]), null);
  assert.equal(maxLastmod([]), null);
});
