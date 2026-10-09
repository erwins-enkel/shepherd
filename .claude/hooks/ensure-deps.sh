#!/usr/bin/env bash
# SessionStart hook: install deps in fresh worktrees so agents never hit the
# "missing node_modules" tax. Installs only when node_modules is absent, so
# warm worktrees pay nothing. Root + ui/ + extension/ are separate packages (own deps).
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
bun="$(command -v bun || true)"
[ -n "$bun" ] || { echo '{"suppressOutput": true}'; exit 0; }

installed=()
for dir in "$root" "$root/ui" "$root/extension"; do
  if [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
    ( cd "$dir" && "$bun" install ) >/dev/null 2>&1 && installed+=("$dir")
  fi
done

msgs=()
[ "${#installed[@]}" -gt 0 ] && msgs+=("ensure-deps: ran bun install in ${installed[*]}")
# Warn (never block) on a Bun below engines.bun (#2916); pre-push enforces it. First
# line only, quotes and backslashes stripped, so it is safe inside the JSON string.
check="$root/scripts/check-bun-version.ts"
if [ -f "$check" ] && ! bun_msg="$("$bun" "$check" 2>&1)"; then
  bun_msg="${bun_msg%%$'\n'*}"
  bun_msg="${bun_msg//[\"\\]/}"
  msgs+=("ensure-deps: ${bun_msg#✗ }")
fi

if [ "${#msgs[@]}" -gt 0 ]; then
  printf '{"systemMessage": "%s"}\n' "${msgs[*]}"
else
  echo '{"suppressOutput": true}'
fi
