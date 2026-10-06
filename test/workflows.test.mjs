/**
 * Guards the one workflow rule that keeps the two syncs from clobbering each other.
 *
 * Both syncs write data/changes/removed.json and moved.json (and data/status.json), and they share one
 * concurrency queue. A queued run starts later than the commit that triggered it, and actions/checkout
 * defaults to that trigger commit, so a run that waited behind the other sync would start from data that
 * predates the other sync's push and hit a rebase conflict in the shared files (this happened on the first
 * real run). Every workflow that commits data must therefore check out the branch tip.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows");
const committers = readdirSync(dir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({ f, text: readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n") }))
  .filter(({ text }) => /^\s*bash scripts\/commit-data\.sh/m.test(text)); // ci.yml only syntax-checks it

test("there are workflows that commit data (the guard is not vacuous)", () => {
  assert.ok(committers.length >= 2, `found ${committers.map((c) => c.f).join(", ")}`);
});

for (const { f, text } of committers) {
  test(`${f} checks out the branch tip, not the trigger commit`, () => {
    const checkout = /uses: actions\/checkout@\S+[^\n]*\n((?:[ ]{8,}[^\n]*\n)*)/.exec(text);
    assert.ok(checkout, "no actions/checkout step");
    assert.match(checkout[1], /^\s+ref: \$\{\{ github\.ref \}\}\s*$/m, "checkout must set ref: ${{ github.ref }}");
  });

  test(`${f} shares the learnsync-data concurrency queue and never cancels a running sync`, () => {
    assert.match(text, /concurrency:\n\s+group: learnsync-data\n\s+cancel-in-progress: false/);
  });
}
