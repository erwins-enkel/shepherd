---
title: Operating Shepherd
description: Run Shepherd as a systemd service, expose it over Tailscale, and deploy code changes.
---

## Run as a systemd user service

Shepherd runs as a **systemd user service** — as your own user, so it keeps your
`claude` subscription login, `~/Work`, and herdr. The installer sets this up on
Linux. It binds to **loopback only** (`SHEPHERD_HOST=127.0.0.1`).

```bash
systemctl --user status shepherd     # check it
systemctl --user restart shepherd    # restart it
```

The unit runs straight from the working tree, so **whatever is checked out is what
runs**.

## Expose it over the network

Reach Shepherd over the network by putting it behind a trusted proxy — e.g.
Tailscale:

```bash
tailscale serve --bg 7330    # → https://<host>.<tailnet>.ts.net proxies to 127.0.0.1:7330
```

A Tailscale-served HUD needs **no allowlist step**: at startup Shepherd folds
every host that `tailscale serve status` shows fronting its port into the CSRF
origin allowlist — the node's own tailnet name (a direct `tailscale serve`, as
above) as well as a Tailscale **Service** front (e.g. `svc:shepherd` →
`shepherd.ts.net`). Only a front that doesn't appear in `tailscale serve status`
— a non-Tailscale reverse proxy or custom-DNS name — still needs its hostname
added to `SHEPHERD_ALLOWED_HOSTS`.

Access control is layered: the network reach is gated by
**tailnet membership**, and the app itself is gated by a **single-operator
password**. The password is exchanged for an HMAC-signed session cookie that
covers every HTTP route plus the live `/events` and `/pty` WebSocket channels.
Set it with `SHEPHERD_PASSWORD`; if you leave it unset, Shepherd generates a
strong one on first boot and prints it to the log **once** (`systemctl --user
status shepherd` / `journalctl --user -u shepherd`) — change it by setting
`SHEPHERD_PASSWORD` in `~/.shepherd/env` and restarting.

Per-deployment overrides (password, token, repo root, alternate hosts) go in
`~/.shepherd/env` (`KEY=value` lines), read by the unit if present. See
[Configuration](/reference/configuration/) for the full list.

## Deploy a code change

The unit runs from the working tree, so to deploy local changes in one shot
(install deps → build UI → restart → health check):

```bash
bun run update          # deploy the current working tree (warns if dirty / off main)
bun run update --pull   # fast-forward main from origin first (skip on a dev==prod box)
```

It is idempotent and safe to re-run — sessions survive the restart (herdr owns the
PTYs). UI-only changes don't strictly need it: a fresh `cd ui && bun run build` is
served on the next request, since the core reads `ui/build` from disk per request.

## Backups & restore

On Linux the installer/provision step also enables a **second** systemd user
timer — `shepherd-backup.timer` (`OnCalendar=hourly`) — that snapshots the SQLite
state DB out-of-process from the server (read-only `VACUUM INTO` → integrity check
→ gzip → atomic rename → GFS rotation). Snapshots land in `~/.shepherd/backups/`
by default (override `SHEPHERD_BACKUP_DIR`).

```bash
systemctl --user status shepherd-backup.timer   # check the timer
journalctl --user -u shepherd-backup             # per-run logs
deploy/shepherd-restore.sh                       # list snapshots, then restore one
deploy/shepherd-restore.sh <file>                # restore a specific shepherd-*.db.gz
```

The server's daily sweep also runs a read-only **staleness probe**: on a host
that's expected to back up, if the newest snapshot is missing or older than 3h it
logs a warning, records a durable `backup_stale` signal, and sends a best-effort
web-push alert. macOS / core-only hosts have no backup timer and stay silent. Full
details are in the
[backups runbook](https://github.com/erwins-enkel/shepherd/blob/main/docs/backups.md).

## Host tuning — tmpfs inodes

Shepherd points spawned **trusted** agents at a disk-backed `TMPDIR`
(`~/.cache/shepherd/tmp`, override `SHEPHERD_AGENT_TMPDIR`) so their scratch tree,
temp worktrees and dependency installs never touch the `/tmp` tmpfs in the first
place — sandboxed spawns already get the membrane's own ephemeral `/tmp`. It keeps
agents' Node compile cache off the tmpfs too, and runs an inode-guard sweep on
**startup + daily** that, once `/tmp` inode use crosses a threshold, drops the
compile cache and stale regenerable tool caches (but never a live session's
scratch). As a host-level belt on long-uptime hosts, raise `/tmp`'s `nr_inodes` in
`/etc/fstab`:

```text
tmpfs /tmp tmpfs nr_inodes=4194304 0 0
```

The relevant override env vars (`SHEPHERD_AGENT_TMPDIR`,
`SHEPHERD_NODE_COMPILE_CACHE`, `SHEPHERD_TMP_INODE_PCT`,
`SHEPHERD_TMP_STALE_HOURS`, `SHEPHERD_TMP_SWEEP_DIR`) are listed in
[Configuration](/reference/configuration/).

The **Temp filesystem inodes** row in Settings → Diagnose surfaces this live: it warns
at `SHEPHERD_TMP_INODE_PCT` (the same threshold that gates the sweep) and errors at 95% by
default. The bands stay ordered: if you raise the knob above 95 the error band rises with it, so
the row never alarms below the line you set.
This matters because inode exhaustion is easy to misdiagnose — writes start failing with
"no space" errors while `df -h` still shows the volume mostly empty. `df -i` is what shows
the real cause.

Its **Fix** button runs the sweep immediately, ignoring the usage threshold. It reclaims
what Shepherd owns — the compile cache and stale tool caches — so the row can legitimately
stay non-OK right after you click it: the two largest consumers when an agent has run a
dependency install in the temp filesystem — a leftover git worktree and the forked
package-manager (pnpm) store it pinned — are **not** touched by the on-demand Fix button.
They are reclaimed by the background sweep that runs at boot and daily: abandoned agent
worktrees are reaped, then the forked pnpm store is **partially** reclaimed — under inode
pressure it unlinks the store content nothing still references and prunes the emptied bucket
dirs, while keeping content a surviving worktree still hardlinks. So a store that is still
partly pinned frees its unlinked fraction rather than nothing at all.

## Host tuning — resource guardrails

**Settings → DIAGNOSE** includes a **Host capacity** check. On a systemd-managed
host it **warns** when Shepherd's unit has no memory or CPU guardrails
(`MemoryMax` / `MemoryHigh` / `CPUQuota`), so a runaway fan-out of sessions can
starve the box. Add limits to the unit — or to a dedicated slice such as
`shepherd.slice` — before running many concurrent sessions.

On a **user-scoped** install the check covers **both** units: Shepherd's own unit
and `herdr.service`, which runs your agent sessions. It stays `ok` only when
Shepherd is bounded *and* herdr is not positively unbounded, and it raises a
distinct warning for the case where Shepherd is bounded but herdr is not. A herdr
that isn't a loaded user unit (absent, masked, or system-scoped) can't be read, so
it's excluded from the verdict rather than reported as unbounded. The check also
**errors** when the kernel reports dangerous live memory/IO pressure (PSI), a cue
to pause or reduce active agent sessions until the host recovers. On non-systemd
or local dev hosts it stays quiet. Because sustained pressure is steady-state, the
background re-check is *not* accelerated on this error — use the Diagnostics
**Re-run** button for an on-demand live reading.

### Add a limit (one click)

On a user-scoped install with at least 6 GiB of RAM, the warning carries a **Fix**
button. It proposes a conservative, host-derived pair — `MemoryHigh` leaving
`clamp(15%, 2 GiB, 8 GiB)` of RAM headroom, `CPUQuota` leaving
`min(1 core, 15% of cores)` for the OS — and shows the exact values and units in a
confirm modal before anything is applied. Applying runs `systemctl --user
set-property` on **only** the units that are currently unbounded, so a limit you
set deliberately is never overwritten. Like the copy-paste command below, it is
live and persistent with no restart and no interrupted sessions.

It bounds each unit **on its own**; it does not create the shared cap across
Shepherd and herdr that a slice gives you — for that, use the slice setup below.

### Add a limit (copy-paste)

Shepherd installs as a **systemd user service** (`shepherd.service`), so you can
add a live, persistent guardrail without `sudo` or a restart. `set-property`
writes a drop-in under `~/.config/systemd/user.control/` and applies it
immediately:

```sh
# Tune the values to the host — e.g. MemoryHigh a few GB below total RAM,
# CPUQuota to leave headroom for the OS and other services. 300% = 3 cores.
systemctl --user set-property shepherd.service MemoryHigh=6G CPUQuota=300%
```

Setting **any** of `MemoryHigh`, `MemoryMax`, or `CPUQuota` on a unit marks that
unit bounded. `MemoryHigh` throttles and reclaims *before* the harder `MemoryMax`
OOM-kill ceiling, so it's the safer first lever.

On a user-scoped install the command above is not enough on its own to clear the
**Host capacity** warning: agent sessions run under **herdr**, a *separate* unit,
so a limit on `shepherd.service` alone bounds Shepherd but not the sessions that
actually consume the box — and where herdr is a loaded user unit, the check keeps
warning until it is bounded too. Repeat the `set-property` for it:

```sh
systemctl --user set-property herdr.service MemoryHigh=6G CPUQuota=300%
```

For **real** protection, prefer a shared **slice** — a per-unit limit on each of
the two still lets them add up to twice the ceiling. Put both units in one slice
and limit the slice instead:

```ini
# ~/.config/systemd/user/shepherd.slice
[Slice]
MemoryHigh=12G
CPUQuota=600%
```

```ini
# ~/.config/systemd/user/shepherd.service.d/slice.conf   (same for herdr.service)
[Service]
Slice=shepherd.slice
```

`Slice=` is assigned at unit load, not via `set-property`, so this pair needs a
reload + restart to take effect (the restart briefly drops the HUD):

```sh
systemctl --user daemon-reload
systemctl --user restart herdr.service shepherd.service
```

A **system**-level install (unit under `/etc/systemd/system/`) takes the same
properties via `sudo systemctl set-property …` or an equivalent drop-in there.
