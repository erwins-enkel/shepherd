---
title: On-demand Postgres
description: Let agents ask Shepherd for their own Postgres database on a shared local server that only runs while it is needed.
---

Shepherd can run **one shared Postgres 18 server** for all your repos and start it
only when an agent needs a database. Each session gets its **own database**, a
copy of its repo's template, and the copy is dropped when the session is
archived. No project needs its own Docker Compose file for Postgres, and agents
never need Docker access inside their sandbox.

It is **off by default**: turn it on for this machine, then pick the repos that
get it.

## Requirements

- **Docker on the Shepherd host**, reachable by the user Shepherd runs as
  (rootless Docker works). Shepherd pulls `postgres:18` on first use.
- A **Claude** task session, on any sandbox profile. An **Autonomous** session
  reaches the server through its sandbox's gateway (`10.0.2.2`); its firewall
  opens the Postgres port when the session starts or resumes, so after switching
  Postgres on, resume a running Autonomous session. Codex sessions don't get the
  tool yet; they are told not to substitute a database of their own.

## Turn it on

1. **Settings → Resources → Postgres:** switch on **Run Postgres on demand**.
   - **Port** (default `54318`) is published on `127.0.0.1` only.
   - **Idle minutes** (default 15): the server stops after this long with no
     client connections.
   - **Image** (default `postgres:18`): keep it on one major version.
   Changing the port or image recreates the container on the next request; the
   data volume is kept.
2. **Pick the repos.** Under **Repos with Postgres** in the same block, type a
   repo's name and pick it to switch it on; **✕** switches a repo off again. You
   can pick repos before turning the server on: they get the tool once it is on.
   This is the same switch as **Repo settings → Agent → Postgres on request**,
   so either place works. Sessions pick up the tool at their next spawn or
   resume.

## How agents use it

The agent calls the `postgres_request` tool. It answers either:

- `ready` with `dsn` (plus `host`, `port`, `database`, `user`, `password`). The
  agent passes the DSN to its app and tests as `DATABASE_URL`.
- `starting` while the server is still coming up (the first use may pull the
  image). The agent calls again.

The tool is idempotent: every call in a session returns the same credentials. If
a connection is refused later, the server stopped while idle, and calling the
tool again starts it.

Sessions that have the tool also get a short note in their system prompt with
these rules, so they don't add a Compose Postgres or ask you how to connect.

## Build apps against it

Any project that uses this Postgres follows one contract, so agents never need to
ask how the app reaches its database:

- The app reads its connection from **`DATABASE_URL`**. The standard libpq
  variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) work too.
  Nothing hardcodes a host, port or password.
- **No Compose file or container for Postgres.** `DATABASE_URL` comes from
  `postgres_request` in an agent session, from the `db` job's service container
  in CI, and from the deployment's environment in production.
- **Schema and seed data come from migrations**, run by one command against
  `DATABASE_URL`. It turns an empty database into the current schema and is safe
  to run again. A session's database starts as a copy of the repo template, which
  may be empty.
- **Locally, `DATABASE_URL` lives in a gitignored `.env`.** Only `.env.example`,
  with a placeholder, is committed. A variable already set in the process
  environment wins over `.env`; that is the default for dotenv, Vite and Bun, so
  leave it that way and don't turn on an override.
- **Tests use the same `DATABASE_URL`.** Each session's database is its own and
  is thrown away on archive.

A **bootstrap** session writes this contract into the new project's `CLAUDE.md`
under `## Database`, and its P3 session adds the section when it is missing. Both
check whether Postgres is on for the repo and, when it is off, ask you to switch
on the machine setting and the repo toggle above.

A later Shepherd release may set `DATABASE_URL` and the `PG*` variables in the
session environment itself, with the same values the tool returns. Because the
process environment wins over `.env`, a project built to this contract keeps
working unchanged.

## Lifecycle

- **Per repo** Shepherd keeps a template database. It starts empty.
- **Per session** the first request clones the template (on btrfs/XFS the copy
  shares blocks and takes well under a second; on ext4 it is a full copy).
- **Archiving** a session drops its database and role. If the server is stopped
  at that moment, the drop happens the next time it starts.
- **At startup and hourly** Shepherd drops leftover session databases that no
  live session owns.
- **Roles your migrations create** (for example a non-owner app role for
  row-level security) belong to the repo. Every session of that repo can use
  and grant them, including sessions started later. Shepherd never drops them.
  Roles are server-wide: if another repo already has a role with the same name,
  the migration's `GRANT` is refused. A session that was already running when a
  sibling first created a role can be refused for up to a minute; re-running the
  migrations then works.

## Security

The port is reachable from every Trusted and Standard sandbox on this machine;
the boundary is the credentials. Each session's role can connect only to its own
database, and the superuser password never leaves Shepherd. A session's role
may create roles (`CREATEROLE`), so migrations can set up app roles. Postgres
still refuses it superuser, `BYPASSRLS` and `CREATEDB` roles, built-in `pg_*`
roles, and changes to other sessions' roles. Details:
[sandbox security notes](https://github.com/erwins-enkel/shepherd/blob/main/docs/sandbox-security.md#on-demand-postgres-4232).

## Diagnose

The **Diagnose** panel shows an **On-demand Postgres** row while the feature is
on: whether Docker is reachable and whether the server is stopped, running, or
waiting to be recreated after a settings change.
