// #4270: the login guard and the CREATEDB path, against a REAL postgres:18 — the string tests in
// postgres-core.test.ts can't prove what Postgres does with the generated SQL (event-trigger copy,
// grantor rows, template permissions). Runs the scripts exactly as PostgresService feeds them
// (`docker exec -i … psql -f -`) in a throwaway container; skipped without docker or the image.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  ADMIN_PGOPTIONS,
  HARDEN_SQL,
  RECLAIM_SQL,
  REVOKE_PUBLIC_SQL,
  UNTEMPLATE_SQL,
  GUARD_SQL,
  adoptScript,
  baseScript,
  cloneScript,
  conninfoDbname,
  dropOwnedDbsSql,
  dropScript,
  finishScript,
  promoteRestoreScript,
  promoteScript,
  repoBaseDb,
  repoRole,
  roleScript,
  sessionDb,
} from "../src/postgres-core";

const IMAGE = "postgres:18";
const CONTAINER = `shepherd-pgtest-${randomBytes(4).toString("hex")}`;

function dockerSync(args: string[], input?: string) {
  const r = Bun.spawnSync(["docker", ...args], {
    stdin: input === undefined ? undefined : Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { ok: r.exitCode === 0, out: r.stdout.toString(), err: r.stderr.toString() };
}

const AVAILABLE =
  dockerSync(["info"]).ok &&
  (dockerSync(["image", "inspect", IMAGE]).ok || dockerSync(["pull", "-q", IMAGE]).ok);

/** Superuser over the local socket, like PostgresService.psql(). Throws on any error. */
function su(sql: string, db = "postgres", options = ADMIN_PGOPTIONS): string {
  const r = dockerSync(
    [
      "exec",
      "-i",
      "-e",
      `PGOPTIONS=${options}`,
      CONTAINER,
      "psql",
      "-X",
      "-q",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      db,
      "-f",
      "-",
    ],
    sql,
  );
  if (!r.ok) throw new Error(`superuser psql failed: ${r.err}`);
  return r.out.trim();
}

/** The `as()` argv: a TCP login, as a session would make one; `options` → PGOPTIONS. */
function asArgs(user: string, password: string, db: string, options = "") {
  return [
    "exec",
    "-i",
    "-e",
    `PGPASSWORD=${password}`,
    "-e",
    `PGOPTIONS=${options}`,
    CONTAINER,
    "psql",
    "-X",
    "-q",
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-h",
    "127.0.0.1",
    "-U",
    user,
    "-d",
    db,
    "-f",
    "-",
  ];
}

/** A login running `sql` in the background (a lock holder or waiter). */
function asAsync(user: string, password: string, db: string, sql: string) {
  const p = Bun.spawn(["docker", ...asArgs(user, password, db)], {
    stdin: Buffer.from(sql),
    stdout: "pipe",
    stderr: "pipe",
  });
  return p.exited;
}

/** A TCP login, as a session would make one. */
function as(user: string, password: string, db: string, sql = "SELECT 1;", options = "") {
  return dockerSync(asArgs(user, password, db, options), sql);
}

const pw = () => `pw_${randomBytes(12).toString("hex")}`;

interface Sess {
  id: string;
  db: string;
  pw: string;
  repo: string;
}
const leases: { db: string; role: string }[] = [];
/** Sessions whose roleScript succeeded once (the store's `roleVerified`). */
const verifiedDbs = new Set<string>();

/** PostgresService.provision(), minus the store. */
function provision(repo: string, id: string = randomUUID(), bypassRls = false): Sess {
  const s = { id, db: sessionDb(id), pw: pw(), repo };
  if (!leases.some((l) => l.db === s.db)) leases.push({ db: s.db, role: repoRole(repo) });
  su(baseScript(repo));
  su(adoptScript(leases) || "SELECT 1;");
  const exists = su(roleScript(id, s.pw, repo, { verified: verifiedDbs.has(s.db), bypassRls }))
    .split("\n")
    .pop();
  verifiedDbs.add(s.db);
  if (exists === "0") su(cloneScript(repo, id));
  su(finishScript(id));
  return s;
}

/** PostgresService.drop(). */
function drop(s: Sess) {
  su(dropOwnedDbsSql(s.db));
  su(adoptScript([{ db: s.db, role: repoRole(s.repo) }], { includeLogin: true }) || "SELECT 1;");
  su(dropScript(s.db));
}

const tick = () => {
  su(RECLAIM_SQL + UNTEMPLATE_SQL + REVOKE_PUBLIC_SQL);
  su(adoptScript(leases) || "SELECT 1;");
};

const owner = (db: string) =>
  su(`SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = '${db}';`);
const dbExists = (db: string) =>
  su(`SELECT count(*) FROM pg_database WHERE datname = '${db}';`) === "1";
const refused = (r: { ok: boolean; err: string }) => {
  expect(r.ok).toBe(false);
  expect(r.err).toContain("may not connect to database");
};

const REPO_A = "/repos/alpha";
const REPO_B = "/repos/bravo";
const REPO_C = "/repos/charlie";
let A: Sess;
let A2: Sess;
let B: Sess;

describe.skipIf(!AVAILABLE)("login guard on a real postgres:18 (#4270)", () => {
  beforeAll(async () => {
    const run = dockerSync([
      "run",
      "-d",
      "--rm",
      "--name",
      CONTAINER,
      "-e",
      `POSTGRES_PASSWORD=${pw()}`,
      IMAGE,
    ]);
    if (!run.ok) throw new Error(`docker run failed: ${run.err}`);
    // The image's init runs a socket-only server first; TCP answers only once the real one is up.
    for (let i = 0; i < 120; i++) {
      if (dockerSync(["exec", CONTAINER, "pg_isready", "-h", "127.0.0.1", "-q"]).ok) break;
      await Bun.sleep(500);
    }
    su(HARDEN_SQL);
    A = provision(REPO_A);
    A2 = provision(REPO_A);
    B = provision(REPO_B);
  }, 180_000);

  afterAll(() => {
    dockerSync(["rm", "-f", CONTAINER]);
  });

  const appPw = pw();

  it("(a) a session creates a role + database; it and its role connect", () => {
    expect(as(A.db, A.pw, A.db).ok).toBe(true);
    const r = as(
      A.db,
      A.pw,
      A.db,
      `CREATE ROLE mvp_app_1 LOGIN PASSWORD '${appPw}' NOSUPERUSER NOBYPASSRLS;\nCREATE DATABASE mvp_test_1;`,
    );
    expect(r.err).toBe("");
    expect(as(A.db, A.pw, "mvp_test_1", "SELECT count(*) FROM pg_event_trigger;").out.trim()).toBe(
      "1",
    );
    expect(as("mvp_app_1", appPw, "mvp_test_1").ok).toBe(true);
  }, 60_000);

  it("repo RLS-bypass opt-in: the owner skips FORCE RLS; shared roles never keep BYPASSRLS", () => {
    let D = provision("/repos/rlsbypass", randomUUID(), true);
    const seed =
      "CREATE TABLE t (id int);\nALTER TABLE t ENABLE ROW LEVEL SECURITY;\nALTER TABLE t FORCE ROW LEVEL SECURITY;\nINSERT INTO t VALUES (1);";
    expect(as(D.db, D.pw, D.db, seed).err).toBe("");
    // Opt-in off: the next provision takes the bypass back.
    D = provision(D.repo, D.id);
    const r = as(D.db, D.pw, D.db, "INSERT INTO t VALUES (2);");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("row-level security");
    D = provision(D.repo, D.id, true);
    expect(as(D.db, D.pw, D.db, "CREATE ROLE rls_app NOLOGIN BYPASSRLS;").err).toBe("");
    tick();
    expect(su("SELECT rolbypassrls FROM pg_roles WHERE rolname = 'rls_app';")).toBe("f");
  }, 60_000);

  it("test-privileges opt-in: replica mode, its app roles' lock waits; the guard still fires; off revokes", async () => {
    const repo = "/repos/testpriv";
    const sibling = provision(repo);
    expect(as(sibling.db, sibling.pw, sibling.db, "CREATE ROLE tp_shared NOLOGIN;").err).toBe("");
    tick(); // adopted by the repo role
    let E = provision(repo, randomUUID(), true);
    const replica = "-c session_replication_role=replica";
    const usage = (role: string) => su(`SELECT pg_has_role('${E.db}', '${role}', 'USAGE');`);

    // SET LOCAL in its clone, replica as a startup option in a database it created.
    expect(
      as(E.db, E.pw, E.db, "BEGIN;\nSET LOCAL session_replication_role = replica;\nCOMMIT;").err,
    ).toBe("");
    expect(as(E.db, E.pw, E.db, "CREATE DATABASE tp_own;").err).toBe("");
    expect(as(E.db, E.pw, "tp_own", "SHOW session_replication_role;", replica).out.trim()).toBe(
      "replica",
    );
    // The login guard fires in replica mode: another session's database stays shut.
    expect(as(B.db, B.pw, B.db, "CREATE DATABASE tp_other;").err).toBe("");
    refused(as(E.db, E.pw, "tp_other", "SELECT 1;", replica));

    // A role it creates (createrole_self_grant) and one its repo role administers are inherited.
    const appPw = pw();
    expect(
      as(
        E.db,
        E.pw,
        "tp_own",
        `CREATE ROLE tp_app LOGIN PASSWORD '${appPw}';\nCREATE TABLE lk (id int);\nGRANT ALL ON lk TO tp_app;`,
      ).err,
    ).toBe("");
    expect(usage("tp_app")).toBe("t");
    expect(usage("tp_shared")).toBe("t");
    // So its admin connection sees the app role's lock wait in pg_stat_activity.
    const holder = asAsync(E.db, E.pw, "tp_own", "BEGIN;\nLOCK lk;\nSELECT pg_sleep(4);\nCOMMIT;");
    await Bun.sleep(800);
    const waiter = asAsync("tp_app", appPw, "tp_own", "SELECT * FROM lk;");
    let waiting = "";
    for (let i = 0; i < 20 && waiting !== "1"; i++) {
      await Bun.sleep(150);
      waiting = as(
        E.db,
        E.pw,
        "tp_own",
        "SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND usename = 'tp_app' AND wait_event_type = 'Lock';",
      ).out.trim();
    }
    expect(waiting).toBe("1");
    expect(await holder).toBe(0);
    expect(await waiter).toBe(0);

    // Stored replica settings on roles it administers and a database it owns…
    const stored = () =>
      su(
        "SELECT count(*) FROM pg_db_role_setting s WHERE EXISTS (SELECT 1 FROM unnest(s.setconfig) c WHERE c LIKE 'session_replication_role=%');",
      );
    expect(
      as(
        E.db,
        E.pw,
        E.db,
        "ALTER ROLE tp_app SET session_replication_role = replica;\nALTER ROLE tp_shared SET session_replication_role = replica;\nALTER ROLE tp_app IN DATABASE tp_own SET session_replication_role = replica;\nALTER DATABASE tp_own SET session_replication_role = replica;",
      ).err,
    ).toBe("");
    expect(stored()).toBe("4");
    // …a shared role loses it at the next adoption tick, even while the opt-in is on.
    tick();
    expect(
      su(
        "SELECT count(*) FROM pg_db_role_setting s JOIN pg_roles r ON r.oid = s.setrole WHERE r.rolname = 'tp_shared';",
      ),
    ).toBe("0");
    expect(stored()).toBe("3");

    // Opt-in off: the next provision takes the parameter, Shepherd's INHERIT grants and every
    // stored replica setting back.
    E = provision(repo, E.id);
    expect(stored()).toBe("0");
    const r = as(
      E.db,
      E.pw,
      E.db,
      "BEGIN;\nSET LOCAL session_replication_role = replica;\nCOMMIT;",
    );
    expect(r.ok).toBe(false);
    expect(r.err).toContain("permission denied to set parameter");
    expect(usage("tp_shared")).toBe("f");
    expect(su(`SELECT rolconfig FROM pg_roles WHERE rolname = '${E.db}';`)).toBe("");

    // A session holding the grants drops cleanly.
    E = provision(repo, E.id, true);
    drop(E);
    expect(su(`SELECT count(*) FROM pg_roles WHERE rolname = '${E.db}';`)).toBe("0");
    expect(dbExists("tp_own")).toBe(false);
  }, 90_000);

  it("GUARD_SQL upgrades an origin-only guard to ENABLE ALWAYS in any database name", () => {
    for (const name of ["plain_db", "x=y", "a'b \\c"]) {
      const target = conninfoDbname(name);
      su(`CREATE DATABASE "${name}";`);
      su("ALTER EVENT TRIGGER shepherd_login_guard ENABLE;", target);
      const state = () =>
        su(
          "SELECT evtenabled FROM pg_event_trigger WHERE evtname = 'shepherd_login_guard';",
          target,
        );
      expect(state()).toBe("O");
      su(GUARD_SQL, target);
      expect(state()).toBe("A");
      su(`DROP DATABASE "${name}";`);
    }
  }, 60_000);

  it("(b) another session is refused", () => {
    refused(as(B.db, B.pw, "mvp_test_1"));
  }, 60_000);

  it("(c)(d) a role another session made and handed ADMIN to the owner is refused", () => {
    const evil = pw();
    expect(
      as(
        B.db,
        B.pw,
        B.db,
        `CREATE ROLE evil LOGIN PASSWORD '${evil}';\nGRANT evil TO ${A.db} WITH ADMIN OPTION;`,
      ).ok,
    ).toBe(true);
    refused(as("evil", evil, "mvp_test_1"));
    expect(
      as(B.db, B.pw, B.db, `CREATE ROLE evil2 LOGIN PASSWORD '${evil}' ADMIN ${A.db};`).ok,
    ).toBe(true);
    refused(as("evil2", evil, "mvp_test_1"));
  }, 60_000);

  it("(e) no copying template0, another session's database or clone", () => {
    for (const t of ["template0", "mvp_test_1", A.db]) {
      const r = as(
        B.db,
        B.pw,
        B.db,
        `CREATE DATABASE cp_${randomBytes(3).toString("hex")} TEMPLATE ${t};`,
      );
      expect(r.ok).toBe(false);
      expect(r.err).toContain("permission denied to copy database");
    }
  }, 60_000);

  it("(f)(g) the guard can't be switched off or removed", () => {
    const off = dockerSync([
      "exec",
      "-i",
      "-e",
      `PGPASSWORD=${B.pw}`,
      "-e",
      "PGOPTIONS=-c event_triggers=off",
      CONTAINER,
      "psql",
      "-X",
      "-At",
      "-h",
      "127.0.0.1",
      "-U",
      B.db,
      "-d",
      "mvp_test_1",
      "-c",
      "SELECT 1",
    ]);
    expect(off.ok).toBe(false);
    expect(as(B.db, B.pw, B.db, `ALTER ROLE ${B.db} SET event_triggers = off;`).ok).toBe(false);
    for (const sql of [
      "ALTER DATABASE mvp_test_1 SET event_triggers = off;",
      "ALTER EVENT TRIGGER shepherd_login_guard DISABLE;",
      "DROP FUNCTION shepherd.login_guard() CASCADE;",
      "DROP SCHEMA shepherd CASCADE;",
      "ALTER SCHEMA shepherd RENAME TO x;",
    ])
      expect(as(A.db, A.pw, "mvp_test_1", sql).ok).toBe(false);
    refused(as(B.db, B.pw, "mvp_test_1"));
  }, 60_000);

  it("(h) Shepherd's databases stay pinned by hba", () => {
    expect(as(B.db, B.pw, A.db).err).toContain("pg_hba.conf rejects connection");
    expect(as(B.db, B.pw, "template1").err).toContain("pg_hba.conf rejects connection");
    expect(as(B.db, B.pw, repoBaseDb(REPO_B)).err).toContain("pg_hba.conf rejects connection");
  }, 60_000);

  it("(n) adoption: a live LOGIN role isn't adopted; an adopted NOLOGIN role made LOGIN is refused", () => {
    expect(as(A.db, A.pw, A.db, "CREATE ROLE app_rls NOLOGIN;").ok).toBe(true);
    tick();
    expect(as(A2.db, A2.pw, A2.db, `ALTER ROLE mvp_app_1 PASSWORD '${pw()}';`).ok).toBe(false);
    expect(as("mvp_app_1", appPw, "mvp_test_1").ok).toBe(true);
    const rls = pw();
    expect(as(A2.db, A2.pw, A2.db, `ALTER ROLE app_rls LOGIN PASSWORD '${rls}';`).ok).toBe(true);
    refused(as("app_rls", rls, "mvp_test_1"));
  }, 60_000);

  it("(o) databases owned by roles the session created: theirs alone, never adopted", () => {
    const own = pw();
    const fake = sessionDb(randomUUID());
    const fakePw = pw();
    const r = as(
      A.db,
      A.pw,
      A.db,
      [
        `CREATE ROLE app_own LOGIN PASSWORD '${own}';`,
        "CREATE ROLE app_nl NOLOGIN;",
        `CREATE ROLE ${fake} LOGIN PASSWORD '${fakePw}';`,
        `GRANT app_own, app_nl, ${fake} TO ${A.db} WITH INHERIT FALSE, SET TRUE;`,
        "CREATE DATABASE t_own OWNER app_own;",
        "CREATE DATABASE t_nl OWNER app_nl;",
        `CREATE DATABASE t_fake OWNER ${fake};`,
      ].join("\n"),
    );
    expect(r.err).toBe("");
    expect(as(A.db, A.pw, "t_own").ok).toBe(true);
    expect(as("app_own", own, "t_own").ok).toBe(true);
    tick();
    for (const sql of [
      `GRANT app_nl TO ${A2.db};`,
      `ALTER ROLE app_nl LOGIN PASSWORD '${pw()}';`,
      `ALTER DATABASE t_nl OWNER TO ${A2.db};`,
      "CREATE DATABASE cp_nl TEMPLATE t_nl;",
      `ALTER ROLE ${fake} PASSWORD '${pw()}';`,
    ])
      expect(as(A2.db, A2.pw, A2.db, sql).ok).toBe(false);
    refused(as(A2.db, A2.pw, "t_nl"));
    refused(as(A2.db, A2.pw, "t_fake"));
  }, 60_000);

  it("(q) a database handed to an already-adopted role is reclaimed by the tick", () => {
    expect(as(A.db, A.pw, A.db, "CREATE ROLE app_late NOLOGIN;").ok).toBe(true);
    tick();
    expect(
      as(
        A.db,
        A.pw,
        A.db,
        `GRANT app_late TO ${A.db} WITH INHERIT FALSE, SET TRUE;\nCREATE DATABASE t_late OWNER app_late;`,
      ).err,
    ).toBe("");
    tick();
    expect(owner("t_late")).toBe(A.db);
    expect(as(A2.db, A2.pw, A2.db, `ALTER DATABASE t_late OWNER TO ${A2.db};`).ok).toBe(false);
    expect(as(A2.db, A2.pw, A2.db, "CREATE DATABASE cp_late TEMPLATE t_late;").ok).toBe(false);
  }, 60_000);

  it("(l) a session-set IS_TEMPLATE is reset", () => {
    expect(as(A.db, A.pw, A.db, "ALTER DATABASE mvp_test_1 IS_TEMPLATE true;").ok).toBe(true);
    su(UNTEMPLATE_SQL);
    expect(su("SELECT datistemplate FROM pg_database WHERE datname = 'mvp_test_1';")).toBe("f");
  }, 60_000);

  it("(j) promote: the session's databases stay its own, the repo role owns none — also on failure", async () => {
    const repoOwns = () =>
      su(
        `SELECT count(*) FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = '${repoRole(REPO_A)}');`,
      );
    // A connection held on the base makes the rename fail after the hand-off.
    const holder = Bun.spawn(
      [
        "docker",
        "exec",
        CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        repoBaseDb(REPO_A),
        "-c",
        "SELECT pg_sleep(20)",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await Bun.sleep(1500);
    su(baseScript(REPO_A));
    expect(() => su(promoteScript(REPO_A, A.id))).toThrow();
    su(promoteRestoreScript(REPO_A, A.id));
    holder.kill();
    dockerSync([
      "exec",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-c",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${repoBaseDb(REPO_A)}' AND pid <> pg_backend_pid();`,
    ]);
    expect(owner("mvp_test_1")).toBe(A.db);
    expect(repoOwns()).toBe("0");
    su(baseScript(REPO_A));
    su(promoteScript(REPO_A, A.id));
    su(promoteRestoreScript(REPO_A, A.id));
    expect(owner("mvp_test_1")).toBe(A.db);
    expect(owner(A.db)).toBe(A.db);
    expect(repoOwns()).toBe("0");
  }, 90_000);

  it("(k) a squatted session role is cleaned up without DROP ROLE; its child roles lose trust", () => {
    const id = randomUUID();
    const s = sessionDb(id);
    const sqPw = pw();
    const childPw = pw();
    expect(
      as(
        B.db,
        B.pw,
        B.db,
        [
          `CREATE ROLE ${s} LOGIN CREATEROLE PASSWORD '${sqPw}';`,
          `GRANT ${s} TO ${B.db} WITH INHERIT FALSE, SET TRUE;`,
          `GRANT CREATE ON SCHEMA public TO ${s};`,
          `CREATE DATABASE t_sq OWNER ${s};`,
          `CREATE DATABASE ${s} OWNER ${s};`,
          `SET ROLE ${s};`,
          "CREATE TABLE public.left_behind ();",
          `CREATE ROLE child_sq LOGIN PASSWORD '${childPw}';`,
        ].join("\n"),
      ).err,
    ).toBe("");
    const S = provision(REPO_B, id);
    expect(dbExists("t_sq")).toBe(false);
    expect(owner(s)).toBe(s);
    expect(su(`SELECT count(*) FROM pg_namespace WHERE nspname = 'shepherd';`, s)).toBe("1");
    expect(as(S.db, S.pw, S.db, "CREATE DATABASE t_s2;").ok).toBe(true);
    refused(as("child_sq", childPw, "t_s2"));
    expect(as(s, sqPw, S.db).ok).toBe(false);
  }, 60_000);

  it("(m) a database named like a clone but made by another role is replaced", () => {
    const id = randomUUID();
    expect(as(B.db, B.pw, B.db, `CREATE DATABASE ${sessionDb(id)};`).ok).toBe(true);
    const M = provision(REPO_B, id);
    expect(owner(M.db)).toBe(M.db);
    expect(
      su("SELECT count(*) FROM pg_event_trigger WHERE evtname = 'shepherd_login_guard';", M.db),
    ).toBe("1");
  }, 60_000);

  it("(p) a session-planted shepherd.login_guard is replaced, never run by the superuser", () => {
    const id = randomUUID();
    const c = sessionDb(id);
    const cPw = pw();
    su(baseScript(REPO_C));
    su(roleScript(id, cPw, REPO_C));
    // An unguarded clone, as before this change.
    su(
      `CREATE DATABASE ${c} TEMPLATE template0 OWNER ${c};\nREVOKE CONNECT, TEMPORARY ON DATABASE ${c} FROM PUBLIC;`,
    );
    const plant = as(
      c,
      cPw,
      c,
      [
        "CREATE TABLE public.pwn (who text);",
        "GRANT INSERT ON public.pwn TO PUBLIC;",
        "CREATE SCHEMA shepherd;",
        "CREATE FUNCTION shepherd.login_guard() RETURNS event_trigger LANGUAGE plpgsql SECURITY INVOKER AS $$ BEGIN INSERT INTO public.pwn VALUES (current_user); END $$;",
      ].join("\n"),
    );
    expect(plant.err).toBe("");
    su(finishScript(id));
    expect(
      su("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'shepherd';", c),
    ).toBe("postgres");
    expect(
      su(
        "SELECT pg_get_userbyid(proowner) || ' ' || prosecdef FROM pg_proc WHERE proname = 'login_guard';",
        c,
      ),
    ).toBe("postgres true");
    expect(as(c, cPw, c).ok).toBe(true);
    expect(su("SELECT count(*) FROM public.pwn;", c)).toBe("0");
    leases.push({ db: c, role: repoRole(REPO_C) });
    su(promoteScript(REPO_C, id));
    su(promoteRestoreScript(REPO_C, id));
    expect(
      su(
        "SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'shepherd';",
        repoBaseDb(REPO_C),
      ),
    ).toBe("postgres");
  }, 60_000);

  it("(r) a session's database settings and functions never run as the superuser", () => {
    const plant = [
      "CREATE SCHEMA evil;",
      "CREATE TABLE evil.hit (who text);",
      "GRANT USAGE ON SCHEMA evil TO PUBLIC;",
      "GRANT INSERT ON evil.hit TO PUBLIC;",
      "CREATE FUNCTION evil.current_setting(text) RETURNS text LANGUAGE plpgsql AS $$ BEGIN INSERT INTO evil.hit VALUES (current_user); RETURN pg_catalog.current_setting($1); END $$;",
      `ALTER DATABASE ${A2.db} SET search_path = evil, pg_catalog;`,
    ].join("\n");
    expect(as(A2.db, A2.pw, A2.db, plant).err).toBe("");
    expect(as(A2.db, A2.pw, A2.db, `ALTER DATABASE ${A2.db} SET role = '${A2.db}';`).ok).toBe(true);
    // Without the options the planted settings bite (role → the session; its function runs).
    su("SELECT current_setting('server_version_num');", A2.db, "");
    expect(su("SELECT count(*) FROM evil.hit;", A2.db)).toBe("1");
    su("TRUNCATE evil.hit;", A2.db);
    su(finishScript(A2.id));
    su(baseScript(REPO_A));
    su(promoteScript(REPO_A, A2.id));
    su(promoteRestoreScript(REPO_A, A2.id));
    expect(su("SELECT count(*) FROM evil.hit;", A2.db)).toBe("0");
    expect(su(`SELECT rolsuper FROM pg_roles WHERE rolname = '${A2.db}';`)).toBe("f");
    expect(
      su("SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'shepherd';", A2.db),
    ).toBe("postgres");
  }, 90_000);

  it("(k2) an orphaned squat (its creator dropped) is still cleaned up at a fresh lease", () => {
    const id = randomUUID();
    const s = sessionDb(id);
    const xPw = pw();
    const spyPw = pw();
    const r = as(
      B.db,
      B.pw,
      B.db,
      [
        `CREATE ROLE sq_x LOGIN CREATEROLE PASSWORD '${xPw}';`,
        `GRANT sq_x TO ${B.db} WITH INHERIT FALSE, SET TRUE;`,
        "SET ROLE sq_x;",
        `CREATE ROLE ${s} LOGIN CREATEROLE;`,
        `GRANT ${s} TO sq_x WITH INHERIT FALSE, SET TRUE;`,
        `SET ROLE ${s};`,
        `CREATE ROLE spy LOGIN PASSWORD '${spyPw}';`,
        "RESET ROLE;",
        "DROP ROLE sq_x;",
      ].join("\n"),
    );
    expect(r.err).toBe("");
    // Orphaned: nobody but superusers administers the squatted role any more.
    expect(
      su(`SELECT count(*) FROM pg_auth_members WHERE roleid = '${s}'::regrole AND admin_option;`),
    ).toBe("0");
    const S = provision(REPO_B, id);
    expect(as(S.db, S.pw, S.db, "CREATE DATABASE t_v;").ok).toBe(true);
    refused(as("spy", spyPw, "t_v"));
  }, 60_000);

  it("(t) templated squats never block provision, base, promote or drop", () => {
    const id = randomUUID();
    const repoD = "/repos/delta";
    const role = repoRole(repoD);
    const r = as(
      B.db,
      B.pw,
      B.db,
      [
        `CREATE DATABASE ${sessionDb(id)} IS_TEMPLATE true;`,
        `CREATE DATABASE ${repoBaseDb(repoD)} IS_TEMPLATE true;`,
        `CREATE DATABASE ${role}_next IS_TEMPLATE true;`,
        `CREATE DATABASE ${role}_old IS_TEMPLATE true;`,
      ].join("\n"),
    );
    expect(r.err).toBe("");
    const D = provision(repoD, id);
    expect(owner(D.db)).toBe(D.db);
    expect(owner(repoBaseDb(repoD))).toBe("postgres");
    su(promoteScript(repoD, id));
    su(promoteRestoreScript(repoD, id));
    expect(dbExists(`${role}_next`) || dbExists(`${role}_old`)).toBe(false);
    expect(as(D.db, D.pw, D.db, "CREATE DATABASE t_d IS_TEMPLATE true;").ok).toBe(true);
    drop(D);
    expect(dbExists("t_d")).toBe(false);
    expect(dbExists(D.db)).toBe(false);
  }, 90_000);

  it("(u) a squat whose cleanup failed part-way is still cleaned up on the retry", () => {
    const id = randomUUID();
    const s = sessionDb(id);
    const spyPw = pw();
    const r = as(
      B.db,
      B.pw,
      B.db,
      [
        `CREATE ROLE ${s} LOGIN CREATEROLE;`,
        `GRANT ${s} TO ${B.db} WITH INHERIT FALSE, SET TRUE;`,
        `SET ROLE ${s};`,
        `CREATE ROLE spy_u LOGIN PASSWORD '${spyPw}';`,
        "RESET ROLE;",
        `CREATE DATABASE t_u OWNER ${s} IS_TEMPLATE true;`,
      ].join("\n"),
    );
    expect(r.err).toBe("");
    leases.push({ db: s, role: repoRole(REPO_B) });
    su(baseScript(REPO_B));
    // First provision dies inside the squat block, after the admin holders were revoked and before
    // the creator rows were: the role now looks orphaned.
    const broken = roleScript(id, pw(), REPO_B, { verified: false }).replace(
      "SELECT format('REVOKE %I FROM %I GRANTED BY",
      "SELECT 1/0;\nSELECT format('REVOKE %I FROM %I GRANTED BY",
    );
    expect(() => su(broken)).toThrow();
    expect(dbExists("t_u")).toBe(false);
    expect(
      su(`SELECT count(*) FROM pg_auth_members WHERE roleid = '${s}'::regrole AND admin_option;`),
    ).toBe("0");
    const S = provision(REPO_B, id);
    expect(as(S.db, S.pw, S.db, "CREATE DATABASE t_u2;").ok).toBe(true);
    refused(as("spy_u", spyPw, "t_u2"));
  }, 60_000);

  it("(v) an unguarded superuser database (operator-made, template0 copy) stays closed", () => {
    su("CREATE DATABASE op_restore TEMPLATE template0;");
    // Default PUBLIC CONNECT and no guard: open until the tick (HARDEN at start covers older ones).
    tick();
    const r = as(B.db, B.pw, "op_restore");
    expect(r.ok).toBe(false);
    expect(r.err).toContain("permission denied for database");
    su("DROP DATABASE op_restore;");
    su("CREATE DATABASE op_preexisting TEMPLATE template0;");
    su(HARDEN_SQL);
    expect(as(B.db, B.pw, "op_preexisting").ok).toBe(false);
  }, 60_000);

  it("(i) archiving drops every database the session or its roles own; nothing adopted owns one", () => {
    drop(A);
    for (const db of [A.db, "mvp_test_1", "t_own", "t_nl", "t_fake", "t_late"])
      expect(dbExists(db)).toBe(false);
    expect(su(`SELECT count(*) FROM pg_roles WHERE rolname = '${A.db}';`)).toBe("0");
    expect(
      su(
        `SELECT count(*) FROM pg_auth_members WHERE roleid = 'mvp_app_1'::regrole AND member = '${repoRole(REPO_A)}'::regrole AND admin_option;`,
      ),
    ).toBe("1");
    expect(
      su(
        "SELECT count(*) FROM pg_database d JOIN pg_auth_members a ON a.roleid = d.datdba AND a.admin_option " +
          `WHERE a.member = '${repoRole(REPO_A)}'::regrole;`,
      ),
    ).toBe("0");
  }, 60_000);
});
