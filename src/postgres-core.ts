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

export type PostgresMode = "off" | "on-request";
export const POSTGRES_MODES: readonly PostgresMode[] = ["off", "on-request"];
export function isPostgresMode(v: unknown): v is PostgresMode {
  return typeof v === "string" && (POSTGRES_MODES as readonly string[]).includes(v);
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

/** Repo role + template. The template is owned by the superuser: the repo role owns NO database,
 *  so `REASSIGN OWNED` in a clone only moves objects inside that clone. */
export function baseScript(repoPath: string): string {
  const role = repoRole(repoPath);
  const base = repoBaseDb(repoPath);
  return [
    `SELECT 'CREATE ROLE ${role} NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(role)})\\gexec`,
    `SELECT 'CREATE DATABASE ${base}' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = ${lit(base)})\\gexec`,
    `REVOKE CONNECT, TEMPORARY ON DATABASE ${base} FROM PUBLIC;`,
    "",
  ].join("\n");
}

/** Login role (password always (re)set) + clone of the template when the clone is missing. The
 *  clone path ends in the clone DB (`\connect`), so it is a separate script. */
export function roleScript(sessionId: string, password: string): string {
  const db = sessionDb(sessionId);
  return [
    `SELECT 'CREATE ROLE ${db} LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${lit(db)})\\gexec`,
    `ALTER ROLE ${db} WITH LOGIN PASSWORD ${literalPassword(password)};`,
    `SELECT count(*) FROM pg_database WHERE datname = ${lit(db)};`,
    "",
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
    "",
  ].join("\n");
}

/** Session roles may connect only to their own clone: PUBLIC loses CONNECT/TEMPORARY on the
 *  cluster's built-in databases too (template0 already refuses connections). Run at every ready. */
export const HARDEN_SQL =
  "REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;\nREVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;\n";

/** Drop the clone and its role. `DROP OWNED` first clears anything the role still holds in the
 *  admin database (grants, default ACLs) so `DROP ROLE` cannot fail on a dependency. */
export function dropScript(db: string): string {
  if (!isSessionDbName(db)) throw new Error(`refusing to drop non-session database: ${db}`);
  return [
    `DROP DATABASE IF EXISTS ${db} WITH (FORCE);`,
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

export function shouldIdleStop(now: number, lastBusyAt: number, idleMinutes: number): boolean {
  return now - lastBusyAt >= idleMinutes * 60_000;
}
