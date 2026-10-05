import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/commit-data.sh", import.meta.url)).replace(/\\/g, "/");
const bash = process.env.BASH || "bash";

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), "commit-data-"));
  const remote = join(base, "remote.git");
  git(base, "init", "--bare", "--initial-branch=main", remote);
  const seed = join(base, "seed");
  mkdirSync(seed);
  git(seed, "init", "--initial-branch=main");
  git(seed, "config", "user.email", "t@example.com");
  git(seed, "config", "user.name", "t");
  mkdirSync(join(seed, "data"));
  writeFileSync(join(seed, "data", "a.json"), "{}\n");
  writeFileSync(join(seed, "data", "b.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "origin", "main");
  const clone = (name) => {
    const dir = join(base, name);
    git(base, "clone", remote, dir);
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    return dir;
  };
  return { base, remote, clone };
}

const run = (cwd, ...args) => spawnSync(bash, [script, ...args], { cwd, encoding: "utf-8", env: { ...process.env, PUSH_BACKOFF_SECONDS: "0" } });

test("commit-data.sh commits and pushes changed data files", () => {
  const { clone, remote } = setup();
  const a = clone("a");
  writeFileSync(join(a, "data", "a.json"), '{"n":1}\n');
  const r = run(a, "Update data", "data/a.json");
  assert.equal(r.status, 0, r.stderr);
  assert.match(git(remote, "log", "--format=%s", "-1", "main"), /Update data/);
});

test("commit-data.sh is a no-op when nothing changed", () => {
  const { clone, remote } = setup();
  const a = clone("a");
  const before = git(remote, "rev-parse", "main");
  const r = run(a, "Update data", "data/a.json");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /No data changes/);
  assert.equal(git(remote, "rev-parse", "main"), before);
});

test("commit-data.sh rebases and retries when the remote moved", () => {
  const { clone, remote } = setup();
  const a = clone("a");
  const b = clone("b");
  // someone else pushes a different file first
  writeFileSync(join(b, "data", "b.json"), '{"other":true}\n');
  git(b, "commit", "-am", "other push");
  git(b, "push", "origin", "main");
  // our push is now non-fast-forward; the script must rebase and retry
  writeFileSync(join(a, "data", "a.json"), '{"n":2}\n');
  const r = run(a, "Update data", "data/a.json");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Push rejected/);
  const log = git(remote, "log", "--format=%s", "main");
  assert.match(log, /Update data/);
  assert.match(log, /other push/);
  git(a, "pull", "origin", "main");
  // autocrlf on Windows checks files out with CRLF; the content is what matters
  assert.equal(readFileSync(join(a, "data", "b.json"), "utf-8").replace(/\r\n/g, "\n"), '{"other":true}\n');
});

test("commit-data.sh gives up after the configured attempts", () => {
  const { clone, base } = setup();
  const a = clone("a");
  writeFileSync(join(a, "data", "a.json"), '{"n":3}\n');
  git(a, "remote", "set-url", "origin", join(base, "does-not-exist.git"));
  const r = spawnSync(bash, [script, "Update data", "data/a.json"], {
    cwd: a,
    encoding: "utf-8",
    env: { ...process.env, PUSH_ATTEMPTS: "2", PUSH_BACKOFF_SECONDS: "0" },
  });
  assert.notEqual(r.status, 0);
});

test("commit-data.sh requires a message and a path", () => {
  const r = spawnSync(bash, [script], { encoding: "utf-8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
