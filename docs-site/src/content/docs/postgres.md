---
title: On-demand Postgres
description: Let agents ask Shepherd for their own Postgres database on a shared local server that only runs while it is needed.
---

Shepherd can run **one shared Postgres 18 server** for all your repos and start it
only when an agent needs a database. Each session gets its **own database**, a
copy of its repo's template, and the copy is dropped when the session is
archived. No project needs its own Docker Compose file for Postgres, and agents
never need Docker access inside their sandbox.

It is **off by default**: turn it on for this machine, then per repo.

## Requirements

- **Docker on the Shepherd host**, reachable by the user Shepherd runs as
  (rootless Docker works). Shepherd pulls `postgres:18` on first use.
- A **Claude** task session running **Trusted** or **Standard**. Autonomous and
  Codex sessions don't get the tool yet.

## Turn it on

1. **Settings → Resources → Postgres:** switch on **Run Postgres on demand**.
   - **Port** (default `54318`) is published on `127.0.0.1` only.
   - **Idle minutes** (default 15): the server stops after this long with no
     client connections.
   - **Image** (default `postgres:18`): keep it on one major version.
   Changing the port or image recreates the container on the next request; the
   data volume is kept.
2. **Repo settings → Agent → Postgres on request:** switch it on for each repo
   that needs a database. Sessions pick up the tool at their next spawn or
   resume.

## How agents use it

The agent calls the `postgres_request` tool. It answers either:

- `ready` with `dsn` (plus `host`, `port`, `database`, `user`, `password`). The
  agent passes the DSN to its app and tests, for example as `DATABASE_URL`.
- `starting` while the server is still coming up (the first use may pull the
  image). The agent calls again.

The tool is idempotent: every call in a session returns the same credentials. If
a connection is refused later, the server stopped while idle, and calling the
tool again starts it.

## Lifecycle

- **Per repo** Shepherd keeps a template database. It starts empty.
- **Per session** the first request clones the template (on btrfs/XFS the copy
  shares blocks and takes well under a second; on ext4 it is a full copy).
- **Archiving** a session drops its database and role. If the server is stopped
  at that moment, the drop happens the next time it starts.
- **At startup and hourly** Shepherd drops leftover session databases that no
  live session owns.

## Security

The port is reachable from every Trusted and Standard sandbox on this machine;
the boundary is the credentials. Each session's role can connect only to its own
database, and the superuser password never leaves Shepherd. Details:
[sandbox security notes](https://github.com/erwins-enkel/shepherd/blob/main/docs/sandbox-security.md#on-demand-postgres-4232).

## Diagnose

The **Diagnose** panel shows an **On-demand Postgres** row while the feature is
on: whether Docker is reachable and whether the server is stopped, running, or
waiting to be recreated after a settings change.
