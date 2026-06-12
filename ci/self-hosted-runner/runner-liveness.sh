#!/usr/bin/env bash
# Shepherd self-hosted CI runner — liveness watchdog.
#
# WHY this exists: once the repo sets the `CI_RUNNER` Actions variable, the
# workflows' `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` resolves to the
# self-hosted label and GitHub's hosted runners are NO LONGER a failover. If our
# runner is silently down, PR jobs don't go red — they sit QUEUED/pending forever
# (GitHub waits indefinitely for a matching runner). A pending-but-not-failed
# check is invisible on the PR; nobody gets paged. This watchdog is what surfaces
# that: it runs on a timer, and on a confirmed outage it first tries to SELF-HEAL
# (see REMEDIATE below), then — only if that is disabled or fails — fails visibly in
# the journal and best-effort desktop-notifies the operator. The outage runbook
# (README) is then: `gh variable delete CI_RUNNER` to instantly revert to hosted
# runners, repair the runner, re-set the variable.
#
# It checks BOTH halves of "the runner is actually serving":
#   (a) GitHub agrees at least one registered runner is `online`, AND
#   (b) at least one local `shepherd-ci-runner@*.service` instance is up.
# Both must hold; either failing means jobs can't be picked up.
#
# WHY DEBOUNCE: the runner is EPHEMERAL=true — after each job the container
# deregisters from GitHub and exits, the unit restarts (RestartSec=5s) and
# re-registers for the next job. So during active CI there's a LEGITIMATE brief
# window where GitHub reports 0 `online` and the local unit is `activating`
# (mid-restart), not failed. A single-shot check would fire a false "runner down"
# alert in that window, and a flappy watchdog trains the operator to ignore it —
# defeating its purpose. So a first down-read is NOT alerted: we sleep one short
# interval and RE-CHECK. We alert (stderr + best-effort notify-send + exit 1)
# ONLY if it's still down on the second read. This rides out the per-job restart
# gap (RestartSec=5s + container spawn + token mint) while still catching a
# genuinely-down runner within one 5-min timer tick. Relatedly, the local check
# accepts `activating` AS WELL AS `active` — a unit mid-restart is up, not failed.
set -euo pipefail

# Seconds to wait before re-checking a first down-read. Long enough to outlast
# the per-job restart gap (5s RestartSec + container spawn + token mint), short
# enough to alert well within one 5-min timer tick.
RECHECK_DELAY="${RECHECK_DELAY:-15}"

# SELF-HEAL: on a CONFIRMED outage (still down after the debounce re-check), try to
# automatically remediate before alerting. Set REMEDIATE=0 to restore the old
# alert-only behaviour. WHY this exists: the dominant real-world outage on this host
# is rootless docker's `slirp4netns` (the per-daemon userspace NAT uplink for all
# containers) dying/zombieing — it silently kills ALL container egress while the
# host itself stays online, so every ephemeral runner fails `configure` with EAGAIN
# on api.github.com and crash-loops. Restarting the runner units does NOT fix it
# (the fresh container hits the same dead slirp and re-loops); only restarting the
# rootless docker daemon respawns a healthy slirp. This watchdog is the only thing
# on a timer positioned to catch + auto-repair that. (2026-06-12 incident.)
REMEDIATE="${REMEDIATE:-1}"

# The ROOTLESS docker daemon the runner containers use (mirrors DOCKER_HOST from the
# unit EnvironmentFile). The egress canary + the docker restart both target THIS
# daemon, never the user's default/rootful docker.
DOCKER_HOST="${DOCKER_HOST:-unix:///run/user/$(id -u)/docker.sock}"
export DOCKER_HOST

# Image for the egress canary. Defaults to the runner IMAGE (from the EnvironmentFile)
# because it is GUARANTEED already present locally — the canary runs with --pull=never
# so it never depends on the very egress it is testing.
CANARY_IMAGE="${CANARY_IMAGE:-${IMAGE:-alpine}}"

# How long (seconds) to wait for a healthy slirp4netns after restarting docker before
# giving up and alerting. Restart + daemon init + slirp spawn is a few seconds.
SLIRP_RECOVER_TIMEOUT="${SLIRP_RECOVER_TIMEOUT:-30}"

# GH_REPO (owner/name) comes from the same EnvironmentFile the runner units load
# (~/.config/shepherd-ci-runner/.env). gh resolves auth from the host login or the
# optional pat.env GH_TOKEN — same credential path as mint-token.sh.
: "${GH_REPO:?GH_REPO must be set (owner/name) — provided by the unit EnvironmentFile}"

fail() {
  # Message lands on stderr -> the systemd journal for this oneshot unit.
  echo "runner-liveness: $1" >&2
  # Best-effort desktop alert. notify-send may be absent (headless host) or have
  # no bus to talk to; never let that turn a real failure into a different error
  # or, worse, mask it — so swallow its exit entirely. The journal is the source
  # of truth; the toast is a courtesy.
  notify-send -u critical "Shepherd CI runner DOWN" "$1" 2>/dev/null || true
  exit 1
}

# probe: run both halves once. Echoes a one-line summary to stdout and returns 0
# if healthy; on the first failing check it echoes a describing-WHICH-failed
# message to stdout and returns 1. It never exits the script — the caller decides
# whether a single failure is the (debounced) first read or the confirming second.
probe() {
  local online_count active_local

  # (a) Ask GitHub how many registered runners report `online`. A repo-scoped
  # query; `--jq` filters to online runners and counts them. A gh error
  # (auth/network) is itself a failing read — we report it and let the debounce
  # re-check decide, rather than aborting the whole script.
  if ! online_count="$(gh api "repos/${GH_REPO}/actions/runners" \
    --jq '[.runners[] | select(.status == "online")] | length' 2>/dev/null)"; then
    echo "could not query GitHub runners for ${GH_REPO} (gh api failed — auth or network?)"
    return 1
  fi
  if [[ -z "${online_count}" || "${online_count}" -lt 1 ]]; then
    echo "no runner reports 'online' to GitHub for ${GH_REPO} — PR jobs will queue pending, not fail"
    return 1
  fi

  # (b) Confirm at least one local runner instance is up. We count instances in
  # EITHER `active` OR `activating`: an ephemeral runner mid-restart (RestartSec
  # gap between jobs) sits in `activating` and is up, not failed. list-units over
  # the template's instances, filtered to both states, counted line-per-unit;
  # `|| true` stops a zero match from tripping `set -e`.
  active_local="$(systemctl --user list-units 'shepherd-ci-runner@*.service' \
    --state=active,activating --no-legend --plain 2>/dev/null | grep -c . || true)"
  if [[ -z "${active_local}" || "${active_local}" -lt 1 ]]; then
    echo "no shepherd-ci-runner@*.service instance is active/activating locally — the runner host unit is down"
    return 1
  fi

  echo "OK — ${online_count} runner(s) online at GitHub, ${active_local} local instance(s) active/activating"
  return 0
}

# runner_instances: space-separated list of the ENABLED shepherd-ci-runner@N.service
# instances, read from the user manager's enable symlinks so it tracks however many
# replicas are deployed (no hard-coded 1..4).
runner_instances() {
  local f
  for f in "${HOME}/.config/systemd/user/default.target.wants/"shepherd-ci-runner@*.service; do
    [ -e "${f}" ] || continue
    basename "${f}"
  done | tr '\n' ' '
}

# egress_ok: returns 0 iff a throwaway container on the ROOTLESS docker daemon can
# open a TCP/443 connection to api.github.com. This is the TRUE root-cause probe for
# the slirp4netns failure mode: a dead slirp takes out container DNS + egress while
# the host stays online, so a host-side check (curl from this script) misses it
# entirely — only a container-side probe sees it. Uses bash /dev/tcp (DNS + connect,
# both of which traverse slirp) rather than curl/wget so it needs no in-image tooling,
# and --pull=never so it never depends on the very egress it is testing.
egress_ok() {
  command -v docker >/dev/null 2>&1 || return 1
  timeout 25 docker run --rm --pull=never --network bridge "${CANARY_IMAGE}" \
    bash -c 'exec 3<>/dev/tcp/api.github.com/443' >/dev/null 2>&1
}

# remediate: best-effort self-heal of a confirmed outage. Returns 0 if it ran its
# repair, 1 if it could not. ORDER + blast-radius are deliberate:
#   1. Only restart the docker daemon when the egress canary PROVES slirp is dead —
#      that restart ABORTS any in-progress job container, so we must not do it for a
#      transient GitHub-0-online registration gap (where the canary still PASSES).
#   2. Restarting the runner units alone never fixes dead egress (proven 2026-06-12),
#      so it is the SECOND lever — applied after egress is confirmed healthy.
remediate() {
  if ! egress_ok; then
    echo "runner-liveness: REMEDIATE — rootless docker egress is DOWN (slirp4netns dead); restarting docker.service" >&2
    if ! systemctl --user restart docker.service; then
      echo "runner-liveness: REMEDIATE — docker.service restart failed" >&2
      return 1
    fi
    # Wait for a healthy slirp before touching the runners — a fresh runner that
    # races the daemon's startup would just re-fail.
    local waited=0
    until egress_ok; do
      if [ "${waited}" -ge "${SLIRP_RECOVER_TIMEOUT}" ]; then
        echo "runner-liveness: REMEDIATE — egress still down ${SLIRP_RECOVER_TIMEOUT}s after docker restart" >&2
        return 1
      fi
      sleep 2
      waited=$((waited + 2))
    done
    echo "runner-liveness: REMEDIATE — docker egress restored after ${waited}s" >&2
  fi

  # Egress is healthy (either it always was — a pure runner-unit fault — or we just
  # fixed it). Clear any failed/crash-loop state and bring the ephemeral instances
  # back up fresh.
  local instances
  instances="$(runner_instances)"
  if [ -z "${instances}" ]; then
    echo "runner-liveness: REMEDIATE — no enabled runner instances found to restart" >&2
    return 1
  fi
  echo "runner-liveness: REMEDIATE — restarting runner instances: ${instances}" >&2
  # shellcheck disable=SC2086  # intentional word-splitting of the instance list
  systemctl --user reset-failed ${instances} 2>/dev/null || true
  # shellcheck disable=SC2086
  if ! systemctl --user restart ${instances}; then
    echo "runner-liveness: REMEDIATE — runner unit restart failed" >&2
    return 1
  fi
  return 0
}

# Debounce: a single down-read may just be the normal per-job restart window
# (ephemeral runner deregistered + unit restarting). Don't alert on it — sleep
# and re-check. Alert only if STILL down on the second read.
if status="$(probe)"; then
  echo "runner-liveness: ${status}"
  exit 0
fi

echo "runner-liveness: first read DOWN (${status}); re-checking in ${RECHECK_DELAY}s to ride out the ephemeral per-job restart gap…" >&2
sleep "${RECHECK_DELAY}"

if status="$(probe)"; then
  echo "runner-liveness: recovered on re-check — was a transient per-job restart window, not an outage"
  exit 0
fi

# Still down after the debounce delay — this is a real outage. Try to self-heal
# (restart dead rootless-docker egress and/or the runner units) BEFORE alerting; a
# successful repair turns a page-the-operator outage into a logged, auto-recovered
# blip. Only if remediation is disabled or fails do we fall through to the alert.
if [ "${REMEDIATE}" = "1" ]; then
  echo "runner-liveness: confirmed DOWN (${status}) — attempting self-heal" >&2
  if remediate; then
    # Give the freshly-restarted ephemeral runners a moment to register, then verify.
    sleep "${RECHECK_DELAY}"
    if status="$(probe)"; then
      echo "runner-liveness: SELF-HEALED — ${status}"
      notify-send -u normal "Shepherd CI runner self-healed" \
        "Auto-recovered after an outage; see journal for details." 2>/dev/null || true
      exit 0
    fi
    echo "runner-liveness: remediation ran but runner still down on re-check" >&2
  else
    echo "runner-liveness: remediation could not complete" >&2
  fi
fi

# Self-heal disabled, impossible, or unsuccessful — surface the outage.
fail "${status}"
