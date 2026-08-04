#!/usr/bin/env bash
# Vercel "Ignored Build Step" gate: build a project only when something it
# actually reads has changed since that project's last successful deploy.
#
# ── EXIT CODES ARE INVERTED ────────────────────────────────────────────────────
#   exit 0 => CANCEL the build   (nothing changed)
#   exit 1 => RUN the build
# That is Vercel's contract, not ours, and it is the opposite of every other
# script in scripts/. Flip it and every deploy stops silently — there is no
# failing build to notice. test/vercel-ignore-build.test.ts pins the polarity.
#
# ── FAIL OPEN ──────────────────────────────────────────────────────────────────
# A build wrongly SKIPPED ships stale content to production and is invisible.
# A build wrongly RUN costs a few minutes. So every uncertainty resolves to
# "build": no previous SHA, a previous SHA we cannot resolve, no path arguments,
# not a git repo, or any `git diff` status other than a clean 0/1 (`git diff
# --quiet` exits 128 on error, which is NOT the documented "1 continues").
#
# The commonest fail-open in practice: Vercel clones with `git clone --depth=10`,
# and $VERCEL_GIT_PREVIOUS_SHA is only an env var — Vercel never promised that
# commit is IN the clone (vercel/vercel#7251 shipped the variable, not a deeper
# clone). Once a project has skipped more than ~10 commits in a row the previous
# SHA falls out of history and we build. That is self-correcting: the build
# succeeds, the previous SHA becomes recent again, and the window reopens.
#
# ── USAGE ──────────────────────────────────────────────────────────────────────
# From a project's vercel.json (`ignoreCommand` runs in its Root Directory, so
# the paths are relative to that directory — hence the `../` ones):
#
#   "ignoreCommand": "bash ../scripts/vercel-ignore-build.sh ./ ../src ../docs"
#
# List EVERY input the build reads. A missing path means a stale deploy.
#
# $VERCEL_GIT_PREVIOUS_SHA is the last SUCCESSFUL deployment for this project and
# branch — cancelled builds do not advance it, which is what makes the comparison
# correct across a run of skipped commits. It is preferable to HEAD^, which is
# simply wrong whenever several commits land between deploys, and it is only
# exposed when an Ignored Build Step is configured.
#
# This header is the only documentation of the deploy gate: vercel.json is strict
# JSON and cannot carry comments.
#
# See issue #2027 for the measurements that motivated this.

# NOT `set -e`: we inspect git's exit status ourselves.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "vercel-ignore-build: no path arguments given — building (misconfigured ignoreCommand)." >&2
  exit 1
fi

previous="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$previous" ]; then
  echo "vercel-ignore-build: no previous deploy SHA — building." >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "vercel-ignore-build: not a git work tree — building." >&2
  exit 1
fi

if ! git cat-file -e "${previous}^{commit}" 2>/dev/null; then
  echo "vercel-ignore-build: previous deploy ${previous} is not in this clone (shallow clone?) — building." >&2
  exit 1
fi

git diff --quiet "$previous" HEAD -- "$@"
status=$?

case "$status" in
  0)
    echo "vercel-ignore-build: no change under [$*] since ${previous} — skipping the build."
    exit 0
    ;;
  1)
    echo "vercel-ignore-build: changes under [$*] since ${previous} — building."
    exit 1
    ;;
  *)
    echo "vercel-ignore-build: git diff failed (exit ${status}) — building." >&2
    exit 1
    ;;
esac
