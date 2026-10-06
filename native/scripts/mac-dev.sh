#!/usr/bin/env bash
# One-shot local Mac dev loop: quit whatever Shepherd.app is running, build the
# Debug app from this checkout and open it. The Mac counterpart of ios-dev.sh.
#
# The installed app and dev builds share run.shepherd.mac. Quit the old app
# before launching the new one. Its server and sessions continue running; the
# new app adopts the recorded local install and resumes supervision.
#
# Usage: native/scripts/mac-dev.sh [--build-only] [--keep-running] [--yes] [--force]
#   --build-only    build, but neither quit nor launch anything
#   --keep-running  build and launch without quitting the running app first
#   --yes, --force  accepted for compatibility; relaunch needs neither
set -euo pipefail

BUNDLE_ID=run.shepherd.mac
PORT="${SHEPHERD_PORT:-7330}"
QUIT=1
LAUNCH=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) QUIT=0; LAUNCH=0; shift ;;
    --keep-running) QUIT=0; shift ;;
    --yes) shift ;;
    --force) shift ;;
    -h|--help) awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$(cd "$SCRIPT_DIR/../Apps/ShepherdMac" && pwd)/.build/Build/Products/Debug/Shepherd.app"

running() { pgrep -f "Shepherd.app/Contents/MacOS/Shepherd" >/dev/null 2>&1; }
# lsof exits 1 when nothing listens; under pipefail that would end the script.
listener() { { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR > 1 { print $1 " (pid " $2 ")"; exit }'; }

# Build before quitting: a compile error must not cost the operator a running app.
echo "==> Building the Debug app…"
LOG="$(mktemp -t shepherd-mac-dev)"
if ! "$SCRIPT_DIR/build-app.sh" Debug >"$LOG" 2>&1; then
  grep -E "error:|BUILD FAILED" "$LOG" | sort -u | head -20 >&2 || true
  echo "Build failed — full log: $LOG" >&2
  exit 1
fi
rm -f "$LOG"
echo "    $APP"
[[ "$LAUNCH" == 1 ]] || exit 0

if [[ "$QUIT" == 1 ]] && running; then
  echo "==> Checking app relaunch…"
  python3 "$SCRIPT_DIR/mac-dev-preflight.py"
  echo "==> Quitting the running Shepherd (the local server keeps running)…"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 75); do running || break; sleep 0.2; done
  if running; then
    echo "Shepherd did not quit within 15 s (a dialog may be open). Quit it by hand and rerun." >&2
    exit 1
  fi
fi

holder="$(listener)"
if [[ -n "$holder" ]]; then
  echo "Note: port $PORT is still served by $holder — the dev app will adopt it if its ownership record and identity match." >&2
fi

echo "==> Launching the dev build…"
open "$APP"
