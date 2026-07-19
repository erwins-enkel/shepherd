#!/usr/bin/env bash
# Build the UI and fail on Rollup's INEFFECTIVE_DYNAMIC_IMPORT.
#
# A STATIC import of a module that other modules import dynamically silently cancels
# their lazy-loading: Rollup hoists it into a shared chunk for every consumer. That is
# exactly what happened with marked/DOMPurify — one static import in the always-mounted
# GitRail defeated the dynamic imports in seven other components, and because Rollup
# only WARNS, the build stayed green the whole time.
#
# Why a script instead of inlining the check:
#   - `.github/workflows/ci.yml` and `scripts/pre-push.ts` must stay in sync (see the
#     job header at ci.yml:24-29). Both call this, so there is ONE implementation to
#     keep correct rather than two copies of the same shell.
#   - It is not library-specific: the `no-restricted-imports` rule in eslint.config.js
#     names marked/dompurify, while this fires for ANY module that regresses this way.
#
# Do NOT assume this gate alone is exhaustive: Rollup emits the warning only for SOME
# static importers. Measured on this repo:
#
#   ui/src/lib/components/GitRail.svelte  -> warns
#   ui/src/lib/recaps.svelte.ts           -> warns
#   ui/src/lib/api.ts  (plain .ts)        -> NO warning at all
#
# So the two gates are complementary, and neither is a superset of the other:
#
#   this script            — ANY library, but only where Rollup actually warns
#   no-restricted-imports  — ANY file under ui/src, but only the named libraries
#                            (marked, dompurify)
#
# The plain-`.ts` case above is covered by the lint rule, which is scoped to `ui/src/**/*`
# precisely because this script cannot see it. Residual hole, uncovered by design: a
# DIFFERENT library, statically imported from a plain `.ts` where Rollup stays silent —
# add it to the rule's `paths`/`patterns` if one ever matters. Review is what stands
# behind that case.
#
# Note this deliberately does NOT live in ui/vite.config.ts. Both in-build hooks were
# tried and neither works: `build.rollupOptions.onwarn` is overridden by SvelteKit's
# config merge, and an `onwarn` returned from a plugin `options` hook is ignored by
# Vite (the plugin's hooks run, but the handler is never consulted). In both cases the
# warning still printed and the build still exited 0 — a silently inert gate.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
log="$(mktemp -t shepherd-ui-build.XXXXXX.log)"
trap 'rm -f "$log"' EXIT

# pipefail (set above) makes a genuine build failure fail the script rather than being
# swallowed by the pipe into tee.
cd "$repo_root/ui" && bun run build 2>&1 | tee "$log"

# `grep -q` as the `if` condition, with the failure raised explicitly below — NOT
# `grep -c`, whose exit status is 1 when the count is 0 and would therefore report
# failure on the success case.
if grep -q INEFFECTIVE_DYNAMIC_IMPORT "$log"; then
  echo ""
  echo "✗ INEFFECTIVE_DYNAMIC_IMPORT in the ui build:"
  grep INEFFECTIVE_DYNAMIC_IMPORT "$log" || true
  echo ""
  echo "  A static import is defeating a dynamic one, forcing the module into a shared"
  echo "  chunk for every consumer. Import it dynamically instead — see SessionRecap.svelte:"
  echo "    Promise.all([import(\"marked\"), import(\"dompurify\")])"
  exit 1
fi
