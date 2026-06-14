# Onboarding Challenge & Regression Harness

Boots deliberately-messy Incus instances, runs Shepherd inside them in degraded mode, captures diagnostics, applies the coaching (a verbatim remediation where one exists, else a Claude Code proxy-user agent), re-probes, and emits a gap report.

## Scenarios & success

Success is scoped **per scenario**: a scenario passes when the checks it broke return to `ok` after the coaching is applied — NOT when the whole host is green. A throw-away instance never reaches all-7-green (no tailnet, no `gh` login), so a global finish line would be permanently red.

Two scenario classes:

- **Green-able** — the defect can be coached back to `ok` unattended. `coaching: "structured"` runs a verbatim `REMEDIATIONS` command (deterministic, LLM-free, **release-gate-eligible**); `coaching: "prose"` uses the agent (e.g. distro-specific git install). Today: `herdr-missing`, `claude-missing`, `node-too-old` (structured) and `git-missing` (prose).
- **Detection-only** (`detectionOnly: true`) — the defect is detectable but its fix needs a human/secret a throw-away instance can't supply (`gh auth login`; a Tailscale tailnet login + `serve`). No apply is attempted; excluded from the green tally and the gate; reported as DETECTION-ONLY. Today: `gh-unauthed`, `gh-missing`, `tailscale-missing`.

## Prerequisites

- Self-hosted Incus host with the `shep-onb` profile configured:
  ```
  incus profile create shep-onb
  incus profile set shep-onb limits.cpu 2 limits.memory 2GiB
  # For tailscale/systemd scenarios (nesting + TUN):
  incus profile set shep-onb security.nesting true
  incus profile device add shep-onb tun unix-char path=/dev/net/tun
  ```
- `bun` installed on the Incus host.
- `~/.claude` credentials accessible on the host (mounted into instances for the agent apply path). The harness expects a valid Claude Code credential so the proxy-user agent can run `claude -p` inside each instance.

## Usage

```bash
# Run all scenarios
bun run onboarding:test

# Run a single scenario
bun run onboarding:test --scenario gh-unauthed

# Reap leaked instances from a crashed run (manual recovery only)
bun run onboarding:test --reap-orphans
```

The report lands at `onboarding-gap-report.md` in the working directory. Exit code is 0 if every apply-able scenario reached green; 1 if any failed; 2 if the named scenario was not found; 3 if another run holds the host lock.

## Run isolation

Each run acquires an exclusive host-wide lock at the **fixed absolute path** `~/.shepherd/onboarding-harness.lock` (NOT `$TMPDIR` — a systemd-user timer and an interactive run can see different `$TMPDIR` under PrivateTmp, so the lock must live under the stable `~/.shepherd` dir to actually serialize them). A second run while one is active exits with code 3.

Each run also uses a unique per-run instance prefix (`shep-onb-<runId>-`) and sweeps only its own prefix on teardown, so two concurrent runs (if the lock were bypassed) could never destroy each other's instances.

Crashed-run leftovers are cleared with `--reap-orphans`, which sweeps all `shep-onb-*` instances regardless of run prefix. This is the only command that touches other runs' instances — never invoked automatically.

## Nightly timer (Incus host)

Copy the systemd units and enable the timer:

```bash
cp ci/onboarding-harness/shepherd-onboarding.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now shepherd-onboarding.timer
```

The timer fires nightly at 03:30 and writes the gap report to the working directory.

## Accountability (GitHub issue)

The `.service` sets `SHEPHERD_ONBOARDING_REPORT_ISSUE=1`, so the nightly **files its outcome to GitHub** as a single rolling issue (label `onboarding-regression`) whose lifecycle mirrors the regression:

- **gap found, no open issue** → opens one (body = the gap report)
- **gap persists** → refreshes the issue body to the latest report + adds a dated comment (an auditable timeline)
- **run goes clean** → closes the issue ("regression resolved")

So a finding can't rot in an overwritten file — it surfaces as an open, trackable issue until the harness is green again. Only **full** runs report (a single `--scenario` never opens/closes the issue, since it checks just one defect); the env-gate keeps manual/ad-hoc full runs side-effect-free. Requires `gh` authenticated on the host. Dedup relies on the daily cadence (GitHub's label list is eventually-consistent, so back-to-back runs within seconds could double-file — irrelevant 24h apart).

The same full run also publishes a **commit status** (`onboarding-harness` context, success/failure) on the tested SHA, so every nightly leaves a visible green/red record on the commit — even a clean run that files no issue — linked to the regression issue when red.

## Release gate

Because the harness needs Incus (a self-hosted host), it **cannot run in GitHub-hosted CI**, and exposing the host's Incus socket to the sandboxed self-hosted runners (which execute untrusted PR code) would defeat their isolation. So enforcement is split: the **host executes** the harness nightly and publishes the verdict to GitHub (the rolling issue + commit status above); **CI consults** it.

`.github/workflows/onboarding-release-gate.yml` runs on release-please's release PR and **fails if an `onboarding-regression` issue is open** — i.e. it blocks shipping a release over a known-red onboarding harness. It only reads an issue (no Incus), runs on a hosted runner, and is robust to `main` moving (it consults the rolling issue, not a per-SHA status). To make it actually block the merge, add `onboarding-release-gate` to the branch's **required status checks** (a repo setting). It reflects the last nightly, so a host that's been down for days can leave the signal stale.

### Manual subset gate

Before tagging a release you can also run the deterministic subset directly:

```bash
scripts/onboarding-gate.sh
```

This runs the deterministic, green-able subset (`structured` AND not `detectionOnly`) and exits non-zero on any red. It bypasses with exit 0 (loudly logged) when the Incus host is unavailable, so infra outages do not block unrelated releases. Add this check to the OSS-release checklist.
