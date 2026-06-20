#!/usr/bin/env bash
# Regenerate-on-merge gate for the docs site (epic #875 / #881).
#
# A PR that changes the GENERATOR SOURCE of a COMMITTED generated doc artifact
# must regenerate that artifact's output in the same range — otherwise the
# committed output silently rots against its generator. This mirrors the
# feature-catalog gate (scripts/check-feature-catalog.sh): a presence heuristic,
# not a proof, with a loud documented opt-out for source edits that genuinely do
# not change output.
#
# SCOPE — only COMMITTED generated outputs are gated. docs-site has three
# generators; only one writes a committed artifact:
#   • TypeDoc API reference (starlight-typedoc)          → src/content/docs/api/        [git-ignored]
#   • Imported docs/* + CLAUDE.md (scripts/sync-docs.mjs)→ …/reference/{…,house-rules}.md [git-ignored]
#   • llms.txt (starlight-llms-txt)                      → dist/llms*.txt               [git-ignored]
#   • herdr CLI reference (scripts/gen-cli-reference.ts) → …/reference/cli/*.md         [COMMITTED] ← gated
# The first three regenerate on EVERY `astro build`, so they cannot be committed-
# stale — the docs-site CI build step (`bun run check && bun run build`) keeps them
# fresh. Only the CLI reference is committed (herdr is absent from CI/Vercel, so its
# pages cannot be built there), so only it needs this gate.
#
# KNOWN HOLES (a heuristic, not a proof — review still matters):
#   • PRESENCE, not freshness: this asserts the output was *regenerated* (its files
#     changed) when the generator source changed; it does NOT verify the committed
#     bytes match live `herdr --help`. CI has no `herdr` (not in the self-hosted
#     runner image), so byte-level verification cannot run here. In practice the CLI
#     pages are PINNED — gen-cli-reference.ts hard-pins EXPECTED_HERDR_VERSION and
#     fails unless the installed herdr matches — so any version/allowlist/format
#     change is a source edit this gate catches; adopting a newer herdr is a
#     deliberate pin bump (also a source edit). The only uncaught case is a
#     committed page hand-edited to not match the pinned herdr.
#   • opt-out is branch-global: ONE [skip-docs-regen] token anywhere in the range's
#     commit subjects/bodies disables the gate for the WHOLE range (like the
#     feature-catalog gate). Use it only for a source edit that truly leaves output
#     byte-identical (a comment tweak, or a pin bump whose regen diff is empty).
#
# Base defaults to origin/main; CI can override via $BASE_REF for non-main bases.
set -euo pipefail

BASE="${BASE_REF:-origin/main}"
OPT_OUT="[skip-docs-regen]"

# Committed generated artifacts to gate. One row per artifact:
#   "<label>|<source path/prefix>|<output dir prefix>|<regen command>"
# A row fails if its SOURCE changed in the range but its OUTPUT did not.
GENERATED=(
  "herdr CLI reference|docs-site/scripts/gen-cli-reference.ts|docs-site/src/content/docs/reference/cli/|cd docs-site && bun run gen:cli"
)

# Make sure we actually have the base ref to diff against (CI shallow clones).
git fetch --quiet origin main 2>/dev/null || true

# Fail CLOSED if the base can't be resolved — otherwise the empty diff below would
# wave the whole PR through on a silent vacuous pass, defeating the gate (same
# reasoning as scripts/check-feature-catalog.sh).
if ! git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null 2>&1; then
  echo "✗ generated docs: base ref '${BASE}' could not be resolved — refusing a vacuous pass." >&2
  echo "  Fetch it first (e.g. \`git fetch origin main\`), or set \$BASE_REF to a local base." >&2
  exit 1
fi

# `base...HEAD` = changes vs the merge-base, so unrelated main churn never counts.
changed="$(git diff --name-only "${BASE}...HEAD" 2>/dev/null || true)"

# True if any changed path starts with the given prefix (exact file or dir prefix).
touched() {
  local prefix="$1" f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in "$prefix"*) return 0 ;; esac
  done <<EOF
$changed
EOF
  return 1
}

# Loud escape hatch: a token anywhere in the range skips the gate but says so.
optout="$(git log --format='%s%n%b' "${BASE}..HEAD" 2>/dev/null | grep -F "$OPT_OUT" || true)"
if [ -n "$optout" ]; then
  echo "⚠ generated docs: SKIPPED via ${OPT_OUT} opt-out token."
  echo "  One opt-out token in the range disables this gate for the WHOLE range. Use it only"
  echo "  when a generator source edit leaves its committed output byte-identical." >&2
  exit 0
fi

stale=0
checked=0
for row in "${GENERATED[@]}"; do
  IFS='|' read -r label source output regen <<<"$row"
  if ! touched "$source"; then
    continue
  fi
  checked=$((checked + 1))
  if touched "$output"; then
    echo "✓ generated docs: ${label} — source changed and output regenerated (${output})"
  else
    stale=1
    cat >&2 <<MSG
✗ generated docs: ${label} — its generator source changed but its committed output
  was NOT regenerated.

    source: ${source}
    output: ${output}  (unchanged)

  Regenerate it and commit the result:
    ${regen}

  If this source edit genuinely leaves the output byte-identical (e.g. a comment
  tweak), opt out by putting ${OPT_OUT} in a commit subject or the PR body.
MSG
  fi
done

if [ "$stale" -ne 0 ]; then
  exit 1
fi
if [ "$checked" -eq 0 ]; then
  echo "✓ generated docs: no committed generator source changed relative to ${BASE} — nothing to check"
fi
exit 0
