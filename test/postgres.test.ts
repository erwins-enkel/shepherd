import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgresService, PostgresError, type DockerRun } from "../src/postgres";
import { POSTGRES_SETTING, sessionDb } from "../src/postgres-core";
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
    if (cmd === "exec" && args[sub === "-i" ? 2 : 1] !== this.name)
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

  private sql(input: string): string {
    if (!this.running) throw new Error("not running");
    if (input.includes("pg_stat_activity")) return `${this.clients}\n`;
    if (input.includes("UNION SELECT rolname"))
      return [...new Set([...this.dbs, ...this.roles])].join("\n");
    for (const m of input.matchAll(/DROP DATABASE IF EXISTS (\w+)/g)) this.dbs.delete(m[1]!);
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
