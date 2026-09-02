import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import { DeliveryFactsService } from "../src/delivery";
import type { GitState } from "../src/forge/types";

const base = {
  name: "feature",
  prompt: "do it",
  repoPath: "/repos/alpha",
  baseBranch: "main",
  branch: "shepherd/feature",
  worktreePath: "/wt",
  isolated: true,
  herdrSession: "default",
  herdrAgentId: "term_1",
};

function git(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    number: 42,
    checks: "success",
    deployConfigured: false,
    ...over,
  } as GitState;
}

function harness(now = 5_000) {
  const store = new SessionStore(":memory:");
  const svc = new DeliveryFactsService({ store, now: () => now });
  return { store, svc };
}

test("records prOpenedAt and the PR number from an observed open PR", () => {
  const { store, svc } = harness();
  const s = store.create(base);
  svc.onGit(s.id, git({ createdAt: 1234 }));
  const [fact] = store.listMergedDeliveryFacts(0);
  expect(fact).toBeUndefined(); // not merged yet
  expect(store.earliestDeliveryFactAt()).toBe(s.createdAt);
});

test("a PR-less session records nothing", () => {
  const { store, svc } = harness();
  const s = store.create(base);
  svc.onGit(s.id, git({ state: "none", number: undefined, createdAt: undefined }));
  expect(store.earliestDeliveryFactAt()).toBeNull();
});

test("an observed merge stamps mergedAt", () => {
  const { store, svc } = harness(9_000);
  const s = store.create(base);
  svc.onGit(s.id, git({ createdAt: 1234 }));
  svc.onGit(s.id, git({ state: "merged", createdAt: 1234 }));
  const [fact] = store.listMergedDeliveryFacts(0);
  expect(fact!.mergedAt).toBe(9_000);
  expect(fact!.prOpenedAt).toBe(1234);
  expect(fact!.prNumber).toBe(42);
  expect(fact!.repoPath).toBe("/repos/alpha");
});

test("replayed events are idempotent and first-write-wins", () => {
  const store = new SessionStore(":memory:");
  let now = 1_000;
  const svc = new DeliveryFactsService({ store, now: () => now });
  const s = store.create(base);
  svc.onGit(s.id, git({ state: "merged", createdAt: 100 }));
  // Boot warm-tick replay, later clock: must NOT move the recorded merge later.
  now = 50_000;
  svc.forget(s.id); // simulate a restart dropping the in-memory stamp state
  svc.onGit(s.id, git({ state: "merged", createdAt: 100 }));
  const [fact] = store.listMergedDeliveryFacts(0);
  expect(fact!.mergedAt).toBe(1_000);
});

test("steady-state polling writes nothing after the facts are stamped", () => {
  const store = new SessionStore(":memory:");
  let writes = 0;
  const svc = new DeliveryFactsService({
    store: {
      get: (id: string) => store.get(id),
      upsertDeliveryFact: (f) => {
        writes += 1;
        store.upsertDeliveryFact(f);
      },
    },
    now: () => 5_000,
  });
  const s = store.create(base);
  for (let i = 0; i < 10; i++) svc.onGit(s.id, git({ createdAt: 100 }));
  expect(writes).toBe(1);
  // A state change to merged is new information → exactly one more write, then quiet again.
  for (let i = 0; i < 10; i++) svc.onGit(s.id, git({ state: "merged", createdAt: 100 }));
  expect(writes).toBe(2);
});

test("a store failure never escapes onGit", () => {
  const svc = new DeliveryFactsService({
    store: {
      get: () => ({ id: "x", repoPath: "/r", desig: "TASK-01", createdAt: 1 }) as never,
      upsertDeliveryFact: () => {
        throw new Error("db down");
      },
    },
  });
  expect(() => svc.onGit("x", git({ createdAt: 1 }))).not.toThrow();
});

test("an unknown session is skipped", () => {
  const { store, svc } = harness();
  svc.onGit("ghost", git({ createdAt: 1 }));
  expect(store.earliestDeliveryFactAt()).toBeNull();
});

// ── the merge-train path: archive stamps mergedAt with NO session:git event ──

test("archive(id,'merged') stamps mergedAt even though the train emits no git event", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(base);
  // No DeliveryFactsService involvement at all — this is the AutoMergeService →
  // settleMergedSession path, which archives and drops the session from the PR poller.
  store.archive(s.id, "merged");
  const [fact] = store.listMergedDeliveryFacts(0);
  expect(fact).toBeDefined();
  expect(fact!.sessionId).toBe(s.id);
  expect(fact!.repoPath).toBe("/repos/alpha");
  expect(fact!.desig).toBe(s.desig);
  expect(fact!.createdAt).toBe(s.createdAt);
  expect(fact!.mergedAt).toBeGreaterThan(0);
});

test("archive for any other reason records no merge", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(base);
  store.archive(s.id, "operator");
  expect(store.listMergedDeliveryFacts(0)).toEqual([]);
  expect(store.earliestDeliveryFactAt()).toBeNull();
});

test("archive keeps an earlier poller-observed merge time", () => {
  const store = new SessionStore(":memory:");
  const svc = new DeliveryFactsService({ store, now: () => 1_000 });
  const s = store.create(base);
  svc.onGit(s.id, git({ state: "merged", createdAt: 100 }));
  store.archive(s.id, "merged"); // settle runs later; must not overwrite
  expect(store.listMergedDeliveryFacts(0)[0]!.mergedAt).toBe(1_000);
});

test("delivery facts survive the archived-session prune", () => {
  const store = new SessionStore(":memory:");
  const s = store.create(base);
  store.archive(s.id, "merged");
  const removed = store.pruneArchivedSessions({ maxAgeMs: -1, keepNewest: 0 });
  expect(removed).toBe(1);
  expect(store.get(s.id)).toBeNull();
  expect(store.listMergedDeliveryFacts(0).length).toBe(1);
});

test("pruneDeliveryFacts drops rows by session age", () => {
  const store = new SessionStore(":memory:");
  store.upsertDeliveryFact({
    sessionId: "old",
    repoPath: "/r",
    desig: "TASK-01",
    issueNumber: null,
    createdAt: 1_000,
    mergedAt: 2_000,
    now: 2_000,
  });
  expect(store.pruneDeliveryFacts(1_500)).toBe(1);
  expect(store.listMergedDeliveryFacts(0)).toEqual([]);
});

// ── first-push CI green (#2159) ─────────────────────────────────────────────

/** The fact row for a session, read back through the only public list accessor. Every case here
 *  ends on a merged observation, which is also what the metric requires to count the task. */
function factFor(store: SessionStore, id: string) {
  return store.listMergedDeliveryFacts(0).find((f) => f.sessionId === id);
}

test("a terminal rollup stamps the conclusion and the head it belongs to", () => {
  const { store, svc } = harness();
  const s = store.create(base);
  svc.onGit(s.id, git({ createdAt: 100, headSha: "aaa", checks: "success" }));
  svc.onGit(s.id, git({ state: "merged", createdAt: 100, headSha: "aaa", checks: "success" }));
  const fact = factFor(store, s.id);
  expect(fact!.firstCiConclusion).toBe("success");
  expect(fact!.firstCiHeadSha).toBe("aaa");
});

test("a red first push is retained even after a later head goes green", () => {
  const { store, svc } = harness();
  const s = store.create(base);
  svc.onGit(s.id, git({ createdAt: 100, headSha: "red", checks: "failure" }));
  svc.onGit(s.id, git({ createdAt: 100, headSha: "green", checks: "success" }));
  svc.onGit(s.id, git({ state: "merged", createdAt: 100, headSha: "green", checks: "success" }));
  const fact = factFor(store, s.id);
  expect(fact!.firstCiConclusion).toBe("failure");
  expect(fact!.firstCiHeadSha).toBe("red"); // the sha stays pinned to the retained conclusion
});

test("a re-run turning the SAME head green does not overwrite the conclusion", () => {
  const { store, svc } = harness();
  const s = store.create(base);
  svc.onGit(s.id, git({ createdAt: 100, headSha: "aaa", checks: "failure" }));
  svc.forget(s.id); // a restart drops the in-memory guard; the store must still hold the line
  svc.onGit(s.id, git({ state: "merged", createdAt: 100, headSha: "aaa", checks: "success" }));
  expect(factFor(store, s.id)!.firstCiConclusion).toBe("failure");
});

test("the store freezes the conclusion even when the service is out of the picture", () => {
  const store = new SessionStore(":memory:");
  const row = {
    sessionId: "s1",
    repoPath: "/r",
    desig: "TASK-01",
    issueNumber: null,
    createdAt: 1_000,
    mergedAt: 2_000,
    now: 2_000,
  };
  store.upsertDeliveryFact({ ...row, firstCiHeadSha: "red", firstCiConclusion: "failure" });
  store.upsertDeliveryFact({ ...row, firstCiHeadSha: "green", firstCiConclusion: "success" });
  const fact = factFor(store, "s1");
  expect(fact!.firstCiConclusion).toBe("failure");
  expect(fact!.firstCiHeadSha).toBe("red");
});

test("a non-terminal or CI-less rollup stamps nothing", () => {
  for (const checks of ["pending", "none"] as const) {
    const { store, svc } = harness();
    const s = store.create(base);
    svc.onGit(s.id, git({ state: "merged", createdAt: 100, headSha: "aaa", checks }));
    const fact = factFor(store, s.id);
    expect(fact!.firstCiConclusion).toBeNull();
    expect(fact!.firstCiHeadSha).toBeNull();
  }
});

test("a terminal rollup with no headSha stamps nothing", () => {
  const { store, svc } = harness();
  const s = store.create(base);
  svc.onGit(s.id, git({ state: "merged", createdAt: 100, checks: "success" }));
  expect(factFor(store, s.id)!.firstCiConclusion).toBeNull();
});

test("a CI conclusion alone records a fact for a PR-less-looking payload", () => {
  // `createdAt` can be absent on a payload that predates the field while headSha + checks are
  // present. The conclusion is still new information, so it must not be dropped.
  const { store, svc } = harness();
  const s = store.create(base);
  svc.onGit(s.id, git({ state: "merged", createdAt: undefined, headSha: "aaa" }));
  expect(factFor(store, s.id)!.firstCiConclusion).toBe("success");
});

test("steady-state polling writes nothing once the conclusion is stamped", () => {
  const store = new SessionStore(":memory:");
  let writes = 0;
  const svc = new DeliveryFactsService({
    store: {
      get: (id: string) => store.get(id),
      upsertDeliveryFact: (f) => {
        writes += 1;
        store.upsertDeliveryFact(f);
      },
    },
    now: () => 5_000,
  });
  const s = store.create(base);
  const observed = git({ createdAt: 100, headSha: "aaa", checks: "success" });
  for (let i = 0; i < 10; i++) svc.onGit(s.id, observed);
  expect(writes).toBe(1);
  // A later push whose CI also goes terminal is NOT new information — the conclusion is retained.
  for (let i = 0; i < 10; i++)
    svc.onGit(s.id, git({ createdAt: 100, headSha: "bbb", checks: "failure" }));
  expect(writes).toBe(1);
});
