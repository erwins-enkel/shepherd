# Backups & restore

Shepherd's entire state lives in one SQLite file (`~/.shepherd/shepherd.db`). This doc covers the
automated hourly backups and how to restore from one. (Issue #1080.)

## What runs

A systemd **user** timer (`shepherd-backup.timer`, `OnCalendar=hourly`, `Persistent=true`) triggers
a oneshot service that runs `scripts/backup.ts` — out-of-process from the server, so snapshot I/O
never touches the single Bun event loop.

Each run:

1. Opens the live DB **read-only** and `VACUUM INTO`s a temp snapshot — atomic and transactionally
   consistent on a running DB, compacted, and emitting no `-wal`/`-shm` sidecars.
2. Runs `PRAGMA integrity_check` on the raw snapshot. A failing snapshot is **discarded** (the run
   exits non-zero) — a corrupt snapshot is never kept.
3. gzips it (`Bun.gzipSync`) to a temp sibling, then **atomically renames** it to
   `shepherd-<YYYYMMDDTHHmmssZ>.db.gz` — a crashed run never leaves a half-file.
4. Applies **GFS rotation**.
5. Writes `.last-success` (ISO timestamp) and appends a line to `backup.log`.

### Locking

Both the server connection (`src/store.ts`) and the backup connection set `PRAGMA busy_timeout =
5000`. `VACUUM INTO` holds a shared read lock for its (sub-second) duration; the timeout makes a
concurrent server write **wait** for it rather than throwing `SQLITE_BUSY`. The wait is bounded by
the snapshot duration on a small DB.

## Layout & configuration

|                           |                                                         |
| ------------------------- | ------------------------------------------------------- |
| DB                        | `~/.shepherd/shepherd.db` — override `SHEPHERD_DB`      |
| Backups                   | `~/.shepherd/backups/` — override `SHEPHERD_BACKUP_DIR` |
| Per-run log               | `~/.shepherd/backups/backup.log`                        |
| Last success              | `~/.shepherd/backups/.last-success`                     |
| "Backups expected" marker | `~/.shepherd/backups/.backup-configured`                |
| Unit logs                 | `journalctl --user -u shepherd-backup`                  |

Overrides go in `~/.shepherd/env` (read by both `shepherd.service` and `shepherd-backup.service`).

> **Same-disk caveat.** Backups land on the same disk as the DB by default — this protects against
> corruption and accidental deletion, **not** disk/host failure (out of scope for v1). Point
> `SHEPHERD_BACKUP_DIR` at a different mount for that.

### GFS retention

A union keep-set, newest-per-bucket — everything else is pruned each run:

| Tier    | Keep | Bucket                                      |
| ------- | ---- | ------------------------------------------- |
| Hourly  | 48   | newest 48 overall                           |
| Daily   | 14   | newest per UTC day, 14 most-recent days     |
| Weekly  | 8    | newest per ISO week, 8 most-recent weeks    |
| Monthly | 12   | newest per UTC month, 12 most-recent months |

~82 small compacted files; monthlies reach ~1 year, outlasting the 30/60/90-day retention prunes.
Counts are tunable constants (`GFS` in `scripts/backup.ts`).

## Staleness alerting

The server's once-daily sweep does a **read-only** check: if `.backup-configured` exists (so the
host is _expected_ to back up), the marker is **itself older than 3h** (a grace window so a
just-configured host isn't flagged before its first backup runs), and `.last-success` is absent or
older than 3h, it emits a guaranteed log line, a durable `backup_stale` signal, and a best-effort
web push. This catches a hard run failure, a box broken from its first run, and a silently-dead
timer alike. (Provision/update also kick one backup immediately on enable, so a healthy host has a
`.last-success` within seconds.)

> **Detection latency.** The probe only runs once per daily sweep, so worst-case detection is ~24h —
> the 3h threshold defines _stale_, not how fast it's noticed. A host with **no** marker (macOS /
> core-only, which has no systemd timer) stays silent. If no push device is subscribed, the alert is
> still recorded in `shepherd.log` and the signal row.

## Restore

> A backup you've never restored isn't a backup.

```sh
deploy/shepherd-restore.sh            # list snapshots, then pick one
deploy/shepherd-restore.sh <file>     # restore a specific shepherd-*.db.gz
```

It stops `shepherd` **and** `shepherd-backup.timer` (so nothing reopens the DB mid-restore), copies
the current DB aside to `shepherd.db.pre-restore-<ts>`, removes any stale `*-journal`/`*-wal`/`*-shm`
sidecars (a crash-left rollback journal would otherwise be replayed into the restored file →
re-corruption), gunzips the snapshot into place, verifies `integrity_check = ok`, and restarts. If
the integrity check fails it aborts and leaves your previous DB at the `.pre-restore-<ts>` copy.

## macOS / core-only

No systemd ⇒ no backup timer ⇒ no `.backup-configured` marker ⇒ no automated backups and no
staleness alerts. Linux is the primary deployment target; on macOS, snapshot manually with
`SHEPHERD_DB=… bun run scripts/backup.ts` if needed.
