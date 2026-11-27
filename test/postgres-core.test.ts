import { describe, expect, it } from "bun:test";
import {
  DEFAULT_POSTGRES_SETTINGS,
  HARDEN_SQL,
  postgresInstanceNames,
  adoptScript,
  baseScript,
  clearDefaultAclsSql,
  cloneScript,
  connectionFor,
  copyDefaultAclsSql,
  dropScript,
  isImageRef,
  isSessionDbName,
  isPostgresMode,
  parsePostgresPatch,
  promoteRestoreScript,
  promoteScript,
  postgresEnv,
  postgresRepoOn,
  repoBaseDb,
  repoRole,
  resetScript,
  roleScript,
  sessionDb,
  sessionPassword,
  shouldIdleStop,
  storedPostgresSettings,
} from "../src/postgres-core";

const SID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("identifiers", () => {
  it("derives a valid, readable, unique repo role", () => {
    const a = repoRole("/home/x/Work/My Repo.git");
    expect(a).toMatch(/^r_my_repo_git_[0-9a-f]{8}$/);
    expect(repoRole("/other/My Repo.git")).not.toBe(a);
    expect(repoBaseDb("/home/x/Work/My Repo.git")).toBe(`${a}_base`);
  });

  it("caps long names and handles symbol-only basenames", () => {
    const long = repoRole(`/x/${"a".repeat(200)}`);
    expect(long.length).toBeLessThanOrEqual(63);
    expect(`${long}_base`.length).toBeLessThanOrEqual(63);
    expect(repoRole("/x/---")).toMatch(/^r_[0-9a-f]{8}$/);
  });

  it("maps a session uuid to s_<hex> and rejects anything else", () => {
    expect(sessionDb(SID)).toBe("s_0f8fad5bd9cb469fa16570867728950e");
    expect(() => sessionDb("x'; DROP DATABASE postgres; --")).toThrow();
    expect(isSessionDbName(sessionDb(SID))).toBe(true);
    expect(isSessionDbName("r_x_base")).toBe(false);
  });

  it("derives a stable password per session under one key", () => {
    const p = sessionPassword("k1", SID);
    expect(p).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(sessionPassword("k1", SID)).toBe(p);
    expect(sessionPassword("k2", SID)).not.toBe(p);
  });
});

describe("scripts", () => {
  const repo = "/home/x/Work/demo";

  it("base: superuser-owned template, CONNECT revoked from PUBLIC", () => {
    const sql = baseScript(repo);
    expect(sql).toContain(`CREATE DATABASE ${repoBaseDb(repo)}'`);
    expect(sql).not.toMatch(/OWNER/);
    expect(sql).not.toMatch(/ALTER DATABASE/);
    expect(sql).toContain(`REVOKE CONNECT, TEMPORARY ON DATABASE ${repoBaseDb(repo)} FROM PUBLIC;`);
    expect(sql).toContain(`CREATE ROLE ${repoRole(repo)} NOLOGIN`);
  });

  it("clone: FILE_COPY + clone, revoke, reassign inside the clone", () => {
    const db = sessionDb(SID);
    const sql = cloneScript(repo, SID);
    expect(sql).toContain("SET file_copy_method = clone;");
    expect(sql).toContain(
      `CREATE DATABASE ${db} TEMPLATE ${repoBaseDb(repo)} STRATEGY FILE_COPY OWNER ${db};`,
    );
    expect(sql).toContain(`REVOKE CONNECT, TEMPORARY ON DATABASE ${db} FROM PUBLIC;`);
    expect(sql.indexOf(`\\connect ${db}`)).toBeLessThan(sql.indexOf("REASSIGN OWNED"));
    expect(sql).toContain(`REASSIGN OWNED BY ${repoRole(repo)} TO ${db};`);
  });

  it("role: password only as a validated literal", () => {
    expect(roleScript(SID, "abcDEF0123456789_-xy", repo)).toContain(
      "PASSWORD 'abcDEF0123456789_-xy'",
    );
    expect(() => roleScript(SID, "bad'pw", repo)).toThrow();
  });

  it("role: CREATEROLE + inherit-only repo-role membership, PG16+ only", () => {
    const db = sessionDb(SID);
    const sql = roleScript(SID, "abcDEF0123456789_-xy", repo);
    const pg16 = "WHERE current_setting('server_version_num')::int >= 160000\\gexec";
    expect(sql).toContain(`ALTER ROLE ${db} WITH LOGIN NOCREATEROLE NOCREATEDB`);
    expect(sql).toContain(`'ALTER ROLE ${db} CREATEROLE' ${pg16}`);
    expect(sql).toContain(
      `'GRANT ${repoRole(repo)} TO ${db} WITH INHERIT TRUE, SET FALSE' ${pg16}`,
    );
    // The caller reads the clone-exists count from the last line.
    expect(sql.trim().split("\n").pop()).toMatch(/^SELECT count\(\*\) FROM pg_database/);
  });

  it("role: a squatted session role loses its admin holders and settings before the password", () => {
    const db = sessionDb(SID);
    const sql = roleScript(SID, "abcDEF0123456789_-xy", repo);
    const revoke = sql.indexOf(`r.rolname = '${db}' AND a.admin_option AND NOT m.rolsuper\\gexec`);
    expect(revoke).toBeGreaterThan(-1);
    expect(sql).toContain("REVOKE %I FROM %I CASCADE");
    expect(revoke).toBeLessThan(sql.indexOf("PASSWORD 'abcDEF"));
    expect(sql).toContain("NOBYPASSRLS INHERIT CONNECTION LIMIT -1 VALID UNTIL 'infinity'");
    expect(sql).toContain(`ALTER ROLE ${db} RESET ALL;`);
    expect(sql).toContain("ALTER ROLE %I IN DATABASE %I RESET ALL");
  });

  it("base: strips a squatted repo role's attributes and admin holders", () => {
    const sql = baseScript(repo);
    const role = repoRole(repo);
    expect(sql).toContain(
      `ALTER ROLE ${role} NOLOGIN NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD NULL;`,
    );
    expect(sql).toContain("REVOKE %I FROM %I CASCADE");
    expect(sql).toContain(`r.rolname = '${role}' AND a.admin_option AND NOT m.rolsuper\\gexec`);
  });

  it("adopt: hands roles a session created to its repo role, never managed names", () => {
    const db = sessionDb(SID);
    const role = repoRole(repo);
    const sql = adoptScript([{ db, role }]);
    expect(sql).toContain("GRANT %I TO %I WITH ADMIN OPTION, INHERIT FALSE, SET FALSE");
    expect(sql).toContain(`h.rolname = '${role}'`);
    // Only the creator's ADMIN row (superuser grantor), never one another session granted (#4272).
    expect(sql).toContain("JOIN pg_roles g ON g.oid = a.grantor");
    expect(sql).toContain(
      `m.rolname = '${db}' AND a.admin_option AND g.rolsuper AND NOT r.rolsuper`,
    );
    expect(sql).toContain("r.rolname !~ '^pg_'");
    expect(sql).toContain("r.rolname !~ '^s_[0-9a-f]{32}$'");
    expect(sql).toContain("r.rolname !~ '^r_([a-z0-9_]{1,20}_)?[0-9a-f]{8}$'");
    expect(sql.trim().endsWith("\\gexec")).toBe(true);
    expect(adoptScript([])).toBe("");
    expect(() => adoptScript([{ db: "postgres", role }])).toThrow();
    expect(() => adoptScript([{ db, role: "x'; DROP" }])).toThrow();
  });

  it("drop clears the role's leftovers before DROP ROLE and refuses non-session names", () => {
    const sql = dropScript(sessionDb(SID));
    expect(sql).toContain("WITH (FORCE)");
    expect(sql.indexOf(`DROP OWNED BY ${sessionDb(SID)}`)).toBeLessThan(sql.indexOf("DROP ROLE"));
    expect(() => dropScript("postgres")).toThrow();
  });

  it("reset force-drops only the session's clone", () => {
    expect(resetScript(SID)).toBe(`DROP DATABASE IF EXISTS ${sessionDb(SID)} WITH (FORCE);\n`);
    expect(() => resetScript("not-a-uuid")).toThrow();
  });

  it("promote: blocks the clone, copies it, re-owns to the repo role, swaps atomically", () => {
    const db = sessionDb(SID);
    const role = repoRole(repo);
    const base = repoBaseDb(repo);
    const sql = promoteScript(repo, SID);
    const at = (s: string) => {
      const i = sql.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at(`ALTER DATABASE ${db} ALLOW_CONNECTIONS false;`)).toBeLessThan(
      at("pg_terminate_backend"),
    );
    expect(at("pg_terminate_backend")).toBeLessThan(
      at(`CREATE DATABASE ${role}_next TEMPLATE ${db} STRATEGY FILE_COPY;`),
    );
    expect(sql).not.toMatch(/CREATE DATABASE \S+ TEMPLATE \S+ STRATEGY FILE_COPY OWNER/);
    at(`REVOKE CONNECT, TEMPORARY ON DATABASE ${role}_next FROM PUBLIC;`);
    // The clone DB is parked on the superuser so REASSIGN can't move it to the repo role.
    expect(at(`ALTER DATABASE ${db} OWNER TO postgres;`)).toBeLessThan(at("REASSIGN OWNED"));
    expect(at(`\\connect ${role}_next`)).toBeLessThan(at(`REASSIGN OWNED BY ${db} TO ${role};`));
    // Default privileges REPLACE the repo role's before DROP OWNED deletes the session role's.
    expect(at(clearDefaultAclsSql(role))).toBeLessThan(at(copyDefaultAclsSql(db, role)));
    expect(at(copyDefaultAclsSql(db, role))).toBeGreaterThan(at(`REASSIGN OWNED BY ${db}`));
    expect(at(copyDefaultAclsSql(db, role))).toBeLessThan(at(`DROP OWNED BY ${db};`));
    expect(at(`DROP OWNED BY ${db};`)).toBeLessThan(at("BEGIN;"));
    expect(at("BEGIN;")).toBeLessThan(at(`ALTER DATABASE ${base} RENAME TO ${role}_old;`));
    expect(at(`ALTER DATABASE ${role}_next RENAME TO ${base};`)).toBeLessThan(at("COMMIT;"));
    expect(at("COMMIT;")).toBeLessThan(at(`DROP DATABASE ${role}_old;`));
  });

  it("default ACLs: reset global rows, re-grant every entry for the target role", () => {
    const sql = copyDefaultAclsSql("s_from", "r_to");
    expect(sql).toContain("REVOKE ALL ON %s FROM PUBLIC, %I', 'r_to'");
    expect(sql).toContain("d.defaclnamespace = 0\\gexec");
    expect(sql).toContain("aclexplode(d.defaclacl)");
    expect(sql).toContain("WHEN a.grantee = d.defaclrole THEN quote_ident('r_to')");
    expect(sql).toContain("WHERE d.defaclrole = 's_from'::regrole\\gexec");
    expect(sql.indexOf("REVOKE ALL")).toBeLessThan(sql.indexOf(" GRANT %s"));
    expect(() => copyDefaultAclsSql("x'; DROP", "r_to")).toThrow();
  });

  it("clone MOVES the repo role's default ACLs to the session role", () => {
    const sql = cloneScript(repo, SID);
    const copy = sql.indexOf(copyDefaultAclsSql(repoRole(repo), sessionDb(SID)));
    expect(sql.indexOf("REASSIGN OWNED")).toBeLessThan(copy);
    expect(copy).toBeLessThan(sql.indexOf(clearDefaultAclsSql(repoRole(repo))));
  });

  it("clearing revokes every entry, then restores built-in defaults on global rows, in one query", () => {
    const sql = clearDefaultAclsSql("r_to");
    expect(sql.match(/\\gexec/g)).toHaveLength(1);
    expect(sql).toContain("REVOKE ALL ON %s FROM %s");
    expect(sql).toContain("GRANT ALL ON %s TO %I");
    expect(sql).toContain("'EXECUTE ON FUNCTIONS' ELSE 'USAGE ON TYPES'");
    expect(sql).toContain("ORDER BY ord");
    expect(() => clearDefaultAclsSql("bad name")).toThrow();
  });

  it("promote restore gives the clone back to its role and clears a half-built copy", () => {
    const db = sessionDb(SID);
    const sql = promoteRestoreScript(repo, SID);
    expect(sql).toContain(`ALTER DATABASE ${db} OWNER TO ${db};`);
    expect(sql).toContain(`ALTER DATABASE ${db} ALLOW_CONNECTIONS true;`);
    expect(sql).toContain(`DROP DATABASE IF EXISTS ${repoRole(repo)}_next;`);
  });
});

it("hardening revokes PUBLIC access to the built-in databases", () => {
  expect(HARDEN_SQL).toContain("REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;");
  expect(HARDEN_SQL).toContain("REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;");
});

it("hardening limits TCP logins to the database named like the user, then reloads", () => {
  expect(HARDEN_SQL).toContain("'host sameuser all all scram-sha-256'");
  expect(HARDEN_SQL).toContain("'local all postgres trust'");
  expect(HARDEN_SQL).toContain("current_setting('hba_file')");
  expect(HARDEN_SQL).not.toMatch(/host all all/);
  expect(HARDEN_SQL.indexOf("COPY")).toBeLessThan(HARDEN_SQL.indexOf("pg_reload_conf()"));
});

it("instance names: plain for the default state dir, suffixed for any other", () => {
  expect(postgresInstanceNames("/h/.shepherd", "/h/.shepherd")).toEqual({
    container: "shepherd-postgres-18",
    volume: "shepherd-postgres-18",
  });
  const other = postgresInstanceNames("/h/.shepherd-b", "/h/.shepherd");
  expect(other.container).toMatch(/^shepherd-postgres-18-[0-9a-f]{8}$/);
  expect(other.volume).toBe(other.container);
  expect(postgresInstanceNames("/h/.shepherd-c", "/h/.shepherd").container).not.toBe(
    other.container,
  );
});

describe("settings", () => {
  it("defaults on missing or corrupt storage", () => {
    expect(storedPostgresSettings(null)).toEqual(DEFAULT_POSTGRES_SETTINGS);
    expect(storedPostgresSettings("{nope")).toEqual(DEFAULT_POSTGRES_SETTINGS);
    expect(DEFAULT_POSTGRES_SETTINGS).toEqual({
      enabled: false,
      port: 54318,
      idleMinutes: 15,
      image: "postgres:18",
    });
  });

  it("validates each field", () => {
    const cur = DEFAULT_POSTGRES_SETTINGS;
    expect(parsePostgresPatch({ enabled: true, port: 6000 }, cur)).toEqual({
      ok: true,
      value: { ...cur, enabled: true, port: 6000 },
    });
    for (const bad of [
      {},
      { port: 80 },
      { port: 70000 },
      { idleMinutes: 0 },
      { image: "--privileged" },
      { enabled: "yes" },
      { other: 1 },
    ])
      expect(parsePostgresPatch(bad, cur).ok).toBe(false);
  });

  it("accepts real image references only", () => {
    for (const ok of ["postgres:18", "postgres:18.7-trixie", "localhost:5000/pg/x:1", "postgres"])
      expect(isImageRef(ok)).toBe(true);
    for (const bad of ["-x", "Postgres", "pg:18 --rm", "a:b:c", ""])
      expect(isImageRef(bad)).toBe(false);
  });
});

it("connection uses the session role and db", () => {
  const c = connectionFor("127.0.0.1", 54318, SID, "pw0123456789abcdef");
  expect(c.dsn).toBe(`postgresql://${c.user}:pw0123456789abcdef@127.0.0.1:54318/${c.database}`);
  expect(c.user).toBe(sessionDb(SID));
});

it("postgresEnv: exactly the connection's six values (#4238)", () => {
  const c = connectionFor("10.0.2.2", 54318, SID, "pw0123456789abcdef");
  expect(postgresEnv(c)).toEqual({
    DATABASE_URL: c.dsn,
    PGHOST: "10.0.2.2",
    PGPORT: "54318",
    PGUSER: c.user,
    PGPASSWORD: "pw0123456789abcdef",
    PGDATABASE: c.database,
  });
});

it("auto is a mode, and on-request/auto count as on (#4238)", () => {
  expect(isPostgresMode("auto")).toBe(true);
  expect(["off", "on-request", "auto", undefined].map(postgresRepoOn)).toEqual([
    false,
    true,
    true,
    false,
  ]);
});

it("idle stop after N minutes", () => {
  expect(shouldIdleStop(15 * 60_000, 0, 15)).toBe(true);
  expect(shouldIdleStop(15 * 60_000 - 1, 0, 15)).toBe(false);
});
