#!/usr/bin/env bash
# Mint a short-lived GitHub Actions runner REGISTRATION token on the host and
# write it (mode 0600) to $RUNNER_TOKEN_FILE for run-runner.sh to hand the
# container via RUNNER_TOKEN.
#
# WHY mint on the host: the admin credential (host `gh` login, or a fine-grained
# PAT in pat.env via GH_TOKEN) NEVER enters the container. Only this ephemeral,
# short-lived registration token does — see run-runner.sh.
#
# FAIL CLOSED: if the token is empty/unmintable we exit non-zero and write
# nothing, so the unit can refuse to start a tokenless runner.
set -euo pipefail

: "${GH_REPO:?GH_REPO must be set (owner/name) — provided by the unit EnvironmentFile}"
: "${RUNNER_TOKEN_FILE:?RUNNER_TOKEN_FILE must be set — provided by the unit via %t}"

# `gh` resolves auth from GH_TOKEN (optional pat.env) or the host login.
# -q .token extracts just the token string from the API response.
token="$(gh api -X POST "repos/${GH_REPO}/actions/runners/registration-token" -q .token)"

if [[ -z "${token}" ]]; then
  echo "mint-token: registration token was empty — refusing to start a tokenless runner" >&2
  exit 1
fi

# Write restrictively (umask first so the create itself is 0600, no race window).
umask 077
printf '%s' "${token}" >"${RUNNER_TOKEN_FILE}"
echo "mint-token: wrote registration token to ${RUNNER_TOKEN_FILE}"
