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

# Which of the four modes above `shepherd_codesign_args` chose. Only "dedicated"
# needs a key of ours unlocked before xcodebuild runs.
SHEPHERD_CODESIGN_MODE="adhoc"

# The password is never read here; `shepherd_security_with_pass` keeps it out of
# argv and out of any xtrace log.
# shellcheck source=native/scripts/keychain-secret.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/keychain-secret.sh"

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
  SHEPHERD_CODESIGN_MODE="adhoc"

  if [ -n "${SHEPHERD_CODESIGN_IDENTITY:-}" ]; then
    CODESIGN_ARGS=(
      "CODE_SIGN_IDENTITY=$SHEPHERD_CODESIGN_IDENTITY"
      "CODE_SIGN_STYLE=Manual"
    )
    SHEPHERD_CODESIGN_MODE="override"
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
    SHEPHERD_CODESIGN_MODE="dedicated"
    echo "Signing: \"$SHEPHERD_DEV_IDENTITY_NAME\" ($sha1, dedicated keychain)"
    return 0
  fi

  if security find-identity -v -p codesigning 2>/dev/null |
    grep -qF "\"$SHEPHERD_DEV_IDENTITY_NAME\""; then
    CODESIGN_ARGS=(
      "CODE_SIGN_IDENTITY=$SHEPHERD_DEV_IDENTITY_NAME"
      "CODE_SIGN_STYLE=Manual"
    )
    SHEPHERD_CODESIGN_MODE="legacy"
    echo "Signing: \"$SHEPHERD_DEV_IDENTITY_NAME\" (legacy location)"
    echo "         Re-run native/scripts/dev-signing-identity.sh to move it into"
    echo "         its own keychain — the login keychain is what prompts."
    return 0
  fi

  echo "Signing: ad-hoc (project.yml default)."
  echo "         Each rebuild is a new signer, so macOS re-asks for Keychain access."
  echo "         Fix it once with: native/scripts/dev-signing-identity.sh"
}

# Prints why the build is stopping, and the two ways out. $1 is the reason, any
# further argument an extra detail line. Every line goes to stderr; none of them
# carries a secret.
shepherd_signing_failure() {
  echo "error: signing with \"$SHEPHERD_DEV_IDENTITY_NAME\" was selected, but its" >&2
  echo "       keychain cannot be unlocked: $1" >&2
  shift
  local detail
  for detail in "$@"; do echo "       $detail" >&2; done
  echo "       codesign would stop the build with a password dialog, and an" >&2
  echo "       unattended run would simply hang there." >&2
  echo >&2
  echo "       Recreate the identity:" >&2
  echo "         native/scripts/dev-signing-identity.sh --remove" >&2
  echo "         native/scripts/dev-signing-identity.sh" >&2
  echo "       or sign this one build ad-hoc:" >&2
  echo "         SHEPHERD_CODESIGN_IDENTITY=\"-\" <the command you just ran>" >&2
}

# Unlocks the dedicated signing keychain before xcodebuild runs, so codesign
# reaches an unlocked key with a populated partition list and never opens a
# dialog.
#
# A no-op in every other mode: an explicit $SHEPHERD_CODESIGN_IDENTITY, the
# legacy login-keychain layout and plain ad-hoc (CI, a fresh clone) all sign
# without a key of ours, so there is nothing here to unlock.
#
# In the dedicated mode it is fatal. Returning 0 on a missing password file or a
# refused unlock — which is what this used to do — let xcodebuild start anyway
# and reach the very dialog the dedicated keychain exists to prevent, turning a
# one-line diagnosis into a hung build. Fail before the build instead.
shepherd_unlock_signing_keychain() {
  [ "${SHEPHERD_CODESIGN_MODE:-adhoc}" = "dedicated" ] || return 0

  if [ ! -f "$SHEPHERD_SIGNING_KEYCHAIN_PASS_FILE" ]; then
    shepherd_signing_failure "the password file is missing." \
      "(expected at $SHEPHERD_SIGNING_KEYCHAIN_PASS_FILE)"
    return 1
  fi

  if shepherd_security_with_pass "$SHEPHERD_SIGNING_KEYCHAIN_PASS_FILE" \
    unlock-keychain -p %PASS% "$SHEPHERD_SIGNING_KEYCHAIN"; then
    echo "Unlocked the signing keychain."
    return 0
  fi

  shepherd_signing_failure "security unlock-keychain refused the stored password."
  return 1
}
