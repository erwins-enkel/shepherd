# shellcheck shell=bash
#
# Sourced by build-app.sh and test-app.sh. Decides how this machine signs a local
# build and fills the array CODESIGN_ARGS with the xcodebuild overrides for it.
#
# Order of preference:
#   1. $SHEPHERD_CODESIGN_IDENTITY — an explicit override (a Developer ID, say).
#   2. "Shepherd Local Dev" — the stable self-signed identity created by
#      native/scripts/dev-signing-identity.sh in its own unlocked keychain.
#      Signing every local build with it keeps the Keychain's "Always allow"
#      grant valid across rebuilds. It is passed to xcodebuild as the
#      certificate's SHA-1 rather than its name, because the certificate is
#      deliberately left untrusted — marking it trusted needs a modal dialog,
#      and codesign is perfectly happy with a hash.
#   3. A "Shepherd Local Dev" that `find-identity -v` reports anywhere else —
#      the pre-dedicated-keychain layout, kept working for an operator who has
#      not re-run dev-signing-identity.sh yet.
#   4. Nothing — project.yml's CODE_SIGN_IDENTITY: "-" applies and the build is
#      ad-hoc signed. This is what CI gets, and it is unchanged.
#
# ENABLE_HARDENED_RUNTIME is deliberately left alone in every mode: the entitlement
# com.apple.security.cs.disable-library-validation in project.yml is what lets a
# hardened-runtime bundle load code signed by a different (here: self-signed,
# team-less) identity, so a dev-identity build needs no relaxation.

SHEPHERD_DEV_IDENTITY_NAME="Shepherd Local Dev"
SHEPHERD_SIGNING_KEYCHAIN="$HOME/Library/Keychains/shepherd-dev-signing.keychain-db"
SHEPHERD_SIGNING_KEYCHAIN_PASS_FILE="$HOME/Library/Application Support/Shepherd/dev-signing.keychain-pass"

# Prints the SHA-1 of the dev identity in the dedicated keychain, or nothing.
shepherd_dev_identity_sha1() {
  [ -f "$SHEPHERD_SIGNING_KEYCHAIN" ] || return 0
  security find-identity -p codesigning "$SHEPHERD_SIGNING_KEYCHAIN" 2>/dev/null |
    grep -F "\"$SHEPHERD_DEV_IDENTITY_NAME\"" |
    head -n 1 |
    awk '{ print $2 }' || true
}

# Sets the global array CODESIGN_ARGS (possibly empty) and prints the mode.
# Expand it at the call site as "${CODESIGN_ARGS[@]+"${CODESIGN_ARGS[@]}"}" —
# bash 3.2, which is what /bin/bash on macOS still is, treats a bare "${a[@]}"
# on an empty array as an unbound variable under `set -u`.
shepherd_codesign_args() {
  CODESIGN_ARGS=()

  if [ -n "${SHEPHERD_CODESIGN_IDENTITY:-}" ]; then
    CODESIGN_ARGS=(
      "CODE_SIGN_IDENTITY=$SHEPHERD_CODESIGN_IDENTITY"
      "CODE_SIGN_STYLE=Manual"
    )
    echo "Signing: \"$SHEPHERD_CODESIGN_IDENTITY\" (from \$SHEPHERD_CODESIGN_IDENTITY)"
    return 0
  fi

  local sha1
  sha1="$(shepherd_dev_identity_sha1)"
  if [ -n "$sha1" ]; then
    # OTHER_CODE_SIGN_FLAGS points codesign at the keychain holding the key, so
    # it does not have to rely on the user search list being in the state we
    # left it in.
    CODESIGN_ARGS=(
      "CODE_SIGN_IDENTITY=$sha1"
      "CODE_SIGN_STYLE=Manual"
      "OTHER_CODE_SIGN_FLAGS=--keychain $SHEPHERD_SIGNING_KEYCHAIN"
    )
    echo "Signing: \"$SHEPHERD_DEV_IDENTITY_NAME\" ($sha1, dedicated keychain)"
    return 0
  fi

  if security find-identity -v -p codesigning 2>/dev/null |
    grep -qF "\"$SHEPHERD_DEV_IDENTITY_NAME\""; then
    CODESIGN_ARGS=(
      "CODE_SIGN_IDENTITY=$SHEPHERD_DEV_IDENTITY_NAME"
      "CODE_SIGN_STYLE=Manual"
    )
    echo "Signing: \"$SHEPHERD_DEV_IDENTITY_NAME\" (legacy location)"
    echo "         Re-run native/scripts/dev-signing-identity.sh to move it into"
    echo "         its own keychain — the login keychain is what prompts."
    return 0
  fi

  echo "Signing: ad-hoc (project.yml default)."
  echo "         Each rebuild is a new signer, so macOS re-asks for Keychain access."
  echo "         Fix it once with: native/scripts/dev-signing-identity.sh"
}

# Unlocks the dedicated signing keychain before xcodebuild runs, so codesign
# reaches an unlocked key with a populated partition list and never opens a
# dialog. A no-op when the keychain was never created (CI, a fresh clone) —
# those builds sign ad-hoc and need no key at all.
#
# The password is read straight from the 0600 file into `security`; it is never
# echoed, and stderr is kept so a genuine failure is still visible.
shepherd_unlock_signing_keychain() {
  [ -f "$SHEPHERD_SIGNING_KEYCHAIN_PASS_FILE" ] || return 0
  [ -f "$SHEPHERD_SIGNING_KEYCHAIN" ] || return 0

  if security unlock-keychain \
    -p "$(cat "$SHEPHERD_SIGNING_KEYCHAIN_PASS_FILE")" \
    "$SHEPHERD_SIGNING_KEYCHAIN"; then
    echo "Unlocked the signing keychain."
  else
    echo "warning: could not unlock $SHEPHERD_SIGNING_KEYCHAIN." >&2
    echo "         codesign may open a password dialog. Re-run:" >&2
    echo "         native/scripts/dev-signing-identity.sh" >&2
  fi
}
