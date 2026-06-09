#!/usr/bin/env bash
# Shepherd self-hosted CI runner — liveness watchdog.
#
# WHY this exists: once the repo sets the `CI_RUNNER` Actions variable, the
# workflows' `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}` resolves to the
# self-hosted label and GitHub's hosted runners are NO LONGER a failover. If our
# runner is silently down, PR jobs don't go red — they sit QUEUED/pending forever
# (GitHub waits indefinitely for a matching runner). A pending-but-not-failed
# check is invisible on the PR; nobody gets paged. This watchdog is what surfaces
# that: it runs on a timer, fails visibly in the journal when the runner is gone,
# and best-effort desktop-notifies the operator. The outage runbook (README) is
# then: `gh variable delete CI_RUNNER` to instantly revert to hosted runners,
# repair the runner, re-set the variable.
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

# Still down after the debounce delay — this is a real outage.
fail "${status}"
