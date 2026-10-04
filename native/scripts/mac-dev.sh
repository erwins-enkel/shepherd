#!/usr/bin/env bash
# One-shot local Mac dev loop: quit whatever Shepherd.app is running, build the
# Debug app from this checkout and open it. The Mac counterpart of ios-dev.sh.
#
# Quitting first is not optional: the installed app and every dev build share
# the bundle id run.shepherd.mac, and a still-running instance keeps supervising
# the local server on :7330. A dev build launched next to it would see that
# server as "externally managed" and never run its own start path (e.g. the Bun
# version check). A normal quit lets the app stop the server it supervises.
#
# Before quitting, mac-dev-preflight.py checks whether that server hosts live
# sessions (Shepherd is developed with Shepherd) and stops with a report:
#   exit 2  sessions would be interrupted (agents survive in herdr) -> --yes
#   exit 3  sessions would be lost (herdr would die too)             -> --force
#
# Usage: native/scripts/mac-dev.sh [--build-only] [--keep-running] [--yes] [--force]
#   --build-only    build, but neither quit nor launch anything
#   --keep-running  build and launch without quitting the running app first
#   --yes           accept interrupting live sessions
#   --force         accept losing live sessions (implies --yes)
set -euo pipefail

BUNDLE_ID=run.shepherd.mac
PORT="${SHEPHERD_PORT:-7330}"
QUIT=1
LAUNCH=1
YES=0
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) QUIT=0; LAUNCH=0; shift ;;
    --keep-running) QUIT=0; shift ;;
    --yes) YES=1; shift ;;
    --force) YES=1; FORCE=1; shift ;;
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

SERVER_STOPPED=0
if [[ "$QUIT" == 1 ]] && running; then
  echo "==> Checking what the restart would interrupt…"
  verdict=0
  python3 "$SCRIPT_DIR/mac-dev-preflight.py" || verdict=$?
  case "$verdict" in
    0) ;;
    2) [[ "$YES" == 1 ]] || { echo "Stopped before quitting; nothing was changed." >&2; exit 2; }
       SERVER_STOPPED=1 ;;
    3) [[ "$FORCE" == 1 ]] || { echo "Stopped before quitting; nothing was changed." >&2; exit 3; }
       SERVER_STOPPED=1 ;;
    *) echo "Preflight failed; not quitting the running app." >&2; exit 1 ;;
  esac
  echo "==> Quitting the running Shepherd (it stops the local server it supervises)…"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 75); do running || break; sleep 0.2; done
  if running; then
    echo "Shepherd did not quit within 15 s (a dialog may be open). Quit it by hand and rerun." >&2
    exit 1
  fi
fi

holder="$(listener)"
if [[ -n "$holder" ]]; then
  echo "Note: port $PORT is still served by $holder — the dev app will treat it as an externally managed server." >&2
fi

echo "==> Launching the dev build…"
open "$APP"
if [[ "$SERVER_STOPPED" == 1 ]]; then
  echo "The local server is stopped. Press Start in the dev app's \"Run on this Mac\" panel to re-attach the sessions."
fi
