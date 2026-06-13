#!/usr/bin/env bash
# Release gate: run the deterministic (structured) onboarding scenarios and fail
# the release if any does not reach a healthy state.
#
# SAFE DEGRADE (point 6): this gate depends on a single self-hosted Incus host.
# If that host is unavailable, we must NOT hard-block an otherwise-good release on
# unrelated infra — we log a loud, explicit bypass and exit 0. A red SCENARIO
# (Incus present, a scenario failed) still fails the gate; only an absent/broken
# Incus host bypasses.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v incus >/dev/null 2>&1 || ! incus list >/dev/null 2>&1; then
  echo "::onboarding-gate:: BYPASSED — Incus host unavailable; not blocking the release on infra." >&2
  exit 0
fi

# Gate runs only green-able deterministic scenarios: structured (verbatim, LLM-free)
# AND not detection-only (detection-only defects need a human/secret to clear, so
# they can never reach green and must not gate a release).
STRUCTURED_IDS=$(bun -e '
  import("./ci/onboarding-harness/scenarios.ts").then(({ SCENARIOS }) =>
    console.log(
      SCENARIOS.filter((s) => s.coaching === "structured" && !s.detectionOnly)
        .map((s) => s.id)
        .join(" "),
    ));
')

fail=0
for id in $STRUCTURED_IDS; do
  echo "::onboarding-gate:: $id"
  bun run onboarding:test --scenario "$id" || fail=1
done
exit "$fail"
