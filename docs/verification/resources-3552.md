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

## Pressure-brake evidence

This change selected no thresholds; it inherited the provisional `min(4 GiB, 15% of RAM)`, PSI
memory `full avg10` 20% and 30-second hold. They were calibrated against measured load in
[#3589](https://github.com/erwins-enkel/shepherd/issues/3589); method, data and the resulting
defaults: [pressure-brake-3589.md](pressure-brake-3589.md).
