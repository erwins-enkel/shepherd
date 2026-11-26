/**
 * The app-side contract for Shepherd's on-demand Postgres (#4232 follow-up): how a project reaches
 * the database, so agents stop asking the operator. ONE source for the bootstrap directives
 * (src/bootstrap-directive.ts) and the `<postgres-notice>` spawn block (src/service.ts); the user
 * docs (docs-site postgres.md) and the `shepherd-onboarding` skill restate it in prose.
 *
 * #4238 alignment: env injection will set exactly `DATABASE_URL` + the `PG*` vars, with exactly the
 * values `postgres_request` returns. The process env wins over `.env`, so an app built against this
 * contract today keeps working unchanged once injection lands.
 *
 * Agent-facing prompt text → fixed English, no i18n (same precedent as the other spawn directives).
 * Never put a dotted version-like literal (e.g. a loopback IP) here: the bootstrap tests assert the
 * directive carries no version string the House Stack did not resolve.
 */

/** The project's `## Database` section, written VERBATIM into its CLAUDE.md by bootstrap. */
export const POSTGRES_APP_CONTRACT = [
  "- The app reads its Postgres connection from `DATABASE_URL` (libpq's `PGHOST`, `PGPORT`, " +
    "`PGUSER`, `PGPASSWORD`, `PGDATABASE` work too). Never hardcode a host, port or credential.",
  "- No Docker Compose file or container for Postgres. `DATABASE_URL` comes from Shepherd's " +
    "`postgres_request` tool in an agent session, from the `db` job's service container in CI, and " +
    "from the deployment's environment in production.",
  "- Schema and seed data come only from migrations, run by ONE command (listed in the verify " +
    "commands) against `DATABASE_URL`. It brings an empty database to the current schema and is " +
    "safe to re-run.",
  "- Locally `DATABASE_URL` lives in a gitignored `.env`; commit only `.env.example` with a " +
    "placeholder. A variable already set in the process environment wins over `.env`: keep the " +
    "env loader's default and never enable an override.",
  "- Tests use the same `DATABASE_URL`; an agent session's database is its own and disposable.",
].join("\n");

/** Where a session with the tool runs: its own worktree, or (isolation fallback) the shared
 *  checkout. `no-tool`: the repo uses Shepherd's Postgres but this session has no tool (#4239). */
export type PostgresNoticeMode = "worktree" | "shared-checkout" | "no-tool";

const NO_TOOL_NOTICE =
  "This repo uses Shepherd's on-demand Postgres, but this session has no `postgres_request` " +
  "tool. Never substitute PGlite, SQLite, an embedded or WASM Postgres, or a Postgres or Docker " +
  "container of your own. Use `DATABASE_URL` only when it is already set; otherwise leave the " +
  "database-backed checks (migrations, DB tests, e2e) to CI's `db` job and say so in your report.";

/**
 * The `<postgres-notice>` body. With the tool: how to get and keep the DSN — a session in the shared
 * repo checkout never gets the `.env` route (a second such session would overwrite it and point the
 * first at the wrong database). Without it: never improvise a database.
 */
export function postgresSessionNotice(mode: PostgresNoticeMode): string {
  if (mode === "no-tool") return NO_TOOL_NOTICE;
  const keepIt =
    mode === "worktree"
      ? "write `DATABASE_URL=<dsn>` to `.env` only when `git check-ignore -q .env` succeeds, " +
        "otherwise prefix each command with it"
      : "prefix each command with `DATABASE_URL=<dsn>` (this session shares the repo checkout, so " +
        "never write it to `.env`)";
  return (
    "This repo uses Shepherd's on-demand Postgres. When you need a database (app, tests, " +
    "migrations), call `postgres_request` (shepherd MCP server) and use the returned `dsn` as " +
    "`DATABASE_URL`. Never add a Docker Compose Postgres or start your own. Shell env does not " +
    `persist between commands: ${keepIt}. Never commit the DSN or hardcode credentials. On ` +
    "`starting`, or a later connection refused, call `postgres_request` again. The database is " +
    "this session's own copy of the repo's template (it may be empty), dropped when the session " +
    "is archived: run the repo's migrations before use."
  );
}

/** What one session can see of Shepherd's Postgres at spawn. */
export interface PostgresAvailability {
  /** The session has the `postgres_request` tool (the `postgresRequest` capability). */
  tool: boolean;
  /** Settings → Resources → Postgres is on for this machine. */
  globalEnabled: boolean;
  /** The repo's `postgresMode` is `on-request`. */
  repoOn: boolean;
}

const MACHINE_SWITCH = "**Settings → Resources → Postgres → Run Postgres on demand**";
const REPO_SWITCH = "**Repo settings → Agent → Postgres on request**";

/** One status sentence for the bootstrap directives: on, on without the tool, or which switch is off. */
export function postgresStatusLine(a: PostgresAvailability): string {
  if (a.tool) {
    return (
      "Shepherd's Postgres is ON for this repo and this session has the `postgres_request` tool: " +
      "follow `<postgres-notice>` to get your own database."
    );
  }
  if (a.globalEnabled && a.repoOn) {
    return (
      "Shepherd's Postgres is ON for this repo, but this session has no `postgres_request` tool " +
      "(Codex sessions don't get it yet). Build against the contract anyway; CI's " +
      "`db` job proves the migrations."
    );
  }
  const off = [a.globalEnabled ? null : MACHINE_SWITCH, a.repoOn ? null : REPO_SWITCH]
    .filter((s): s is string => s !== null)
    .join(" and ");
  return (
    `Shepherd's Postgres is OFF for this repo. If the project needs Postgres, ask the operator to ` +
    `switch on ${off}, then to resume this session: Claude Trusted/Standard sessions get the ` +
    "`postgres_request` tool on resume, and the drain sessions need it too. Meanwhile build " +
    "against the contract anyway; never add a Compose Postgres instead."
  );
}
