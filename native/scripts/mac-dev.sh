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
# Usage: native/scripts/mac-dev.sh [--build-only] [--keep-running]
#   --build-only    build, but neither quit nor launch anything
#   --keep-running  build and launch without quitting the running app first
set -euo pipefail

BUNDLE_ID=run.shepherd.mac
PORT="${SHEPHERD_PORT:-7330}"
QUIT=1
LAUNCH=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build-only) QUIT=0; LAUNCH=0; shift ;;
    --keep-running) QUIT=0; shift ;;
    -h|--help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
