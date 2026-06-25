#!/usr/bin/env bash
# Restore Shepherd's SQLite DB from a backup snapshot (#1080).
#
#   deploy/shepherd-restore.sh              # list snapshots, then pick one
#   deploy/shepherd-restore.sh <snapshot>   # restore a specific shepherd-*.db.gz
#
# A backup you've never restored isn't a backup. This stops the service (and the backup timer, so a
# mid-restore firing can't open the DB), copies the current DB aside as a safety net, removes any
# hot rollback-journal/WAL sidecars (a crash-left journal would otherwise be REPLAYED into the
# freshly-restored file → re-corruption), gunzips the snapshot into place, verifies its integrity,
# and restarts.
set -euo pipefail

note() { printf '\033[36m▸ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
die() {
  printf '\033[31m✗ %s\033[0m\n' "$*" >&2
  exit 1
}

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

# Mirror the systemd units' EnvironmentFile=-%h/.shepherd/env so a SHEPHERD_DB / SHEPHERD_BACKUP_DIR
# override resolves to the SAME paths the server + backup script use — else we'd restore to the
# wrong DB / list the wrong backup dir (#1080).
set -a
[ -f "$HOME/.shepherd/env" ] && . "$HOME/.shepherd/env"
set +a

# Resolve DB + backup dir through the shared resolver so this never drifts from the backup script.
DB="$(bun -e 'import {resolveDbPath} from "./src/backup-paths"; process.stdout.write(resolveDbPath())')"
BACKUP_DIR="$(bun -e 'import {resolveBackupDir} from "./src/backup-paths"; process.stdout.write(resolveBackupDir())')"

SNAP="${1:-}"
if [[ -z "$SNAP" ]]; then
  note "available snapshots in $BACKUP_DIR (newest first):"
  mapfile -t SNAPS < <(ls -1 "$BACKUP_DIR"/shepherd-*.db.gz 2>/dev/null | sort -r)
  [[ ${#SNAPS[@]} -gt 0 ]] || die "no snapshots found in $BACKUP_DIR"
  for i in "${!SNAPS[@]}"; do printf '  [%d] %s\n' "$i" "$(basename "${SNAPS[$i]}")"; done
  read -r -p "restore which index? " IDX
  [[ "$IDX" =~ ^[0-9]+$ && -n "${SNAPS[$IDX]:-}" ]] || die "invalid selection"
  SNAP="${SNAPS[$IDX]}"
fi
[[ -f "$SNAP" ]] || die "snapshot not found: $SNAP"

warn "About to OVERWRITE $DB with $(basename "$SNAP")."
read -r -p "Type 'restore' to proceed: " CONFIRM
[[ "$CONFIRM" == "restore" ]] || die "aborted"

# Stop the server AND the backup timer so nothing holds/opens the DB mid-restore.
note "stopping shepherd + backup timer"
systemctl --user stop shepherd shepherd-backup.timer || warn "stop returned non-zero (already stopped?)"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f "$DB" ]]; then
  note "copying current DB aside → $DB.pre-restore-$TS"
  cp "$DB" "$DB.pre-restore-$TS"
fi

# A hot journal/WAL left by a crash would be rolled back INTO the restored file on next open.
note "removing stale rollback-journal / WAL sidecars"
rm -f "$DB-journal" "$DB-wal" "$DB-shm"

note "restoring snapshot"
gunzip -c "$SNAP" >"$DB"

note "verifying restored DB integrity"
INTEGRITY="$(bun -e "import {Database} from 'bun:sqlite'; const d=new Database(process.argv[1],{readonly:true}); const r=d.query('PRAGMA integrity_check').all(); process.stdout.write(JSON.stringify(r)); d.close();" "$DB")"
[[ "$INTEGRITY" == '[{"integrity_check":"ok"}]' ]] || die "integrity_check FAILED on restored DB: $INTEGRITY (your previous DB is at $DB.pre-restore-$TS)"

note "starting shepherd + backup timer"
systemctl --user start shepherd
systemctl --user enable --now shepherd-backup.timer

printf '\033[32m✓ restored %s → %s (integrity ok)\033[0m\n' "$(basename "$SNAP")" "$DB"
printf '  previous DB preserved at %s\n' "$DB.pre-restore-$TS"
