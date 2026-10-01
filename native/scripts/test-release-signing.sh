#!/usr/bin/env bash
# Argument/env guards and notarization control flow; never sign or contact Apple.
set -euo pipefail
SCRIPTS="$(cd "$(dirname "$0")" && pwd)"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT
unset GITHUB_STEP_SUMMARY
export RUNNER_TEMP="$FIXTURE"
export CALLS="$FIXTURE/calls"
mkdir -p "$FIXTURE/bin" "$FIXTURE/Shepherd.app/Contents"
touch "$FIXTURE/Shepherd.app/Contents/Info.plist" "$FIXTURE/release.keychain-db" "$FIXTURE/Shepherd.dmg"
# Every signing/security/Apple entry point is intercepted, including accidental calls.
for tool in security codesign xcrun ditto; do
  cat > "$FIXTURE/bin/$tool" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$(basename "$0") $*" >> "$CALLS"
case "$(basename "$0") $1 ${2:-}" in
  'xcrun notarytool submit')
    if [[ "${NOTARY_STATUS:-Accepted}" == malformed ]]; then echo invalid; exit 1; fi
    printf '{"id":"test-submission","status":"%s"}\n' "${NOTARY_STATUS:-Accepted}"
    ;;
  'xcrun notarytool log') echo '{"issues":["mock rejection diagnostic"]}' ;;
  'xcrun stapler staple') exit "${STAPLE_EXIT:-0}" ;;
  'xcrun stapler validate'|'ditto -c -k') ;;
  *) exit 99 ;;
esac
MOCK
  chmod +x "$FIXTURE/bin/$tool"
done
export PATH="$FIXTURE/bin:$PATH"
reject() {
  local expected="$1"
  shift
  : > "$CALLS"
  if "$@" > "$FIXTURE/output" 2>&1; then
    echo "FAIL: expected rejection: $expected" >&2; exit 1
  fi
  grep -qF "$expected" "$FIXTURE/output"
  [[ ! -s "$CALLS" ]] || { echo 'FAIL: validation invoked an external signing tool' >&2; exit 1; }
}
reject 'Usage:' "$SCRIPTS/sign-release.sh"
reject 'Expected an app bundle' "$SCRIPTS/sign-release.sh" missing identity missing
reject 'Expected a Developer ID' "$SCRIPTS/sign-release.sh" "$FIXTURE/Shepherd.app" - missing
reject 'Expected an existing temporary keychain' "$SCRIPTS/sign-release.sh" "$FIXTURE/Shepherd.app" 'Developer ID Application: Test' missing
unset GITHUB_ACTIONS APPLE_TEAM_ID ASC_API_KEY_PATH ASC_KEY_ID ASC_ISSUER_ID
reject 'requires GitHub Actions' "$SCRIPTS/sign-release.sh" "$FIXTURE/Shepherd.app" 'Developer ID Application: Test' "$FIXTURE/release.keychain-db"
export GITHUB_ACTIONS=true
reject 'Set APPLE_TEAM_ID' "$SCRIPTS/sign-release.sh" "$FIXTURE/Shepherd.app" 'Developer ID Application: Test' "$FIXTURE/release.keychain-db"
reject 'Usage:' "$SCRIPTS/notarize.sh"
reject 'Expected an existing app bundle or DMG' "$SCRIPTS/notarize.sh" missing.zip
reject 'Set ASC_API_KEY_PATH' "$SCRIPTS/notarize.sh" "$FIXTURE/Shepherd.dmg"
export ASC_API_KEY_PATH="$FIXTURE/key.p8"
reject 'Set ASC_KEY_ID' "$SCRIPTS/notarize.sh" "$FIXTURE/Shepherd.dmg"
export ASC_KEY_ID=test
reject 'Set ASC_ISSUER_ID' "$SCRIPTS/notarize.sh" "$FIXTURE/Shepherd.dmg"
export ASC_ISSUER_ID=test
reject 'Expected an API key file' "$SCRIPTS/notarize.sh" "$FIXTURE/Shepherd.dmg"
printf 'test key' > "$ASC_API_KEY_PATH"
chmod 644 "$ASC_API_KEY_PATH"
reject 'API key file must have mode 600' "$SCRIPTS/notarize.sh" "$FIXTURE/Shepherd.dmg"
chmod 600 "$ASC_API_KEY_PATH"
for target in "$FIXTURE/Shepherd.app" "$FIXTURE/Shepherd.dmg"; do
  : > "$CALLS"
  "$SCRIPTS/notarize.sh" "$target" > "$FIXTURE/output"
  grep -q 'status Accepted' "$FIXTURE/output"
  grep -q 'stapler staple' "$CALLS"
  grep -q 'stapler validate' "$CALLS"
  if [[ "$target" == *.app ]]; then grep -q 'ditto -c -k' "$CALLS"; fi
done
for status in Invalid 'In Progress' malformed; do
  : > "$CALLS"
  if NOTARY_STATUS="$status" "$SCRIPTS/notarize.sh" "$FIXTURE/Shepherd.dmg" > "$FIXTURE/output" 2>&1; then
    echo 'FAIL: non-Accepted notarization passed' >&2; exit 1
  fi
  ! grep -q stapler "$CALLS"
  if [[ "$status" != malformed ]]; then
    grep -q 'notarytool log test-submission' "$CALLS"
    grep -q 'mock rejection diagnostic' "$FIXTURE/output"
  fi
done
: > "$CALLS"
if STAPLE_EXIT=1 "$SCRIPTS/notarize.sh" "$FIXTURE/Shepherd.dmg" > "$FIXTURE/output" 2>&1; then
  echo 'FAIL: stapling failure passed' >&2; exit 1
fi
! grep -q 'stapler validate' "$CALLS"
# Explicit CI overrides must bypass every local keychain discovery/unlock path.
: > "$CALLS"
export SHEPHERD_CODESIGN_IDENTITY='Developer ID Application: Test'
# shellcheck source=native/scripts/codesign-mode.sh
. "$SCRIPTS/codesign-mode.sh"
shepherd_codesign_args > "$FIXTURE/output"
shepherd_unlock_signing_keychain
[[ "$SHEPHERD_CODESIGN_MODE" == override && "${CODESIGN_ARGS[1]}" == CODE_SIGN_STYLE=Manual ]]
[[ ! -s "$CALLS" ]]
echo 'PASS: release validation, override isolation, notarization acceptance/rejection and stapling failures'
