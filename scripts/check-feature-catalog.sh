#!/usr/bin/env bash
# Feature-catalog gate: a feat PR that ships user-facing UI must register itself
# in the What's-New / coachmark catalog (ui/src/lib/feature-announcements.ts).
#
# The failure mode (see issue #299): a `feat` PR adds a user-facing capability,
# builds clean, passes CI, deploys — and silently never adds its catalog entry,
# so the What's-New drawer + first-view coachmarks rot and stop reflecting reality.
# This is the same silent-incompleteness the i18n `check:i18n` gate prevents.
#
# A perfect "did this ship a user-facing feature?" check is undecidable, so this
# is a pragmatic heuristic: a `feat(...)` commit + a diff touching user-facing UI
# ⇒ the catalog must have been touched in the same range. Genuinely non-surfacing
# feats (server-only, internal plumbing, mislabeled refactors) opt out LOUDLY via
# a documented token — never a silent bypass.
#
# Base defaults to origin/main; CI can override via $BASE_REF for non-main bases.
# See CLAUDE.md → "Feature discovery (REQUIRED for user-facing features)".
set -euo pipefail

BASE="${BASE_REF:-origin/main}"
CATALOG="ui/src/lib/feature-announcements.ts"
OPT_OUT="[no-feature-entry]"
# User-facing UI surfaces — a feat touching these is presumed to ship UX.
UI_GLOBS=("ui/src/lib/components/" "ui/src/routes/")

# Make sure we actually have the base ref to diff against (CI shallow clones).
git fetch --quiet origin main 2>/dev/null || true

# `base..HEAD` = commits introduced by this branch; `base...HEAD` (diff) =
# changes vs the merge-base, so unrelated main churn never counts.
feat_commits="$(git log --format='%s' "${BASE}..HEAD" 2>/dev/null | grep -E '^feat(\(.*\))?!?:' || true)"
if [ -z "$feat_commits" ]; then
  echo "✓ feature catalog: no feat(...) commits relative to ${BASE} — nothing to check"
  exit 0
fi

# Loud escape hatch: any commit subject/body in range carrying the opt-out token
# skips the check — but says exactly what it skipped and why (no silent bypass).
optout="$(git log --format='%s%n%b' "${BASE}..HEAD" 2>/dev/null | grep -F "$OPT_OUT" || true)"
if [ -n "$optout" ]; then
  echo "⚠ feature catalog: SKIPPED via ${OPT_OUT} opt-out token."
  echo "  These feat commit(s) were treated as non-surfacing (no catalog entry expected):"
  echo "$feat_commits" | sed 's/^/    • /' >&2
  echo "  If any of these actually ships user-facing UX, add a catalog entry instead." >&2
  exit 0
fi

# Did the diff touch a user-facing UI surface?
changed="$(git diff --name-only "${BASE}...HEAD" 2>/dev/null || true)"
ui_touched=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  for g in "${UI_GLOBS[@]}"; do
    case "$f" in "$g"*) ui_touched="yes"; break 2;; esac
  done
done <<EOF
$changed
EOF

if [ -z "$ui_touched" ]; then
  echo "✓ feature catalog: feat commit(s) present but no user-facing UI changed (${UI_GLOBS[*]}) — nothing to register"
  exit 0
fi

# UI changed under a feat — the catalog must have been touched too.
if printf '%s\n' "$changed" | grep -qxF "$CATALOG"; then
  echo "✓ feature catalog: feat + user-facing UI change registered in ${CATALOG}"
  exit 0
fi

cat >&2 <<MSG
✗ feature catalog: a feat(...) commit touches user-facing UI but does NOT modify
  ${CATALOG}.

  feat commit(s) in range:
$(echo "$feat_commits" | sed 's/^/    • /')

  Every shipped user-facing feature adds ONE entry to the catalog in the SAME PR
  (id, sinceVersion, titleKey/bodyKey in EN+DE, optional targetId). It drives the
  What's-New drawer + first-view coachmarks. See CLAUDE.md → "Feature discovery".

  Fix: add your entry to ${CATALOG}
  Or, if this feat ships no user-facing UX (server-only / internal / mislabeled),
  opt out by putting ${OPT_OUT} in a commit subject or the PR body.
MSG
exit 1
