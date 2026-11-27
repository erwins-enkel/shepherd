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
  Postgres on, resume a running Autonomous session. Codex sessions have no
  tool: they get their database through **Database at every spawn** (below).

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
3. **Optional: Database at every spawn.** Under the repo's **Postgres on
   request** switch, tick **Database at every spawn** to give every session its
   database without asking: Shepherd clones it in the background at spawn and
   sets the connection in the session's environment. Codex sessions need this,
   since they have no `postgres_request` tool. Repos with it show an **auto**
   tag in the **Repos with Postgres** list.
4. **Optional: Superuser-like test privileges.** Tick it under the same switch
   when the repo's tests expect the admin connection to act like the CI
   superuser. The session's role then gets `BYPASSRLS` (seeding tables with
   `FORCE ROW LEVEL SECURITY`), may `SET session_replication_role = replica`,
   and sees the queries and lock waits of the roles it creates (and the repo's
   shared app roles) in `pg_stat_activity`. It applies the
   next time the session's database is set up: its next `postgres_request` or
   `postgres_reset`, or its next spawn with **Database at every spawn**.

## How agents use it

The agent calls the `postgres_request` tool. It answers either:

- `ready` with `dsn` (plus `host`, `port`, `database`, `user`, `password`). The
  agent passes the DSN to its app and tests as `DATABASE_URL`.
- `starting` while the server is still coming up (the first use may pull the
  image). The agent calls again.

The tool is idempotent: every call in a session returns the same credentials. If
a connection is refused later, the server stopped while idle, and calling the
tool again starts it.

Two more tools come with it:

- `postgres_reset` throws the session's database away and re-creates it as a
  fresh copy of the repo template, with the same credentials. It answers like
  `postgres_request`.
- `postgres_status` shows whether the server is off, stopped, starting or
  running and whether the session has a database. It never starts the server
  and returns no credentials.

Sessions that have the tool also get a short note in their system prompt with
these rules, so they don't add a Compose Postgres or ask you how to connect.

## Connection in the environment

Shepherd sets **`DATABASE_URL`** plus **`PGHOST`**, **`PGPORT`**, **`PGUSER`**,
**`PGPASSWORD`** and **`PGDATABASE`** in a session's environment, with exactly
the values `postgres_request` returns:

- at **every spawn and resume** when **Database at every spawn** is on (the
  database may still be starting for a moment; agents retry a refused
  connection), and
- at **resume** of a session that already asked for its database with the tool.

The values never appear on a command line: they reach the agent through
private files that a small launcher exports. An Autonomous session's
`PGHOST` is its sandbox gateway (`10.0.2.2`).

The **live preview** gets the same variables (host `127.0.0.1`) when its
session has a database, so the repo's `preview-start.sh` reads `$DATABASE_URL`
instead of starting its own Postgres.

A Codex session can't restart a server that stopped while idle. If its
connection stays refused, it leaves database checks to CI; resuming the session
starts the server again.

## Build apps against it

Any project that uses this Postgres follows one contract, so agents never need to
ask how the app reaches its database:

- The app reads its connection from **`DATABASE_URL`**. The standard libpq
  variables (`PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`) work too.
  Nothing hardcodes a host, port or password.
- **No Compose file or container for Postgres.** `DATABASE_URL` is set by
  Shepherd (or comes from `postgres_request`) in an agent session, from the `db` job's service container
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

When Shepherd sets `DATABASE_URL` and the `PG*` variables in the session
environment (see above), the process environment wins over `.env`, so a project
built to this contract keeps working unchanged.

## Lifecycle

- **Per repo** Shepherd keeps a template database. It starts empty.
- **Per session** the first request (or the spawn, with **Database at every
  spawn**) clones the template (on btrfs/XFS the copy
  shares blocks and takes well under a second; on ext4 it is a full copy).
- **Promoting** a session's database makes it the repo's new template (see
  below).
- **Archiving** a session drops its database and role, and every database the
  session created (for example a test harness's per-run databases). If the server is stopped
  at that moment, the drop happens the next time it starts.
- **At startup and hourly** Shepherd drops leftover session databases that no
  live session owns.
- **Roles your migrations create** (for example a non-owner app role for
  row-level security) belong to the repo. Every session of that repo can use
  and grant them, including sessions started later. Shepherd never drops them.
  Roles are server-wide: if another repo already has a role with the same name,
  a migration that grants it to itself is refused. Give app roles a name
  specific to the project (for example `<project>_app`). A session that was already running when a
  sibling first created a role can be refused for up to a minute; re-running the
  migrations then works. Create shared roles `NOLOGIN`: a login role, or a role
  that owns a database, stays with the session that created it until that
  session is archived.
- **Databases your tests create** (Postgres 17 and newer): a session's role may
  `CREATE DATABASE`, so a harness that makes its own database and login role
  per run works unchanged. Point its admin connection at `DATABASE_URL`. Only
  the session's role and roles it created can connect to such a database. Don't
  give one a name Shepherd uses for its own databases (`s_<hex>`,
  `r_<repo>_base`).

## Update the template

A repo's template starts empty. When a session has migrated or seeded its
database into a state every later session should start from, make it the
template: right-click the session's card and choose **Make database the repo
template**, then click again to confirm. The item only shows while the session
has a database.

- Shepherd copies the session's database over the template. New sessions start
  from the copy; databases of sessions that already have one stay as they are.
- Grants and default privileges the migrations set (`ALTER DEFAULT PRIVILEGES`)
  carry over to the template and to every new session's database.
- The previous template is dropped. There is no undo, but the schema can always
  be rebuilt by the repo's migrations.
- The session's own connections are closed and refused for the few seconds the
  copy takes. Its database and credentials stay the same.
- If the server is stopped, promoting starts it.
- Promote before the session is archived: archiving drops its database.

## Security

The port is reachable from every Trusted and Standard sandbox on this machine;
the boundary is the credentials. Each session's role can connect only to its own
database, and the superuser password never leaves Shepherd. A session's role
may create roles (`CREATEROLE`), so migrations can set up app roles. Postgres
still refuses it superuser roles, built-in `pg_*` roles, and changes to other
sessions' roles, and `BYPASSRLS` unless the repo has **Superuser-like test
privileges** on. That setting reaches no other data: the role owns its
databases and could switch off row-level security there anyway, and the login
guard still fires in replica mode. Roles the repo's
migrations share are reset to `NOBYPASSRLS` about once a minute while the
server runs, and whenever a session's database is set up. Logins to Shepherd's own databases are pinned
to the database named like the user, so no role, however it was granted, opens
another session's database. On Postgres 17 and newer the role may also create
databases (`CREATEDB`). A login guard then lets into such a database only the
session that owns it and the roles that session alone administers. Details:
[sandbox security notes](https://github.com/erwins-enkel/shepherd/blob/main/docs/sandbox-security.md#on-demand-postgres-4232).

## Diagnose

The **Diagnose** panel shows an **On-demand Postgres** row while the feature is
on: whether Docker is reachable and whether the server is stopped, running, or
waiting to be recreated after a settings change.
