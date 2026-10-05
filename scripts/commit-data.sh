#!/usr/bin/env bash
# Commit refreshed data files and push them, retrying when the remote moved.
#
# Usage: scripts/commit-data.sh "<commit message>" <path>...
#
# The sync workflows share one concurrency group so they never run at the same
# time, but a person (or a bot) can still push to the default branch while a
# sync is running. A rejected push is rebased onto the remote and retried
# instead of throwing away a whole week of work.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <commit message> <path>..." >&2
  exit 2
fi

message="$1"
shift

git add -- "$@"
if git diff --cached --quiet; then
  echo "No data changes to commit."
  exit 0
fi

git commit -m "$message"
branch="$(git rev-parse --abbrev-ref HEAD)"
max_attempts="${PUSH_ATTEMPTS:-5}"

for attempt in $(seq 1 "$max_attempts"); do
  if git push origin "HEAD:${branch}"; then
    echo "Pushed on attempt ${attempt}."
    exit 0
  fi
  echo "Push rejected (attempt ${attempt}/${max_attempts}); rebasing onto origin/${branch}." >&2
  git pull --rebase --autostash origin "${branch}"
  sleep "$((attempt * ${PUSH_BACKOFF_SECONDS:-3}))"
done

echo "Could not push after ${max_attempts} attempts." >&2
exit 1
