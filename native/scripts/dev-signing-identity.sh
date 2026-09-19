#!/usr/bin/env bash
# Creates a stable, self-signed code-signing identity named "Shepherd Local Dev"
# in a DEDICATED keychain, so that neither `codesign` nor the app's Keychain
# access ever opens a password dialog during an unattended build.
#
# Why a separate keychain: the identity used to live in the login keychain. A
# private key there has an empty "partition list", and macOS answers every
# `codesign` request against such a key with a modal "codesign wants to use
# your confidential information" dialog. The scripted cure —
# `security set-key-partition-list` — needs the *keychain's* password on the
# command line, which we will not ask for the login keychain. A keychain we own
# has a password we generated, so we can set the partition list ourselves and
# the dialog never appears.
#
#   keychain:  ~/Library/Keychains/shepherd-dev-signing.keychain-db
#   password:  ~/Library/Application Support/Shepherd/dev-signing.keychain-pass
#              (mode 0600, random, created with umask 077; never printed)
#
# The keychain is added to the *user* search list, has auto-lock disabled, and
# is unlocked here and again by build-app.sh / test-app.sh. It holds nothing but
# this one development certificate.
#
# The certificate is deliberately NOT marked "always trust" for code signing:
# writing a trust setting is itself a modal dialog, and codesign does not need
# one when it is handed the certificate's SHA-1. codesign-mode.sh therefore
# passes the hash, not the name.
#
# Usage:
#   native/scripts/dev-signing-identity.sh           create it if absent (idempotent)
#   native/scripts/dev-signing-identity.sh --check   exit 0 if usable, 1 if not
#   native/scripts/dev-signing-identity.sh --remove  delete identity, keychain and password
#
# CI never runs this. With no such identity in the search list, build-app.sh and
# test-app.sh keep signing ad-hoc exactly as before.
set -euo pipefail

IDENTITY_NAME="Shepherd Local Dev"
VALID_DAYS=3650

KEYCHAIN_PATH="$HOME/Library/Keychains/shepherd-dev-signing.keychain-db"
PASS_DIR="$HOME/Library/Application Support/Shepherd"
PASS_FILE="$PASS_DIR/dev-signing.keychain-pass"

# `apple-tool:` and `apple:` keep Apple's own tooling working; `codesign:`
# is the entry that stops the dialog for /usr/bin/codesign specifically.
PARTITIONS="apple-tool:,apple:,codesign:"

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

# One keychain path per line, unquoted, in search-list order.
search_list() {
  security list-keychains -d user | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//'
}

# The `find-identity` line for our identity in OUR keychain, or empty.
#
# Note the missing `-v`. `-v` means "valid", which for a self-signed leaf also
# means "trusted for code signing" — and the only way to write that trust
# setting, `security add-trusted-cert`, opens a modal authorisation dialog.
# codesign does not actually need it: given the certificate's SHA-1 it signs
# happily with an untrusted self-signed identity (the resulting designated
# requirement pins the certificate root hash, which is what a Keychain ACL
# matches on). Skipping trust is what makes this script fully unattended.
identity_line() {
  # `|| true`: `set -o pipefail` would otherwise turn "no match" — the normal
  # answer before the identity exists — into a fatal error for the caller.
  security find-identity -p codesigning "$KEYCHAIN_PATH" 2>/dev/null |
    grep -F "\"${IDENTITY_NAME}\"" |
    head -n 1 || true
}

identity_sha1() {
  identity_line | awk '{ print $2 }' || true
}

cert_in() {
  security find-certificate -c "$IDENTITY_NAME" "$1" >/dev/null 2>&1
}

keychain_exists() {
  [ -f "$KEYCHAIN_PATH" ]
}

# Reads the password into the *caller's* variable rather than printing it, so
# it never lands in a pipeline, a log or `set -x` output.
read_pass() {
  # shellcheck disable=SC2034  # assigned for the caller
  KEYCHAIN_PASS="$(cat "$PASS_FILE")"
}

usage() {
  sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ── steps ────────────────────────────────────────────────────────────────────

ensure_pass_file() {
  if [ -f "$PASS_FILE" ]; then
    chmod 600 "$PASS_FILE"
    return 0
  fi
  # umask in a subshell so the rest of the script keeps the caller's.
  (
    umask 077
    mkdir -p "$PASS_DIR"
    openssl rand -base64 32 >"$PASS_FILE"
  )
  chmod 600 "$PASS_FILE"
  echo "Wrote a new random keychain password to $PASS_FILE (mode 0600)."
}

ensure_keychain() {
  local KEYCHAIN_PASS
  read_pass

  if ! keychain_exists; then
    # Braces are load-bearing: under a non-UTF-8 locale bash would otherwise
    # swallow the first byte of the "…" into the variable name.
    echo "Creating ${KEYCHAIN_PATH}…"
    security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN_PATH"
  fi

  # No arguments at all = no lock timeout and no lock-on-sleep. A keychain that
  # relocks mid-build is exactly the thing that puts a dialog on screen.
  security set-keychain-settings "$KEYCHAIN_PATH"
  security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN_PATH"
}

ensure_in_search_list() {
  local existing=() line
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    if [ "$line" = "$KEYCHAIN_PATH" ]; then
      return 0 # already there — leave the list exactly as it is
    fi
    existing+=("$line")
  done < <(search_list)

  # -s REPLACES the list, so every entry that was there has to be repeated.
  echo "Adding the signing keychain to the user search list…"
  security list-keychains -d user -s "${existing[@]+"${existing[@]}"}" "$KEYCHAIN_PATH"
}

# The identity used to be created in the login keychain. There is no way to
# export a private key from it without a password dialog, so migration means:
# drop it there, make a fresh one here.
migrate_from_login() {
  local login
  login="$(login_keychain)"
  cert_in "$login" || return 0

  echo "Found \"$IDENTITY_NAME\" in the login keychain — removing it there first."
  # -c matches the common name exactly, so only our own certificate is touched,
  # and `delete-identity` needs no authorisation dialog.
  #
  # `security remove-trusted-cert` is deliberately NOT called: editing trust
  # settings opens a modal authorisation dialog, which is the very thing this
  # script exists to avoid. The old certificate's trust entry is keyed by a
  # certificate that no longer exists anywhere, so it is inert; Keychain Access
  # → View → Show Expired/Invalid is where to clear it by hand if you care.
  security delete-identity -c "$IDENTITY_NAME" "$login" >/dev/null
  echo "Removed it from $login."
  echo
  echo "NOTE: the new certificate has a new root hash, so the app's designated"
  echo "requirement changes ONE more time. The next launch of a freshly built"
  echo "Shepherd.app will ask once for its own stored token — click \"Always"
  echo "Allow\". After that the requirement is stable for good."
  echo
}

create_identity() {
  local KEYCHAIN_PASS tmp sha1
  read_pass

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

  # -T pre-authorises those tools in the key's ACL; the partition list below is
  # the other half, and the one that actually silences the dialog.
  echo "Importing it into the signing keychain…"
  security import "$tmp/identity.p12" -k "$KEYCHAIN_PATH" -P "$p12_pass" -f pkcs12 \
    -T /usr/bin/codesign -T /usr/bin/security -T /usr/bin/productsign >/dev/null

  # No `security add-trusted-cert` here on purpose — see identity_line().
  apply_partition_list

  sha1="$(identity_sha1)"
  if [ -z "$sha1" ]; then
    echo "The identity was imported but is not listed by" >&2
    echo "  security find-identity -p codesigning $KEYCHAIN_PATH" >&2
    return 1
  fi
}

# THE step that stops the prompts: it writes the ACL partition list onto every
# signing key in our keychain, so codesign is pre-authorised. It needs the
# keychain password, which is why the identity had to leave the login keychain.
apply_partition_list() {
  local KEYCHAIN_PASS
  read_pass
  security set-key-partition-list \
    -S "$PARTITIONS" -s -k "$KEYCHAIN_PASS" "$KEYCHAIN_PATH" >/dev/null 2>&1
}

# ── commands ─────────────────────────────────────────────────────────────────

cmd_check() {
  local sha1 ok=0
  if ! keychain_exists; then
    echo "absent: $KEYCHAIN_PATH does not exist"
    ok=1
  fi
  if [ ! -f "$PASS_FILE" ]; then
    echo "absent: $PASS_FILE does not exist"
    ok=1
  fi
  if ! search_list | grep -qxF "$KEYCHAIN_PATH"; then
    echo "not in the user keychain search list: $KEYCHAIN_PATH"
    ok=1
  fi
  if cert_in "$(login_keychain)"; then
    echo "stale: \"$IDENTITY_NAME\" is ALSO in the login keychain — re-run without"
    echo "       arguments to migrate it out (it is the one that prompts)."
    ok=1
  fi

  sha1="$(identity_sha1)"
  if [ -n "$sha1" ]; then
    echo "present: \"$IDENTITY_NAME\" ($sha1)"
  else
    echo "absent: no code-signing identity named \"$IDENTITY_NAME\""
    ok=1
  fi
  return "$ok"
}

cmd_remove() {
  local line existing=()

  if keychain_exists; then
    if cert_in "$KEYCHAIN_PATH"; then
      # delete-identity removes the certificate AND its private key, and needs
      # no authorisation dialog. The per-user trust setting is left alone on
      # purpose: `security remove-trusted-cert` opens a modal dialog, and once
      # the certificate is gone the entry refers to nothing and does nothing.
      security delete-identity -c "$IDENTITY_NAME" "$KEYCHAIN_PATH" >/dev/null || true
    fi

    # Take it out of the search list before deleting the file, so the list never
    # names a keychain that is gone.
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      [ "$line" = "$KEYCHAIN_PATH" ] && continue
      existing+=("$line")
    done < <(search_list)
    security list-keychains -d user -s "${existing[@]+"${existing[@]}"}"

    security delete-keychain "$KEYCHAIN_PATH" 2>/dev/null || rm -f "$KEYCHAIN_PATH"
    echo "Removed $KEYCHAIN_PATH."
  else
    echo "Nothing to remove: $KEYCHAIN_PATH does not exist."
  fi

  if [ -f "$PASS_FILE" ]; then
    rm -f "$PASS_FILE"
    echo "Removed $PASS_FILE."
  fi

  echo "Local builds fall back to ad-hoc signing; the app will ask for Keychain"
  echo "access again on the next build."
}

cmd_create() {
  local sha1

  ensure_pass_file
  ensure_keychain
  ensure_in_search_list
  migrate_from_login

  sha1="$(identity_sha1)"
  if [ -n "$sha1" ] && cert_in "$KEYCHAIN_PATH"; then
    # Already ours: re-assert the partition list and the unlock, both of which
    # are cheap and are the two things that decay.
    apply_partition_list
    echo "Already present — nothing to do."
    echo "identity: \"$IDENTITY_NAME\""
    echo "SHA-1:    $sha1"
    echo "keychain: $KEYCHAIN_PATH"
    return 0
  fi

  if cert_in "$KEYCHAIN_PATH"; then
    echo "A certificate named \"$IDENTITY_NAME\" is in the signing keychain but is" >&2
    echo "not usable for code signing. Remove it first:" >&2
    echo "  native/scripts/dev-signing-identity.sh --remove" >&2
    return 1
  fi

  command -v openssl >/dev/null 2>&1 || {
    echo "openssl not found in PATH." >&2
    return 1
  }

  create_identity
  sha1="$(identity_sha1)"

  cat <<EOF

Done.
identity: "$IDENTITY_NAME"
SHA-1:    $sha1
keychain: $KEYCHAIN_PATH

build-app.sh and test-app.sh pick this up automatically and unlock the keychain
before xcodebuild, so codesign never opens a dialog again.
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
