#!/usr/bin/env bash
# Creates a stable, self-signed code-signing identity named "Shepherd Local Dev"
# in the login keychain, so a local build's Keychain access grant survives the
# next rebuild.
#
# Why: the app signs ad-hoc (CODE_SIGN_IDENTITY: "-" in project.yml). An ad-hoc
# signature carries no identity, so every rebuild is a different signer as far as
# the Keychain is concerned. The "Always allow" the operator granted the previous
# build no longer matches, macOS asks again, and an unattended run stalls — the
# app gives up on its credential probe after 8 s and falls back to the login
# sheet. One long-lived self-signed identity gives that ACL something stable to
# point at.
#
# Usage:
#   native/scripts/dev-signing-identity.sh           create it if absent (idempotent)
#   native/scripts/dev-signing-identity.sh --check   exit 0 if usable, 1 if not
#   native/scripts/dev-signing-identity.sh --remove  delete the key, cert and trust
#
# CI never runs this. With no such identity in the keychain, build-app.sh and
# test-app.sh keep signing ad-hoc exactly as before.
set -euo pipefail

IDENTITY_NAME="Shepherd Local Dev"
VALID_DAYS=3650

# Track temp directories for cleanup on any exit (including set -e abort)
TMPDIRS=()

cleanup() {
  for d in "${TMPDIRS[@]+"${TMPDIRS[@]}"}"; do
    rm -rf "$d"
  done
}

trap cleanup EXIT

login_keychain() {
  # `security login-keychain` prints the path quoted and indented.
  security login-keychain | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//'
}

# The `find-identity -v` line for our identity, or empty. `-v` means "valid":
# a cert that is missing its private key, expired, or not trusted for code
# signing is deliberately NOT matched here, because codesign could not use it.
identity_line() {
  # `|| true`: `set -o pipefail` would otherwise turn "no match" — the normal
  # answer before the identity exists — into a fatal error for the caller.
  security find-identity -v -p codesigning 2>/dev/null |
    grep -F "\"${IDENTITY_NAME}\"" |
    head -n 1 || true
}

identity_sha1() {
  identity_line | awk '{ print $2 }' || true
}

cert_exists() {
  security find-certificate -c "$IDENTITY_NAME" "$(login_keychain)" >/dev/null 2>&1
}

usage() {
  sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

cmd_check() {
  local sha1
  sha1="$(identity_sha1)"
  if [ -n "$sha1" ]; then
    echo "present: \"$IDENTITY_NAME\" ($sha1)"
    return 0
  fi
  if cert_exists; then
    echo "incomplete: a certificate named \"$IDENTITY_NAME\" exists but is not a"
    echo "valid code-signing identity (no private key, expired, or not trusted)."
    echo "Run: native/scripts/dev-signing-identity.sh --remove, then re-create it."
    return 1
  fi
  echo "absent: no code-signing identity named \"$IDENTITY_NAME\""
  return 1
}

cmd_remove() {
  local keychain tmp
  keychain="$(login_keychain)"
  if ! cert_exists; then
    echo "Nothing to remove: no certificate named \"$IDENTITY_NAME\"."
    return 0
  fi

  tmp="$(mktemp -d)"
  TMPDIRS+=("$tmp")

  # Drop the per-user trust setting first — it survives the certificate and
  # would otherwise linger as an orphan entry in Keychain Access.
  if security find-certificate -c "$IDENTITY_NAME" -p "$keychain" >"$tmp/cert.pem" 2>/dev/null; then
    security remove-trusted-cert "$tmp/cert.pem" 2>/dev/null ||
      echo "note: no trust setting to remove (or it needed a password you declined)."
  fi

  # delete-identity removes the certificate AND its private key.
  security delete-identity -c "$IDENTITY_NAME" "$keychain" >/dev/null
  echo "Removed \"$IDENTITY_NAME\" from $keychain."
  echo "Local builds fall back to ad-hoc signing; the app will ask for Keychain"
  echo "access again on the next build."
}

cmd_create() {
  local keychain tmp sha1
  keychain="$(login_keychain)"

  sha1="$(identity_sha1)"
  if [ -n "$sha1" ]; then
    echo "Already present — nothing to do."
    echo "identity: \"$IDENTITY_NAME\""
    echo "SHA-1:    $sha1"
    return 0
  fi

  if cert_exists; then
    echo "A certificate named \"$IDENTITY_NAME\" exists but is not usable for code" >&2
    echo "signing. Remove it first:" >&2
    echo "  native/scripts/dev-signing-identity.sh --remove" >&2
    return 1
  fi

  command -v openssl >/dev/null 2>&1 || {
    echo "openssl not found in PATH." >&2
    return 1
  }

  tmp="$(mktemp -d)"
  TMPDIRS+=("$tmp")
  chmod 700 "$tmp"

  cat >"$tmp/openssl.cnf" <<CNF
[ req ]
distinguished_name = req_dn
x509_extensions    = v3_codesign
prompt             = no

[ req_dn ]
CN = ${IDENTITY_NAME}
O  = Shepherd local development
OU = shepherd.run

[ v3_codesign ]
basicConstraints     = critical,CA:false
keyUsage             = critical,digitalSignature
extendedKeyUsage     = critical,codeSigning
subjectKeyIdentifier = hash
CNF

  echo "Generating a self-signed code-signing certificate (${VALID_DAYS} days)…"
  openssl req -x509 -newkey rsa:2048 -sha256 -days "$VALID_DAYS" -nodes \
    -config "$tmp/openssl.cnf" -extensions v3_codesign \
    -keyout "$tmp/key.pem" -out "$tmp/cert.pem" >/dev/null 2>&1

  # `security import` needs a password-protected PKCS#12; a throwaway one is
  # enough because the bundle never leaves this temp directory.
  local p12_pass
  p12_pass="$(openssl rand -hex 16)"

  # OpenSSL 3 defaults to AES-256-CBC/PBES2 for PKCS#12, which older Security
  # framework importers reject. Ask for the SHA1/3DES encoding macOS has always
  # read, and fall back to the defaults if this openssl does not offer it.
  openssl pkcs12 -export \
    -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1 \
    -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$IDENTITY_NAME" \
    -out "$tmp/identity.p12" -passout "pass:$p12_pass" >/dev/null 2>&1 ||
    openssl pkcs12 -export \
      -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -name "$IDENTITY_NAME" \
      -out "$tmp/identity.p12" -passout "pass:$p12_pass" >/dev/null

  # -T grants those two tools access to the private key without the generic
  # "unknown application" ACL. It does NOT populate the key's partition list —
  # see the note printed at the end.
  echo "Importing it into ${keychain}…"
  security import "$tmp/identity.p12" -k "$keychain" -P "$p12_pass" -f pkcs12 \
    -T /usr/bin/codesign -T /usr/bin/security >/dev/null

  # A self-signed certificate is its own root, so it has to be trusted for the
  # codeSign policy before `find-identity -v` will admit it. Without -d this
  # writes the *per-user* trust settings, which needs no admin account — macOS
  # still asks for the login password in a dialog.
  echo "Trusting it for code signing (macOS may ask for your login password)…"
  if ! security add-trusted-cert -r trustRoot -p codeSign -k "$keychain" "$tmp/cert.pem" 2>/dev/null; then
    cat >&2 <<EOF

Could not write the trust setting automatically. Do it once by hand — no admin
account is required:

  1. Open Keychain Access, select the "login" keychain, "My Certificates".
  2. Double-click "$IDENTITY_NAME".
  3. Expand "Trust" and set "Code Signing" to "Always Trust".
  4. Close the window and confirm with your login password.
  5. Re-run: native/scripts/dev-signing-identity.sh --check

EOF
    return 1
  fi

  sha1="$(identity_sha1)"
  if [ -z "$sha1" ]; then
    echo "The identity was imported but is still not listed as valid by" >&2
    echo "  security find-identity -v -p codesigning" >&2
    echo "Check its Trust settings in Keychain Access." >&2
    return 1
  fi

  cat <<EOF

Done.
identity: "$IDENTITY_NAME"
SHA-1:    $sha1

build-app.sh and test-app.sh pick this up automatically from now on.

One prompt is still to come: the first codesign run has to unlock this new
private key, and macOS asks "codesign wants to sign using key … in your
keychain". Click **Always Allow** — not "Allow". That writes codesign into the
key's ACL for good, and it is the last Keychain prompt you will see for these
builds. (The scripted equivalent, \`security set-key-partition-list\`, needs your
keychain password on the command line, so it is deliberately not automated.)
EOF
}

case "${1:-}" in
  --check) cmd_check ;;
  --remove) cmd_remove ;;
  -h | --help) usage ;;
  "") cmd_create ;;
  *)
    echo "Unknown argument: $1" >&2
    usage >&2
    exit 2
    ;;
esac
