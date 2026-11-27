import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresService, PostgresError, type DockerRun } from "../src/postgres";
import {
  ADMIN_PGOPTIONS,
  POSTGRES_SETTING,
  RECLAIM_SQL,
  REVOKE_PUBLIC_SQL,
  UNTEMPLATE_SQL,
  dropOwnedDbsSql,
  finishScript,
  repoBaseDb,
  sessionDb,
} from "../src/postgres-core";
import { SessionStore } from "../src/store";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";

/** A tiny in-memory docker + cluster: enough state to drive the service's real argv/SQL. */
class FakeDocker {
  calls: { args: string[]; input?: string }[] = [];
  exists = false;
  running = false;
  image = "";
  port = "";
  imagePresent = true;
  dockerDown = false;
  failRun = false;
  failAdopt = false;
  failRoleOnce = false;
  failPromote = false;
  ready = true;
  clients = 0;
  dbs = new Set<string>();
  roles = new Set<string>();
  name = "shepherd-postgres-18";

  run: DockerRun = async (args, opts) => {
    this.calls.push({ args, input: opts.input });
    if (this.dockerDown) throw new Error("Docker failed");
    const [cmd, sub] = args;
    if (cmd === "ps")
      return this.exists
        ? `${this.running ? "running" : "exited"}\t${this.image}\t${this.port}\n`
        : "";
    if (cmd === "image") {
      if (!this.imagePresent) throw new Error("no such image");
      return "sha256:x\n";
    }
    if (cmd === "pull") {
      this.imagePresent = true;
      return "";
    }
    if (cmd === "run") return this.doRun(args);
    if (cmd === "start") return this.set(true);
    if (cmd === "stop") return this.set(false);
    if (cmd === "rm") {
      this.exists = this.running = false;
      return "";
    }
    if (cmd === "exec" && args[sub === "-i" ? 4 : 1] !== this.name)
      throw new Error(`exec on unknown container: ${args.join(" ")}`);
    if (cmd === "exec" && sub === "-i") return this.sql(opts.input ?? "");
    if (cmd === "exec") {
      if (!this.running || !this.ready) throw new Error("not ready");
      return "";
    }
    throw new Error(`unexpected docker ${args.join(" ")}`);
  };

  private doRun(args: string[]): string {
    if (this.failRun) throw new Error("port is already allocated");
    const label = (k: string) =>
      args[args.indexOf(args.find((a) => a.startsWith(`${k}=`)) ?? "") ?? -1]?.split("=")[1] ?? "";
    this.exists = this.running = true;
    this.image = label("run.shepherd.image");
    this.port = label("run.shepherd.port");
    return "cid\n";
  }

  private set(running: boolean): string {
    this.running = running;
    return "";
  }

  private sql(raw: string): string {
    if (!this.running) throw new Error("not running");
    // The fake cluster never has a squatted session role: skip roleScript's squat-only block.
    const input = raw.replace(/\\if :shepherd_squatted[\s\S]*?\\endif/g, "");
    if (this.failPromote && input.includes("RENAME TO")) throw new Error("being accessed");
    if (input.includes("pg_terminate_backend")) return "0\n";
    if (input.includes("pg_stat_activity")) return `${this.clients}\n`;
    if (input.includes("WITH ADMIN OPTION") && this.failAdopt) throw new Error("adopt failed");
    if (this.failRoleOnce && input.includes("AS shepherd_squatted")) {
      this.failRoleOnce = false;
      throw new Error("cannot drop a template database");
    }
    if (input.includes("UNION SELECT rolname"))
      return [...new Set([...this.dbs, ...this.roles])].join("\n");
    for (const m of input.matchAll(/FROM pg_database d WHERE d\.datname = '(\w+)'\\gexec/g))
      this.dbs.delete(m[1]!);
    for (const m of input.matchAll(/DROP ROLE IF EXISTS (\w+)/g)) this.roles.delete(m[1]!);
    for (const m of input.matchAll(/^CREATE DATABASE (s_\w+) TEMPLATE/gm)) this.dbs.add(m[1]!);
    const role = input.match(/ALTER ROLE (s_\w+) WITH LOGIN/);
    if (role) {
      this.roles.add(role[1]!);
      return `${this.dbs.has(role[1]!) ? 1 : 0}\n`;
    }
    return "";
  }

  count(cmd: string): number {
    return this.calls.filter((c) => c.args[0] === cmd).length;
  }
  sqlCalls(re: RegExp): number {
    return this.calls.filter((c) => c.input && re.test(c.input)).length;
  }
}

let dir: string;
let store: SessionStore;
let docker: FakeDocker;
let clock: number;
let ticks: (() => void)[];

function mkSession(): string {
  return store.create({
    name: "t",
    prompt: "p",
    repoPath: "/repos/demo",
    baseBranch: "main",
    branch: "shepherd/t",
    worktreePath: "/repos/demo-wt",
    isolated: true,
    herdrSession: "default",
    herdrAgentId: `a${Math.random()}`,
  }).id;
}

function svc(overrides: Partial<ConstructorParameters<typeof PostgresService>[0]> = {}) {
  return new PostgresService({
    store,
    stateDir: join(dir, "pg"),
    names: { container: "shepherd-postgres-18", volume: "shepherd-postgres-18" },
    docker: docker.run,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    setInterval: (fn) => {
      ticks.push(fn);
      return ticks.length;
    },
    clearInterval: () => {
      ticks = [];
    },
    log: () => {},
    ...overrides,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pg-svc-"));
  store = new SessionStore(":memory:");
  store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: true }));
  docker = new FakeDocker();
  clock = 1_000_000;
  ticks = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ensureRunning", () => {
  it("creates the container with loopback port, labels, restart no, shm and env-file", async () => {
    await svc().ensureRunning();
    const run = docker.calls.find((c) => c.args[0] === "run")!.args;
    expect(run).toContain("127.0.0.1:54318:5432");
    expect(run).toEqual(expect.arrayContaining(["--restart", "no", "--shm-size", "256m"]));
    expect(run).toEqual(
      expect.arrayContaining([
        "run.shepherd.managed=true",
        "run.shepherd.kind=postgres",
        "shepherd-postgres-18:/var/lib/postgresql",
      ]),
    );
    expect(run.at(-1)).toBe("postgres:18");
    const envFile = run[run.indexOf("--env-file") + 1]!;
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "pg")).mode & 0o777).toBe(0o700);
    expect(run.join(" ")).not.toMatch(/PASSWORD/);
    expect(docker.count("pull")).toBe(0);
    expect(ticks.length).toBe(1);
  });

  it("revokes PUBLIC access to postgres/template1 once ready", async () => {
    await svc().ensureRunning();
    expect(docker.sqlCalls(/REVOKE CONNECT, TEMPORARY ON DATABASE template1 FROM PUBLIC/)).toBe(1);
  });

  it("drives only its own container", async () => {
    docker.name = "pg-b";
    await svc({ names: { container: "pg-b", volume: "vol-b" } }).ensureRunning();
    const run = docker.calls.find((c) => c.args[0] === "run")!.args;
    expect(run).toEqual(expect.arrayContaining(["--name", "pg-b", "vol-b:/var/lib/postgresql"]));
    expect(docker.calls.find((c) => c.args[0] === "ps")!.args).toContain("name=^pg-b$");
  });

  it("pulls only when the image is missing", async () => {
    docker.imagePresent = false;
    await svc().ensureRunning();
    expect(docker.count("pull")).toBe(1);
  });

  it("starts a stopped container instead of recreating it", async () => {
    Object.assign(docker, { exists: true, running: false, image: "postgres:18", port: "54318" });
    await svc().ensureRunning();
    expect(docker.count("start")).toBe(1);
    expect(docker.count("run")).toBe(0);
  });

  it("recreates on settings drift, keeping the volume", async () => {
    Object.assign(docker, { exists: true, running: true, image: "postgres:18", port: "5999" });
    await svc().ensureRunning();
    expect(docker.calls.find((c) => c.args[0] === "rm")!.args).toEqual([
      "rm",
      "-f",
      "shepherd-postgres-18",
    ]);
    expect(docker.count("run")).toBe(1);
  });

  it("is disabled-aware and reports docker/start failures", async () => {
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    await expect(svc().ensureRunning()).rejects.toMatchObject({ code: "disabled" });
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: true }));
    docker.dockerDown = true;
    await expect(svc().ensureRunning()).rejects.toMatchObject({ code: "docker" });
    docker.dockerDown = false;
    docker.failRun = true;
    await expect(svc().ensureRunning()).rejects.toMatchObject({ code: "start-failed" });
  });

  it("gives up when the server never becomes ready", async () => {
    docker.ready = false;
    await expect(svc({ readyTimeoutMs: 2000 }).ensureRunning()).rejects.toBeInstanceOf(
      PostgresError,
    );
  });
});

describe("request", () => {
  it("builds the DSN on the host the session reaches (slirp gateway for autonomous)", async () => {
    const id = mkSession();
    const out = await svc().request(id, undefined, "10.0.2.2");
    if (out.status !== "ready") throw new Error("not ready");
    expect(out.connection.host).toBe("10.0.2.2");
    expect(out.connection.dsn).toContain(`@10.0.2.2:54318/${sessionDb(id)}`);
  });

  it("clones once and returns the same DSN on repeat", async () => {
    const s = svc();
    const id = mkSession();
    const [a, b] = await Promise.all([s.request(id), s.request(id)]);
    expect(a.status).toBe("ready");
    expect(b).toEqual(a);
    const again = await s.request(id);
    expect(again).toEqual(a);
    expect(docker.count("run")).toBe(1);
    expect(docker.sqlCalls(/CREATE DATABASE s_\w+ TEMPLATE/)).toBe(1);
    if (a.status !== "ready") throw new Error("not ready");
    expect(a.connection.host).toBe("127.0.0.1");
    expect(a.connection.database).toBe(sessionDb(id));
    expect(a.connection.dsn).toContain(`@127.0.0.1:54318/${sessionDb(id)}`);
    expect(store.getPostgresLease(id)).toMatchObject({ db: sessionDb(id), state: "active" });
    // the password only ever travels on stdin
    expect(docker.calls.some((c) => c.args.join(" ").includes(a.connection.password))).toBe(false);
  });

  it("answers starting past the budget and finishes in the background", async () => {
    const id = mkSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: DockerRun = async (args, opts) => {
      if (args[0] === "pull") await gate;
      return docker.run(args, opts);
    };
    docker.imagePresent = false;
    const s = svc({ docker: slow, requestBudgetMs: 10 });
    expect(await s.request(id)).toEqual({ status: "starting" });
    release();
    await new Promise((r) => setTimeout(r, 0));
    const done = await s.request(id);
    expect(done.status).toBe("ready");
    expect(docker.count("pull")).toBe(1);
  });

  it("refuses unknown/archived sessions and a disabled server", async () => {
    await expect(svc().request(S1)).rejects.toMatchObject({ code: "no-session" });
    const id = mkSession();
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    await expect(svc().request(id)).rejects.toMatchObject({ code: "disabled" });
    expect(docker.calls.length).toBe(0);
  });
});

describe("app roles", () => {
  const ADOPT = /WITH ADMIN OPTION, INHERIT FALSE/;
  const inputs = () => docker.calls.map((c) => c.input ?? "");

  it("provision adopts siblings' roles before applying the session role", async () => {
    const s = svc();
    const a = mkSession();
    const b = mkSession();
    await s.request(a);
    const from = docker.calls.length;
    await s.request(b);
    const after = inputs().slice(from);
    const adopt = after.findIndex((i) => ADOPT.test(i));
    const role = after.findIndex((i) => i.includes(`ALTER ROLE ${sessionDb(b)} WITH LOGIN`));
    expect(adopt).toBeGreaterThanOrEqual(0);
    expect(adopt).toBeLessThan(role);
    expect(after[adopt]).toContain(`m.rolname = '${sessionDb(a)}'`);
  });

  it("release adopts the session's roles before dropping it", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    const from = docker.calls.length;
    await s.releaseSession(id);
    const after = inputs().slice(from);
    const adopt = after.findIndex((i) => ADOPT.test(i) && i.includes(`'${sessionDb(id)}'`));
    expect(adopt).toBeGreaterThanOrEqual(0);
    expect(adopt).toBeLessThan(after.findIndex((i) => i.includes("DROP ROLE IF EXISTS")));
  });

  it("release sweeps the session's databases, then adopts LOGIN roles too, then drops (#4270)", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    expect(
      inputs()
        .filter((i) => ADOPT.test(i))
        .every((i) => i.includes("NOT r.rolcanlogin")),
    ).toBe(true);
    const from = docker.calls.length;
    await s.releaseSession(id);
    const after = inputs().slice(from);
    const sweep = after.findIndex((i) => i === dropOwnedDbsSql(sessionDb(id)));
    const adopt = after.findIndex((i) => ADOPT.test(i));
    const drop = after.findIndex((i) => i.includes(`DROP ROLE IF EXISTS ${sessionDb(id)}`));
    expect(sweep).toBeGreaterThanOrEqual(0);
    expect(sweep).toBeLessThan(adopt);
    expect(adopt).toBeLessThan(drop);
    expect(after[adopt]).not.toContain("rolcanlogin");
  });

  it("idle tick reclaims and untemplates before adopting (#4270)", async () => {
    const s = svc();
    await s.request(mkSession());
    const from = docker.calls.length;
    await s.idleTick();
    const after = inputs().slice(from);
    const reclaim = after.findIndex((i) => i === RECLAIM_SQL + UNTEMPLATE_SQL + REVOKE_PUBLIC_SQL);
    expect(reclaim).toBeGreaterThanOrEqual(0);
    expect(reclaim).toBeLessThan(after.findIndex((i) => ADOPT.test(i)));
  });

  it("idle tick adopts while sessions hold leases", async () => {
    const s = svc();
    await s.request(mkSession());
    const before = docker.sqlCalls(ADOPT);
    await s.idleTick();
    expect(docker.sqlCalls(ADOPT)).toBe(before + 1);
  });

  it("a failed adoption never fails the request or the drop", async () => {
    const s = svc();
    const a = mkSession();
    await s.request(a);
    docker.failAdopt = true;
    expect((await s.request(mkSession())).status).toBe("ready");
    await s.releaseSession(a);
    expect(docker.dbs.has(sessionDb(a))).toBe(false);
  });
});

describe("finish (#4270)", () => {
  it("a role script that failed leaves the lease unverified: the retry still treats an existing role as squatted", async () => {
    const s = svc();
    const id = mkSession();
    docker.failRoleOnce = true;
    await expect(s.request(id)).rejects.toThrow();
    expect(store.getPostgresLease(id)?.roleVerified).toBe(0);
    await s.request(id);
    const roles = docker.calls
      .map((c) => c.input ?? "")
      .filter((i) => i.includes("AS shepherd_squatted"));
    expect(roles).toHaveLength(2);
    expect(roles.every((i) => i.includes("IS NOT NULL AS shepherd_squatted"))).toBe(true);
    expect(store.getPostgresLease(id)?.roleVerified).toBe(1);
  });

  it("every admin psql pins search_path/role; only a fresh lease treats an existing role as squatted", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    await s.reset(id);
    const psql = docker.calls.filter((c) => c.input !== undefined);
    expect(psql.every((c) => c.args.includes(`PGOPTIONS=${ADMIN_PGOPTIONS}`))).toBe(true);
    const roles = psql.map((c) => c.input!).filter((i) => i.includes("AS shepherd_squatted"));
    expect(roles).toHaveLength(2);
    expect(roles[0]).toContain("IS NOT NULL AS shepherd_squatted");
    expect(roles[1]).not.toContain("IS NOT NULL AS shepherd_squatted");
  });

  it("runs finishScript after the clone, on request and on reset", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    await s.reset(id);
    const inputs = docker.calls.map((c) => c.input ?? "");
    const clones = inputs.flatMap((i, n) =>
      /^CREATE DATABASE s_\w+ TEMPLATE/m.test(i) ? [n] : [],
    );
    const finishes = inputs.flatMap((i, n) => (i === finishScript(id) ? [n] : []));
    expect(clones).toHaveLength(2);
    expect(finishes).toHaveLength(2);
    expect(finishes[0]!).toBeGreaterThan(clones[0]!);
    expect(finishes[1]!).toBeGreaterThan(clones[1]!);
  });
});

describe("reset", () => {
  /** resetScript alone — roleScript also force-drops, but only squat or foreign-owned databases. */
  const RESET =
    /^SELECT format\('ALTER DATABASE %I OWNER TO postgres'.* WHERE d\.datname = 's_\w+'\\gexec\n$/;
  it("re-clones the session's DB from the template with the same DSN", async () => {
    const s = svc();
    const id = mkSession();
    const first = await s.request(id);
    const again = await s.reset(id);
    expect(again).toEqual(first);
    expect(
      docker.sqlCalls(
        new RegExp(`^SELECT format.* WHERE d\\.datname = '${sessionDb(id)}'\\\\gexec\n$`),
      ),
    ).toBe(1);
    expect(docker.sqlCalls(/CREATE DATABASE s_\w+ TEMPLATE/)).toBe(2);
    expect(docker.dbs.has(sessionDb(id))).toBe(true);
  });

  it("provisions a session that had no database yet without a drop", async () => {
    const id = mkSession();
    const out = await svc().reset(id);
    expect(out.status).toBe("ready");
    expect(docker.sqlCalls(RESET)).toBe(0);
    expect(store.getPostgresLease(id)?.state).toBe("active");
  });

  it("runs after an in-flight request and a follow-up request joins it", async () => {
    const id = mkSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: DockerRun = async (args, opts) => {
      if (args[0] === "pull") await gate;
      return docker.run(args, opts);
    };
    docker.imagePresent = false;
    const s = svc({ docker: slow, requestBudgetMs: 10 });
    expect(await s.request(id)).toEqual({ status: "starting" });
    expect(await s.reset(id)).toEqual({ status: "starting" });
    release();
    const done = await s.request(id);
    expect(done.status).toBe("ready");
    expect(docker.sqlCalls(RESET)).toBe(1);
    expect(docker.sqlCalls(/CREATE DATABASE s_\w+ TEMPLATE/)).toBe(2);
  });

  it("refuses unknown sessions and a disabled server", async () => {
    await expect(svc().reset(S1)).rejects.toMatchObject({ code: "no-session" });
    const id = mkSession();
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    await expect(svc().reset(id)).rejects.toMatchObject({ code: "disabled" });
  });
});

describe("promote", () => {
  it("swaps the clone in as the template and restores the clone afterwards", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    expect(await s.promote(id)).toEqual({ template: repoBaseDb("/repos/demo") });
    const inputs = docker.calls.map((c) => c.input ?? "");
    const promoteAt = inputs.findIndex((i) => i.includes(`TEMPLATE ${sessionDb(id)} STRATEGY`));
    const restoreAt = inputs.findIndex((i) => i.includes("ALLOW_CONNECTIONS true"));
    expect(promoteAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeGreaterThan(promoteAt);
  });

  it("still restores the clone when the swap fails", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    docker.failPromote = true;
    await expect(s.promote(id)).rejects.toThrow("being accessed");
    expect(docker.sqlCalls(/ALLOW_CONNECTIONS true/)).toBe(1);
  });

  it("starts a stopped server first", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    docker.running = false;
    await s.promote(id);
    expect(docker.count("start")).toBe(1);
  });

  it("refuses without a database, for archived sessions and while disabled", async () => {
    const s = svc();
    const id = mkSession();
    await expect(s.promote(id)).rejects.toMatchObject({ code: "no-database" });
    await expect(s.promote(S2)).rejects.toMatchObject({ code: "no-session" });
    await s.request(id);
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    await expect(s.promote(id)).rejects.toMatchObject({ code: "disabled" });
    expect(docker.sqlCalls(/RENAME TO/)).toBe(0);
  });
});

describe("sessionStatus", () => {
  it("reports server and database state without starting anything", async () => {
    const s = svc();
    const id = mkSession();
    expect(await s.sessionStatus(id)).toEqual({ server: "stopped", database: "none" });
    expect(docker.count("run") + docker.count("start")).toBe(0);
    await s.request(id);
    expect(await s.sessionStatus(id)).toEqual({ server: "running", database: "provisioned" });
    docker.dockerDown = true;
    expect((await s.sessionStatus(id)).server).toBe("docker-unreachable");
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    expect(await s.sessionStatus(id)).toEqual({ server: "off", database: "provisioned" });
  });
});

it("reports a session's database appearing and going away", async () => {
  const seen: [string, boolean][] = [];
  const s = svc({ onLease: (id, active) => seen.push([id, active]) });
  const id = mkSession();
  await s.request(id);
  await s.request(id);
  await s.reset(id);
  await s.releaseSession(id);
  expect(seen).toEqual([
    [id, true],
    [id, false],
  ]);
});

describe("connection (#4238)", () => {
  it("equals request()'s connection for the same host, without provisioning anything", async () => {
    const id = mkSession();
    const s = svc();
    const before = await s.connection(id, "10.0.2.2");
    expect(docker.calls.length).toBe(0);
    expect(store.getPostgresLease(id)).toBeNull();
    const out = await s.request(id, undefined, "10.0.2.2");
    if (out.status !== "ready") throw new Error("not ready");
    expect(before).toEqual(out.connection);
    expect(await s.connection(id)).toEqual({
      ...out.connection,
      host: "127.0.0.1",
      dsn: out.connection.dsn.replace("@10.0.2.2:", "@127.0.0.1:"),
    });
  });

  it("answers a joined in-flight request for the joining caller's host", async () => {
    const id = mkSession();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: DockerRun = async (args, opts) => {
      if (args[0] === "pull") await gate;
      return docker.run(args, opts);
    };
    docker.imagePresent = false;
    const s = svc({ docker: slow });
    const kick = s.request(id); // loopback, like the spawn kick
    const joined = s.request(id, undefined, "10.0.2.2");
    release();
    const [a, b] = await Promise.all([kick, joined]);
    if (a.status !== "ready" || b.status !== "ready") throw new Error("not ready");
    expect(a.connection.host).toBe("127.0.0.1");
    expect(b.connection).toEqual(await s.connection(id, "10.0.2.2"));
    expect(docker.sqlCalls(/CREATE DATABASE s_\w+ TEMPLATE/)).toBe(1);
  });

  it("throws disabled when Postgres is off and never touches docker", async () => {
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    await expect(svc().connection(mkSession(), "127.0.0.1")).rejects.toMatchObject({
      code: "disabled",
    });
    expect(docker.calls.length).toBe(0);
  });
});

describe("release + reconcile", () => {
  it("drops the clone at once while running", async () => {
    const s = svc();
    const id = mkSession();
    await s.request(id);
    await s.releaseSession(id);
    expect(docker.dbs.has(sessionDb(id))).toBe(false);
    expect(docker.roles.has(sessionDb(id))).toBe(false);
    expect(store.getPostgresLease(id)).toBeNull();
  });

  it("marks dropping while stopped and drains on the next start", async () => {
    const s = svc();
    const a = mkSession();
    const b = mkSession();
    await s.request(a);
    docker.running = false;
    await s.releaseSession(a);
    expect(store.getPostgresLease(a)?.state).toBe("dropping");
    expect(docker.count("start")).toBe(0);
    await s.request(b);
    expect(store.getPostgresLease(a)).toBeNull();
    expect(docker.dbs.has(sessionDb(a))).toBe(false);
    expect(docker.dbs.has(sessionDb(b))).toBe(true);
  });

  it("reconcile drops unleased session objects and archived sessions' clones", async () => {
    const s = svc();
    const a = mkSession();
    await s.request(a);
    docker.dbs.add(sessionDb(S2));
    docker.roles.add(sessionDb(S2));
    store.archive(a);
    await s.reconcile();
    expect(docker.dbs.has(sessionDb(a))).toBe(false);
    expect(store.getPostgresLease(a)).toBeNull();
    expect(docker.dbs.has(sessionDb(S2))).toBe(false);
    expect(docker.roles.has(sessionDb(S2))).toBe(false);
  });

  it("reconcile and idle do nothing while Postgres is off", async () => {
    const s = svc();
    await s.request(mkSession());
    docker.dbs.add(sessionDb(S2));
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    const before = docker.calls.length;
    await s.reconcile();
    clock += 24 * 60 * 60_000;
    await s.idleTick();
    expect(docker.calls.length).toBe(before);
    expect(docker.dbs.has(sessionDb(S2))).toBe(true);
    expect(docker.running).toBe(true);
    expect(ticks.length).toBe(0);
  });

  it("reconcile is a no-op while stopped", async () => {
    await svc().reconcile();
    expect(docker.calls.every((c) => c.args[0] === "ps")).toBe(true);
  });
});

describe("idle stop", () => {
  it("stops only after idleMinutes without client connections", async () => {
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: true, idleMinutes: 5 }));
    const s = svc();
    await s.ensureRunning();
    docker.clients = 2;
    clock += 10 * 60_000;
    await s.idleTick();
    expect(docker.count("stop")).toBe(0);
    docker.clients = 0;
    clock += 4 * 60_000;
    await s.idleTick();
    expect(docker.count("stop")).toBe(0);
    clock += 60_000;
    await s.idleTick();
    expect(docker.count("stop")).toBe(1);
    expect(docker.running).toBe(false);
    expect(ticks.length).toBe(0);
  });

  it("turning the setting off stops a running server", async () => {
    const s = svc();
    await s.ensureRunning();
    store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
    await s.applySettings();
    expect(docker.running).toBe(false);
  });
});

it("status reflects docker, image, container and readiness", async () => {
  const s = svc();
  expect(await s.status()).toMatchObject({ enabled: true, docker: true, container: "missing" });
  await s.ensureRunning();
  expect(await s.status()).toMatchObject({ container: "running", ready: true, drift: false });
  docker.dockerDown = true;
  expect(await s.status()).toEqual({ enabled: true, docker: false });
  store.setSetting(POSTGRES_SETTING, JSON.stringify({ enabled: false }));
  expect(await s.status()).toEqual({ enabled: false });
});
