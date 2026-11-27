// On-demand Postgres (#4232) — the pure half: settings, identifiers, SQL scripts, DSN, idle rule.
// NO I/O. `src/postgres.ts` runs these scripts through `docker exec … psql -f -` (stdin), so no
// value here ever reaches argv; every identifier is validated before it is interpolated.
import { createHash, createHmac } from "node:crypto";
import { basename } from "node:path";

export const POSTGRES_SETTING = "postgres";
const POSTGRES_BASE_NAME = "shepherd-postgres-18";
export const POSTGRES_DATA_DIR = "/var/lib/postgresql";
export const POSTGRES_LABEL_MANAGED = "run.shepherd.managed";
export const POSTGRES_LABEL_KIND = "run.shepherd.kind";
export const POSTGRES_LABEL_IMAGE = "run.shepherd.image";
export const POSTGRES_LABEL_PORT = "run.shepherd.port";

/** `on-request`: a session gets a clone when it calls `postgres_request`. `auto` (#4238): every
 *  task session gets one at spawn, with the connection injected into its env (Codex too). */
export type PostgresMode = "off" | "on-request" | "auto";
export const POSTGRES_MODES: readonly PostgresMode[] = ["off", "on-request", "auto"];
export function isPostgresMode(v: unknown): v is PostgresMode {
  return typeof v === "string" && (POSTGRES_MODES as readonly string[]).includes(v);
}

/** The repo uses Shepherd's Postgres at all (any mode but `off`). */
export function postgresRepoOn(mode: string | null | undefined): boolean {
  return mode === "on-request" || mode === "auto";
}

export interface PostgresSettings {
  enabled: boolean;
  port: number;
  idleMinutes: number;
  image: string;
}

export const DEFAULT_POSTGRES_SETTINGS: PostgresSettings = {
  enabled: false,
  port: 54318,
  idleMinutes: 15,
  image: "postgres:18",
};

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const IMAGE_RE =
  /^(?:[a-z0-9.-]+(?::\d{1,5})?\/)?[a-z0-9]+(?:[._/-][a-z0-9]+)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** A docker image reference Shepherd will pass to `docker run`/`pull` (never starts with `-`). */
export function isImageRef(v: unknown): v is string {
  return typeof v === "string" && v.length <= 255 && IMAGE_RE.test(v);
}

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

function applyField(next: PostgresSettings, key: string, value: unknown): string | null {
  const at = `${POSTGRES_SETTING}.${key}`;
  switch (key) {
    case "enabled":
      if (typeof value !== "boolean") return `${at} must be a boolean`;
      next.enabled = value;
      return null;
    case "port":
      if (!isInt(value, 1024, 65535)) return `${at} must be an integer 1024..65535`;
      next.port = value;
      return null;
    case "idleMinutes":
      if (!isInt(value, 1, 1440)) return `${at} must be an integer 1..1440`;
      next.idleMinutes = value;
      return null;
    case "image":
      if (!isImageRef(value)) return `${at} must be a docker image reference`;
      next.image = value;
      return null;
    default:
      return `${at} is not a setting`;
  }
}

/** Apply a partial patch onto `current`; every named field is validated. */
export function parsePostgresPatch(
  raw: unknown,
  current: PostgresSettings,
): Parsed<PostgresSettings> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).length === 0)
    return { ok: false, error: `${POSTGRES_SETTING} must be a non-empty object` };
  const next = { ...current };
  for (const [key, value] of Object.entries(raw)) {
    const error = applyField(next, key, value);
    if (error) return { ok: false, error };
  }
  return { ok: true, value: next };
}

/** The stored setting, falling back to the defaults on absence or corruption. */
export function storedPostgresSettings(stored: string | null | undefined): PostgresSettings {
  if (!stored) return { ...DEFAULT_POSTGRES_SETTINGS };
  try {
    const parsed = parsePostgresPatch(JSON.parse(stored), { ...DEFAULT_POSTGRES_SETTINGS });
    return parsed.ok ? parsed.value : { ...DEFAULT_POSTGRES_SETTINGS };
  } catch {
    return { ...DEFAULT_POSTGRES_SETTINGS };
  }
}

/** Container + volume names for one Shepherd instance. Two instances on one host (a second state
 *  dir, docs/machines.md) must never share a cluster: each one's reconcile treats session DBs it
 *  has no lease for as orphans. The default `~/.shepherd` keeps the plain name; any other state
 *  dir gets a stable suffix derived from it. */
export function postgresInstanceNames(
  stateRoot: string,
  defaultRoot: string,
): { container: string; volume: string } {
  const name =
    stateRoot === defaultRoot
      ? POSTGRES_BASE_NAME
      : `${POSTGRES_BASE_NAME}-${createHash("sha256").update(stateRoot).digest("hex").slice(0, 8)}`;
  return { container: name, volume: name };
}

// ── identifiers ──────────────────────────────────────────────────────────────

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const SESSION_DB_RE = /^s_[0-9a-f]{32}$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`invalid postgres identifier: ${name}`);
  return name;
}

/** `r_<slug≤20>_<hash8>`: readable, unique per repo key (realpath), always a valid identifier. */
export function repoRole(repoPath: string): string {
  const slug = basename(repoPath)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 8);
  return ident(`r_${slug ? `${slug}_` : ""}${hash}`);
}

export function repoBaseDb(repoPath: string): string {
  return ident(`${repoRole(repoPath)}_base`);
}

/** `s_<uuid hex>` — the session's database AND login role. */
export function sessionDb(sessionId: string): string {
  const name = `s_${sessionId.toLowerCase().replace(/-/g, "")}`;
  if (!SESSION_DB_RE.test(name)) throw new Error(`invalid session id for postgres: ${sessionId}`);
  return name;
}

export function isSessionDbName(name: string): boolean {
  return SESSION_DB_RE.test(name);
}

/** Deterministic per-session password: HMAC of the session id under Shepherd's lease key. */
export function sessionPassword(leaseKey: string, sessionId: string): string {
  return createHmac("sha256", leaseKey).update(sessionId).digest("base64url").slice(0, 32);
}

const PASSWORD_RE = /^[A-Za-z0-9_-]{16,64}$/;
function literalPassword(password: string): string {
  if (!PASSWORD_RE.test(password)) throw new Error("invalid postgres password");
  return `'${password}'`;
}

const lit = (name: string) => `'${ident(name)}'`;

// ── SQL scripts (psql, fed on stdin, ON_ERROR_STOP) ──────────────────────────

/** Session roles hold CREATEROLE, so a session could create one of Shepherd's role names first (a
 *  squat) and keep ADMIN on it. Revoke every non-superuser admin holder, CASCADE taking the grants
 *  made through that admin; legit memberships are superuser-granted without ADMIN and stay. */
function revokeAdminHolders(role: string): string {
  return `SELECT format('REVOKE %I FROM %I CASCADE', r.rolname, m.rolname) FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE r.rolname = ${lit(role)} AND a.admin_option AND NOT m.rolsuper\\gexec`;
}

const PG16 = "pg_catalog.current_setting('server_version_num')::int >= 160000";
const PG17 = "pg_catalog.current_setting('server_version_num')::int >= 170000";

/** #4270: startup options for EVERY admin psql connection (env `PGOPTIONS`, so each `\\connect`
 *  gets them too). Shepherd connects as the superuser into session-owned databases (clones,
 *  `_next`); their owner can `ALTER DATABASE … SET search_path` / `role` and plant functions
 *  that would otherwise resolve before pg_catalog. Client options override those settings. */
export const ADMIN_PGOPTIONS = "-c search_path=pg_catalog,pg_temp -c role=none";
const SESSION_ROLE_PATTERN = "^s_[0-9a-f]{32}$";

/** The role row of `name`, or NULL — so a missing role matches nothing (no `::regrole` error). */
const roleOid = (name: string) => `(SELECT oid FROM pg_roles WHERE rolname = ${lit(name)})`;

/** Force-drop every database `where` selects (alias `d`), one `\\gexec` row each. Postgres refuses
 *  to drop a template database — even for a superuser, even WITH (FORCE) — and an owner can set
 *  IS_TEMPLATE at will (#4270). So each one is parked on the superuser first (its owner can no
 *  longer re-set the flag), un-templated, then dropped. A missing database matches nothing. */
function forceDropSql(where: string): string {
  return (
    `SELECT format('ALTER DATABASE %I OWNER TO postgres', d.datname), ` +
    `format('ALTER DATABASE %I IS_TEMPLATE false', d.datname), ` +
    `format('DROP DATABASE %I WITH (FORCE)', d.datname) FROM pg_database d WHERE ${where}\\gexec`
  );
}

/** {@link forceDropSql} for one database name. */
const forceDropNamedSql = (name: string) => forceDropSql(`d.datname = ${lit(name)}`);

/** SQL boolean: role `r` belongs to tenant `t` (both oid expressions). `r = t`, or `t` created `r`
 *  (its ADMIN row with a superuser grantor: PG16+ records the creator's self-grant that way, the
 *  creator can't revoke it, later grants carry the granting role) AND no other non-superuser
 *  holds ADMIN on `r` (no repo-role adoption, no grant by another session). */
function trustedSql(r: string, t: string): string {
  return (
    `(${r} = ${t} OR (EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.grantor ` +
    `WHERE a.roleid = ${r} AND a.member = ${t} AND a.admin_option AND g.rolsuper) ` +
    `AND NOT EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member ` +
    `WHERE a.roleid = ${r} AND a.admin_option AND NOT m.rolsuper AND m.oid <> ${t})))`
  );
}

/** #4270: the login guard. On PG17+ a session role holds CREATEDB, and a database it creates gets
 *  default PUBLIC CONNECT; hba lets every name that isn't Shepherd's through (`HBA_LINES_PG17`).
 *  This superuser-owned `ON login` event trigger is then the boundary: it admits superusers, and
 *  `session_user` only when some TENANT `t` — a session role (`s_<id>`) no non-superuser
 *  administers — has both the database owner and the user (`trustedSql`). New databases copy it
 *  from their template, so it is installed in every database a session can copy: template1, each
 *  repo base (clones inherit it) and each clone (`finishScript`). */
const GUARD_FUNCTION = `CREATE OR REPLACE FUNCTION shepherd.login_guard() RETURNS event_trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $guard$
DECLARE
  u oid := (SELECT oid FROM pg_roles WHERE rolname = session_user);
  o oid := (SELECT datdba FROM pg_database WHERE datname = current_database());
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE oid = u) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles t WHERE t.rolname ~ '${SESSION_ROLE_PATTERN}'
      AND NOT EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member
        WHERE a.roleid = t.oid AND a.admin_option AND NOT m.rolsuper)
      AND ${trustedSql("o", "t.oid")} AND ${trustedSql("u", "t.oid")}) THEN
    RETURN;
  END IF;
  RAISE EXCEPTION 'role % may not connect to database %', session_user, current_database();
END
$guard$;`;

/** Install the guard in the CURRENT database (run as the superuser after `\\connect`). PG17+ only
 *  (login event triggers). A `shepherd` schema or function a session owns (pre-created in its
 *  own clone) is dropped first, CASCADE taking any event trigger bound to it: the superuser
 *  never binds or runs a session-owned function. Idempotent. */
export const GUARD_SQL = [
  `SELECT ${PG17} AS shepherd_pg17 \\gset`,
  "\\if :shepherd_pg17",
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles o ON o.oid = n.nspowner WHERE n.nspname = 'shepherd' AND NOT o.rolsuper) " +
    "OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_roles o ON o.oid = p.proowner WHERE n.nspname = 'shepherd' AND NOT o.rolsuper) " +
    "AS shepherd_tainted \\gset",
  "\\if :shepherd_tainted",
  "DROP SCHEMA shepherd CASCADE;",
  "\\endif",
  "CREATE SCHEMA IF NOT EXISTS shepherd AUTHORIZATION postgres;",
  "REVOKE ALL ON SCHEMA shepherd FROM PUBLIC;",
  GUARD_FUNCTION,
  "REVOKE ALL ON FUNCTION shepherd.login_guard() FROM PUBLIC;",
  "SELECT 'CREATE EVENT TRIGGER shepherd_login_guard ON login EXECUTE FUNCTION shepherd.login_guard()' WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = 'shepherd_login_guard')\\gexec",
  "\\endif",
].join("\n");

/** Force-drop every database owned by session role `db` or by a role it created (its ADMIN row
 *  with a superuser grantor), the clone included. Used by `dropScript`, the squat cleanup in
 *  `roleScript`, and first in `PostgresService.drop()` — before adoption, so no adopted role ever
 *  owns a database of the session. A missing role matches nothing. */
export function dropOwnedDbsSql(db: string): string {
  if (!isSessionDbName(db)) throw new Error(`refusing to sweep non-session role: ${db}`);
  const r = roleOid(db);
  return forceDropSql(
    `d.datdba = ${r} OR d.datdba IN (SELECT a.roleid FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.grantor ` +
      `WHERE a.member = ${r} AND a.admin_option AND g.rolsuper)`,
  );
}

/** Repo role + template. The template is owned by the superuser: the repo role owns NO database,
 *  so `REASSIGN OWNED` in a clone only moves objects inside that clone. A base a session created
 *  first (CREATEDB, #4270) is not superuser-owned: it is dropped and re-created. Ends in the base
 *  with the login guard installed, so every clone inherits it. */
export function baseScript(repoPath: string): string {
  const role = repoRole(repoPath);
  const base = repoBaseDb(repoPath);
  return [
    `SELECT 'CREATE ROLE ${role} NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(role)})\\gexec`,
    forceDropSql(
      `d.datname = ${lit(base)} AND NOT (SELECT o.rolsuper FROM pg_roles o WHERE o.oid = d.datdba)`,
    ),
    `SELECT 'CREATE DATABASE ${base}' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${lit(base)})\\gexec`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${base} FROM PUBLIC;`,
    // A squatted repo role: drop its admin holders and any attributes they gave it.
    revokeAdminHolders(role),
    `ALTER ROLE ${role} NOLOGIN NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD NULL;`,
    `\\connect ${base}`,
    GUARD_SQL,
    "",
  ].join("\n");
}

/** Login role (password always (re)set) + clone of the template when the clone is missing. The
 *  clone path ends in the clone DB (`\connect`), so it is a separate script. CREATEROLE lets the
 *  repo's migrations create app roles (PG16+ limits it to roles it administers, no SUPERUSER /
 *  BYPASSRLS / CREATEDB); membership in the repo role inherits ADMIN on the roles sibling sessions
 *  created (`adoptScript`). Re-applied on every request, so older session roles get it too.
 *  PG16+ only (`PG16`); on older servers the role stays NOCREATEROLE. */
export function roleScript(
  sessionId: string,
  password: string,
  repoPath: string,
  { verified = true }: { verified?: boolean } = {},
): string {
  const db = sessionDb(sessionId);
  // A squatted session role (session ids are in agent env): it has a non-superuser ADMIN holder
  // (a creator can't revoke its own ADMIN), or — its creator since dropped — it already exists
  // while its lease is not yet VERIFIED (no roleScript succeeded for it: Shepherd never leaves a
  // role behind a deleted lease, and a failed cleanup leaves the lease unverified for the retry).
  const preexisting = verified ? "" : ` OR ${roleOid(db)} IS NOT NULL`;
  return [
    `SELECT EXISTS (SELECT 1 FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member WHERE a.roleid = ${roleOid(db)} AND a.admin_option AND NOT m.rolsuper)${preexisting} AS shepherd_squatted \\gset`,
    `SELECT 'CREATE ROLE ${db} LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(db)})\\gexec`,
    // Drop its admin holders, then reset everything a holder could have set, before the password
    // and before the clone exists.
    revokeAdminHolders(db),
    `ALTER ROLE ${db} WITH LOGIN NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS INHERIT CONNECTION LIMIT -1 VALID UNTIL 'infinity' PASSWORD ${literalPassword(password)};`,
    `ALTER ROLE ${db} RESET ALL;`,
    `SELECT format('ALTER ROLE %I IN DATABASE %I RESET ALL', ${lit(db)}, d.datname) FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase WHERE s.setrole = (SELECT oid FROM pg_roles WHERE rolname = ${lit(db)})\\gexec`,
    // #4270: what the squatter made AS the role survives the revoke. Drop the databases it (or a
    // role it created) owns, then every ADMIN membership of the role — the creator rows of roles
    // made while squatting, which the login guard would trust. No DROP ROLE: grants or objects
    // the squatter left in databases this psql never visits could block it.
    "\\if :shepherd_squatted",
    dropOwnedDbsSql(db),
    forceDropNamedSql(db),
    `SELECT format('REVOKE %I FROM %I GRANTED BY %I CASCADE', r.rolname, ${lit(db)}, g.rolname) FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles g ON g.oid = a.grantor WHERE a.member = ${roleOid(db)} AND a.admin_option\\gexec`,
    "\\endif",
    // A database named like the clone that the role doesn't own was made by someone else.
    forceDropSql(`d.datname = ${lit(db)} AND d.datdba IS DISTINCT FROM ${roleOid(db)}`),
    // Before PG16, CREATEROLE is close to superuser (any role's password, any grant) and the
    // INHERIT/SET grant syntax doesn't exist: an older configured image gets neither.
    `SELECT 'ALTER ROLE ${db} CREATEROLE' WHERE ${PG16}\\gexec`,
    `SELECT 'GRANT ${repoRole(repoPath)} TO ${db} WITH INHERIT TRUE, SET FALSE' WHERE ${PG16}\\gexec`,
    `SELECT count(*) FROM pg_database WHERE datname = ${lit(db)};`,
    "",
  ].join("\n");
}

/** `pg_default_acl.defaclobjtype` → the `ALTER DEFAULT PRIVILEGES … ON <kind>` keyword. */
const ACL_KIND =
  "CASE d.defaclobjtype WHEN 'r' THEN 'TABLES' WHEN 'S' THEN 'SEQUENCES' WHEN 'f' THEN 'FUNCTIONS' " +
  "WHEN 'T' THEN 'TYPES' WHEN 'n' THEN 'SCHEMAS' END";

/** Remove every default-privilege row of `role` in the current database (#4240): revoke each entry,
 *  then give a global row back the built-in default (owner ALL; PUBLIC EXECUTE on functions, USAGE
 *  on types) — Postgres deletes a row that equals the default, and a schema row once empty. One
 *  query, so every statement is computed from the rows as they were before any of them runs. */
export function clearDefaultAclsSql(role: string): string {
  ident(role);
  const r = lit(role);
  const scope =
    "CASE WHEN d.defaclnamespace <> 0 THEN ' IN SCHEMA ' || quote_ident(n.nspname) ELSE '' END";
  return (
    `SELECT stmt FROM (` +
    `SELECT 1 AS ord, format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s REVOKE ALL ON %s FROM %s', ${r}, ${scope}, ${ACL_KIND}, ` +
    `CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(a.grantee)) END) AS stmt ` +
    `FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a ` +
    `WHERE d.defaclrole = ${r}::regrole ` +
    `UNION ALL SELECT 2, format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT ALL ON %s TO %I', ${r}, ${ACL_KIND}, ${r}) ` +
    `FROM pg_default_acl d WHERE d.defaclrole = ${r}::regrole AND d.defaclnamespace = 0 ` +
    `UNION ALL SELECT 3, format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT %s TO PUBLIC', ${r}, ` +
    `CASE d.defaclobjtype WHEN 'f' THEN 'EXECUTE ON FUNCTIONS' ELSE 'USAGE ON TYPES' END) ` +
    `FROM pg_default_acl d WHERE d.defaclrole = ${r}::regrole AND d.defaclnamespace = 0 AND d.defaclobjtype IN ('f', 'T')` +
    `) s ORDER BY ord\\gexec`
  );
}

/** Re-issue `from`'s default privileges (`ALTER DEFAULT PRIVILEGES`) as `FOR ROLE to`, in the
 *  current database (#4240). `REASSIGN OWNED` does not move them and `DROP OWNED` deletes them, so a
 *  migration's `ALTER DEFAULT PRIVILEGES … GRANT … TO app_role` would otherwise vanish on promote
 *  and never reach a clone's session role. A global row fully replaces the built-in default, so it
 *  is reset first (`REVOKE ALL … FROM PUBLIC, to`); a schema row only adds. `from` itself as a
 *  grantee maps to `to`. */
export function copyDefaultAclsSql(from: string, to: string): string {
  ident(from);
  ident(to);
  return [
    `SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON %s FROM PUBLIC, %I', ${lit(to)}, ${ACL_KIND}, ${lit(to)}) ` +
      `FROM pg_default_acl d WHERE d.defaclrole = ${lit(from)}::regrole AND d.defaclnamespace = 0\\gexec`,
    `SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I%s GRANT %s ON %s TO %s%s', ${lit(to)}, ` +
      `CASE WHEN d.defaclnamespace <> 0 THEN ' IN SCHEMA ' || quote_ident(n.nspname) ELSE '' END, ` +
      `a.privilege_type, ${ACL_KIND}, ` +
      `CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = d.defaclrole THEN quote_ident(${lit(to)}) ` +
      `ELSE quote_ident(pg_get_userbyid(a.grantee)) END, ` +
      `CASE WHEN a.is_grantable THEN ' WITH GRANT OPTION' ELSE '' END) ` +
      `FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) a ` +
      `WHERE d.defaclrole = ${lit(from)}::regrole\\gexec`,
  ].join("\n");
}

export function cloneScript(repoPath: string, sessionId: string): string {
  const db = sessionDb(sessionId);
  return [
    "SET file_copy_method = clone;",
    `CREATE DATABASE ${db} TEMPLATE ${repoBaseDb(repoPath)} STRATEGY FILE_COPY OWNER ${db};`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC;`,
    `\\connect ${db}`,
    `REASSIGN OWNED BY ${repoRole(repoPath)} TO ${db};`,
    copyDefaultAclsSql(repoRole(repoPath), db),
    clearDefaultAclsSql(repoRole(repoPath)),
    "",
  ].join("\n");
}

/** End of every provision (#4270): the login guard in the clone (older clones predate it), then —
 *  PG17+ only, and only now that template1 (HARDEN) and the clone carry the guard — CREATEDB.
 *  `roleScript` resets the role to NOCREATEDB at the start of each provision. */
export function finishScript(sessionId: string): string {
  const db = sessionDb(sessionId);
  return [
    `\\connect ${db}`,
    GUARD_SQL,
    "\\connect postgres",
    `SELECT 'ALTER ROLE ${db} CREATEDB' WHERE ${PG17}\\gexec`,
    "",
  ].join("\n");
}

const REPO_ROLE_PATTERN = "^r_([a-z0-9_]{1,20}_)?[0-9a-f]{8}$";

/** Hand the roles a session created to its repo role WITH ADMIN, so every session of that repo
 *  inherits ADMIN and the roles keep an admin holder after the session is dropped. "Created" = the
 *  session's direct ADMIN row has a superuser grantor: PG16+ records a CREATEROLE user's implicit
 *  ADMIN on its new role as granted by the bootstrap superuser, while a role another session
 *  granted it (`GRANT … WITH ADMIN OPTION`, `CREATE ROLE … ADMIN`) carries that session as grantor
 *  and is never adopted (#4272: cross-repo role injection). Never `pg_*`, superusers or Shepherd's
 *  own session/repo role names; a missing session or repo role is a no-op. Empty input → ""
 *  (nothing to run). */
export function adoptScript(
  leases: readonly { db: string; role: string }[],
  { includeLogin = false }: { includeLogin?: boolean } = {},
): string {
  // #4270: a role that owns a database is never adopted (a sibling inheriting ADMIN could grant it
  // to itself, re-own or copy the database), and a LOGIN role only once its creator is being
  // dropped (`includeLogin`, after `dropOwnedDbsSql`): the login guard trusts roles only their
  // creating session administers.
  const login = includeLogin ? "" : "AND NOT r.rolcanlogin ";
  const lines = leases.map(({ db, role }) => {
    if (!isSessionDbName(db)) throw new Error(`invalid session role: ${db}`);
    return (
      `SELECT format('GRANT %I TO %I WITH ADMIN OPTION, INHERIT FALSE, SET FALSE', r.rolname, h.rolname) ` +
      `FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member ` +
      `JOIN pg_roles g ON g.oid = a.grantor JOIN pg_roles h ON h.rolname = ${lit(role)} ` +
      `WHERE m.rolname = ${lit(db)} AND a.admin_option AND g.rolsuper AND NOT r.rolsuper AND r.rolname !~ '^pg_' ` +
      `AND r.rolname !~ '${SESSION_ROLE_PATTERN}' AND r.rolname !~ '${REPO_ROLE_PATTERN}' ` +
      `AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid) ${login}` +
      `AND NOT EXISTS (SELECT 1 FROM pg_auth_members x WHERE x.roleid = a.roleid AND x.member = h.oid AND x.admin_option)\\gexec`
    );
  });
  return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Client auth for the cluster: Shepherd's own `docker exec psql -U postgres` over the local socket,
 *  and over TCP only a login whose database is named like the user (`sameuser`). A session's clone
 *  and login role share the name `s_<id>`, so no role, whatever privileges it was granted or
 *  inherits (app roles are shared, #4232 follow-up), can open another session's database. */
const POSTGRES_HBA_LINES = [
  "local all postgres trust",
  "host sameuser all all scram-sha-256",
] as const;

/** PG17+ (#4270): Shepherd's own database names stay pinned to `sameuser` (the reject line); every
 *  other name — a database a session created — falls through to password auth, and the login
 *  guard (`GUARD_SQL`) decides. */
const HBA_LINES_PG17 = [
  ...POSTGRES_HBA_LINES,
  "host /^s_[0-9a-f]{32}$,/^r_[a-z0-9_]*[0-9a-f]{8}_(base|next|old)$,postgres,template1 all all reject",
  "host all all all scram-sha-256",
] as const;

const hbaCopy = (lines: readonly string[]) =>
  `EXECUTE format('COPY (VALUES ${lines.map(() => "(%L)").join(", ")}) TO %L', ${lines.map((l) => `'${l}'`).join(", ")}, current_setting('hba_file'));`;

/** `postgres_reset` (#4240): drop the clone (force-closing its connections) so `cloneScript` can
 *  re-create it from the template; the login role and its password stay. */
export function resetScript(sessionId: string): string {
  return `${forceDropNamedSql(sessionDb(sessionId))}\n`;
}

/** Scratch names for the template swap in {@link promoteScript}. */
const repoNextDb = (repoPath: string) => ident(`${repoRole(repoPath)}_next`);
const repoOldDb = (repoPath: string) => ident(`${repoRole(repoPath)}_old`);

/** Promote (#4240): the session's clone becomes the repo's new template. Clones `s_<id>` into a
 *  superuser-owned `_next` (connections to the clone blocked + closed first: a template must have
 *  none), re-owns its objects to the repo role so later clones' `REASSIGN OWNED BY r_<repo>` works,
 *  then swaps it in by rename in one transaction and drops the old template. `REASSIGN OWNED` also
 *  moves SHARED objects (databases) the role owns, so the clone DB is parked on the superuser around
 *  it; default privileges REPLACE the repo role's (`clearDefaultAclsSql` + `copyDefaultAclsSql`)
 *  before `DROP OWNED` deletes the session role's.
 *  Always follow with {@link promoteRestoreScript}, success or failure. */
export function promoteScript(repoPath: string, sessionId: string): string {
  const db = sessionDb(sessionId);
  const role = repoRole(repoPath);
  const base = repoBaseDb(repoPath);
  const next = repoNextDb(repoPath);
  const old = repoOldDb(repoPath);
  return [
    // #4270: a superuser-owned guard in the clone first, so the copy never carries a
    // session-owned `shepherd` schema into the template.
    `\\connect ${db}`,
    GUARD_SQL,
    "\\connect postgres",
    forceDropNamedSql(next),
    forceDropNamedSql(old),
    `ALTER DATABASE ${db} ALLOW_CONNECTIONS false;`,
    `SELECT count(pg_terminate_backend(pid, 5000)) FROM pg_stat_activity WHERE datname = ${lit(db)} AND pid <> pg_backend_pid();`,
    "SET file_copy_method = clone;",
    `CREATE DATABASE ${next} TEMPLATE ${db} STRATEGY FILE_COPY;`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${next} FROM PUBLIC;`,
    `ALTER DATABASE ${db} OWNER TO postgres;`,
    `\\connect ${next}`,
    // The session's other databases (#4270) move with REASSIGN; hand them back in the same
    // transaction, so the repo role never owns a database even if a later step fails.
    "BEGIN;",
    `REASSIGN OWNED BY ${db} TO ${role};`,
    `SELECT format('ALTER DATABASE %I OWNER TO ${db}', datname) FROM pg_database WHERE datdba = ${roleOid(role)}\\gexec`,
    "COMMIT;",
    clearDefaultAclsSql(role),
    copyDefaultAclsSql(db, role),
    `DROP OWNED BY ${db};`,
    "\\connect postgres",
    "BEGIN;",
    `ALTER DATABASE ${base} RENAME TO ${old};`,
    `ALTER DATABASE ${next} RENAME TO ${base};`,
    "COMMIT;",
    `DROP DATABASE ${old};`,
    "",
  ].join("\n");
}

/** Undo promote's temporary changes to the clone and clear a half-built `_next`. Idempotent. */
export function promoteRestoreScript(repoPath: string, sessionId: string): string {
  const db = sessionDb(sessionId);
  return [
    `ALTER DATABASE ${db} OWNER TO ${db};`,
    `ALTER DATABASE ${db} ALLOW_CONNECTIONS true;`,
    forceDropNamedSql(repoNextDb(repoPath)),
    "",
  ].join("\n");
}

/** A session marking its own database IS_TEMPLATE would let every CREATEDB role copy it; owners
 *  copy their own databases without the flag. Reset on every non-superuser-owned database. */
export const UNTEMPLATE_SQL =
  "SELECT format('ALTER DATABASE %I IS_TEMPLATE false', d.datname) FROM pg_database d JOIN pg_roles o ON o.oid = d.datdba WHERE d.datistemplate AND NOT o.rolsuper\\gexec\n";

/** PG17+ lets every unreserved database name through hba to the login guard, but a database
 *  without the guard (one an operator made before this, or any `CREATE DATABASE … TEMPLATE
 *  template0`, e.g. `pg_restore --create`) would then be open to every login. Superuser-owned
 *  databases are never a session's: PUBLIC loses CONNECT/TEMPORARY on all of them (#4270). */
export const REVOKE_PUBLIC_SQL =
  "SELECT format('REVOKE CONNECT, TEMPORARY ON DATABASE %I FROM PUBLIC', d.datname) FROM pg_database d JOIN pg_roles o ON o.oid = d.datdba WHERE o.rolsuper AND d.datallowconn\\gexec\n";

/** A database handed to a role AFTER that role was adopted (another non-superuser holds ADMIN on
 *  it) goes back to the session that created the owner. Runs before adoption on every idle tick. */
export const RECLAIM_SQL =
  "SELECT format('ALTER DATABASE %I OWNER TO %I', d.datname, c.rolname) FROM pg_database d " +
  "JOIN pg_auth_members a ON a.roleid = d.datdba AND a.admin_option " +
  "JOIN pg_roles g ON g.oid = a.grantor AND g.rolsuper " +
  `JOIN pg_roles c ON c.oid = a.member AND c.rolname ~ '${SESSION_ROLE_PATTERN}' ` +
  "WHERE EXISTS (SELECT 1 FROM pg_auth_members x JOIN pg_roles h ON h.oid = x.member " +
  "WHERE x.roleid = d.datdba AND x.admin_option AND NOT h.rolsuper AND h.oid <> c.oid)\\gexec\n";

/** Session roles may connect only to their own clone: PUBLIC loses CONNECT/TEMPORARY on the
 *  cluster's built-in databases too, template0 can no longer be copied by non-superusers, and the
 *  cluster's hba file is rewritten (`POSTGRES_HBA_LINES`; PG17+ `HBA_LINES_PG17`) + reloaded.
 *  Ends in template1 with the login guard installed. Run at every ready. */
export const HARDEN_SQL = [
  "REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;",
  "REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;",
  "ALTER DATABASE template0 IS_TEMPLATE false;",
  `DO $$ BEGIN IF ${PG17} THEN ${hbaCopy(HBA_LINES_PG17)} ELSE ${hbaCopy(POSTGRES_HBA_LINES)} END IF; END $$;`,
  "SELECT pg_reload_conf();",
  REVOKE_PUBLIC_SQL.trimEnd(),
  UNTEMPLATE_SQL.trimEnd(),
  "\\connect template1",
  GUARD_SQL,
  "",
].join("\n");

/** Drop the clone, every other database the role or a role it created owns (#4270), and the role.
 *  `DROP OWNED` first clears anything the role still holds in the admin database (grants, default
 *  ACLs) so `DROP ROLE` cannot fail on a dependency. */
export function dropScript(db: string): string {
  if (!isSessionDbName(db)) throw new Error(`refusing to drop non-session database: ${db}`);
  return [
    forceDropNamedSql(db),
    dropOwnedDbsSql(db),
    `SELECT 'DROP OWNED BY ${db}' WHERE EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(db)})\\gexec`,
    `DROP ROLE IF EXISTS ${db};`,
    "",
  ].join("\n");
}

/** Session databases and roles present in the cluster (one name per line). */
export const LIST_SESSION_OBJECTS_SQL =
  "SELECT datname FROM pg_database WHERE datname ~ '^s_[0-9a-f]{32}$' UNION SELECT rolname FROM pg_roles WHERE rolname ~ '^s_[0-9a-f]{32}$';\n";

export const CLIENT_CONNECTIONS_SQL =
  "SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid();\n";

// ── DSN + idle ───────────────────────────────────────────────────────────────

/** Where the server is published on the host (and where host-net sessions reach it). */
export const POSTGRES_HOST_LOOPBACK = "127.0.0.1";

export interface PostgresConnection {
  dsn: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function connectionFor(
  host: string,
  port: number,
  sessionId: string,
  password: string,
): PostgresConnection {
  const db = sessionDb(sessionId);
  return {
    dsn: `postgresql://${db}:${password}@${host}:${port}/${db}`,
    host,
    port,
    database: db,
    user: db,
    password,
  };
}

/** The env a session gets for its connection (#4238): exactly `postgres_request`'s values. */
export function postgresEnv(conn: PostgresConnection): Record<string, string> {
  return {
    DATABASE_URL: conn.dsn,
    PGHOST: conn.host,
    PGPORT: String(conn.port),
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGDATABASE: conn.database,
  };
}

export function shouldIdleStop(now: number, lastBusyAt: number, idleMinutes: number): boolean {
  return now - lastBusyAt >= idleMinutes * 60_000;
}
