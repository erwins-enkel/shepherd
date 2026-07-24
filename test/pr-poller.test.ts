import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { PrPoller, trustsTerminal, gitStateChanged } from "../src/pr-poller";
import type { GitForge, GitState, PrStatus } from "../src/forge/types";
import { EMPTY_BACKLOG_COUNTS } from "../src/forge/types";

const openGit = (over: Partial<GitState> = {}): GitState => ({
  kind: "github",
  state: "open",
  number: 1,
  checks: "pending",
  deployConfigured: false,
  ...over,
});

test("gitStateChanged: true when the running-checks set changes", () => {
  expect(
    gitStateChanged(openGit({ runningChecks: ["a"] }), openGit({ runningChecks: ["a", "b"] })),
  ).toBe(true);
  expect(
    gitStateChanged(openGit({ runningChecks: ["a"] }), openGit({ runningChecks: ["c"] })),
  ).toBe(true);
  expect(
    gitStateChanged(openGit({ runningChecks: undefined }), openGit({ runningChecks: ["a"] })),
  ).toBe(true);
});

test("gitStateChanged: false when running-checks only reorders (set-equal)", () => {
  expect(
    gitStateChanged(openGit({ runningChecks: ["a", "b"] }), openGit({ runningChecks: ["b", "a"] })),
  ).toBe(false);
  expect(
    gitStateChanged(openGit({ runningChecks: undefined }), openGit({ runningChecks: undefined })),
  ).toBe(false);
});

test("gitStateChanged: true when reviewerStates or reviewBlock changes", () => {
  const prev = openGit({
    checks: "success",
    latestReview: { state: "changes_requested", author: "scoop", submittedAt: 1 },
  });
  expect(
    gitStateChanged(prev, {
      ...prev,
      reviewerStates: { scoop: { state: "changes_requested", latestAt: 1 } },
    }),
  ).toBe(true);
  expect(
    gitStateChanged(
      {
        ...prev,
        reviewerStates: { scoop: { state: "changes_requested", latestAt: 1 } },
      },
      {
        ...prev,
        reviewerStates: { scoop: { state: "changes_requested", latestAt: 1 } },
        reviewBlock: { reviewer: "scoop", state: "changes_requested", latestAt: 1 },
      },
    ),
  ).toBe(true);
});

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
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => status(),
    openPr: async () => status(),
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
}

const NONE: PrStatus = { state: "none", checks: "none", deployConfigured: false };
const OPEN: PrStatus = { state: "open", number: 7, checks: "pending", deployConfigured: false };

test("emits session git state on first poll and only again on change", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: {
    id: string;
    git: { state: string; number?: number; kind: string; noCi?: boolean };
  }[] = [];
  let cur = OPEN;
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  // annotateHandoff stamps noCi (repoPath "/r" has no .github/workflows ⇒ GitHub no-CI repo).
  expect(emitted).toEqual([{ id: s.id, git: { ...OPEN, kind: "github", noCi: true } }]);

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
  expect(store.listSessionGitCache()[s.id]?.state).toBe("none");
  poller.drop(s.id);
  expect(poller.snapshot()[s.id]).toBeUndefined();
  expect(store.listSessionGitCache()[s.id]).toBeUndefined();
});

test("restart hydrates prior PR identity and accepts its unreachable terminal transition", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  let cur: PrStatus = OPEN;
  const beforeRestart = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    () => {},
  );
  await beforeRestart.tick();
  expect(store.listSessionGitCache()[s.id]?.state).toBe("open");

  cur = {
    state: "merged",
    number: 7,
    checks: "success",
    headSha: "remote-final-head",
    deployConfigured: false,
  };
  const afterRestart = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => false,
  );

  expect(afterRestart.snapshot()[s.id]?.state).toBe("open");
  await afterRestart.tick();
  expect(afterRestart.snapshot()[s.id]).toMatchObject({ state: "merged", number: 7 });
  expect(store.listSessionGitCache()[s.id]).toMatchObject({ state: "merged", number: 7 });
});

test("re-emits when checks or head SHA change on the same PR", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const emitted: { state: string; checks: string; headSha?: string }[] = [];
  let cur: PrStatus = {
    state: "open",
    number: 7,
    checks: "pending",
    headSha: "aaa",
    deployConfigured: false,
  };
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (_id, git) => emitted.push({ state: git.state, checks: git.checks, headSha: git.headSha }),
  );
  await poller.tick(); // first emit
  cur = { ...cur, checks: "success" };
  await poller.tick(); // checks changed → emit
  cur = { ...cur, headSha: "bbb" };
  await poller.tick(); // head changed → emit
  await poller.tick(); // unchanged → no emit
  expect(emitted.map((e) => e.checks)).toEqual(["pending", "success", "success"]);
  expect(emitted.map((e) => e.headSha)).toEqual(["aaa", "aaa", "bbb"]);
});

const tick = () => new Promise((r) => setTimeout(r, 0));

test("pollSession emits for one session without a full sweep", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: { id: string; state: string }[] = [];
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN),
    (id, git) => emitted.push({ id, state: git.state }),
    120_000,
    0, // no debounce delay in tests
  );

  poller.pollSession(s.id);
  await tick();
  expect(emitted).toEqual([{ id: s.id, state: "open" }]);

  poller.pollSession(s.id); // unchanged → no new emit
  await tick();
  expect(emitted).toHaveLength(1);
});

test("pollSession coalesces a burst into a single poll", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  let calls = 0;
  const poller = new PrPoller(
    store,
    () =>
      forgeReturning(() => {
        calls++;
        return OPEN;
      }),
    () => {},
    120_000,
    5,
  );

  poller.pollSession(s.id);
  poller.pollSession(s.id);
  poller.pollSession(s.id);
  await new Promise((r) => setTimeout(r, 20));
  expect(calls).toBe(1);
});

test("pollSession ignores archived/unknown sessions", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  store.archive(s.id);
  const emitted: unknown[] = [];
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN),
    (id, git) => emitted.push({ id, git }),
    120_000,
    0,
  );

  poller.pollSession(s.id);
  poller.pollSession("nope");
  await tick();
  expect(emitted).toHaveLength(0);
});

test("emits when only the latest review changes", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const emitted: { id: string; git: any }[] = [];
  let cur: PrStatus = { state: "open", number: 7, checks: "success", deployConfigured: false };
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  expect(emitted.length).toBe(1);

  // same state/number/checks/headSha, but a new human review lands
  cur = { ...cur, latestReview: { state: "changes_requested", author: "bob", submittedAt: 1000 } };
  await poller.tick();
  expect(emitted.length).toBe(2);
  expect(emitted[1]!.git.latestReview.state).toBe("changes_requested");

  await poller.tick(); // unchanged → no new emit
  expect(emitted.length).toBe(2);
});

test("emits when only mergeStateStatus changes (blocked → unstable)", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const emitted: { id: string; git: any }[] = [];
  let cur: PrStatus = {
    state: "open",
    number: 7,
    checks: "failure",
    headSha: "abc",
    mergeStateStatus: "blocked",
    deployConfigured: false,
  };
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  expect(emitted.length).toBe(1);

  // required check passes → merge now allowed, but checks rollup + headSha unchanged
  cur = { ...cur, mergeStateStatus: "unstable" };
  await poller.tick();
  expect(emitted.length).toBe(2);
  expect(emitted[1]!.git.mergeStateStatus).toBe("unstable");

  await poller.tick(); // unchanged → no new emit
  expect(emitted.length).toBe(2);
});

test("emits when only isDraft changes (true → false)", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const emitted: { id: string; git: any }[] = [];
  let cur: PrStatus = {
    state: "open",
    number: 7,
    checks: "success",
    headSha: "abc",
    isDraft: true,
    deployConfigured: false,
  };
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  expect(emitted.length).toBe(1);

  // draft marked ready-for-review → Merge un-blocks, but no other field changes
  cur = { ...cur, isDraft: false };
  await poller.tick();
  expect(emitted.length).toBe(2);
  expect(emitted[1]!.git.isDraft).toBe(false);

  await poller.tick(); // unchanged → no new emit
  expect(emitted.length).toBe(2);
});

test("emits when only mergeable changes (false → true)", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const emitted: { id: string; git: any }[] = [];
  let cur: PrStatus = {
    state: "open",
    number: 7,
    checks: "success",
    headSha: "abc",
    mergeable: false,
    deployConfigured: false,
  };
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (id, git) => emitted.push({ id, git }),
  );

  await poller.tick();
  expect(emitted.length).toBe(1);

  // conflict resolved via a base-branch change — mergeable flips without a new head commit
  cur = { ...cur, mergeable: true };
  await poller.tick();
  expect(emitted.length).toBe(2);
  expect(emitted[1]!.git.mergeable).toBe(true);

  await poller.tick(); // unchanged → no new emit
  expect(emitted.length).toBe(2);
});

function forgeByBranch(byBranch: Record<string, PrStatus>): GitForge {
  return {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (head: string) => byBranch[head] ?? NONE,
    openPr: async () => NONE,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
}

test("reconciles to the live worktree branch when the stored branch has no PR", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession); // stored branch shepherd/x has no PR
  const emitted: { id: string; state: string; number?: number }[] = [];
  let reconcileCalls = 0;
  const poller = new PrPoller(
    store,
    () => forgeByBranch({ "shepherd/renamed": OPEN }), // PR lives on the renamed branch
    (id, git) => emitted.push({ id, state: git.state, number: git.number }),
    120_000,
    1000,
    (sess) => {
      reconcileCalls++;
      expect(sess.id).toBe(s.id);
      return "shepherd/renamed"; // agent renamed the worktree branch
    },
  );

  await poller.tick();
  expect(reconcileCalls).toBe(1);
  expect(emitted).toEqual([{ id: s.id, state: "open", number: 7 }]);
});

test("does not reconcile when the stored branch already has a PR", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  let reconcileCalls = 0;
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN),
    () => {},
    120_000,
    1000,
    () => {
      reconcileCalls++;
      return "shepherd/renamed";
    },
  );

  await poller.tick();
  expect(reconcileCalls).toBe(0); // stored branch matched → no reconcile attempt
});

test("leaves state none when reconcile finds no other branch", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: { state: string }[] = [];
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => NONE),
    (_id, git) => emitted.push({ state: git.state }),
    120_000,
    1000,
    () => null, // nothing to adopt
  );

  await poller.tick();
  expect(emitted).toEqual([{ state: "none" }]);
  expect(poller.snapshot()[s.id]?.state).toBe("none");
});

const OPEN_PENDING: PrStatus = {
  state: "open",
  number: 1,
  checks: "pending",
  deployConfigured: false,
};

// Worst-of rollup already "failure" (one check failed) but jobs still running.
// mergeable + mergeStateStatus are settled so the ONLY transient trigger is
// runningChecks — proving isTransientOpen keys on it.
const OPEN_FAILING_RUNNING: PrStatus = {
  state: "open",
  number: 1,
  checks: "failure",
  runningChecks: ["verify / test"],
  mergeable: true,
  mergeStateStatus: "clean",
  deployConfigured: false,
};

const MERGED: PrStatus = {
  state: "merged",
  number: 344,
  checks: "success",
  headSha: "deadbee",
  deployConfigured: false,
};

test("discards a merged PR whose head commit isn't on this session's branch (name collision)", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const emitted: { state: string; number?: number }[] = [];
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => MERGED), // a stale, name-matched merged PR
    (_id, git) => emitted.push({ state: git.state, number: git.number }),
    120_000,
    1000,
    () => null, // no other branch to adopt
    15_000,
    () => false, // head commit does NOT belong to this session's branch
  );

  await poller.tick();
  // the false MERGED is dropped to none — the row stays in "active", not "merged"
  expect(emitted).toEqual([{ state: "none", number: undefined }]);
  expect(poller.snapshot()[s.id]?.state).toBe("none");
});

test("keeps a merged PR whose head commit is on this session's branch", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const emitted: { state: string; number?: number }[] = [];
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => MERGED),
    (_id, git) => emitted.push({ state: git.state, number: git.number }),
    120_000,
    1000,
    () => null,
    15_000,
    () => true, // genuinely this session's own merged PR
  );

  await poller.tick();
  expect(emitted).toEqual([{ state: "merged", number: 344 }]);
});

test("keeps a merged PR when ownership is unknowable (null) rather than hiding it", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const emitted: { state: string }[] = [];
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => MERGED),
    (_id, git) => emitted.push({ state: git.state }),
    120_000,
    1000,
    () => null,
    15_000,
    () => null, // bad worktree / git error → don't mask a real merge
  );

  await poller.tick();
  expect(emitted).toEqual([{ state: "merged" }]);
});

test("never runs the ownership check for an open PR (name match is current)", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  let ownsCalls = 0;
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN),
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => {
      ownsCalls++;
      return false;
    },
  );

  await poller.tick();
  expect(ownsCalls).toBe(0); // open PRs are inherently the live one — no guard needed
});

test("applies the ownership guard to an adopted live branch's terminal PR too", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession); // stored branch shepherd/x has no PR
  const emitted: { state: string; number?: number }[] = [];
  const poller = new PrPoller(
    store,
    // stored branch → none, forcing reconcile; adopted branch → a stale merged PR
    () => forgeByBranch({ "shepherd/renamed": MERGED }),
    (_id, git) => emitted.push({ state: git.state, number: git.number }),
    120_000,
    1000,
    () => "shepherd/renamed", // agent renamed the worktree branch
    15_000,
    () => false, // the adopted branch's merged head isn't this session's commit
  );

  await poller.tick();
  // the reused-name merged hit on the adopted branch is rejected, not re-introduced
  expect(emitted).toEqual([{ state: "none", number: undefined }]);
  expect(poller.snapshot()[s.id]?.state).toBe("none");
});

test("fast tick re-polls only open PRs — accelerating in-flight CI", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" }); // open PR (CI running)
  store.create({ ...baseSession, branch: "shepherd/b" }); // merged → settled
  const polled: string[] = [];
  const byBranch: Record<string, PrStatus> = {
    "shepherd/a": OPEN_PENDING,
    "shepherd/b": { state: "merged", number: 2, checks: "success", deployConfigured: false },
  };
  const forge: GitForge = {
    ...forgeByBranch(byBranch),
    prStatus: async (head: string) => {
      polled.push(head);
      return byBranch[head] ?? NONE;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick(); // warm the cache (both branches polled)
  polled.length = 0;
  await poller.fastTick(); // only the open PR is re-polled on the fast cadence
  expect(polled).toEqual(["shepherd/a"]);
});

test("fastTick batches a transient-dominant repo via one listOpenPrStatuses (a)", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  store.create({ ...baseSession, branch: "shepherd/b" });
  // P == eligible: the open set is exactly the two transient PRs → P ≤ ratio×count → batch.
  const { forge, stats } = forgeWithBatch({
    "shepherd/a": OPEN_PENDING,
    "shepherd/b": OPEN_PENDING,
  });
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick(); // seed cache (both open+transient) + transientSince
  stats.list = 0;
  stats.count = 0;
  stats.prStatus = 0;
  await poller.fastTick();
  expect(stats.count).toBe(1); // one count-gate probe for the repo
  expect(stats.list).toBe(1); // one batch refresh covers both PRs
  expect(stats.prStatus).toBe(0); // no per-PR fan-out
});

test("fastTick falls back to per-session for a single eligible PR — count<2 (b)", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  const { forge, stats } = forgeWithBatch(
    { "shepherd/a": OPEN_PENDING },
    { prStatusByBranch: { "shepherd/a": OPEN_PENDING } },
  );
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick();
  stats.list = 0;
  stats.count = 0;
  stats.prStatus = 0;
  await poller.fastTick();
  expect(stats.count).toBe(0); // count<2 short-circuits before the probe
  expect(stats.list).toBe(0);
  expect(stats.prStatus).toBe(1); // lone eligible → per-session
});

test("fastTick keeps re-polling an open PR whose CI failed but still has running jobs", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  const { forge, stats } = forgeWithBatch(
    { "shepherd/a": OPEN_FAILING_RUNNING },
    { prStatusByBranch: { "shepherd/a": OPEN_FAILING_RUNNING } },
  );
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick();
  stats.prStatus = 0;
  await poller.fastTick();
  // Transient purely via runningChecks (merge state settled) → still fast-polled.
  expect(stats.prStatus).toBe(1);
});

test("fastTick fans out O(eligible) per-session across singleton repos, no cap (c)", async () => {
  const store = new SessionStore(":memory:");
  const REPOS = 10; // exceeds the old fastBatch=8 cap → proves no cap remains
  const forges: Record<string, GitForge> = {};
  let prStatusCalls = 0;
  let listCalls = 0;
  for (let i = 0; i < REPOS; i++) {
    const repoPath = `/r${i}`;
    store.create({ ...baseSession, repoPath, branch: `shepherd/${i}` });
    const { forge } = forgeWithBatch(
      { [`shepherd/${i}`]: OPEN_PENDING },
      { slug: `o/r${i}`, prStatusByBranch: { [`shepherd/${i}`]: OPEN_PENDING } },
    );
    forges[repoPath] = {
      ...forge,
      prStatus: async () => {
        prStatusCalls++;
        return OPEN_PENDING;
      },
      listOpenPrStatuses: async () => {
        listCalls++;
        return new Map();
      },
    };
  }
  const poller = new PrPoller(
    store,
    (rp) => forges[rp] ?? null,
    () => {},
  );

  await poller.tick();
  prStatusCalls = 0;
  listCalls = 0;
  await poller.fastTick();
  expect(prStatusCalls).toBe(REPOS); // every singleton repo polled per-session in one tick
  expect(listCalls).toBe(0); // count<2 each → never batched
});

test("fastTick covers all eligible PRs of one repo in a single tick — no rotation (d)", async () => {
  const store = new SessionStore(":memory:");
  const open: Record<string, PrStatus> = {};
  for (let i = 0; i < 10; i++) open[`shepherd/${i}`] = { ...OPEN_PENDING, number: i + 1 };
  for (let i = 0; i < 10; i++) store.create({ ...baseSession, branch: `shepherd/${i}` });
  const { forge, stats } = forgeWithBatch(open);
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick();
  stats.list = 0;
  stats.prStatus = 0;
  await poller.fastTick();
  expect(stats.list).toBe(1); // single batch covers all 10 (old code rotated 8/tick)
  expect(stats.prStatus).toBe(0);
});

test("fastTick keeps a mixed repo (P ≫ eligible) per-session via the count-gate (e)", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  store.create({ ...baseSession, branch: "shepherd/b" });
  // Only 2 transient PRs eligible, but the repo has 20 open PRs total → 20 > 2×2 → per-session.
  const { forge, stats } = forgeWithBatch(
    { "shepherd/a": OPEN_PENDING, "shepherd/b": OPEN_PENDING },
    { count: 20, prStatusByBranch: { "shepherd/a": OPEN_PENDING, "shepherd/b": OPEN_PENDING } },
  );
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick();
  stats.list = 0;
  stats.count = 0;
  stats.prStatus = 0;
  await poller.fastTick();
  expect(stats.count).toBe(1); // probed countOpenPrs
  expect(stats.list).toBe(0); // gate tripped → no full-rollup batch
  expect(stats.prStatus).toBe(2); // refreshed the 2 eligible per-session
});

test("serializes a targeted poll behind a sweep — one gh at a time", async () => {
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 3; i++) store.create({ ...baseSession, branch: `shepherd/${i}` });
  let active = 0;
  let maxActive = 0;
  const forge: GitForge = {
    ...forgeByBranch({}),
    prStatus: async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return OPEN_PENDING;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    0, // fire the targeted poll immediately so it races the sweep
  );

  const sweep = poller.tick();
  poller.pollSession(store.list({ activeOnly: true })[0]!.id); // races the in-flight sweep
  await sweep;
  await new Promise((r) => setTimeout(r, 30)); // let the debounced targeted poll drain
  expect(maxActive).toBe(1); // never two `gh` calls in flight at once
});

// ── warm() / rateLimited() cadence gating ─────────────────────────────────────

test("fastTick under rateLimited() keeps transient PRs moving per-session", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  let calls = 0;
  let rl = false;
  const forge: GitForge = {
    ...forgeByBranch({}),
    prStatus: async () => {
      calls++;
      return OPEN_PENDING;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true, // warm
    () => rl,
  );
  await poller.tick(); // cache one open PR (rl=false so tick runs)
  calls = 0;
  rl = true; // engage the rate-limit gate
  await poller.fastTick();
  expect(calls).toBe(1); // rateLimited → no batch, but per-session status still refreshes
  expect(poller.snapshot()).toBeDefined(); // cache untouched
});

test("fastTick skips when warm() is false and runs when warm & not limited", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  let calls = 0;
  let warm = true;
  const forge: GitForge = {
    ...forgeByBranch({}),
    prStatus: async () => {
      calls++;
      return OPEN_PENDING;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => warm,
    () => false,
  );
  await poller.tick(); // cache one open PR
  calls = 0;
  warm = false;
  await poller.fastTick();
  expect(calls).toBe(0); // not warm → skipped
  warm = true;
  await poller.fastTick();
  expect(calls).toBe(1); // warm & not limited → runs
});

test("tick runs every call when warm() is true", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  let calls = 0;
  const poller = new PrPoller(
    store,
    () =>
      forgeReturning(() => {
        calls++;
        return OPEN;
      }),
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true, // warm
    () => false,
  );
  await poller.tick();
  await poller.tick();
  expect(calls).toBe(2);
});

test("tick when not warm runs once then skips within idleIntervalMs", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  let calls = 0;
  const poller = new PrPoller(
    store,
    () =>
      forgeReturning(() => {
        calls++;
        return OPEN;
      }),
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => false, // not warm
    () => false,
    600_000, // large idleIntervalMs → second call is throttled out
  );
  await poller.tick();
  expect(calls).toBe(1); // first sweep proceeds and stamps lastFullSweepAt
  await poller.tick();
  expect(calls).toBe(1); // within idle window → skipped
});

test("tick when not warm runs again with idleIntervalMs 0", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  let calls = 0;
  const poller = new PrPoller(
    store,
    () =>
      forgeReturning(() => {
        calls++;
        return OPEN;
      }),
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => false, // not warm
    () => false,
    0, // no idle throttle → every call sweeps
  );
  await poller.tick();
  await poller.tick();
  expect(calls).toBe(2);
});

test("tick under rateLimited() skips GraphQL batches but still polls sessions", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  let calls = 0;
  let batchCalls = 0;
  const forge: GitForge = {
    ...forgeReturning(() => {
      calls++;
      return OPEN;
    }),
    countOpenPrs: async () => {
      batchCalls++;
      return 1;
    },
    listOpenPrSnapshot: async () => {
      batchCalls++;
      return { prs: [], statuses: new Map(), capped: false };
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true, // warm
    () => true, // but rate limited
  );
  await poller.tick();
  expect(calls).toBe(1);
  expect(batchCalls).toBe(0);
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

// ── trustsTerminal unit tests ─────────────────────────────────────────────────

test("trustsTerminal: signal (a) cold cache + marked + same number → true", () => {
  expect(
    trustsTerminal(
      undefined,
      { kind: "github", state: "merged", number: 42, checks: "none", deployConfigured: false },
      true,
      42,
    ),
  ).toBe(true);
});

test("trustsTerminal: marked + different-number terminal → false (falls to prev-cache path)", () => {
  expect(
    trustsTerminal(
      undefined,
      { kind: "github", state: "merged", number: 99, checks: "success", deployConfigured: false },
      true,
      42,
    ),
  ).toBe(false);
});

test("trustsTerminal: marked + markedNumber null + terminal, no prev → false", () => {
  expect(
    trustsTerminal(
      undefined,
      { kind: "github", state: "merged", number: 7, checks: "success", deployConfigured: false },
      true,
      null,
    ),
  ).toBe(false);
});

test("trustsTerminal: marked but state none → false (terminal-state gate)", () => {
  const noneState = {
    kind: "github" as const,
    state: "none" as const,
    checks: "none" as const,
    deployConfigured: false,
  };
  expect(trustsTerminal(undefined, noneState, true, 42)).toBe(false);
});

test("trustsTerminal: marked but state open (non-terminal) → false (terminal-state gate)", () => {
  expect(
    trustsTerminal(
      undefined,
      { kind: "github", state: "open", number: 7, checks: "pending", deployConfigured: false },
      true,
      7,
    ),
  ).toBe(false);
});

test("trustsTerminal: signal (b) prev open #7, raw merged #7, unmarked → true", () => {
  expect(
    trustsTerminal(
      { kind: "github", state: "open", number: 7, checks: "pending", deployConfigured: false },
      { kind: "github", state: "merged", number: 7, checks: "success", deployConfigured: false },
      false,
      null,
    ),
  ).toBe(true);
});

test("trustsTerminal: no prev, raw merged #7, unmarked → false", () => {
  expect(
    trustsTerminal(
      undefined,
      { kind: "github", state: "merged", number: 7, checks: "success", deployConfigured: false },
      false,
      null,
    ),
  ).toBe(false);
});

test("trustsTerminal: prev none, raw merged #7, unmarked → false", () => {
  expect(
    trustsTerminal(
      { kind: "github", state: "none", checks: "none", deployConfigured: false },
      { kind: "github", state: "merged", number: 7, checks: "success", deployConfigured: false },
      false,
      null,
    ),
  ).toBe(false);
});

test("trustsTerminal: prev open #7, raw merged #8 (mismatched number), unmarked → false", () => {
  expect(
    trustsTerminal(
      { kind: "github", state: "open", number: 7, checks: "pending", deployConfigured: false },
      { kind: "github", state: "merged", number: 8, checks: "success", deployConfigured: false },
      false,
      null,
    ),
  ).toBe(false);
});

// ── refresh integration tests ─────────────────────────────────────────────────

test("refresh signal (b): prior-owned PR transitions to merged, bypasses guard when ownsPr=false", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession); // unmarked (mergingSince=null by default)
  const emitted: { state: string; number?: number }[] = [];
  let cur: PrStatus = OPEN; // number 7
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => cur),
    (_id, git) => emitted.push({ state: git.state, number: git.number }),
    120_000,
    1000,
    () => null,
    15_000,
    () => false, // ownsPr always returns false
  );

  await poller.tick(); // first tick caches open #7 (emits #1)
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.state).toBe("open");

  // same PR number 7 now transitions to merged
  cur = {
    state: "merged",
    number: 7,
    checks: "success",
    headSha: "newsha",
    deployConfigured: false,
  };
  await poller.tick(); // prev cache owns #7, so trust the terminal result
  expect(emitted).toHaveLength(2);
  expect(emitted[1]!.state).toBe("merged"); // NOT "none"
  expect(emitted[1]!.number).toBe(7);
  expect(poller.snapshot()[s.id]?.state).toBe("merged");
});

test("refresh signal (a): cold cache + marked + markedNumber matches, ownsPr=false → merged passes through", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  // Mark the session as merge-train-flagged with the observed PR number BEFORE any poll
  store.update(s.id, { mergingSince: Date.now(), mergingTrainId: "t", mergingPrNumber: 344 });
  const emitted: { state: string; number?: number }[] = [];
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => MERGED), // number 344, headSha "deadbee"
    (_id, git) => emitted.push({ state: git.state, number: git.number }),
    120_000,
    1000,
    () => null,
    15_000,
    () => false, // ownsPr always returns false
  );

  await poller.tick(); // cold cache, but marked → trust the terminal
  expect(emitted).toHaveLength(1);
  expect(emitted[0]!.state).toBe("merged"); // NOT "none"
  expect(emitted[0]!.number).toBe(344);
  expect(poller.snapshot()[s.id]?.state).toBe("merged");
});

// ── Task 3: activity-aware fast-sweep filter ───────────────────────────────────

/** Open PR that is stable-green: CI passed, mergeable, clean merge state — not transient. */
const OPEN_STABLE: PrStatus = {
  state: "open",
  number: 10,
  checks: "success",
  mergeable: true,
  mergeStateStatus: "clean",
  deployConfigured: false,
};

test("fastTick skips a stable-green open PR (not transient — parked)", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/stable" });
  let fastPolled = 0;
  const forge: GitForge = {
    ...forgeByBranch({}),
    prStatus: async () => {
      fastPolled++;
      return OPEN_STABLE;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick(); // seed cache; also calls prStatus (fastPolled++)
  fastPolled = 0; // reset — only count fastTick polls
  await poller.fastTick(); // stable PR → not eligible → 0 polls
  expect(fastPolled).toBe(0);
});

test("fastTick polls a transient open PR (checks:pending)", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/pending-fast" });
  let fastPolled = 0;
  const forge: GitForge = {
    ...forgeByBranch({}),
    prStatus: async () => {
      fastPolled++;
      return OPEN_PENDING;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick();
  fastPolled = 0;
  await poller.fastTick(); // pending → transient → eligible → polled
  expect(fastPolled).toBe(1);
});

test("fastTick parks a transient PR whose transientMaxMs window has expired", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, branch: "shepherd/aged" });
  let fastPolled = 0;
  const forge: GitForge = {
    ...forgeByBranch({}),
    prStatus: async () => {
      fastPolled++;
      return OPEN_PENDING;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true,
    () => false,
    300_000,
    300_000, // transientMaxMs
  );

  await poller.tick(); // seed cache + transientSince (since ≈ now)
  fastPolled = 0;

  // Age the transientSince entry past the 300s window
  const ts = (poller as any).transientSince as Map<string, { since: number; headSha?: string }>;
  ts.set(s.id, { since: Date.now() - 400_000, headSha: undefined });

  await poller.fastTick(); // aged out → parked → 0 polls
  expect(fastPolled).toBe(0);
});

test("headSha change restamps the transient window, making an aged-out PR eligible again", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, branch: "shepherd/pushed" });
  let cur: PrStatus = { ...OPEN_PENDING, headSha: "sha-aaa" };
  let fastPolled = 0;
  const forge: GitForge = {
    ...forgeByBranch({}),
    prStatus: async () => {
      fastPolled++;
      return cur;
    },
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true,
    () => false,
    300_000,
    300_000, // transientMaxMs
  );

  await poller.tick(); // seed with sha-aaa

  // Age out the entry so fastTick would park it
  const ts = (poller as any).transientSince as Map<string, { since: number; headSha?: string }>;
  ts.set(s.id, { since: Date.now() - 400_000, headSha: "sha-aaa" });

  fastPolled = 0;
  await poller.fastTick(); // aged out → 0 polls
  expect(fastPolled).toBe(0);

  // New push: headSha changes → refresh() sees sha-bbb ≠ sha-aaa → restamps since
  cur = { ...OPEN_PENDING, headSha: "sha-bbb" };
  await poller.tick(); // tick re-stamps transientSince with since ≈ now
  fastPolled = 0;
  await poller.fastTick(); // fresh window → eligible → polled
  expect(fastPolled).toBe(1);
});

test("transientSince entry is deleted when a session is pruned in tick()", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, branch: "shepherd/prune-tick" });
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN_PENDING),
    () => {},
  );

  await poller.tick(); // seed cache + transientSince

  const ts = (poller as any).transientSince as Map<string, { since: number; headSha?: string }>;
  expect(ts.has(s.id)).toBe(true);

  store.archive(s.id);
  await poller.tick(); // session no longer active → pruned from cache + transientSince

  expect(ts.has(s.id)).toBe(false);
  expect(poller.snapshot()[s.id]).toBeUndefined();
});

test("transientSince entry is deleted on drop()", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create({ ...baseSession, branch: "shepherd/prune-drop" });
  const poller = new PrPoller(
    store,
    () => forgeReturning(() => OPEN_PENDING),
    () => {},
  );

  await poller.tick(); // seed transientSince

  const ts = (poller as any).transientSince as Map<string, { since: number; headSha?: string }>;
  expect(ts.has(s.id)).toBe(true);

  poller.drop(s.id);

  expect(ts.has(s.id)).toBe(false);
  expect(poller.snapshot()[s.id]).toBeUndefined();
});

// ── Task 2: per-repo batch full sweep (count-gate + bounds) ────────────────────

/** A forge double implementing the batch methods (`listOpenPrStatuses` /
 *  `countOpenPrs`). `openByBranch` / `prStatusByBranch` are read live on each call,
 *  so tests can mutate them between ticks. `stats` counts each path's calls. */
function forgeWithBatch(
  openByBranch: Record<string, PrStatus>,
  opts: {
    isFork?: boolean;
    count?: number;
    slug?: string;
    prStatusByBranch?: Record<string, PrStatus>;
  } = {},
): { forge: GitForge; stats: { list: number; count: number; prStatus: number } } {
  const stats = { list: 0, count: 0, prStatus: 0 };
  const forge: GitForge = {
    kind: "github",
    slug: opts.slug ?? "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    isFork: opts.isFork,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (head: string) => {
      stats.prStatus++;
      return opts.prStatusByBranch?.[head] ?? NONE;
    },
    listOpenPrStatuses: async () => {
      stats.list++;
      return new Map(Object.entries(openByBranch));
    },
    countOpenPrs: async () => {
      stats.count++;
      return opts.count ?? Object.keys(openByBranch).length;
    },
    openPr: async () => NONE,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  return { forge, stats };
}

test("batch hit: open PR served from batch, no per-session prStatus", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession); // branch shepherd/x
  store.create({ ...baseSession, branch: "shepherd/dummy" }); // second session — satisfies count≥2 floor
  const emitted: { id: string; state: string }[] = [];
  const { forge, stats } = forgeWithBatch({ "shepherd/x": OPEN, "shepherd/dummy": NONE });
  const poller = new PrPoller(
    store,
    () => forge,
    (id, git) => emitted.push({ id, state: git.state }),
  );

  await poller.tick();
  expect(emitted).toContainEqual({ id: s.id, state: "open" });
  expect(stats.prStatus).toBe(0);
  expect(stats.list).toBe(1);
});

test("O(repos): five sessions on one forge resolve via a single batch call", async () => {
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 5; i++) store.create({ ...baseSession, branch: `shepherd/${i}` });
  const open: Record<string, PrStatus> = {};
  for (let i = 0; i < 5; i++) open[`shepherd/${i}`] = { ...OPEN, number: i + 1 };
  const emitted: string[] = [];
  const { forge, stats } = forgeWithBatch(open);
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push(g.state),
  );

  await poller.tick();
  expect(stats.list).toBe(1);
  expect(stats.prStatus).toBe(0);
  expect(emitted.filter((s) => s === "open").length).toBe(5);
});

test("fork mode never batches — falls back to per-session prStatus", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const { forge, stats } = forgeWithBatch(
    { "shepherd/x": OPEN },
    { isFork: true, prStatusByBranch: { "shepherd/x": OPEN } },
  );
  const emitted: string[] = [];
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push(g.state),
  );

  await poller.tick();
  expect(stats.list).toBe(0); // fork → never batched
  expect(stats.prStatus).toBe(1); // per-session fallback
  expect(emitted).toEqual(["open"]);
});

test("count-gate: over-ratio falls back to per-session, under-ratio batches", async () => {
  // over-ratio: 100 open PRs vs 2 sessions → 100 > 2×2=4 → per-session (ratio gate)
  {
    const store = new SessionStore(":memory:");
    store.create({ ...baseSession, branch: "shepherd/a" });
    store.create({ ...baseSession, branch: "shepherd/b" });
    const { forge, stats } = forgeWithBatch(
      {},
      { count: 100, prStatusByBranch: { "shepherd/a": OPEN, "shepherd/b": OPEN } },
    );
    const poller = new PrPoller(
      store,
      () => forge,
      () => {},
    );
    await poller.tick();
    expect(stats.count).toBe(1);
    expect(stats.list).toBe(0); // gate fails → no batch list
    expect(stats.prStatus).toBe(2); // per-session for both
  }
  // under-ratio: 1 open PR vs 2 sessions → 1 ≤ 2×2=4 → batch
  {
    const store = new SessionStore(":memory:");
    store.create({ ...baseSession, branch: "shepherd/a" });
    store.create({ ...baseSession, branch: "shepherd/b" });
    const { forge, stats } = forgeWithBatch(
      { "shepherd/a": OPEN, "shepherd/b": NONE },
      { count: 1 },
    );
    const poller = new PrPoller(
      store,
      () => forge,
      () => {},
    );
    await poller.tick();
    expect(stats.list).toBe(1);
    expect(stats.prStatus).toBe(0);
  }
});

test("merged transition: batch miss + prev-open → per-session confirm emits merged", async () => {
  const store = new SessionStore(":memory:");
  // dummy created FIRST so it is processed first in tick, shepherd/x last → emitted.at(-1) tracks shepherd/x
  store.create({ ...baseSession, branch: "shepherd/dummy" }); // second session — satisfies count≥2 floor
  store.create(baseSession); // shepherd/x
  const open: Record<string, PrStatus> = { "shepherd/x": OPEN, "shepherd/dummy": NONE }; // #7
  const prByBranch: Record<string, PrStatus> = {};
  const { forge, stats } = forgeWithBatch(open, { prStatusByBranch: prByBranch });
  const emitted: { state: string; number?: number }[] = [];
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push({ state: g.state, number: g.number }),
  );

  await poller.tick(); // batch hit open #7
  expect(emitted.at(-1)).toEqual({ state: "open", number: 7 });
  const before = stats.prStatus;

  // tick 2: batch miss + per-session reports merged #7 (prev open #7 → trustsTerminal)
  delete open["shepherd/x"];
  prByBranch["shepherd/x"] = {
    state: "merged",
    number: 7,
    checks: "success",
    headSha: "h7",
    deployConfigured: false,
  };
  await poller.tick();
  expect(stats.prStatus).toBe(before + 1); // exactly one confirm call
  expect(emitted.at(-1)?.state).toBe("merged");
});

test("stale-terminal guard under batch: reused-name merged dropped to none", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const open: Record<string, PrStatus> = { "shepherd/x": OPEN }; // #7
  const prByBranch: Record<string, PrStatus> = {};
  const { forge } = forgeWithBatch(open, { prStatusByBranch: prByBranch });
  const emitted: { state: string; number?: number }[] = [];
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push({ state: g.state, number: g.number }),
    120_000,
    1000,
    () => null,
    15_000,
    () => false, // ownsPr false → reused-name terminal rejected
  );

  await poller.tick(); // open #7 cached
  delete open["shepherd/x"];
  prByBranch["shepherd/x"] = {
    state: "merged",
    number: 8,
    checks: "success",
    headSha: "x",
    deployConfigured: false,
  };
  await poller.tick(); // miss → confirm merged #8 (different number) → guard → none
  expect(emitted.at(-1)).toEqual({ state: "none", number: undefined });
  expect(poller.snapshot()[s.id]?.state).toBe("none");
});

test("rename present in batch adopted next sweep with no extra prStatus", async () => {
  const store = new SessionStore(":memory:");
  // dummy created FIRST (always in batch) so it never calls prStatus; shepherd/x SECOND
  store.create({ ...baseSession, branch: "shepherd/dummy" }); // satisfies count≥2 floor
  store.create(baseSession); // shepherd/x
  const open: Record<string, PrStatus> = { "shepherd/dummy": NONE }; // dummy always in batch; shepherd/x initially missing
  let live: string | null = null;
  const { forge, stats } = forgeWithBatch(open, { prStatusByBranch: {} });
  const emitted: { state: string; number?: number }[] = [];
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push({ state: g.state, number: g.number }),
    120_000,
    1000,
    () => live,
  );

  await poller.tick(); // tick1: dummy batch hit (none); shepherd/x miss → one confirm (none) → reconcile null → none
  expect(stats.prStatus).toBe(1); // only shepherd/x called prStatus
  expect(emitted.at(-1)?.state).toBe("none"); // shepherd/x processed last

  // tick2 (within noneRecheckMs): rename visible + open PR present on renamed branch
  live = "shepherd/renamed";
  open["shepherd/renamed"] = OPEN;
  await poller.tick();
  expect(stats.prStatus).toBe(1); // adopted from batch — no extra GraphQL
  expect(emitted.at(-1)).toEqual({ state: "open", number: 7 });
});

test("rename via pollSession (per-session path) adopts the renamed branch", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession);
  const { forge } = forgeWithBatch({}, { prStatusByBranch: { "shepherd/renamed": OPEN } });
  const emitted: { state: string }[] = [];
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push({ state: g.state }),
    120_000,
    0, // no debounce
    () => "shepherd/renamed",
  );

  poller.pollSession(s.id);
  await tick();
  expect(emitted.at(-1)).toEqual({ state: "open" });
});

test("cold-cache none: confirmed once then skipped within the recheck window", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession); // shepherd/x
  store.create({ ...baseSession, branch: "shepherd/dummy" }); // satisfies count≥2 floor; always hits batch → no prStatus
  const { forge, stats } = forgeWithBatch({ "shepherd/dummy": NONE }, { prStatusByBranch: {} });
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
  );

  await poller.tick(); // shepherd/x: prev null → confirm once → none cached; dummy: batch hit
  expect(stats.prStatus).toBe(1);
  await poller.tick(); // shepherd/x: within noneRecheckMs, prev none → no re-confirm; dummy: batch hit unchanged
  expect(stats.prStatus).toBe(1);
});

test("stuck-none heals after noneRecheckMs via a per-session re-confirm", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession);
  const prByBranch: Record<string, PrStatus> = {};
  const { forge } = forgeWithBatch({}, { prStatusByBranch: prByBranch });
  const emitted: { state: string }[] = [];
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push({ state: g.state }),
    120_000,
    1000,
    () => null,
    15_000,
    () => true, // ownsPr true → keep the merge
    () => true,
    () => false,
    300_000,
    300_000,
    2, // batchOpenRatio
    0, // noneRecheckMs → every sweep re-confirms a cached none
  );

  await poller.tick(); // none cached
  expect(emitted.at(-1)?.state).toBe("none");

  // PR merged between sweeps — a --state open batch can't surface it
  prByBranch["shepherd/x"] = {
    state: "merged",
    number: 5,
    checks: "success",
    headSha: "h5",
    deployConfigured: false,
  };
  await poller.tick(); // recheckNone → confirm → merged
  expect(emitted.at(-1)?.state).toBe("merged");
});

test("multi-repo: one batch call per distinct slug", async () => {
  const store = new SessionStore(":memory:");
  // Two sessions per repo so each slug has count≥2 and passes the single-session floor
  store.create({ ...baseSession, repoPath: "/a", branch: "shepherd/a1" });
  store.create({ ...baseSession, repoPath: "/a", branch: "shepherd/a2" });
  store.create({ ...baseSession, repoPath: "/b", branch: "shepherd/b1" });
  store.create({ ...baseSession, repoPath: "/b", branch: "shepherd/b2" });
  const a = forgeWithBatch({ "shepherd/a1": OPEN, "shepherd/a2": NONE }, { slug: "o/a" });
  const b = forgeWithBatch({ "shepherd/b1": OPEN, "shepherd/b2": NONE }, { slug: "o/b" });
  const poller = new PrPoller(
    store,
    (repo) => (repo === "/a" ? a.forge : b.forge),
    () => {},
  );

  await poller.tick();
  expect(a.stats.list).toBe(1);
  expect(b.stats.list).toBe(1);
  expect(a.stats.prStatus).toBe(0);
  expect(b.stats.prStatus).toBe(0);
});

test("single-gh: batch (count/list) + per-session never overlap (maxActive 1)", async () => {
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 3; i++) store.create({ ...baseSession, branch: `shepherd/${i}` });
  let active = 0;
  let maxActive = 0;
  const bump = async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  };
  const forge: GitForge = {
    kind: "github",
    slug: "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async () => {
      await bump();
      return NONE;
    },
    listOpenPrStatuses: async () => {
      await bump();
      return new Map();
    },
    countOpenPrs: async () => {
      await bump();
      return 0;
    },
    openPr: async () => NONE,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    0, // fire the targeted poll immediately so it races the sweep
  );

  const sweep = poller.tick();
  poller.pollSession(store.list({ activeOnly: true })[0]!.id);
  await sweep;
  await new Promise((r) => setTimeout(r, 60));
  expect(maxActive).toBe(1);
});

// ── M1: single-session floor + M2: P≥200 cap-hit ─────────────────────────────

test("single-session floor: count<2 skips count probe and batch, serves via prStatus", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession); // one session → count=1 in buildBatches
  const { forge, stats } = forgeWithBatch(
    { "shepherd/x": OPEN },
    { prStatusByBranch: { "shepherd/x": OPEN } },
  );
  const emitted: { state: string }[] = [];
  const poller = new PrPoller(
    store,
    () => forge,
    (_id, g) => emitted.push({ state: g.state }),
  );

  await poller.tick();
  // count<2 floor fires before count probe — neither countOpenPrs nor listOpenPrStatuses called
  expect(stats.count).toBe(0);
  expect(stats.list).toBe(0);
  expect(stats.prStatus).toBe(1); // per-session fallback
  expect(emitted).toEqual([{ state: "open" }]);
});

test("single-session floor boundary: 2 sessions for same repo still batch", async () => {
  // regression guard: count=2 is the break-even point — must not be floored
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  store.create({ ...baseSession, branch: "shepherd/b" });
  const { forge, stats } = forgeWithBatch({ "shepherd/a": OPEN, "shepherd/b": NONE }, { count: 1 });
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
  );

  await poller.tick();
  expect(stats.count).toBe(1); // count=2 passes floor → count probe runs
  expect(stats.list).toBe(1); // batch list called
  expect(stats.prStatus).toBe(0); // no per-session calls
});

test("cap-hit: countOpenPrs≥200 forces per-session regardless of ratio", async () => {
  // 3 sessions + batchOpenRatio=1000 → ratio gate (200 > 1000×3=3000) cannot trip;
  // only the explicit p≥200 cap-hit clause forces per-session here.
  const store = new SessionStore(":memory:");
  for (let i = 0; i < 3; i++) store.create({ ...baseSession, branch: `shepherd/${i}` });
  const { forge, stats } = forgeWithBatch(
    { "shepherd/0": OPEN, "shepherd/1": OPEN, "shepherd/2": OPEN },
    {
      count: 200,
      prStatusByBranch: { "shepherd/0": OPEN, "shepherd/1": OPEN, "shepherd/2": OPEN },
    },
  );
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true,
    () => false,
    300_000,
    300_000,
    1000, // very high batchOpenRatio — only p≥200 can force per-session here
  );

  await poller.tick();
  expect(stats.count).toBe(1); // count probe ran (count=3 passes floor)
  expect(stats.list).toBe(0); // cap-hit (p=200 ≥ 200) → no list
  expect(stats.prStatus).toBe(3); // per-session for all 3 sessions
});

// ── Task C: snapshot-backed batch ─────────────────────────────────────────────

/** Minimal fake OpenPrSnapshotService for snapshot-path tests. */
function fakeSnapshotSvc(statuses: Map<string, PrStatus>): {
  svc: {
    refresh: (forge: GitForge) => Promise<any>;
    get: (forge: GitForge) => Promise<any>;
    peek: (forge: GitForge) => any;
  };
  calls: { refresh: number; get: number };
} {
  const calls = { refresh: 0, get: 0 };
  const svc = {
    refresh: async () => {
      calls.refresh++;
      return { prs: [], statuses, capped: false };
    },
    get: async () => {
      calls.get++;
      return null;
    },
    peek: () => null,
  };
  return { svc, calls };
}

/** Forge with listOpenPrSnapshot (not listOpenPrStatuses) + countOpenPrs. */
function forgeWithSnapshot(
  openByBranch: Record<string, PrStatus>,
  opts: { isFork?: boolean; count?: number; slug?: string } = {},
): { forge: GitForge; stats: { count: number; prStatus: number } } {
  const stats = { count: 0, prStatus: 0 };
  const statusMap = new Map(Object.entries(openByBranch));
  const forge: GitForge = {
    kind: "github",
    slug: opts.slug ?? "o/r",
    mergeMethod: "squash",
    deployWorkflow: null,
    isFork: opts.isFork,
    listIssues: async () => [],
    listPullRequests: async () => [],
    listBacklogCounts: async () => EMPTY_BACKLOG_COUNTS,
    prStatus: async (head: string) => {
      stats.prStatus++;
      return openByBranch[head] ?? NONE;
    },
    listOpenPrSnapshot: async () => ({ prs: [], statuses: statusMap, capped: false }),
    countOpenPrs: async () => {
      stats.count++;
      return opts.count ?? Object.keys(openByBranch).length;
    },
    openPr: async () => NONE,
    merge: async () => {},
    redeploy: async () => {},
    postReview: async () => ({}),
    defaultBranch: async () => "main",
  };
  return { forge, stats };
}

test("snapshot: poller calls refresh (not get) and results drive session git state", async () => {
  const store = new SessionStore(":memory:");
  const s = store.create(baseSession); // branch shepherd/x
  store.create({ ...baseSession, branch: "shepherd/dummy" }); // count≥2 floor
  const emitted: { id: string; state: string }[] = [];
  const statusMap = new Map<string, PrStatus>([
    ["shepherd/x", OPEN],
    ["shepherd/dummy", NONE],
  ]);
  const { svc, calls } = fakeSnapshotSvc(statusMap);
  const { forge } = forgeWithSnapshot({ "shepherd/x": OPEN, "shepherd/dummy": NONE });
  const poller = new PrPoller(
    store,
    () => forge,
    (id, git) => emitted.push({ id, state: git.state }),
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true,
    () => false,
    300_000,
    300_000,
    2,
    600_000,
    svc as any,
  );

  await poller.tick();
  expect(calls.refresh).toBe(1); // refresh called once (per slug, not per session)
  expect(calls.get).toBe(0); // get never called
  expect(emitted).toContainEqual({ id: s.id, state: "open" }); // state came from refresh's statuses
});

test("snapshot: count-gate trip prevents snapshot.refresh from being called", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  store.create({ ...baseSession, branch: "shepherd/b" }); // count=2, batchOpenRatio=2 (default)
  const { svc, calls } = fakeSnapshotSvc(new Map());
  // count=100 > 2 * 2 = 4 → ratio gate trips → per-session
  const { forge, stats } = forgeWithSnapshot(
    { "shepherd/a": OPEN, "shepherd/b": OPEN },
    { count: 100 },
  );
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true,
    () => false,
    300_000,
    300_000,
    2,
    600_000,
    svc as any,
  );

  await poller.tick();
  expect(calls.refresh).toBe(0); // count-gate → snapshot never touched
  expect(stats.prStatus).toBe(2); // per-session fallback for both sessions
});

test("snapshot: fork mode never calls snapshot.refresh", async () => {
  const store = new SessionStore(":memory:");
  store.create({ ...baseSession, branch: "shepherd/a" });
  store.create({ ...baseSession, branch: "shepherd/b" }); // count=2 so fork gate (not count gate) fires
  const { svc, calls } = fakeSnapshotSvc(new Map());
  const { forge, stats } = forgeWithSnapshot(
    { "shepherd/a": OPEN, "shepherd/b": OPEN },
    { isFork: true },
  );
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true,
    () => false,
    300_000,
    300_000,
    2,
    600_000,
    svc as any,
  );

  await poller.tick();
  expect(calls.refresh).toBe(0); // isFork → always per-session
  expect(stats.prStatus).toBe(2); // per-session for both sessions
});

test("snapshot: single-session repo (count<2) never calls snapshot.refresh", async () => {
  const store = new SessionStore(":memory:");
  store.create(baseSession); // only one session → count=1 < 2 floor
  const { svc, calls } = fakeSnapshotSvc(new Map());
  const { forge, stats } = forgeWithSnapshot({ "shepherd/x": OPEN });
  const poller = new PrPoller(
    store,
    () => forge,
    () => {},
    120_000,
    1000,
    () => null,
    15_000,
    () => true,
    () => true,
    () => false,
    300_000,
    300_000,
    2,
    600_000,
    svc as any,
  );

  await poller.tick();
  expect(calls.refresh).toBe(0); // count<2 → per-session, no snapshot call
  expect(stats.prStatus).toBe(1); // per-session fallback
});
