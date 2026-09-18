import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../src/store";
import { SessionService } from "../../src/service";
import { EventHub } from "../../src/events";
import type { AppDeps } from "../../src/server";
import { config } from "../../src/config";

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
  };
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
 *  config.rootCeiling at a temp dir holding one fake repo. */
export function makeContractDeps(): ContractDeps {
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "shepherd-contract-")));
  const validRepo = join(tmpRoot, "repo");
  mkdirSync(validRepo);
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
  const deps: AppDeps = {
    store,
    service,
    events,
    usageLimits,
    distiller: { distillNow: async () => {} },
  };
  return {
    deps,
    tmpRoot,
    validRepo,
    stubs: { herdr, worktree, usageLimits },
    cleanup() {
      config.repoRoot = savedRoot;
      config.rootCeiling = savedCeiling;
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
