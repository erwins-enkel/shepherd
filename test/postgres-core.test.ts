import { describe, expect, it } from "bun:test";
import {
  DEFAULT_POSTGRES_SETTINGS,
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
    expect(sql).toContain(`REVOKE CONNECT ON DATABASE ${repoBaseDb(repo)} FROM PUBLIC;`);
    expect(sql).toContain(`CREATE ROLE ${repoRole(repo)} NOLOGIN`);
  });

  it("clone: FILE_COPY + clone, revoke, reassign inside the clone", () => {
    const db = sessionDb(SID);
    const sql = cloneScript(repo, SID);
    expect(sql).toContain("SET file_copy_method = clone;");
    expect(sql).toContain(
      `CREATE DATABASE ${db} TEMPLATE ${repoBaseDb(repo)} STRATEGY FILE_COPY OWNER ${db};`,
    );
    expect(sql).toContain(`REVOKE CONNECT ON DATABASE ${db} FROM PUBLIC;`);
    expect(sql.indexOf(`\\connect ${db}`)).toBeLessThan(sql.indexOf("REASSIGN OWNED"));
    expect(sql).toContain(`REASSIGN OWNED BY ${repoRole(repo)} TO ${db};`);
  });

  it("role: password only as a validated literal", () => {
    expect(roleScript(SID, "abcDEF0123456789_-xy")).toContain("PASSWORD 'abcDEF0123456789_-xy'");
    expect(() => roleScript(SID, "bad'pw")).toThrow();
  });

  it("drop refuses non-session names", () => {
    expect(dropScript(sessionDb(SID))).toContain("WITH (FORCE)");
    expect(() => dropScript("postgres")).toThrow();
  });
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
