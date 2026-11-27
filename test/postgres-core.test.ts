import { describe, expect, it } from "bun:test";
import {
  ADMIN_PGOPTIONS,
  DEFAULT_POSTGRES_SETTINGS,
  GUARD_SQL,
  HARDEN_SQL,
  RECLAIM_SQL,
  REVOKE_PUBLIC_SQL,
  UNTEMPLATE_SQL,
  postgresInstanceNames,
  adoptScript,
  baseScript,
  clearDefaultAclsSql,
  cloneScript,
  connectionFor,
  copyDefaultAclsSql,
  dropOwnedDbsSql,
  dropScript,
  finishScript,
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
    // The base is created plain (superuser-owned); only a squatted base is parked + dropped.
    expect(sql).not.toMatch(/CREATE DATABASE \S+ OWNER/);
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
    const pg16 = "WHERE pg_catalog.current_setting('server_version_num')::int >= 160000\\gexec";
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
    const sql = resetScript(SID);
    expect(sql).toContain(`FROM pg_database d WHERE d.datname = '${sessionDb(SID)}'\\gexec`);
    expect(sql.match(/\\gexec/g)).toHaveLength(1);
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
    const swap = at(`BEGIN;\nALTER DATABASE ${base} RENAME TO ${role}_old;`);
    expect(at(`DROP OWNED BY ${db};`)).toBeLessThan(swap);
    const commit = sql.indexOf("COMMIT;", swap);
    expect(at(`ALTER DATABASE ${role}_next RENAME TO ${base};`)).toBeLessThan(commit);
    expect(commit).toBeLessThan(at(`DROP DATABASE ${role}_old;`));
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
    expect(sql).toContain(`WHERE d.datname = '${repoRole(repo)}_next'\\gexec`);
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
  expect(HARDEN_SQL.indexOf("COPY")).toBeLessThan(HARDEN_SQL.indexOf("pg_reload_conf()"));
});

it("hardening: PG17+ pins Shepherd's names, lets other names through to the guard; older keeps 2 lines", () => {
  const pg17 = HARDEN_SQL.indexOf(
    "IF pg_catalog.current_setting('server_version_num')::int >= 170000 THEN",
  );
  const otherwise = HARDEN_SQL.indexOf(" ELSE EXECUTE format('COPY (VALUES (%L), (%L)) TO %L'");
  expect(pg17).toBeGreaterThan(-1);
  expect(otherwise).toBeGreaterThan(pg17);
  const reject =
    "'host /^s_[0-9a-f]{32}$,/^r_[a-z0-9_]*[0-9a-f]{8}_(base|next|old)$,postgres,template1 all all reject'";
  expect(HARDEN_SQL.indexOf(reject)).toBeGreaterThan(pg17);
  expect(HARDEN_SQL.indexOf(reject)).toBeLessThan(
    HARDEN_SQL.indexOf("'host all all all scram-sha-256'"),
  );
  expect(HARDEN_SQL.indexOf("'host all all all scram-sha-256'")).toBeLessThan(otherwise);
});

it("hardening: template0 uncopyable, IS_TEMPLATE reset, guard installed in template1", () => {
  expect(HARDEN_SQL).toContain("ALTER DATABASE template0 IS_TEMPLATE false;");
  expect(HARDEN_SQL).toContain(UNTEMPLATE_SQL.trimEnd());
  expect(HARDEN_SQL).toContain(REVOKE_PUBLIC_SQL.trimEnd());
  expect(REVOKE_PUBLIC_SQL).toContain("WHERE o.rolsuper AND d.datallowconn");
  expect(HARDEN_SQL.trimEnd().endsWith(`\\connect template1\n${GUARD_SQL}`)).toBe(true);
});

describe("login guard (#4270)", () => {
  it("PG17-gated, drops a session-owned schema/function before creating its own", () => {
    const at = (s: string) => {
      const i = GUARD_SQL.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(
      GUARD_SQL.startsWith(
        "SELECT pg_catalog.current_setting('server_version_num')::int >= 170000 AS shepherd_pg17 \\gset\n\\if :shepherd_pg17",
      ),
    ).toBe(true);
    expect(at("AS shepherd_tainted \\gset")).toBeLessThan(
      at("\\if :shepherd_tainted\nDROP SCHEMA shepherd CASCADE;\n\\endif"),
    );
    expect(GUARD_SQL).toContain("n.nspname = 'shepherd' AND NOT o.rolsuper");
    expect(GUARD_SQL).toContain("p.proowner WHERE n.nspname = 'shepherd' AND NOT o.rolsuper");
    expect(at("DROP SCHEMA shepherd CASCADE")).toBeLessThan(
      at("CREATE SCHEMA IF NOT EXISTS shepherd AUTHORIZATION postgres;"),
    );
    expect(at("CREATE SCHEMA IF NOT EXISTS")).toBeLessThan(
      at("CREATE OR REPLACE FUNCTION shepherd.login_guard()"),
    );
    expect(at("CREATE OR REPLACE FUNCTION")).toBeLessThan(
      at("CREATE EVENT TRIGGER shepherd_login_guard ON login"),
    );
    expect(GUARD_SQL).toContain("SECURITY DEFINER SET search_path = pg_catalog, pg_temp");
    expect(GUARD_SQL).toContain("REVOKE ALL ON SCHEMA shepherd FROM PUBLIC;");
    expect(GUARD_SQL.trimEnd().endsWith("\\endif")).toBe(true);
  });

  it("admits superusers and tenant-trusted roles only", () => {
    expect(GUARD_SQL).toContain(
      "IF (SELECT rolsuper FROM pg_roles WHERE oid = u) THEN RETURN; END IF;",
    );
    expect(GUARD_SQL).toContain("t.rolname ~ '^s_[0-9a-f]{32}$'");
    // creator row: superuser grantor; and no other non-superuser admin holder — for owner and user
    expect(GUARD_SQL.match(/a\.member = t\.oid AND a\.admin_option AND g\.rolsuper/g)).toHaveLength(
      2,
    );
    expect(GUARD_SQL.match(/NOT m\.rolsuper AND m\.oid <> t\.oid/g)).toHaveLength(2);
    expect(GUARD_SQL).toContain("RAISE EXCEPTION");
  });

  it("finish: guard in the clone, then CREATEDB on PG17+ only", () => {
    const db = sessionDb(SID);
    const sql = finishScript(SID);
    expect(sql.indexOf(`\\connect ${db}\n${GUARD_SQL}\n\\connect postgres`)).toBe(0);
    expect(sql).toContain(
      `SELECT 'ALTER ROLE ${db} CREATEDB' WHERE pg_catalog.current_setting('server_version_num')::int >= 170000\\gexec`,
    );
    expect(sql.indexOf(GUARD_SQL)).toBeLessThan(sql.indexOf("CREATEDB"));
  });

  it("base: a non-superuser-owned base is dropped first; ends with the guard in the base", () => {
    const base = repoBaseDb("/home/x/Work/demo");
    const sql = baseScript("/home/x/Work/demo");
    const drop = sql.indexOf(
      `WHERE d.datname = '${base}' AND NOT (SELECT o.rolsuper FROM pg_roles o WHERE o.oid = d.datdba)\\gexec`,
    );
    expect(drop).toBeGreaterThan(-1);
    expect(drop).toBeLessThan(sql.indexOf(`'CREATE DATABASE ${base}'`));
    expect(sql.trimEnd().endsWith(`\\connect ${base}\n${GUARD_SQL}`)).toBe(true);
  });

  it("force-drop parks on the superuser and un-templates before DROP", () => {
    const sql = resetScript(SID);
    const owner = sql.indexOf("ALTER DATABASE %I OWNER TO postgres");
    const untemplate = sql.indexOf("ALTER DATABASE %I IS_TEMPLATE false");
    expect(owner).toBeGreaterThan(-1);
    expect(owner).toBeLessThan(untemplate);
    expect(untemplate).toBeLessThan(sql.indexOf("DROP DATABASE %I WITH (FORCE)"));
    for (const s of [
      dropOwnedDbsSql(sessionDb(SID)),
      dropScript(sessionDb(SID)),
      baseScript("/home/x/Work/demo"),
      roleScript(SID, "abcDEF0123456789_-xy", "/home/x/Work/demo"),
      promoteScript("/home/x/Work/demo", SID),
      promoteRestoreScript("/home/x/Work/demo", SID),
    ])
      expect(s).not.toMatch(/^DROP DATABASE IF EXISTS/m);
  });

  it("owned-DB sweep: the role's databases and those of roles it created", () => {
    const db = sessionDb(SID);
    const sql = dropOwnedDbsSql(db);
    expect(sql).toContain("DROP DATABASE %I WITH (FORCE)");
    expect(sql).toContain(`d.datdba = (SELECT oid FROM pg_roles WHERE rolname = '${db}')`);
    expect(sql).toContain(
      `a.member = (SELECT oid FROM pg_roles WHERE rolname = '${db}') AND a.admin_option AND g.rolsuper`,
    );
    expect(() => dropOwnedDbsSql("postgres")).toThrow();
    const drop = dropScript(db);
    expect(drop.indexOf(sql)).toBeGreaterThan(-1);
    expect(drop.indexOf(sql)).toBeLessThan(drop.indexOf("DROP ROLE"));
  });

  it("role: squat flag read first; squat block sweeps databases before revoking ADMIN rows, no DROP ROLE", () => {
    const db = sessionDb(SID);
    const sql = roleScript(SID, "abcDEF0123456789_-xy", "/home/x/Work/demo");
    const at = (s: string) => {
      const i = sql.indexOf(s);
      expect(i).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(sql.startsWith("SELECT EXISTS (")).toBe(true);
    expect(at("AS shepherd_squatted \\gset")).toBeLessThan(at(`'CREATE ROLE ${db} LOGIN'`));
    expect(at("AS shepherd_squatted")).toBeLessThan(at("REVOKE %I FROM %I CASCADE"));
    const block = at("\\if :shepherd_squatted");
    expect(block).toBeGreaterThan(at("RESET ALL"));
    expect(at(dropOwnedDbsSql(db))).toBeGreaterThan(block);
    expect(at(dropOwnedDbsSql(db))).toBeLessThan(at("GRANTED BY %I CASCADE"));
    expect(at("GRANTED BY %I CASCADE")).toBeLessThan(at("\\endif"));
    expect(sql).not.toContain("DROP ROLE");
    // a same-named database the role doesn't own is dropped before the clone-exists count
    expect(at("d.datdba IS DISTINCT FROM")).toBeLessThan(at("SELECT count(*) FROM pg_database"));
  });

  it("role: at a fresh lease a pre-existing session role counts as squatted", () => {
    const db = sessionDb(SID);
    const flag = (fresh: boolean) =>
      roleScript(SID, "abcDEF0123456789_-xy", "/home/x/Work/demo", { verified: !fresh }).split(
        "\n",
      )[0]!;
    expect(flag(true)).toContain(
      `OR (SELECT oid FROM pg_roles WHERE rolname = '${db}') IS NOT NULL AS shepherd_squatted`,
    );
    expect(flag(false)).not.toContain("IS NOT NULL");
  });

  it("admin connections pin search_path and role", () => {
    expect(ADMIN_PGOPTIONS).toBe("-c search_path=pg_catalog,pg_temp -c role=none");
  });

  it("promote: guard in the clone first; REASSIGN + hand-back of other databases in one transaction", () => {
    const db = sessionDb(SID);
    const role = repoRole("/home/x/Work/demo");
    const sql = promoteScript("/home/x/Work/demo", SID);
    expect(sql.indexOf(`\\connect ${db}\n${GUARD_SQL}\n\\connect postgres`)).toBe(0);
    expect(sql).toContain(
      `BEGIN;\nREASSIGN OWNED BY ${db} TO ${role};\nSELECT format('ALTER DATABASE %I OWNER TO ${db}', datname) FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = '${role}')\\gexec\nCOMMIT;`,
    );
  });

  it("adopt: never a database owner; LOGIN roles only with includeLogin", () => {
    const leases = [{ db: sessionDb(SID), role: repoRole("/home/x/Work/demo") }];
    expect(adoptScript(leases)).toContain(
      "AND NOT EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid)",
    );
    expect(adoptScript(leases)).toContain("AND NOT r.rolcanlogin");
    const all = adoptScript(leases, { includeLogin: true });
    expect(all).toContain("WHERE d.datdba = r.oid");
    expect(all).not.toContain("rolcanlogin");
  });

  it("reclaim + untemplate target only non-superuser owners", () => {
    expect(RECLAIM_SQL).toContain("ALTER DATABASE %I OWNER TO %I");
    expect(RECLAIM_SQL).toContain("g.rolsuper");
    expect(RECLAIM_SQL).toContain("c.rolname ~ '^s_[0-9a-f]{32}$'");
    expect(RECLAIM_SQL).toContain("NOT h.rolsuper AND h.oid <> c.oid");
    expect(UNTEMPLATE_SQL).toContain("d.datistemplate AND NOT o.rolsuper");
  });
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
