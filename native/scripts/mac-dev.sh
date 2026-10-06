#!/usr/bin/env bash
# One-shot local Mac dev loop: quit whatever Shepherd.app is running, build the
# Debug app from this checkout and open it. The Mac counterpart of ios-dev.sh.
#
# The installed app and dev builds share run.shepherd.mac. Quit the old app
# before launching the new one. A detaching build keeps its server running; the
# new app adopts the recorded local install and resumes supervision.
#
# Usage: native/scripts/mac-dev.sh [--build-only] [--keep-running] [--yes] [--force]
#   --build-only    build, but neither quit nor launch anything
#   --keep-running  build and launch without quitting the running app first
#   --yes           accept interrupting sessions in an older app
#   --force         accept losing sessions in an older app (implies --yes)
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

# A rebuild must preserve the Keychain's trusted application identity.
# shellcheck source=native/scripts/codesign-mode.sh
. "$SCRIPT_DIR/codesign-mode.sh"
shepherd_codesign_args
if [[ "$SHEPHERD_CODESIGN_MODE" == adhoc || "${SHEPHERD_CODESIGN_IDENTITY:-}" == - ]]; then
  echo 'error: mac-dev.sh requires a stable signing identity.' >&2
  echo 'Run native/scripts/dev-signing-identity.sh once, then retry.' >&2
  exit 1
fi

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
# Package resource bundles may change without Xcode re-sealing the outer app.
# Sign the outer bundle last with the same identity and existing runtime/entitlements.
SIGNING_ARGS=(--force --sign "${CODESIGN_ARGS[0]#CODE_SIGN_IDENTITY=}"   --preserve-metadata=identifier,entitlements,flags,runtime)
if [[ "$SHEPHERD_CODESIGN_MODE" == dedicated ]]; then
  SIGNING_ARGS+=(--keychain "$SHEPHERD_SIGNING_KEYCHAIN")
fi
codesign "${SIGNING_ARGS[@]}" "$APP"
# Verify before quitting: an unusable build must not cost a running app.
codesign --verify --deep --strict "$APP"
REQUIREMENT="$(codesign -d -r- "$APP" 2>&1)"
echo "$REQUIREMENT"
if echo "$REQUIREMENT" | grep -q 'designated =>.*cdhash'; then
  echo 'error: the built app has an unstable ad-hoc signing requirement.' >&2
  exit 1
fi
echo "    $APP"
[[ "$LAUNCH" == 1 ]] || exit 0

if [[ "$QUIT" == 1 ]] && running; then
  echo "==> Checking app relaunch…"
  verdict=0
  python3 "$SCRIPT_DIR/mac-dev-preflight.py" || verdict=$?
  case "$verdict" in
    0) ;;
    2) [[ "$YES" == 1 ]] || { echo "Stopped before quitting; nothing was changed." >&2; exit 2; } ;;
    3) [[ "$FORCE" == 1 ]] || { echo "Stopped before quitting; nothing was changed." >&2; exit 3; } ;;
    *) echo "Preflight failed; not quitting the running app." >&2; exit 1 ;;
  esac
  echo "==> Quitting the running Shepherd…"
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
open -n "$APP"
