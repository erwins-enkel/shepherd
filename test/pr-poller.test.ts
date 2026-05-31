import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { PrPoller } from "../src/pr-poller";
import type { GitForge, PrStatus } from "../src/forge/types";

const baseSession = {
  name: "x",
  prompt: "x",
  repoPath: "/r",
  baseBranch: "main",
  branch: "shepherd/x",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_a",
};

function forgeReturning(status: () => PrStatus): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    prStatus: async () => status(),
    openPr: async () => status(),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
  };
}

const NONE: PrStatus = { state: "none", checks: "none", deployConfigured: false };
const OPEN: PrStatus = { state: "open", number: 7, checks: "pending", deployConfigured: false };

test("emits session git state on first poll and only again on change", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: { id: string; git: { state: string; number?: number; kind: string } }[] = [];
  let cur = OPEN;
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  expect(emitted).toEqual([{ id: s.id, git: { ...OPEN, kind: "github" } }]);

  await poller.tick(); // unchanged → no new emit
  expect(emitted.length).toBe(1);

  cur = { state: "merged", number: 7, checks: "success", deployConfigured: false };
  await poller.tick();
  expect(emitted.length).toBe(2);
  expect(emitted[1]!.git.state).toBe("merged");
});

test("skips sessions with no branch or no forge", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: null }); // no branch
  store.create({ ...baseSession, repoPath: "/no-forge" }); // forge resolves null
  const emitted: unknown[] = [];
  const poller = new PrPoller(
    store,
    (repo) => (repo === "/no-forge" ? null : forgeReturning(() => OPEN)),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  expect(emitted).toHaveLength(0);
  expect(poller.snapshot()).toEqual({});
});

test("keeps the last cached value when prStatus throws", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: unknown[] = [];
  let fail = false;
  const poller = new PrPoller(
    store,
    () =>
      forgeReturning(() => {
        if (fail) throw new Error("gh down");
        return OPEN;
      }),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  expect(emitted).toHaveLength(1);
  fail = true;
  await poller.tick(); // transient failure → no emit, snapshot intact
  expect(emitted).toHaveLength(1);
  expect(poller.snapshot()[s.id]?.state).toBe("open");
});

test("snapshot/set/drop manage the cache", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN),
    () => {},
  );

  poller.set(s.id, { ...NONE, kind: "github" });
  expect(poller.snapshot()[s.id]?.state).toBe("none");
  poller.drop(s.id);
  expect(poller.snapshot()[s.id]).toBeUndefined();
});

test("prunes cache entries for sessions no longer active", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN),
    () => {},
  );

  await poller.tick();
  expect(poller.snapshot()[s.id]?.state).toBe("open");
  store.archive(s.id);
  await poller.tick(); // session no longer active → pruned
  expect(poller.snapshot()[s.id]).toBeUndefined();
});
