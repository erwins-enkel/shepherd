# Onboarding Challenge & Regression Harness

Boots deliberately-messy Incus instances, runs Shepherd inside them in degraded mode, captures diagnostics, applies coaching via a Claude Code proxy-user agent, re-probes, and emits a gap report.

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

## Release gate

Before tagging a release, run:

```bash
scripts/onboarding-gate.sh
```

This runs the deterministic (`structured`) scenario subset and exits non-zero on any red. It bypasses with exit 0 (loudly logged) when the Incus host is unavailable, so infra outages do not block unrelated releases. Add this check to the OSS-release checklist.
