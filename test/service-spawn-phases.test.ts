import { test, expect, beforeEach } from "bun:test";
import { SessionStore } from "../src/store";
import { SessionService } from "../src/service";
import {
  SpawnCanceled,
  SpawnPhaseTracker,
  cancelSpawn,
  registerSpawn,
  resetSpawnRegistry,
  type SpawnPhase,
  type SpawnPhaseProgress,
} from "../src/spawn-progress";
import { stubBaseRef } from "./helpers/base-ref";

const SPAWN_ID = "11111111-2222-3333-4444-555555555555";

const AGENT = {
  terminalId: "term_z",
  cwd: "/wt/repo-task",
  agent: "claude",
  agentStatus: "working",
  paneId: "p",
  tabId: "t",
  workspaceId: "w",
};

const INPUT = {
  repoPath: "/repo",
  baseBranch: "main",
  prompt: "flatten it",
  model: null,
  images: [],
};

/** Service whose worktree + herdr fakes record what create() drove through them. */
function makeService(
  store: SessionStore,
  herdrStart: (opts?: { signal?: AbortSignal }) => Promise<typeof AGENT>,
) {
  const removed: string[] = [];
  const service = new SessionService({
    store,
    namer: async () => "repo-task",
    worktree: {
      ensureBaseRef: async () => stubBaseRef(),
      branchExists: () => false,
      create: () => ({
        worktreePath: "/wt/repo-task",
        branch: "shepherd/repo-task",
        isolated: true,
      }),
      remove: (path: string) => removed.push(path),
    } as never,
    herdr: {
      start: async (
        _name: string,
        _cwd: string,
        _argv: string[],
        _env?: Record<string, string>,
        opts?: { signal?: AbortSignal },
      ) => herdrStart(opts),
      list: () => [],
    } as never,
  });
  return { service, removed };
}

/** Tracker that records the phases announced to a watching dialog. */
function watchedTracker(): { tracker: SpawnPhaseTracker; seen: SpawnPhase[] } {
  const seen: SpawnPhase[] = [];
  const tracker = new SpawnPhaseTracker({
    spawnId: SPAWN_ID,
    emit: (p: SpawnPhaseProgress) => seen.push(p.phase),
    log: () => {},
    yieldToLoop: () => Promise.resolve(),
  });
  return { tracker, seen };
}

beforeEach(() => resetSpawnRegistry());

test("create announces every phase, in the order it runs them", async () => {
  const store = new SessionStore(":memory:");
  const { service } = makeService(store, async () => AGENT);
  const { tracker, seen } = watchedTracker();

  await service.create(INPUT, tracker);

  expect(seen).toEqual(["base", "worktree", "prompt", "launch", "agent"]);
});

test("create logs one phase line naming where the time went", async () => {
  const store = new SessionStore(":memory:");
  const { service } = makeService(store, async () => AGENT);
  const lines: string[] = [];
  const tracker = new SpawnPhaseTracker({ log: (line) => lines.push(line) });

  await service.create(INPUT, tracker);

  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(
    /^\[create\] spawn ok base \d+\.\ds worktree \d+\.\ds prompt \d+\.\ds launch \d+\.\ds agent \d+\.\ds total \d+\.\ds$/,
  );
});

test("the tracker's signal reaches herdr.start, so a cancel lands inside the wait", async () => {
  const store = new SessionStore(":memory:");
  let sawSignal: AbortSignal | undefined;
  const { service } = makeService(store, async (opts) => {
    sawSignal = opts?.signal;
    return AGENT;
  });
  const { tracker } = watchedTracker();

  await service.create(INPUT, tracker);

  expect(sawSignal).toBe(tracker.signal);
});

test("cancelling during the agent wait rolls the worktree back and persists no session", async () => {
  const store = new SessionStore(":memory:");
  // Stands in for herdr's auto-detect poll loop: it observes the signal and gives up when set.
  const { service, removed } = makeService(store, async (opts) => {
    expect(cancelSpawn(SPAWN_ID)).toBe("canceled");
    if (opts?.signal?.aborted) throw new SpawnCanceled();
    return AGENT;
  });
  const { tracker } = watchedTracker();
  registerSpawn(tracker);

  await expect(service.create(INPUT, tracker)).rejects.toBeInstanceOf(SpawnCanceled);

  expect(removed).toEqual(["/wt/repo-task"]);
  expect(store.list()).toHaveLength(0);
});

test("a cancel before the worktree exists leaves nothing to roll back", async () => {
  const store = new SessionStore(":memory:");
  const { service, removed } = makeService(store, async () => AGENT);
  const { tracker } = watchedTracker();
  registerSpawn(tracker);
  cancelSpawn(SPAWN_ID);

  await expect(service.create(INPUT, tracker)).rejects.toBeInstanceOf(SpawnCanceled);

  expect(removed).toEqual([]);
  expect(store.list()).toHaveLength(0);
});

test("a sealed spawn refuses a late cancel — the session is already live", async () => {
  const store = new SessionStore(":memory:");
  const { service, removed } = makeService(store, async () => AGENT);
  const { tracker } = watchedTracker();
  registerSpawn(tracker);

  const session = await service.create(INPUT, tracker);

  expect(cancelSpawn(SPAWN_ID)).toBe("too_late");
  expect(removed).toEqual([]);
  expect(store.get(session.id)).toBeTruthy();
});

test("an unobserved create still measures and still logs", async () => {
  const store = new SessionStore(":memory:");
  const { service } = makeService(store, async () => AGENT);
  const lines: string[] = [];

  await service.create(INPUT, new SpawnPhaseTracker({ log: (line) => lines.push(line) }));

  expect(lines[0]).toContain("[create] spawn ok");
});
