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
  cleanup(): void;
}

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
  const service = new SessionService({
    store,
    namer: async () => "x",
    worktree: {
      create: () => ({ worktreePath: "/wt", branch: "shepherd/x", isolated: true }),
      ensureBaseRef: async () => {},
      branchExists: () => false,
      remove: () => {},
    } as any,
    herdr: {
      start: async () => ({
        terminalId: "term_x",
        cwd: "/wt",
        agent: "claude",
        agentStatus: "working",
        paneId: "p",
        tabId: "t",
        workspaceId: "w",
      }),
      list: () => [],
      paneForegroundProcs: async () => ["claude"],
      stop: async () => {},
      send: () => {},
    } as any,
    events,
  });
  const usageLimits = {
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
    cleanup() {
      config.repoRoot = savedRoot;
      config.rootCeiling = savedCeiling;
      rmSync(tmpRoot, { recursive: true, force: true });
    },
  };
}
