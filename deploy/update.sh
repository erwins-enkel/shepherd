#!/usr/bin/env bash
# Deploy local code to the running Shepherd service.
# Idempotent: install deps → build UI → restart unit → health check.
#   deploy/update.sh                     # deploy the current working tree
#   deploy/update.sh --pull              # fast-forward main from origin first (dev==prod box: skip)
#   deploy/update.sh --pull --discard    # discard the CONFIRMED tracked changes first, then pull
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

UNIT="shepherd"
PORT="${SHEPHERD_PORT:-7330}"
PULL=0
DISCARD=0
# Parse ALL args (order-independent), not just $1 — so `--pull --discard` and
# `--discard --pull` both take effect.
for arg in "$@"; do
  case "$arg" in
    --pull) PULL=1 ;;
    --discard) DISCARD=1 ;;
  esac
done

note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

# retry <attempts> <cmd...>: run <cmd> until it succeeds, up to <attempts> times, with a
# 3s backoff between tries. Bun's dependency fetch/extract can hit a transient registry/
# mirror flake — observed as `error: Fail extracting tarball for "node-pty"` (#1602) — that
# succeeds on a re-run, so we wrap the `bun install` steps below. Fail-closed: a deterministic
# failure re-fails every attempt and the final non-zero exit propagates under `set -e`.
retry() {
  local attempts="$1"
  shift
  local i
  for ((i = 1; i <= attempts; i++)); do
    "$@" && return 0
    [ "$i" -lt "$attempts" ] && {
      warn "\`$*\` failed (attempt $i/$attempts) — retrying in 3s"
      sleep 3
    }
  done
  return 1
}

# sha256 of stdin as bare hex (Linux: sha256sum; macOS: shasum -a 256)
sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    shasum -a 256 | cut -d' ' -f1
  fi
}
# Framed content signature of the tracked dirty state: three per-command subhashes
# (status + staged diff + unstaged diff), then hash their concatenated hex. Diff
# config fully neutralised so it depends only on real content. Must match the
# Node side in src/update.ts byte-for-byte.
discard_sig() {
  local s1 s2 s3
  s1="$(git status --porcelain -z --untracked-files=no | sha256_hex)"
  s2="$(git diff --cached --binary --no-color --no-ext-diff --no-textconv | sha256_hex)"
  s3="$(git diff --binary --no-color --no-ext-diff --no-textconv | sha256_hex)"
  printf '%s%s%s' "$s1" "$s2" "$s3" | sha256_hex
}

# ── guard: the working tree IS the deployment ────────────────────────────────
branch="$(git rev-parse --abbrev-ref HEAD)"
[[ "$branch" == "main" ]] || warn "on branch '$branch' (not main) — the service will run THIS code"
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "working tree has uncommitted changes — they will go live"
fi

if [[ "$PULL" == "1" ]]; then
  [[ "$branch" == "main" ]] || die "--pull requires being on main (currently '$branch')"

  # ── scoped discard of the CONFIRMED tracked changes ─────────────────────────
  # Never a blanket `git reset --hard` (which would also wipe anything written to
  # the tree between confirmation and now). Instead restore ONLY the confirmed
  # NUL pathspecs, re-verified against the confirmed signature at the last instant.
  if [[ "$DISCARD" == "1" ]]; then
    [[ -n "${SHEPHERD_DISCARD_SIG:-}" && -n "${SHEPHERD_DISCARD_DIR:-}" \
      && -n "${SHEPHERD_DISCARD_PATHSPEC_ALL:-}" && -n "${SHEPHERD_DISCARD_PATHSPEC_WT:-}" ]] \
      || die "--discard requires the confirmation tokens"
    # remove the private pathspec dir on ANY exit path (guarded against rm -rf "")
    trap '[ -n "${SHEPHERD_DISCARD_DIR:-}" ] && rm -rf "$SHEPHERD_DISCARD_DIR"' EXIT
    [[ "$(discard_sig)" == "$SHEPHERD_DISCARD_SIG" ]] \
      || die "SHEPHERD_DISCARD_STALE: working tree changed since confirmation"
    note "discarding confirmed local changes"
    # --literal-pathspecs: a confirmed filename may itself contain pathspec magic
    # (e.g. *.ts or :(glob)…); treat every listed path literally so the restore
    # can't fan out to unconfirmed matching files.
    git --literal-pathspecs restore --source=HEAD --staged \
      --pathspec-from-file="$SHEPHERD_DISCARD_PATHSPEC_ALL" --pathspec-file-nul
    if [[ -s "$SHEPHERD_DISCARD_PATHSPEC_WT" ]]; then
      git --literal-pathspecs restore --source=HEAD --worktree \
        --pathspec-from-file="$SHEPHERD_DISCARD_PATHSPEC_WT" --pathspec-file-nul
    fi
  fi

  # final gate: if an UNconfirmed tracked change slipped in (not in the pathspec),
  # abort here rather than pulling over a dirty tree — routes back to reconfirm.
  git diff --quiet && git diff --cached --quiet || die "--pull needs a clean tree"
  note "fast-forwarding main from origin"
  git pull --ff-only
fi

# ── build ────────────────────────────────────────────────────────────────────
note "installing deps (root + ui)"
# Retry only the network-bound install (transient node-pty tarball-extract flake, #1602);
# fix-perms + build below are local + deterministic.
retry 2 bun install
# node-pty ships spawn-helper without the exec bit + Bun keeps tarball perms, so on
# macOS posix_spawn fails ("posix_spawnp failed.") and panes stay black. Re-set it
# after install (a silent no-op on Linux, where the forkpty path uses no helper).
bun scripts/fix-node-pty-perms.mjs
(cd ui && retry 2 bun install)

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

  # ── sync the core shepherd.service unit ──────────────────────────────────────
  # Same self-heal rationale as the timers + herdr unit: provision.ts installs shepherd.service
  # only on a FRESH box, so an already-provisioned host never picks up later changes to the unit
  # — most consequentially the `After=herdr.service` ordering. Without it, at boot Shepherd can
  # start BEFORE the sibling herdr daemon, and the diagnostics probe (4s after Shepherd boot,
  # src/index.ts) races herdr's startup and latches a false `herdr: offline`.
  #
  # TEMPLATED like the backup service above (templateUnit in provision.ts): rewrite only the
  # WorkingDirectory line to THIS checkout so a custom SHEPHERD_DIR install runs against the right
  # dir. Write only when the rendered unit differs (`cmp -s`, which also treats a missing installed
  # unit as changed) so a byte-identical unit skips even a redundant daemon-reload. No restart in
  # this block: the `systemctl --user restart shepherd` below applies the reloaded unit, and the
  # `After=` ordering only takes effect at the next boot anyway.
  SHEP_UNIT_TMP="$(mktemp)"
  sed "s|^WorkingDirectory=.*|WorkingDirectory=${REPO}|" \
    "$REPO/deploy/shepherd.service" >"$SHEP_UNIT_TMP"
  if ! cmp -s "$SHEP_UNIT_TMP" "$UNIT_DIR/shepherd.service"; then
    note "syncing shepherd.service unit"
    mv "$SHEP_UNIT_TMP" "$UNIT_DIR/shepherd.service"
    systemctl --user daemon-reload
  else
    rm -f "$SHEP_UNIT_TMP"
  fi

  # ── sync the herdr daemon unit (#1574) ───────────────────────────────────────
  # Same self-heal rationale as the timers above: provision.ts installs herdr.service only on a
  # FRESH box, so without this every already-provisioned host would keep running an unsupervised
  # daemon (or none at all) forever. herdr 0.7.3 does NOT auto-spawn its server, and Shepherd
  # cannot start a single agent without it.
  #
  # ExecStart is TEMPLATED to the resolved herdr, not copied: an installer puts herdr in
  # ~/.local/bin, a package in /usr/local/bin, and the unit must exec the same binary the
  # diagnostics probe resolves on PATH.
  #
  # Before `enable --now`: hand the socket over. A daemon the unit does NOT own (an in-app Fix's
  # detached child, or a hand-rolled `herdr server`) makes ExecStart exit 1 ("already running"),
  # and Restart=always would thrash. `herdr server stop` is graceful — panes outlive the server
  # and reattach — and update.sh restarts Shepherd immediately below anyway.
  #
  # Resolution mirrors config.herdrBin (`HERDR_BIN ?? "herdr"`): source the unit's own env file,
  # then look up ${HERDR_BIN:-herdr}. Done in a SUBSHELL — like the BACKUP_DIR resolution above —
  # so neither the ~/.local/bin PATH prepend nor anything in ~/.shepherd/env leaks into the
  # `systemctl restart` + health check further down this script.
  HERDR_PATH="$(
    set -a
    [ -f "$HOME/.shepherd/env" ] && . "$HOME/.shepherd/env"
    set +a
    PATH="$HOME/.local/bin:$PATH" command -v "${HERDR_BIN:-herdr}" || true
  )"
  if [[ -n "$HERDR_PATH" ]]; then
    note "syncing herdr daemon unit"
    HERDR_UNIT_TMP="$(mktemp)"
    sed "s|^ExecStart=.*|ExecStart=${HERDR_PATH} server|" \
      "$REPO/deploy/herdr.service" >"$HERDR_UNIT_TMP"
    # Only reload+bounce when the unit ACTUALLY changed. `try-restart` kills the daemon that
    # backs every live agent session, so doing it on every `bun run update` would bounce the
    # session backend for a byte-identical unit. `cmp` also treats a missing installed unit as
    # "changed", which is the first-sync case.
    if ! cmp -s "$HERDR_UNIT_TMP" "$UNIT_DIR/herdr.service"; then
      mv "$HERDR_UNIT_TMP" "$UNIT_DIR/herdr.service"
      systemctl --user daemon-reload
      # `enable --now` does NOT restart an already-active unit, so a sync that CHANGED ExecStart
      # (herdr moved, or HERDR_BIN changed) would leave the running daemon on the stale path
      # forever. try-restart restarts iff active; no-op otherwise.
      systemctl --user try-restart herdr >/dev/null 2>&1 || true
    else
      rm -f "$HERDR_UNIT_TMP"
    fi
    if ! systemctl --user is-active --quiet herdr; then
      # Stop the unsupervised daemon in its OWN `set -a` subshell: the env file must reach the
      # `server stop` CHILD (HERDR_SOCKET_PATH / HERDR_SESSION select which socket it addresses),
      # or on a non-default-session host we stop nothing and leave the real orphan bound — after
      # which `enable --now` below thrashes the unit forever behind a green check. Subshell keeps
      # the no-leak property: nothing sourced here reaches the restart/health-check below.
      (
        set -a
        [ -f "$HOME/.shepherd/env" ] && . "$HOME/.shepherd/env"
        set +a
        "$HERDR_PATH" server stop >/dev/null 2>&1
      ) || true
      systemctl --user reset-failed herdr >/dev/null 2>&1 || true
    fi
    systemctl --user enable --now herdr || warn "herdr.service did not start — DIAGNOSE will report herdr offline"
  else
    warn "herdr not found (HERDR_BIN / PATH) — skipping herdr.service sync"
  fi
else
  warn "no systemd user manager — skipping backup timer sync (no automated backups on this host)"
fi

# ── restart ───────────────────────────────────────────────────────────────────
# macOS / core-only has no systemd user manager: there is no unit to restart, and a
# bare `systemctl --user restart` would abort under `set -e` (killing the deploy
# after the build already succeeded). Gate it on the same probe the backup block
# uses; where there's no systemd, tell the operator to (re)start manually and exit
# clean — the build + node-pty helper fix above have already been applied.
if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  note "restarting $UNIT"
  systemctl --user restart "$UNIT"
else
  warn "no systemd user manager — not restarting; (re)start Shepherd manually: cd \"$REPO\" && bun run start"
  exit 0
fi

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
