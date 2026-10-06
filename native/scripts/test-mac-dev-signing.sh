#!/usr/bin/env bash
# Exercise the dev launch boundary without building, signing or touching Keychain.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
export CALLS="$FIXTURE/calls"
mkdir -p "$FIXTURE/native/scripts" "$FIXTURE/native/Apps/ShepherdMac" "$FIXTURE/bin"
cp "$SCRIPTS/mac-dev.sh" "$SCRIPTS/codesign-mode.sh" "$SCRIPTS/keychain-secret.sh" "$FIXTURE/native/scripts/"
cat > "$FIXTURE/native/scripts/build-app.sh" <<'MOCK'
#!/usr/bin/env bash
echo build >> "$CALLS"
MOCK
chmod +x "$FIXTURE/native/scripts/build-app.sh"
for tool in security codesign open pgrep; do
  cat > "$FIXTURE/bin/$tool" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$(basename "$0") $*" >> "$CALLS"
case "$(basename "$0")" in
  security) exit 0 ;;
  pgrep) exit 1 ;;
  codesign)
    if [[ "$1" == --force ]]; then exit "${SIGN_EXIT:-0}"; fi
    if [[ "$1" == --verify ]]; then
      if [[ "${STALE_RESOURCE:-0}" == 1 ]] && ! grep -q '^codesign --force ' "$CALLS"; then exit 1; fi
      exit "${VERIFY_EXIT:-0}"
    fi
    if [[ "${ARTIFACT_ADHOC:-0}" == 1 ]]; then
      echo 'designated => cdhash H"fixture"' >&2
    else
      echo 'designated => identifier "run.shepherd.mac" and certificate root = H"fixture"' >&2
    fi
    ;;
  open) ;;
esac
MOCK
  chmod +x "$FIXTURE/bin/$tool"
done
export PATH="$FIXTURE/bin:$PATH"
run="$FIXTURE/native/scripts/mac-dev.sh"
reject() {
  : > "$CALLS"
  if "$run" > "$FIXTURE/output" 2>&1; then echo 'FAIL: expected rejection' >&2; exit 1; fi
  ! grep -qE '^(pgrep|open) ' "$CALLS"
}
unset SHEPHERD_CODESIGN_IDENTITY
reject
! grep -q '^build$' "$CALLS"
SHEPHERD_CODESIGN_IDENTITY=- reject
! grep -q '^build$' "$CALLS"
export SHEPHERD_CODESIGN_IDENTITY='Stable Test Identity'
SIGN_EXIT=1 reject
VERIFY_EXIT=1 reject
ARTIFACT_ADHOC=1 reject
grep -q '^build$' "$CALLS"
: > "$CALLS"
STALE_RESOURCE=1 "$run" --build-only > "$FIXTURE/output" 2>&1
grep -qF 'codesign --force --sign Stable Test Identity' "$CALLS"
grep -qF -- '--preserve-metadata=identifier,entitlements,flags,runtime' "$CALLS"
grep -q '^codesign --verify --deep --strict ' "$CALLS"
! grep -qE '^(pgrep|open) ' "$CALLS"
: > "$CALLS"
"$run" > "$FIXTURE/output" 2>&1
grep -qF "open -n $FIXTURE/native/Apps/ShepherdMac/.build/Build/Products/Debug/Shepherd.app" "$CALLS"
grep -q 'designated =>' "$FIXTURE/output"
echo 'PASS: stable dev signing, verification and exact bundle launch'
