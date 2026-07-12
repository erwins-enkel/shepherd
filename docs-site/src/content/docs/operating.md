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

Shepherd keeps spawned agents' Node compile cache **off** the `/tmp` tmpfs and runs
an inode-guard sweep on **startup + daily** that, once `/tmp` inode use crosses a
threshold, drops the compile cache and stale regenerable tool caches (but never a
live session's scratch). As a host-level belt on long-uptime hosts, raise `/tmp`'s
`nr_inodes` in `/etc/fstab`:

```text
tmpfs /tmp tmpfs nr_inodes=4194304 0 0
```

The relevant override env vars (`SHEPHERD_NODE_COMPILE_CACHE`,
`SHEPHERD_TMP_INODE_PCT`, `SHEPHERD_TMP_STALE_HOURS`, `SHEPHERD_TMP_SWEEP_DIR`) are
listed in [Configuration](/reference/configuration/).
