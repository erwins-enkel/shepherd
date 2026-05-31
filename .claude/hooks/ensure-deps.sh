#!/usr/bin/env bash
# SessionStart hook: install deps in fresh worktrees so agents never hit the
# "missing node_modules" tax. Installs only when node_modules is absent, so
# warm worktrees pay nothing. Root + ui/ are separate packages (own deps).
set -euo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
bun="$(command -v bun || true)"
[ -n "$bun" ] || { echo '{"suppressOutput": true}'; exit 0; }

installed=()
for dir in "$root" "$root/ui"; do
  if [ -f "$dir/package.json" ] && [ ! -d "$dir/node_modules" ]; then
    ( cd "$dir" && "$bun" install ) >/dev/null 2>&1 && installed+=("$dir")
  fi
done

if [ "${#installed[@]}" -gt 0 ]; then
  printf '{"systemMessage": "ensure-deps: ran bun install in %s"}\n' "${installed[*]}"
else
  echo '{"suppressOutput": true}'
fi
