#!/usr/bin/env bash
# Only authorized live entry point. Wrap this entire script once in the native lock.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ $# == 2 && "$1" == --config ]] || { echo 'UNMET: use --config with the operator-named live-smoke file' >&2; exit 1; }
umask 077
exec python3 "$SCRIPT_DIR/verify-ios-live-cleanup.py" --run --config "$2"
