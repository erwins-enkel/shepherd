import { describe, expect, it } from "bun:test";
import {
  DEFAULT_POSTGRES_SETTINGS,
  HARDEN_SQL,
  postgresInstanceNames,
  adoptScript,
  baseScript,
  cloneScript,
  connectionFor,
  dropScript,
  isImageRef,
  isSessionDbName,
  parsePostgresPatch,
  repoBaseDb,
  repoRole,
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
    expect(sql).toContain(`ALTER ROLE ${db} WITH LOGIN NOCREATEROLE PASSWORD`);
    expect(sql).toContain(`'ALTER ROLE ${db} CREATEROLE' ${pg16}`);
    expect(sql).toContain(
      `'GRANT ${repoRole(repo)} TO ${db} WITH INHERIT TRUE, SET FALSE' ${pg16}`,
    );
    // The caller reads the clone-exists count from the last line.
    expect(sql.trim().split("\n").pop()).toMatch(/^SELECT count\(\*\) FROM pg_database/);
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

  it("adopt: hands roles a session administers to its repo role, never managed names", () => {
    const db = sessionDb(SID);
    const role = repoRole(repo);
    const sql = adoptScript([{ db, role }]);
    expect(sql).toContain("GRANT %I TO %I WITH ADMIN OPTION, INHERIT FALSE, SET FALSE");
    expect(sql).toContain(`h.rolname = '${role}'`);
    expect(sql).toContain(`m.rolname = '${db}' AND a.admin_option AND NOT r.rolsuper`);
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
});

it("hardening revokes PUBLIC access to the built-in databases", () => {
  expect(HARDEN_SQL).toContain("REVOKE CONNECT, TEMPORARY ON DATABASE postgres FROM PUBLIC;");
  expect(HARDEN_SQL).toContain("REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC;");
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

it("idle stop after N minutes", () => {
  expect(shouldIdleStop(15 * 60_000, 0, 15)).toBe(true);
  expect(shouldIdleStop(15 * 60_000 - 1, 0, 15)).toBe(false);
});
