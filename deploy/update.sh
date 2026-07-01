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
# node-pty ships spawn-helper without the exec bit + Bun keeps tarball perms, so on
# macOS posix_spawn fails ("posix_spawnp failed.") and panes stay black. Re-set it
# after install (a silent no-op on Linux, where the forkpty path uses no helper).
bun scripts/fix-node-pty-perms.mjs
(cd ui && bun install)

note "building UI"
(cd ui && bun run build)

# ── sync backup units (#1080) ─────────────────────────────────────────────────
# update.sh historically only restarts; provision.ts installs units only on a fresh box. So an
# existing live host would never pick up the hourly-backup timer. Re-sync it here, idempotently, so
# every `bun run update` self-heals: template the .service (WorkingDirectory → this checkout), copy
# the .timer verbatim, reload, enable --now, and (re)write the backup-expected marker. Soft-skip
# where there's no systemd user manager (macOS / core-only) — those hosts get no backups by design.
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  note "syncing backup timer units"
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed "s|^WorkingDirectory=.*|WorkingDirectory=${REPO}|" \
    "$REPO/deploy/shepherd-backup.service" >"$UNIT_DIR/shepherd-backup.service"
  cp "$REPO/deploy/shepherd-backup.timer" "$UNIT_DIR/shepherd-backup.timer"
  # Resolve the backup dir via the shared resolver so the marker can't drift from the script.
  # Source ~/.shepherd/env (the units' EnvironmentFile) in a SUBSHELL first, so a SHEPHERD_DB /
  # SHEPHERD_BACKUP_DIR override resolves to the SAME dir the server reads — else the marker lands
  # where the server never looks and staleness alerting is silently off (#1080). Subshell-scoped so
  # the override can't leak into the rest of this deploy script.
  BACKUP_DIR="$(set -a; [ -f "$HOME/.shepherd/env" ] && . "$HOME/.shepherd/env"; set +a; bun -e 'import {resolveBackupDir} from "./src/backup-paths"; process.stdout.write(resolveBackupDir())')"
  mkdir -p "$BACKUP_DIR"
  [[ -f "$BACKUP_DIR/.backup-configured" ]] || printf 'shepherd-backup.timer enabled\n' >"$BACKUP_DIR/.backup-configured"
  systemctl --user daemon-reload
  systemctl --user enable --now shepherd-backup.timer
  # Kick one backup now (the timer's first scheduled run is at the next hour boundary), so a freshly
  # adopted host has a .last-success well before the daily-sweep staleness probe runs (#1080).
  systemctl --user start shepherd-backup.service || warn "initial backup run did not start"

  # ── sync log-rotation units (#1212) ──────────────────────────────────────────
  # Mirrors the backup-timer self-heal so an existing host picks up the log-rotation timer.
  # Self-contained: the timer runs deploy/rotate-shepherd-log.sh (a copytruncate size-cap), so
  # there's NO external `logrotate` binary to be missing — this is unconditional now (it used to be
  # gated on logrotate being present, which left shepherd.log unbounded on hosts that lacked it).
  # Copy the rotator to ~/.shepherd (the unit execs %h/.shepherd/...); copy units verbatim (systemd
  # expands their %h); reload + enable --now the hourly timer.
  note "syncing log-rotation timer units"
  mkdir -p "$HOME/.shepherd"
  cp "$REPO/deploy/rotate-shepherd-log.sh" "$HOME/.shepherd/rotate-shepherd-log.sh"
  cp "$REPO/deploy/shepherd-logrotate.service" "$UNIT_DIR/shepherd-logrotate.service"
  cp "$REPO/deploy/shepherd-logrotate.timer" "$UNIT_DIR/shepherd-logrotate.timer"
  systemctl --user daemon-reload
  systemctl --user enable --now shepherd-logrotate.timer
else
  warn "no systemd user manager — skipping backup timer sync (no automated backups on this host)"
fi

# ── restart ───────────────────────────────────────────────────────────────────
note "restarting $UNIT"
systemctl --user restart "$UNIT"

# ── health check ───────────────────────────────────────────────────────────────
# Hit the PUBLIC liveness route, not /api/sessions: single-operator auth (#1079/#1081) gates
# the whole /api/* surface, so an un-credentialed deploy probe of a gated route now 401s
# (never 200). /api/health is auth-exempt and proves the restarted server serves HTTP. #1112
note "health check"
for i in $(seq 1 10); do
  code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  if [[ "$code" == "200" ]]; then
    printf '\033[32m✓ shepherd healthy on :%s (HTTP 200)\033[0m\n' "$PORT"
    exit 0
  fi
  sleep 1
done
die "service did not return 200 within 10s — check: journalctl --user -u $UNIT -n 50"
