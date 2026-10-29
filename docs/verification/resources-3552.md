# Resource settings verification (#3552)

Settings → Resources applies to this server. Stored values override the startup environment;
clearing a numeric override restores the default (including `SHEPHERD_HEAVY_SLOTS`, if set).
The master switch preserves the other settings. Running processes are never killed or restarted.
Disabling releases queued checks: blocking runners resume at their next poll, while agents that
already returned from their tool call receive a steer to rerun. This does not guarantee the
agent executes the command at the exact instant the operator switches off.

Waiting defaults to informing the agent. With bounded waiting, updated JS and Rust runners poll
until a fixed deadline, then return exit 75 and leave the check queued for an eventual steer.
If polling stops, an unclaimed offer falls back to an agent steer after the polling lease expires.
The acquire request advertises `canWait: true`; older runners retain the inform-and-steer path.
An operator CLI invocation outside a session still returns immediately when no slot is free
because there is no agent to notify. A polling failure never starts a queued command unmanaged.

The heavy-command list uses command names, optionally restricted to subcommands. Custom entries
replace the corresponding built-in rule; disabled entries retain their saved definitions.
Guard processes read an atomically replaced JSON file. Codex PATH shims are refreshed when
settings change, including custom commands. Already running pre-update Claude sessions need a
new spawn to receive the new guard argument and sandbox directory mount. Shells, `node` and
`env` cannot be shadowed safely by a PATH shim; those names are excluded from custom shims.

Peak values are the most recently **measured** maximum summed RSS of a job's process tree, sampled
by the existing Linux marker scanner. They are neither an all-time maximum nor kernel high-water
marks. A run shorter than a scan interval can be missed; unavailable measurements remain unknown.
The open panel refreshes live status, but command peaks currently refresh on reopen or save.
External-load values come from the existing snapshot and stay unknown if that producer has none.

## Pressure-brake evidence and limitation

No new default threshold is selected by this change. The inherited provisional limits remain
`min(4 GiB, 15% of RAM)`, PSI memory `full avg10` 20%, and a 30-second healthy hold. The page
explicitly labels them provisional rather than presenting them as measured recommendations.

Ten one-second observations from `/proc/meminfo` and `/proc/pressure/memory` on this development
host, 2026-10-28 23:09:20–23:09:29 UTC, during targeted verification / CLI compilation:

| Measurement             | Observed         |
| ----------------------- | ---------------- |
| Total memory            | 30.63 GiB        |
| Available memory        | 12.63–13.87 GiB  |
| Memory PSI `full avg10` | 0.00% throughout |
| Memory PSI `full avg60` | 0.13–0.15%       |

These observations demonstrate a healthy operating point only. They **do not** validate the
low-memory cutoff, PSI threshold, or release time, and do not satisfy the requested load
calibration. Selecting validated defaults needs a controlled representative workload on an
isolated host: record available RAM, full PSI, job RSS, completion times and interactive latency
while varying concurrency; then replay measured pressure traces through the brake. Do not
manufacture memory pressure on the shared operator host to obtain such data.

The implementation tests verify threshold behavior and release hysteresis independently of
whether these provisional values are good defaults. Calibration remains follow-up work in [#3589](https://github.com/erwins-enkel/shepherd/issues/3589).
