import { test, expect, mock } from "bun:test";
import {
  recordEpicIntegrationIfChild,
  settleMergedSession,
  type EpicIntegrationStore,
  type MergeTeardownDeps,
} from "../src/merge-teardown";

function deps(over: Partial<MergeTeardownDeps> = {}): MergeTeardownDeps {
  return {
    resolveForge: () => ({ closeIssue: mock(async () => {}) }) as any,
    archive: mock(async () => 1),
    dropPrCache: mock(() => {}),
    emitArchived: mock(() => {}),
    retainClaim: mock(() => {}),
    isIntegratedEpicChild: () => false,
    ...over,
  };
}

test("auto session with issue: closes issue, archives, does NOT retain claim", async () => {
  const d = deps();
  await settleMergedSession({ id: "s1", auto: true, issueNumber: 9, repoPath: "/r" } as any, d);
  expect((d.archive as any).mock.calls).toEqual([["s1", "merged"]]);
  expect((d.retainClaim as any).mock.calls.length).toBe(0);
});

test("closeIssue throws → retain claim (issue still open)", async () => {
  const d = deps({
    resolveForge: () =>
      ({
        closeIssue: async () => {
          throw new Error("x");
        },
      }) as any,
  });
  await settleMergedSession({ id: "s1", auto: true, issueNumber: 9, repoPath: "/r" } as any, d);
  expect((d.retainClaim as any).mock.calls).toEqual([["s1"]]);
  expect((d.archive as any).mock.calls.length).toBe(1);
});

test("integrated epic child: archives + retains claim, NEVER closes the issue (#1037)", async () => {
  const close = mock(async () => {});
  const d = deps({
    resolveForge: () => ({ closeIssue: close }) as any,
    isIntegratedEpicChild: () => true,
  });
  await settleMergedSession({ id: "s1", auto: true, issueNumber: 12, repoPath: "/r" } as any, d);
  expect(close.mock.calls.length).toBe(0); // close reserved for the landing PR merge
  expect((d.retainClaim as any).mock.calls).toEqual([["s1"]]); // still-open issue must not re-spawn
  expect((d.archive as any).mock.calls).toEqual([["s1", "merged"]]);
});

test("manual session (no issue): archives, no close, no retain", async () => {
  const close = mock(async () => {});
  const d = deps({ resolveForge: () => ({ closeIssue: close }) as any });
  await settleMergedSession({ id: "s1", auto: false, issueNumber: null, repoPath: "/r" } as any, d);
  expect(close.mock.calls.length).toBe(0);
  expect((d.archive as any).mock.calls.length).toBe(1);
  expect((d.retainClaim as any).mock.calls.length).toBe(0);
});

// ── recordEpicIntegrationIfChild (#1401) ─────────────────────────────────────

const PINNED = "epic/7-thing";

function recStore(over: Partial<Record<keyof EpicIntegrationStore, unknown>> = {}) {
  return {
    getEpicRun: mock(() => ({
      repoPath: "/r",
      parentIssueNumber: 7,
      mode: "autonomous",
      status: "running",
    })),
    getEpicIntegrationBranch: mock(() => PINNED),
    recordEpicIntegrated: mock(() => {}),
    ...over,
  } as unknown as EpicIntegrationStore;
}

function child(over: Record<string, unknown> = {}) {
  return { id: "s1", issueNumber: 12, repoPath: "/r", baseBranch: PINNED, ...over } as any;
}

test("record: merged child PR on the pinned base records (with PR facts)", async () => {
  const store = recStore();
  await recordEpicIntegrationIfChild(
    child(),
    { number: 44, url: "http://pr/44", baseRefName: PINNED },
    { store },
  );
  expect((store.recordEpicIntegrated as any).mock.calls).toEqual([
    ["/r", 7, 12, { number: 44, url: "http://pr/44" }, PINNED],
  ]);
});

test("record: NOT gated on s.auto — a manual (auto=0) session records too", async () => {
  const store = recStore();
  await recordEpicIntegrationIfChild(
    child({ auto: false }),
    { number: 44, url: "u", baseRefName: PINNED },
    { store },
  );
  expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(1);
});

test("no-op: session without an issueNumber", async () => {
  const store = recStore();
  await recordEpicIntegrationIfChild(
    child({ issueNumber: null }),
    { number: 44, baseRefName: PINNED },
    { store },
  );
  expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(0);
});

test("no-op: no epic run / idle epic run", async () => {
  for (const run of [null, { repoPath: "/r", parentIssueNumber: 7, mode: "a", status: "idle" }]) {
    const store = recStore({ getEpicRun: mock(() => run) });
    await recordEpicIntegrationIfChild(child(), { number: 44, baseRefName: PINNED }, { store });
    expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(0);
  }
});

test("record: paused epic still records (mirrors the retire path's epicActive)", async () => {
  const store = recStore({
    getEpicRun: mock(() => ({ repoPath: "/r", parentIssueNumber: 7, mode: "a", status: "paused" })),
  });
  await recordEpicIntegrationIfChild(child(), { number: 44, baseRefName: PINNED }, { store });
  expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(1);
});

test("no-op: unpinned integration branch", async () => {
  const store = recStore({ getEpicIntegrationBranch: mock(() => null) });
  await recordEpicIntegrationIfChild(child(), { number: 44, baseRefName: PINNED }, { store });
  expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(0);
});

test("no-op: base mismatch, incl. a divergent epic/* base (fail-closed)", async () => {
  for (const base of ["main", "epic/7-old-title"]) {
    const store = recStore();
    await recordEpicIntegrationIfChild(child(), { number: 44, baseRefName: base }, { store });
    expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(0);
  }
});

test("fallback: missing baseRefName resolves via number-keyed prReviewMeta", async () => {
  const store = recStore();
  const forge = { prReviewMeta: mock(async () => ({ baseRefName: PINNED })) } as any;
  await recordEpicIntegrationIfChild(child(), { number: 44, url: "u" }, { store, forge });
  expect(forge.prReviewMeta.mock.calls).toEqual([[44]]);
  expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(1);
});

test("fail closed: base-capable forge with unresolvable base does NOT record", async () => {
  // prReviewMeta returns null (PR not found) and prReviewMeta throws — both no-record.
  for (const meta of [async () => null, async () => Promise.reject(new Error("api down"))]) {
    const store = recStore();
    await recordEpicIntegrationIfChild(
      child(),
      { number: 44 },
      { store, forge: { prReviewMeta: meta } as any },
    );
    expect((store.recordEpicIntegrated as any).mock.calls.length).toBe(0);
  }
});

test("carve-out: base-incapable forge (no prReviewMeta) trusts s.baseBranch", async () => {
  const store = recStore();
  await recordEpicIntegrationIfChild(
    child(),
    { number: 44, url: "u" },
    { store, forge: {} as any },
  );
  expect((store.recordEpicIntegrated as any).mock.calls).toEqual([
    ["/r", 7, 12, { number: 44, url: "u" }, PINNED],
  ]);
  // ...and still fails closed when the session's base is not the pinned branch.
  const store2 = recStore();
  await recordEpicIntegrationIfChild(
    child({ baseBranch: "main" }),
    { number: 44 },
    { store: store2, forge: {} as any },
  );
  expect((store2.recordEpicIntegrated as any).mock.calls.length).toBe(0);
});

test("never throws: a throwing store is swallowed (best-effort)", async () => {
  const store = recStore({
    getEpicRun: mock(() => {
      throw new Error("db locked");
    }),
  });
  await recordEpicIntegrationIfChild(child(), { number: 44, baseRefName: PINNED }, { store });
});
