# shellcheck shell=bash
#
# Sourced by build-app.sh and test-app.sh. Decides how this machine signs a local
# build and fills the array CODESIGN_ARGS with the xcodebuild overrides for it.
#
# Order of preference:
#   1. $SHEPHERD_CODESIGN_IDENTITY — an explicit override (a Developer ID, say).
#   2. "Shepherd Local Dev" — the stable self-signed identity created by
#      native/scripts/dev-signing-identity.sh. Signing every local build with it
#      keeps the login Keychain's "Always allow" grant valid across rebuilds.
#   3. Nothing — project.yml's CODE_SIGN_IDENTITY: "-" applies and the build is
#      ad-hoc signed. This is what CI gets, and it is unchanged.
#
# ENABLE_HARDENED_RUNTIME is deliberately left alone in every mode: the entitlement
# com.apple.security.cs.disable-library-validation in project.yml is what lets a
# hardened-runtime bundle load code signed by a different (here: self-signed,
# team-less) identity, so a dev-identity build needs no relaxation.

SHEPHERD_DEV_IDENTITY_NAME="Shepherd Local Dev"

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

  if security find-identity -v -p codesigning 2>/dev/null |
    grep -qF "\"$SHEPHERD_DEV_IDENTITY_NAME\""; then
    CODESIGN_ARGS=(
      "CODE_SIGN_IDENTITY=$SHEPHERD_DEV_IDENTITY_NAME"
      "CODE_SIGN_STYLE=Manual"
    )
    echo "Signing: \"$SHEPHERD_DEV_IDENTITY_NAME\" (stable local identity)"
    return 0
  fi

  echo "Signing: ad-hoc (project.yml default)."
  echo "         Each rebuild is a new signer, so macOS re-asks for Keychain access."
  echo "         Fix it once with: native/scripts/dev-signing-identity.sh"
}
