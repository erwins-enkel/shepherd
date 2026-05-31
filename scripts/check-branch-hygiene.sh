#!/usr/bin/env bash
# Branch-hygiene gate: a feature branch must be a clean, linear rebase off main.
#
# The failure we keep hitting: a branch cut from a shared "dev-integration"
# branch (which had *merged* several other feature branches) drags all those
# unrelated commits + a huge diff into the PR. A clean branch off the latest
# main is linear — it has NO merge commits — so that's the signal we gate on.
#
# Base defaults to origin/main; CI can override via $BASE_REF for non-main bases.
set -euo pipefail

BASE="${BASE_REF:-origin/main}"

# Make sure we actually have the base ref to diff against (CI shallow clones).
git fetch --quiet origin main 2>/dev/null || true

merges="$(git rev-list --merges "${BASE}..HEAD" 2>/dev/null || true)"
if [ -n "$merges" ]; then
  echo "✗ branch hygiene: this branch contains merge commit(s) relative to ${BASE}:" >&2
  git log --oneline --merges "${BASE}..HEAD" >&2 || true
  cat >&2 <<'MSG'

  Feature branches must be cut from the latest main and kept linear:
    • branch from origin/main (not from another feature/dev-integration branch)
    • rebase onto main — never `git merge main` into your branch
    • one feature per branch, only this change's commits

  Re-create the branch off main with just this change, then force-push:
    git fetch origin
    git checkout -b <branch> origin/main
    git cherry-pick <your commits>   # or rebase --onto origin/main
MSG
  exit 1
fi

echo "✓ branch hygiene: linear off ${BASE} (no merge commits)"
