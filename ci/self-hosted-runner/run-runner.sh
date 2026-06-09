#!/usr/bin/env bash
# Launch ONE ephemeral, hardened self-hosted runner container.
#
# Usage: run-runner.sh <runner-name>   (the unit passes runner-%i, e.g. runner-1)
#
# The docker invocation lives here rather than inline in the unit so it stays
# testable (`bash -n`, shellcheck) and free of systemd quoting traps.
#
# Security posture (this runs UNTRUSTED PR code, one fresh --rm container/job):
#   - default bridge network, NEVER --network host / --pid host
#   - NO docker socket mount, NOT --privileged
#   - --shm-size=1g so Chromium doesn't OOM on the default 64M /dev/shm
#   - per-replica --cpus / --memory caps
#   - only the short-lived RUNNER_TOKEN crosses in — never a PAT
#   - NO --security-opt no-new-privileges: the in-job
#     `playwright install --with-deps` needs the image's passwordless sudo.
#     TRADEOFF: the container therefore runs as root and untrusted PR code can
#     `sudo` to root INSIDE its namespace. That escalation is contained by the
#     unprivileged / no-docker-socket / non-privileged boundary above — which is
#     exactly why rootless Docker is recommended for this on a shared host.
set -euo pipefail

runner_name="${1:?usage: run-runner.sh <runner-name>}"

: "${RUNNER_TOKEN_FILE:?RUNNER_TOKEN_FILE must be set — provided by the unit via %t}"
: "${REPO_URL:?REPO_URL must be set — provided by the unit EnvironmentFile}"
: "${IMAGE:?IMAGE must be set — provided by the unit EnvironmentFile}"
: "${RUNNER_LABELS:?RUNNER_LABELS must be set — provided by the unit EnvironmentFile}"
: "${RUNNER_CPUS:?RUNNER_CPUS must be set — provided by the unit EnvironmentFile}"
: "${RUNNER_MEMORY:?RUNNER_MEMORY must be set — provided by the unit EnvironmentFile}"

# Read the host-minted registration token (mint-token.sh ran in ExecStartPre).
# Fail closed: no readable, non-empty token => no container.
if [[ ! -s "${RUNNER_TOKEN_FILE}" ]]; then
  echo "run-runner: ${RUNNER_TOKEN_FILE} missing or empty — refusing to start" >&2
  exit 1
fi
# Export so docker reads it from our environment (bare `-e RUNNER_TOKEN`) rather
# than as an argv element — keeping the token out of `ps auxww`/`/proc/<pid>/cmdline`
# where any local user could read it for the token's ~1h life.
export RUNNER_TOKEN="$(cat "${RUNNER_TOKEN_FILE}")"
if [[ -z "${RUNNER_TOKEN}" ]]; then
  echo "run-runner: registration token empty — refusing to start" >&2
  exit 1
fi

# exec so the container is PID 1 under systemd — Restart/stop act on it directly.
exec docker run --rm \
  --name "shepherd-ci-${runner_name}" \
  --network bridge \
  --shm-size=1g \
  --cpus="${RUNNER_CPUS}" \
  --memory="${RUNNER_MEMORY}" \
  -e RUNNER_SCOPE=repo \
  -e REPO_URL="${REPO_URL}" \
  -e RUNNER_NAME="${runner_name}" \
  -e RUNNER_TOKEN \
  -e LABELS="${RUNNER_LABELS}" \
  -e EPHEMERAL=true \
  -e DISABLE_AUTO_UPDATE=true \
  -e RUNNER_WORKDIR=/_work \
  "${IMAGE}"
