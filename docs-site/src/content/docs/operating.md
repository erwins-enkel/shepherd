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

Add the public hostname to `SHEPHERD_ALLOWED_HOSTS` (the unit ships with the
Tailscale name). Access control is layered: the network reach is gated by
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

## herdr server lifecycle & "Update Herd"

Shepherd drives herdr but **does not own the herdr server's lifecycle** — the
daemon is normally auto-spawned on demand by any `herdr` CLI call. **"Update
Herd"** swaps the herdr binary (`herdr update --handoff`), which stops the running
server for the swap. Afterwards Shepherd makes a best-effort attempt to bring it
back: it runs `herdr agent list` (which auto-spawns the daemon) with a short
grace+retry, and only if that still fails does it relaunch a detached server so
orphaned panes reattach.

If you run the herdr **server** under your own systemd unit, use
**`Restart=always`**, not `Restart=on-failure`. The stop during an update is a
_clean_ exit (status 0), which `Restart=on-failure` does **not** treat as a restart
trigger — so the server would stay down after "Update Herd", leaving a stale
`~/.config/herdr/herdr.sock` and clients looping on `ConnectionRefused`.
`Restart=always` survives that clean stop and is the durable fix; Shepherd's
post-update recovery above is a subordinate best-effort belt (its relaunched server
is a child of Shepherd's cgroup and is not durable across a `systemctl restart
shepherd`).

Every "Update Herd" run appends one delimited block to `~/.shepherd/herdr-update.log`
— written by the update child itself, so the record survives even if Shepherd dies
mid-update:

```bash
grep '>>> herdr-update' ~/.shepherd/herdr-update.log   # each step marker + the exit code
```

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
