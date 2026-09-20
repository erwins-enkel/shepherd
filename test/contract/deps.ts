import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/store";
import { SessionService } from "../../src/service";
import { EventHub } from "../../src/events";
import type { AppDeps } from "../../src/server";
import { config } from "../../src/config";

/** A seedable snapshot dep: the harness hands the route a live read of `rows`, and a test mutates
 *  `rows` in place for the duration of one request. Same contract as `stubs.herdr` — mutate, make
 *  the request, restore what you changed. */
export interface SnapshotStub<T> {
  rows: Record<string, T>;
}

/** The two list-shaped deps. `ids` is read on every call, so assigning it is enough. */
export interface IdsStub {
  ids: string[];
}

export interface ContractDeps {
  deps: AppDeps;
  tmpRoot: string;
  validRepo: string;
  /** The stub objects the real service/routes call, exposed so a test can swap one method for
   *  the duration of a single request and drive an outcome (held task, missing base ref, spawn
   *  failure) through the production handler. Restore what you replace. */
  stubs: {
    herdr: StubMethods;
    worktree: StubMethods;
    usageLimits: AppDeps["usageLimits"];
    /** Milestone-3 snapshot deps. Absent from AppDeps by default, so the routes that read them
     *  answer `{}` / `[]`; wired here so a stream's contract test can prove the payload it
     *  declared, not merely the status code. */
    prCache: SnapshotStub<unknown>;
    activity: SnapshotStub<unknown>;
    claudeAlive: SnapshotStub<boolean>;
    workingBlocked: SnapshotStub<boolean>;
    blocks: SnapshotStub<unknown>;
    holds: SnapshotStub<unknown>;
    reviewCache: SnapshotStub<unknown> & { inflight: unknown[] };
    planGateCache: SnapshotStub<unknown> & { inflight: unknown[] };
    recapCache: SnapshotStub<unknown>;
    stranded: IdsStub;
    autoMerge: { rows: unknown[] };
    /** S11's. `forge` is read on every call, so assigning it swaps what GET /api/issues and
     *  GET /api/issues/{n} see. null (the default) is "this repo has no forge", which is a real
     *  200 answer, not an error. */
    resolveForge: { forge: unknown | null };
    /** S11's. Absent ⇒ POST /api/shape answers 503 `{"error":"unavailable"}`. */
    shapeTask: { impl: ((...args: never[]) => Promise<unknown>) | null };
  };
  /** Overrides MAX_UPLOAD_BYTES for POST /api/uploads so the 413 path is testable without
   *  allocating a 250 MB fixture. Assigned on `deps` directly, not through a closure, because
   *  the route reads the number itself. */
  setMaxUploadBytes(bytes: number | undefined): void;
  cleanup(): void;
}

/** A stub object whose methods a test may swap out; the real interfaces are re-asserted with
 *  `as any` where the service consumes them. */
type StubMethod = (...args: never[]) => unknown;
/** Optional-valued on purpose: with `noUncheckedIndexedAccess` a read off an index signature is
 *  `StubMethod | undefined`, and a test has to be able to put exactly that value back. */
type StubMethods = Record<string, StubMethod | undefined>;

/** Stubbed AppDeps mirroring test/server-auth.test.ts: in-memory store, real service and
 *  EventHub, fake herdr/worktree so nothing is spawned. Also points config.repoRoot and
 *  config.rootCeiling at a temp dir holding one real, commitless repo. */
export function makeContractDeps(): ContractDeps {
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-contract-")));
  const validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
  // A real repository, not an empty directory: GET /api/branches and
  // POST /api/repos/init-empty-commit shell out to git against this path, and an empty dir makes
  // both of them fail for a reason that has nothing to do with the contract. `-q` keeps the
  // suite's output clean; the initial branch is pinned so `listBranches` is deterministic across
  // machines with different `init.defaultBranch` settings.
  execFileSync("git", ["init", "-q", "-b", "main", validRepo]);
  execFileSync("git", ["-C", validRepo, "config", "user.email", "contract@test.local"]);
  execFileSync("git", ["-C", validRepo, "config", "user.name", "Contract Test"]);
  const savedRoot = config.repoRoot;
  const savedCeiling = config.rootCeiling;
  config.repoRoot = tmpRoot;
  config.rootCeiling = tmpRoot;

  const store = new SessionStore(":memory:");
  const events = new EventHub();
  const worktree: StubMethods = {
    create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
    ensureBaseRef: async () => {},
    branchExists: () => false,
    remove: () => {},
  };
  // Every `start` hands out a DISTINCT pane and `list` reports all of them, because matchAgents
  // adopts each agent by at most one session: with a single shared terminalId only the oldest
  // session would resolve to a live agent, and every later session's interrupt would 404.
  // Nothing is spawned — `send` is a no-op.
  const panes: Record<string, unknown>[] = [];
  let paneSeq = 0;
  const herdr: StubMethods = {
    start: async () => {
      const id = `term_${++paneSeq}`;
      const pane = {
        terminalId: id,
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: `p${paneSeq}`,
        tabId: `t${paneSeq}`,
        workspaceId: "w",
        name: "x",
      };
      panes.push(pane);
      return pane;
    },
    list: () => panes,
    paneForegroundProcs: async () => ["claude"],
    stop: async () => {},
    send: () => {},
  };
  // Methods are read off the object on every call (never destructured), so a test can swap one
  // in place to drive an outcome and put the original back.
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: worktree as any,
    herdr: herdr as any,
    events,
  });
  const usageLimits: AppDeps["usageLimits"] = {
    limits: () => ({
      session5h: null,
      week: null,
      perModelWeek: [],
      credits: null,
      stale: true,
      calibratedAt: null,
      subscriptionOnly: false,
    }),
    projections: () => [],
  };
  // Each stub is read through a closure on every call, never destructured, so a test may mutate
  // `rows` in place between requests. `as any` at the boundary for the same reason the herdr and
  // worktree stubs use it: the real interfaces are re-asserted by the routes that consume them,
  // and the fixtures are typed with the server's own types inside each stream's test file.
  const prCache = { rows: {} as Record<string, unknown> };
  const activity = { rows: {} as Record<string, unknown> };
  const claudeAlive = { rows: {} as Record<string, boolean> };
  const workingBlocked = { rows: {} as Record<string, boolean> };
  const blocks = { rows: {} as Record<string, unknown> };
  const holds = { rows: {} as Record<string, unknown> };
  const reviewCache = { rows: {} as Record<string, unknown>, inflight: [] as unknown[] };
  const planGateCache = { rows: {} as Record<string, unknown>, inflight: [] as unknown[] };
  const recapCache = { rows: {} as Record<string, unknown> };
  const stranded = { ids: [] as string[] };
  const autoMerge = { rows: [] as unknown[] };
  const resolveForge = { forge: null as unknown | null };
  const shapeTask = { impl: null as ((...args: never[]) => Promise<unknown>) | null };
  const deps: AppDeps = {
    store,
    service,
    events,
    usageLimits,
    distiller: { distillNow: async () => {} },
    // A WHOLE `PrCache` (src/pr-poller.ts:14-20), not just `snapshot()`. `resolveGitState`
    // calls `deps.prCache?.get(id)` and `.set(id, git)` on the /review-pr, /git and PR-open
    // paths (src/server.ts:4206, 4213, 4351, 4358, 4569); a present-but-partial stub makes those
    // routes throw and answer 500/502 instead of the status the stream declared, which is worse
    // than leaving the dep absent.
    prCache: {
      snapshot: () => prCache.rows,
      get: (id: string) => prCache.rows[id],
      set: (id: string, git: unknown) => {
        prCache.rows[id] = git;
      },
      drop: (id: string) => {
        delete prCache.rows[id];
      },
    } as any,
    activity: { snapshot: () => activity.rows } as any,
    claudeAlive: { snapshot: () => claudeAlive.rows },
    workingBlocked: { snapshot: () => workingBlocked.rows },
    blocks: { snapshot: () => blocks.rows } as any,
    holds: { snapshot: () => holds.rows } as any,
    stranded: { ids: () => stranded.ids },
    reviewCache: {
      snapshot: () => reviewCache.rows,
      reviewing: () => reviewCache.inflight,
    } as any,
    planGateCache: {
      snapshot: () => planGateCache.rows,
      reviewing: () => planGateCache.inflight,
    } as any,
    recapCache: { snapshot: () => recapCache.rows } as any,
    autoMerge: { snapshot: async () => autoMerge.rows } as any,
    // Read on every call so a test may swap `forge` in place. Returning null is the honest
    // default: a temp dir has no forge, and the routes have a documented 200 for that.
    resolveForge: () => resolveForge.forge as never,
    shapeTask: (async (...args: never[]) =>
      shapeTask.impl ? await shapeTask.impl(...args) : { error: "unavailable" }) as never,
  };
  return {
    deps,
    tmpRoot,
    validRepo,
    stubs: {
      herdr,
      worktree,
      usageLimits,
      prCache,
      activity,
      claudeAlive,
      workingBlocked,
      blocks,
      holds,
      reviewCache,
      planGateCache,
      recapCache,
      stranded,
      autoMerge,
      resolveForge,
      shapeTask,
    },
    setMaxUploadBytes(bytes) {
      deps.maxUploadBytes = bytes;
    },
    cleanup() {
      config.repoRoot = savedRoot;
      config.rootCeiling = savedCeiling;
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
