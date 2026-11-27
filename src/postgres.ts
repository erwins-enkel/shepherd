// On-demand Postgres (#4232): one Shepherd-managed `postgres:18` container shared by every repo,
// started when a session asks for a database and stopped once nobody is connected. Each session
// gets its own clone of its repo's template DB plus a login role (see src/postgres-core.ts).
//
// Single Bun loop: every docker/psql call is async (src/docker-cli.ts) and bounded. All cluster
// mutations go through ONE admin queue, so clones, drops and reconciles never interleave. SQL is
// fed to `psql` on stdin — no password ever reaches argv. The superuser password is only used
// for the image's first init (`--env-file`, 0600) and Shepherd itself connects through
// `docker exec` (local-socket trust), so agents never see it.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { dockerChildEnv, resolveDockerEndpoint, runDocker } from "./docker-cli";
import { writeSecretsFile } from "./plugins/secrets";
import {
  CLIENT_CONNECTIONS_SQL,
  HARDEN_SQL,
  LIST_SESSION_OBJECTS_SQL,
  POSTGRES_DATA_DIR,
  POSTGRES_LABEL_IMAGE,
  POSTGRES_LABEL_KIND,
  POSTGRES_LABEL_MANAGED,
  POSTGRES_LABEL_PORT,
  POSTGRES_SETTING,
  adoptScript,
  baseScript,
  cloneScript,
  connectionFor,
  dropScript,
  isSessionDbName,
  promoteRestoreScript,
  promoteScript,
  repoBaseDb,
  repoRole,
  resetScript,
  roleScript,
  sessionDb,
  sessionPassword,
  shouldIdleStop,
  storedPostgresSettings,
  type PostgresConnection,
  type PostgresSettings,
  POSTGRES_HOST_LOOPBACK,
} from "./postgres-core";
import type { PostgresLease, PostgresLeaseState } from "./store";
import type { Session } from "./types";

/** Event carrying whether a session holds a database (`{ id, postgresDb }`, #4240). */
export const POSTGRES_SESSION_EVENT = "session:postgres";

export type DockerRun = (
  args: string[],
  opts: { timeoutMs: number; input?: string },
) => Promise<string>;

export interface PostgresStore {
  getSetting(key: string): string | null;
  get(id: string): Pick<Session, "repoPath" | "archivedAt"> | null | undefined;
  getPostgresLease(sessionId: string): PostgresLease | null;
  listPostgresLeases(): PostgresLease[];
  upsertPostgresLease(lease: Omit<PostgresLease, "state" | "createdAt">): void;
  setPostgresLeaseState(sessionId: string, state: PostgresLeaseState): void;
  deletePostgresLease(sessionId: string): void;
}

export interface PostgresServiceDeps {
  store: PostgresStore;
  /** Secrets dir (0700): `superuser.env` + `lease.key` — beside the instance's DB. */
  stateDir: string;
  /** This instance's container + volume (`postgresInstanceNames`). */
  names: { container: string; volume: string };
  /** Docker CLI seam; default resolves the local endpoint and runs `docker --host … <args>`. */
  docker?: DockerRun;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  log?: (msg: string) => void;
  /** One `request()`'s wait budget before it answers `starting` (MCP calls cap at 60 s). */
  requestBudgetMs?: number;
  readyTimeoutMs?: number;
  /** A session's database appeared (`true`) or went away (`false`) — drives the card menu's
   *  promote item via the `session:postgres` event (#4240). */
  onLease?: (sessionId: string, active: boolean) => void;
}

export type PostgresRequestOutcome =
  { status: "ready"; connection: PostgresConnection } | { status: "starting" };

export class PostgresError extends Error {
  constructor(
    readonly code: "disabled" | "no-session" | "no-database" | "docker" | "start-failed",
    message: string,
  ) {
    super(message);
    this.name = "PostgresError";
  }
}

export type PostgresStatus =
  | { enabled: false }
  | { enabled: true; docker: false }
  | {
      enabled: true;
      docker: true;
      image: boolean;
      container: "missing" | "stopped" | "running";
      ready: boolean;
      drift: boolean;
    };

/** One session's view for `postgres_status` (#4240): no credentials, never starts anything. */
export interface PostgresSessionStatus {
  server: "off" | "docker-unreachable" | "stopped" | "starting" | "running";
  database: "none" | "provisioned" | "dropping";
}

interface ContainerState {
  running: boolean;
  image: string;
  port: string;
}

const PROBE_MS = 10_000;
const RUN_MS = 60_000;
const PULL_MS = 15 * 60_000;
const ADMIN_MS = 120_000;
const STOP_MS = 60_000;
const IDLE_TICK_MS = 60_000;
const READY_POLL_MS = 500;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_BUDGET_MS = 45_000;
const HOST = POSTGRES_HOST_LOOPBACK;

function defaultDocker(): DockerRun {
  const env = dockerChildEnv(process.env);
  const raw = (args: string[], timeoutMs: number, input?: string) =>
    runDocker(args, { timeoutMs, env, input });
  let endpoint: Promise<string | null> | null = null;
  return async (args, opts) => {
    endpoint ??= resolveDockerEndpoint((a, t) => raw(a, t), process.env, PROBE_MS).catch((e) => {
      endpoint = null;
      throw e;
    });
    const host = await endpoint;
    if (!host) throw new Error("no local docker endpoint");
    return raw(["--host", host, ...args], opts.timeoutMs, opts.input);
  };
}

export class PostgresService {
  private readonly store: PostgresStore;
  private readonly stateDir: string;
  private readonly container: string;
  private readonly volume: string;
  private readonly docker: DockerRun;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (msg: string) => void;
  private readonly requestBudgetMs: number;
  private readonly readyTimeoutMs: number;
  private readonly onLease: (sessionId: string, active: boolean) => void;
  private secrets: Promise<{ envFile: string; leaseKey: string }> | null = null;
  private ensuring: Promise<void> | null = null;
  private readonly requests = new Map<string, Promise<PostgresConnection>>();
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: unknown = null;
  private lastBusyAt = 0;

  constructor(deps: PostgresServiceDeps) {
    this.store = deps.store;
    this.stateDir = deps.stateDir;
    this.container = deps.names.container;
    this.volume = deps.names.volume;
    this.docker = deps.docker ?? defaultDocker();
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.setTimer =
      deps.setInterval ??
      ((fn, ms) => {
        const t = setInterval(fn, ms);
        t.unref?.();
        return t;
      });
    this.clearTimer =
      deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
    this.log = deps.log ?? ((m) => console.log(`[postgres] ${m}`));
    this.requestBudgetMs = deps.requestBudgetMs ?? DEFAULT_REQUEST_BUDGET_MS;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.onLease = deps.onLease ?? (() => {});
  }

  settings(): PostgresSettings {
    return storedPostgresSettings(this.store.getSetting(POSTGRES_SETTING));
  }

  // ── secrets ────────────────────────────────────────────────────────────────

  private loadSecrets(): Promise<{ envFile: string; leaseKey: string }> {
    this.secrets ??= this.readOrCreateSecrets().catch((e) => {
      this.secrets = null;
      throw e;
    });
    return this.secrets;
  }

  private async readOrCreateSecrets(): Promise<{ envFile: string; leaseKey: string }> {
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await chmod(this.stateDir, 0o700);
    const envFile = join(this.stateDir, "superuser.env");
    await this.readOrWrite(envFile, () => `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}\n`);
    const leaseKey = (
      await this.readOrWrite(join(this.stateDir, "lease.key"), () =>
        randomBytes(32).toString("hex"),
      )
    ).trim();
    return { envFile, leaseKey };
  }

  private async readOrWrite(path: string, make: () => string): Promise<string> {
    try {
      const existing = await readFile(path, "utf8");
      if (existing.trim()) return existing;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const value = make();
    await writeSecretsFile(path, value);
    return value;
  }

  // ── container ──────────────────────────────────────────────────────────────

  /** null = no such container; rejects when docker itself is unreachable. */
  private async inspect(): Promise<ContainerState | null> {
    const out = await this.docker(
      [
        "ps",
        "-a",
        "--filter",
        `name=^${this.container}$`,
        "--format",
        `{{.State}}\t{{.Label "${POSTGRES_LABEL_IMAGE}"}}\t{{.Label "${POSTGRES_LABEL_PORT}"}}`,
      ],
      { timeoutMs: PROBE_MS },
    );
    const line = out.trim().split("\n")[0];
    if (!line) return null;
    const [state, image = "", port = ""] = line.split("\t");
    return { running: state === "running", image, port };
  }

  private drifted(c: ContainerState, s: PostgresSettings): boolean {
    return c.image !== s.image || c.port !== String(s.port);
  }

  private async imagePresent(image: string): Promise<boolean> {
    return this.docker(["image", "inspect", "--format", "{{.Id}}", image], {
      timeoutMs: PROBE_MS,
    }).then(
      () => true,
      () => false,
    );
  }

  private async create(s: PostgresSettings): Promise<void> {
    if (!(await this.imagePresent(s.image))) {
      this.log(`pulling ${s.image}`);
      await this.docker(["pull", "--quiet", s.image], { timeoutMs: PULL_MS });
    }
    const { envFile } = await this.loadSecrets();
    await this.docker(
      [
        "run",
        "-d",
        "--name",
        this.container,
        "--label",
        `${POSTGRES_LABEL_MANAGED}=true`,
        "--label",
        `${POSTGRES_LABEL_KIND}=postgres`,
        "--label",
        `${POSTGRES_LABEL_IMAGE}=${s.image}`,
        "--label",
        `${POSTGRES_LABEL_PORT}=${s.port}`,
        "--restart",
        "no",
        "--shm-size",
        "256m",
        "-p",
        `${HOST}:${s.port}:5432`,
        "-v",
        `${this.volume}:${POSTGRES_DATA_DIR}`,
        "--env-file",
        envFile,
        s.image,
      ],
      { timeoutMs: RUN_MS },
    );
  }

  private async ready(): Promise<boolean> {
    return this.docker(["exec", this.container, "pg_isready", "-h", HOST, "-p", "5432", "-q"], {
      timeoutMs: PROBE_MS,
    }).then(
      () => true,
      () => false,
    );
  }

  private async waitReady(): Promise<void> {
    const deadline = this.now() + this.readyTimeoutMs;
    while (!(await this.ready())) {
      if (this.now() >= deadline)
        throw new PostgresError("start-failed", "Postgres did not become ready in time");
      await this.sleep(READY_POLL_MS);
    }
  }

  /** Make sure the container exists with the current settings, runs and accepts TCP. One at a
   *  time; concurrent callers share the attempt, a failed attempt is retried by the next call. */
  ensureRunning(): Promise<void> {
    this.ensuring ??= this.doEnsure().finally(() => {
      this.ensuring = null;
    });
    return this.ensuring;
  }

  private async doEnsure(): Promise<void> {
    const s = this.settings();
    if (!s.enabled) throw new PostgresError("disabled", "Postgres is turned off in Settings");
    let c = await this.inspect().catch((e: unknown) => {
      throw new PostgresError("docker", `Docker unreachable: ${(e as Error).message}`);
    });
    if (c && this.drifted(c, s)) {
      this.log("settings changed; recreating the container (data volume kept)");
      await this.docker(["rm", "-f", this.container], { timeoutMs: STOP_MS });
      c = null;
    }
    try {
      if (!c) await this.create(s);
      else if (!c.running) await this.docker(["start", this.container], { timeoutMs: RUN_MS });
    } catch (e) {
      throw new PostgresError("start-failed", `Could not start Postgres: ${(e as Error).message}`);
    }
    await this.waitReady();
    await this.admin(() => this.psql(HARDEN_SQL));
    this.lastBusyAt = this.now();
    this.armIdle();
    await this.drainDropping();
  }

  private async isRunning(): Promise<boolean> {
    // Docker unreachable reads as "not running": callers then defer (drop later, skip
    // reconcile/stop) instead of failing.
    const c = await this.inspect().catch(() => null); // best-effort: see above
    return c?.running ?? false;
  }

  // ── admin SQL ──────────────────────────────────────────────────────────────

  private psql(sql: string): Promise<string> {
    return this.docker(
      [
        "exec",
        "-i",
        this.container,
        "psql",
        "-X",
        "-q",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-f",
        "-",
      ],
      { timeoutMs: ADMIN_MS, input: sql },
    );
  }

  /** Serialize every cluster mutation: one admin op at a time. */
  private admin<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(
      () => fn(),
      () => fn(),
    );
    // best-effort: the caller handles `run`'s rejection; the chain only orders the next op.
    this.queue = run.catch(() => {});
    return run;
  }

  // ── requests ───────────────────────────────────────────────────────────────

  /** Ensure the server, the repo template and this session's clone; answer within the budget.
   *  Idempotent: a repeat call returns the same DSN. Past the budget it answers `starting` while
   *  the work continues, so the agent's next call picks up the result. `host` is where the session
   *  reaches the server: the host loopback, or the slirp gateway from an Autonomous netns (#4239). */
  async request(
    sessionId: string,
    signal?: AbortSignal,
    host: string = HOST,
  ): Promise<PostgresRequestOutcome> {
    const repoPath = this.liveRepo(sessionId);
    let work = this.requests.get(sessionId);
    if (!work) work = this.track(sessionId, this.provision(sessionId, repoPath, host));
    return this.within(work, signal);
  }

  /** `postgres_reset` (#4240): drop this session's clone and re-clone it from the repo template.
   *  Same DSN (role + password stay). Runs after any in-flight request for the session and becomes
   *  its in-flight work, so a `postgres_request` after `starting` picks up the reset's result. */
  async reset(
    sessionId: string,
    signal?: AbortSignal,
    host: string = HOST,
  ): Promise<PostgresRequestOutcome> {
    const repoPath = this.liveRepo(sessionId);
    const prior = this.requests.get(sessionId)?.catch(() => null); // best-effort: reset retries it
    const work = this.track(
      sessionId,
      (prior ?? Promise.resolve()).then(() => this.provision(sessionId, repoPath, host, true)),
    );
    return this.within(work, signal);
  }

  /** The live session's repo, or the request-time refusals. */
  private liveRepo(sessionId: string): string {
    const session = this.store.get(sessionId);
    if (!session || session.archivedAt)
      throw new PostgresError("no-session", "Unknown or archived session");
    if (!this.settings().enabled)
      throw new PostgresError("disabled", "Postgres is turned off in Settings");
    return session.repoPath;
  }

  /** Register `work` as the session's in-flight provisioning until it settles. */
  private track(sessionId: string, work: Promise<PostgresConnection>): Promise<PostgresConnection> {
    const tracked: Promise<PostgresConnection> = work.finally(() => {
      if (this.requests.get(sessionId) === tracked) this.requests.delete(sessionId);
    });
    tracked.catch((e: unknown) => this.log(`request ${sessionId} failed: ${(e as Error).message}`));
    this.requests.set(sessionId, tracked);
    return tracked;
  }

  /** Answer within one call's budget: the connection, or `starting` while the work continues. */
  private async within(
    work: Promise<PostgresConnection>,
    signal?: AbortSignal,
  ): Promise<PostgresRequestOutcome> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.requestBudgetMs);
      signal?.addEventListener("abort", () => resolve(null), { once: true });
    });
    try {
      const connection = await Promise.race([work, timeout]);
      return connection ? { status: "ready", connection } : { status: "starting" };
    } finally {
      clearTimeout(timer);
    }
  }

  private async provision(
    sessionId: string,
    repoPath: string,
    host: string,
    reset = false,
  ): Promise<PostgresConnection> {
    await this.ensureRunning();
    const { leaseKey } = await this.loadSecrets();
    const password = sessionPassword(leaseKey, sessionId);
    const db = sessionDb(sessionId);
    // Lease first: a reconcile between clone and lease would otherwise drop the fresh clone.
    const fresh = !this.hasLease(sessionId);
    this.store.upsertPostgresLease({ sessionId, repoPath, db, role: repoRole(repoPath) });
    if (fresh) this.onLease(sessionId, true);
    await this.admin(async () => {
      await this.psql(baseScript(repoPath));
      await this.adoptNow(this.activeLeases());
      let exists = (await this.psql(roleScript(sessionId, password, repoPath)))
        .trim()
        .split("\n")
        .pop();
      if (reset && exists !== "0") {
        await this.psql(resetScript(sessionId));
        exists = "0";
      }
      if (exists === "0") await this.psql(cloneScript(repoPath, sessionId));
    });
    this.lastBusyAt = this.now();
    return connectionFor(host, this.settings().port, sessionId, password);
  }

  /** The session's lease, if any (resume/relaunch use it to re-start the server). */
  hasLease(sessionId: string): boolean {
    return this.store.getPostgresLease(sessionId)?.state === "active";
  }

  // ── app roles ──────────────────────────────────────────────────────────────

  private activeLeases(): PostgresLease[] {
    return this.store.listPostgresLeases().filter((l) => l.state === "active");
  }

  /** Hand roles the sessions created to their repo roles (`adoptScript`). Callers already hold the
   *  admin queue. Never fails its caller: a missed adoption is retried by the next tick. */
  private async adoptNow(leases: readonly PostgresLease[]): Promise<void> {
    try {
      const sql = adoptScript(leases.filter((l) => isSessionDbName(l.db)));
      if (sql) await this.psql(sql);
    } catch (e) {
      this.log(`adopting app roles failed: ${(e as Error).message}`);
    }
  }

  // ── template promote (#4240) ───────────────────────────────────────────────

  /** Operator action: this session's clone becomes its repo's template (`promoteScript`). Starts
   *  the server when needed; the clone's connections are refused for the duration. The clone's
   *  owner and connectability are restored whether or not the swap succeeded. */
  async promote(sessionId: string): Promise<{ template: string }> {
    const session = this.store.get(sessionId);
    if (!session || session.archivedAt)
      throw new PostgresError("no-session", "Unknown or archived session");
    if (!this.settings().enabled)
      throw new PostgresError("disabled", "Postgres is turned off in Settings");
    if (!this.hasLease(sessionId))
      throw new PostgresError("no-database", "This session has no database");
    await this.requests.get(sessionId)?.catch(() => null); // best-effort: a failed clone fails below
    await this.ensureRunning();
    const { repoPath } = session;
    await this.admin(async () => {
      try {
        await this.psql(baseScript(repoPath));
        await this.psql(promoteScript(repoPath, sessionId));
      } catch (e) {
        this.log(`promote ${sessionId} failed: ${(e as Error).message}`);
        throw e;
      } finally {
        await this.psql(promoteRestoreScript(repoPath, sessionId)).catch((e: unknown) =>
          this.log(`promote restore ${sessionId} failed: ${(e as Error).message}`),
        );
      }
    });
    this.lastBusyAt = this.now();
    const template = repoBaseDb(repoPath);
    this.log(`promoted ${sessionDb(sessionId)} to ${template}`);
    return { template };
  }

  /** `postgres_status` (#4240): the server's state and whether this session has a database. */
  async sessionStatus(sessionId: string): Promise<PostgresSessionStatus> {
    const lease = this.store.getPostgresLease(sessionId);
    const database = !lease ? "none" : lease.state === "active" ? "provisioned" : "dropping";
    const s = await this.status();
    if (!s.enabled) return { server: "off", database };
    if (!s.docker) return { server: "docker-unreachable", database };
    if (s.container !== "running") return { server: "stopped", database };
    return { server: s.ready ? "running" : "starting", database };
  }

  // ── release / reconcile ────────────────────────────────────────────────────

  private async drop(lease: PostgresLease): Promise<void> {
    if (!isSessionDbName(lease.db)) {
      this.store.deletePostgresLease(lease.sessionId);
      return;
    }
    await this.admin(async () => {
      // Adopt first: roles this session created would otherwise lose their only admin holder.
      await this.adoptNow([lease]);
      await this.psql(dropScript(lease.db));
    });
    this.store.deletePostgresLease(lease.sessionId);
  }

  /** Archive hook: drop the clone now when the server runs, else leave it marked `dropping` for
   *  the next start or reconcile. Never starts the container just to drop. */
  async releaseSession(sessionId: string): Promise<void> {
    const lease = this.store.getPostgresLease(sessionId);
    if (!lease) return;
    this.store.setPostgresLeaseState(sessionId, "dropping");
    if (lease.state === "active") this.onLease(sessionId, false);
    if (!(await this.isRunning())) return;
    await this.drop({ ...lease, state: "dropping" }).catch((e: unknown) =>
      this.log(`drop ${lease.db} failed: ${(e as Error).message}`),
    );
  }

  private async drainDropping(): Promise<void> {
    for (const lease of this.store.listPostgresLeases()) {
      const session = this.store.get(lease.sessionId);
      if (lease.state !== "dropping" && session && !session.archivedAt) continue;
      await this.drop(lease).catch((e: unknown) =>
        this.log(`drop ${lease.db} failed: ${(e as Error).message}`),
      );
    }
  }

  /** Boot + hourly: drain pending drops, drop clones of archived/missing sessions and session DBs
   *  or roles no lease claims. Only while the server runs; also (re-)arms the idle timer. */
  async reconcile(): Promise<void> {
    try {
      if (!this.settings().enabled || !(await this.isRunning())) return;
      if (!this.idleTimer) {
        this.lastBusyAt = this.now();
        this.armIdle();
      }
      await this.drainDropping();
      const claimed = new Set(this.store.listPostgresLeases().map((l) => l.db));
      await this.admin(async () => {
        await this.adoptNow(this.activeLeases());
        const names = (await this.psql(LIST_SESSION_OBJECTS_SQL)).split("\n").map((n) => n.trim());
        for (const name of names)
          if (isSessionDbName(name) && !claimed.has(name)) await this.psql(dropScript(name));
      });
    } catch (e) {
      this.log(`reconcile failed: ${(e as Error).message}`);
    }
  }

  // ── idle stop ──────────────────────────────────────────────────────────────

  private armIdle(): void {
    if (this.idleTimer) return;
    this.idleTimer = this.setTimer(() => void this.idleTick(), IDLE_TICK_MS);
  }

  private disarmIdle(): void {
    if (!this.idleTimer) return;
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  /** One idle check: any client connection keeps it up; none for `idleMinutes` stops it. */
  async idleTick(): Promise<void> {
    if (!this.settings().enabled) {
      this.disarmIdle(); // turned off: applySettings stops the server, nothing to watch
      return;
    }
    if (this.ensuring || this.requests.size > 0) {
      this.lastBusyAt = this.now();
      return;
    }
    let count: number;
    try {
      count = Number((await this.psql(CLIENT_CONNECTIONS_SQL)).trim());
    } catch {
      this.disarmIdle(); // container gone or stopped elsewhere; the next ensure re-arms
      return;
    }
    // Bounds how long a running session waits for a role a sibling just created.
    await this.admin(() => this.adoptNow(this.activeLeases()));
    if (count > 0) this.lastBusyAt = this.now();
    else if (shouldIdleStop(this.now(), this.lastBusyAt, this.settings().idleMinutes))
      await this.stop("idle");
  }

  async stop(reason: string): Promise<void> {
    this.disarmIdle();
    try {
      if (!(await this.isRunning())) return;
      this.log(`stopping (${reason})`);
      await this.docker(["stop", "-t", "30", this.container], { timeoutMs: STOP_MS });
    } catch (e) {
      this.log(`stop failed: ${(e as Error).message}`);
    }
  }

  /** After a Settings change: turning it off stops the server; other changes apply on the next
   *  ensure (drift → recreate). */
  async applySettings(): Promise<void> {
    if (!this.settings().enabled) await this.stop("disabled");
  }

  // ── diagnostics ────────────────────────────────────────────────────────────

  async status(): Promise<PostgresStatus> {
    const s = this.settings();
    if (!s.enabled) return { enabled: false };
    let c: ContainerState | null;
    try {
      c = await this.inspect();
    } catch {
      return { enabled: true, docker: false };
    }
    return {
      enabled: true,
      docker: true,
      image: await this.imagePresent(s.image),
      container: !c ? "missing" : c.running ? "running" : "stopped",
      ready: c?.running ? await this.ready() : false,
      drift: c ? this.drifted(c, s) : false,
    };
  }
}
