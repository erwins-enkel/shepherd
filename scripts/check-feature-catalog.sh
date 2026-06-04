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
# KNOWN HOLES (a heuristic, not a proof — review still matters):
#   • feat-label dependency: a user-facing feature mislabeled `fix:`/`chore:`/etc.
#     carries no `feat(...)` subject, so the gate never fires for it. Conventional-
#     commit discipline is the only thing closing this hole.
#   • UI_GLOBS scope: only ui/src/lib/components/** and ui/src/routes/** count as
#     "user-facing". A feat surfacing UX purely via other ui/src/lib/ code (api.ts,
#     stores, actions, etc.) without touching components/routes is NOT detected.
#   • opt-out is branch-global: ONE `[no-feature-entry]` anywhere in the range's
#     commit subjects/bodies disables the gate for the WHOLE PR range, not just the
#     commit that carries it. (Range-level, like the rest of the heuristic.)
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
  echo "  One opt-out token in the range disables this gate for the WHOLE PR range —"
  echo "  ALL feat commit(s) below are treated as non-surfacing (no catalog entry expected):"
  echo "$feat_commits" | sed 's/^/    • /' >&2
  echo "  If ANY of these actually ships user-facing UX, drop the token and add a catalog entry." >&2
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
