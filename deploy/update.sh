#!/usr/bin/env bash
# Deploy local code to the running Shepherd service.
# Idempotent: install deps → build UI → restart unit → health check.
#   deploy/update.sh           # deploy the current working tree
#   deploy/update.sh --pull    # fast-forward main from origin first (dev==prod box: skip)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

UNIT="shepherd"
PORT="${SHEPHERD_PORT:-7330}"
PULL=0
[[ "${1:-}" == "--pull" ]] && PULL=1

note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# ── guard: the working tree IS the deployment ────────────────────────────────
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || warn "on branch '$branch' (not main) — the service will run THIS code"
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "working tree has uncommitted changes — they will go live"
fi

if [[ "$PULL" == "1" ]]; then
  [[ "$branch" == "main" ]] || die "--pull requires being on main (currently '$branch')"
  git diff --quiet && git diff --cached --quiet || die "--pull needs a clean tree"
  note "fast-forwarding main from origin"
  git pull --ff-only
fi

# ── build ────────────────────────────────────────────────────────────────────
note "installing deps (root + ui)"
bun install
(cd ui && bun install)

note "building UI"
(cd ui && bun run build)

# ── restart ───────────────────────────────────────────────────────────────────
note "restarting $UNIT"
systemctl --user restart "$UNIT"

# ── health check ───────────────────────────────────────────────────────────────
note "health check"
for i in $(seq 1 10); do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/api/sessions" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    printf '\033[32m✓ shepherd healthy on :%s (HTTP 200)\033[0m\n' "$PORT"
    exit 0
  fi
  sleep 1
done
die "service did not return 200 within 10s — check: journalctl --user -u $UNIT -n 50"
