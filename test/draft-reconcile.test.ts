import { test, expect, mock } from "bun:test";
import { DraftReconcileService, type DraftReconcileDeps } from "../src/draft-reconcile";
import type { GitState } from "../src/forge/types";

// ── helpers ──────────────────────────────────────────────────────────────────

function baseSession(over: Record<string, unknown> = {}) {
  return {
    id: "s1",
    desig: "TASK-01",
    repoPath: "/r",
    status: "idle",
    ...over,
  };
}

function baseGit(over: Partial<GitState> = {}): GitState {
  return {
    kind: "github",
    state: "open",
    checks: "success",
    number: 42,
    headSha: "abc123",
    isDraft: false,
    deployConfigured: false,
    ...over,
  };
}

function baseReview(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    headSha: "abc123",
    decision: "commented" as const,
    findings: [] as string[],
    body: "",
    addressRound: 0,
    ...over,
  };
}

function makeDeps(over: Partial<DraftReconcileDeps> = {}): DraftReconcileDeps {
  return {
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () =>
        ({
          draftMode: false,
          signoffAuthority: "human",
          criticEnabled: false,
          autoMergeEnabled: false,
          autopilotEnabled: false,
          autoDrainEnabled: false,
          autoAddressEnabled: false,
          learningsEnabled: false,
          buildQueueEnabled: false,
          maxAuto: 0,
          autoLabel: null,
          usageCeilingPct: null,
          rebaseCap: 5,
        }) as any,
      getReview: () => null,
    } as any,
    resolveForge: () =>
      ({
        kind: "github",
        markReady: mock(async () => {}),
        convertToDraft: mock(async () => {}),
      }) as any,
    prCache: {
      snapshot: () => ({
        s1: baseGit({
          isDraft: true,
          latestReview: { state: "approved", author: "human", submittedAt: 1 },
        }),
      }),
    },
    pollSession: mock(() => {}),
    emitStatus: mock(() => {}),
    ...over,
  };
}

// ── tests ─────────────────────────────────────────────────────────────────────

test("open draft + human approved → markReady called; pollSession called; no error status", async () => {
  const markReady = mock(async () => {});
  const emitStatus = mock(() => {});
  const pollSession = mock(() => {});
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady, convertToDraft: mock(async () => {}) }) as any,
    prCache: {
      snapshot: () => ({
        s1: baseGit({
          isDraft: true,
          latestReview: { state: "approved", author: "human", submittedAt: 1 },
        }),
      }),
    },
    emitStatus,
    pollSession,
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(1);
  expect((markReady.mock.calls[0] as any)[0]).toBe(42);
  expect(pollSession.mock.calls.length).toBe(1);
  // emitStatus should emit state: null (cleared/ok)
  expect(emitStatus.mock.calls.length).toBe(1);
  expect((emitStatus.mock.calls[0] as any)[0].state).toBeNull();
});

test("open draft + signed + draftMode OFF → STILL markReady (promote is flag-independent)", async () => {
  const markReady = mock(async () => {});
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady, convertToDraft: mock(async () => {}) }) as any,
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () => ({ draftMode: false, signoffAuthority: "human" }) as any,
      getReview: () => null,
    } as any,
    prCache: {
      snapshot: () => ({
        s1: baseGit({
          isDraft: true,
          latestReview: { state: "approved", author: "human", submittedAt: 1 },
        }),
      }),
    },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(1);
});

test("open non-draft + unsigned + draftMode ON → convertToDraft called; status cleared", async () => {
  const convertToDraft = mock(async () => {});
  const emitStatus = mock(() => {});
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady: mock(async () => {}), convertToDraft }) as any,
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () => ({ draftMode: true, signoffAuthority: "human" }) as any,
      getReview: () => null,
    } as any,
    prCache: { snapshot: () => ({ s1: baseGit({ isDraft: false }) }) },
    emitStatus,
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(convertToDraft.mock.calls.length).toBe(1);
  expect((convertToDraft.mock.calls[0] as any)[0]).toBe(42);
  // success clears any prior enforce_error (symmetric with promote)
  expect(emitStatus.mock.calls.length).toBe(1);
  expect((emitStatus.mock.calls[0] as any)[0].state).toBeNull();
});

test("concurrent reconciles for the same session run the forge op once (re-entrancy guard)", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const markReady = mock(async () => {
    await gate; // hold the first call open so the second overlaps
  });
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady, convertToDraft: mock(async () => {}) }) as any,
  });
  const svc = new DraftReconcileService(d);
  const first = svc.onGit("s1"); // enters, awaits the gate (still in reconciling set)
  const second = svc.onGit("s1"); // should bail on the re-entrancy guard
  release();
  await Promise.all([first, second]);
  expect(markReady.mock.calls.length).toBe(1);
});

test("open non-draft + unsigned + draftMode OFF → neither markReady nor convertToDraft", async () => {
  const markReady = mock(async () => {});
  const convertToDraft = mock(async () => {});
  const d = makeDeps({
    resolveForge: () => ({ kind: "github", markReady, convertToDraft }) as any,
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () => ({ draftMode: false, signoffAuthority: "human" }) as any,
      getReview: () => null,
    } as any,
    prCache: { snapshot: () => ({ s1: baseGit({ isDraft: false }) }) },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
  expect(convertToDraft.mock.calls.length).toBe(0);
});

test("open non-draft + signed → no-op", async () => {
  const markReady = mock(async () => {});
  const convertToDraft = mock(async () => {});
  const d = makeDeps({
    resolveForge: () => ({ kind: "github", markReady, convertToDraft }) as any,
    prCache: {
      snapshot: () => ({
        s1: baseGit({
          isDraft: false,
          latestReview: { state: "approved", author: "human", submittedAt: 1 },
        }),
      }),
    },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
  expect(convertToDraft.mock.calls.length).toBe(0);
});

test("open draft + unsigned → no-op", async () => {
  const markReady = mock(async () => {});
  const convertToDraft = mock(async () => {});
  const d = makeDeps({
    resolveForge: () => ({ kind: "github", markReady, convertToDraft }) as any,
    prCache: {
      snapshot: () => ({ s1: baseGit({ isDraft: true }) }),
    },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
  expect(convertToDraft.mock.calls.length).toBe(0);
});

test("critic authority: clean verdict on current head → markReady (exercises getReview→SignoffView join)", async () => {
  const markReady = mock(async () => {});
  const headSha = "deadbeef";
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady, convertToDraft: mock(async () => {}) }) as any,
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () => ({ draftMode: false, signoffAuthority: "critic" }) as any,
      getReview: () => baseReview({ headSha, decision: "commented", findings: [] }) as any,
    } as any,
    prCache: {
      snapshot: () => ({ s1: baseGit({ isDraft: true, headSha }) }),
    },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(1);
});

test("human authority but only a critic-clean verdict → NOT promoted (authority respected)", async () => {
  const markReady = mock(async () => {});
  const headSha = "deadbeef";
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady, convertToDraft: mock(async () => {}) }) as any,
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () => ({ draftMode: false, signoffAuthority: "human" }) as any,
      getReview: () => baseReview({ headSha, decision: "commented", findings: [] }) as any,
    } as any,
    prCache: {
      // latestReview is undefined → humanApproved = false
      snapshot: () => ({ s1: baseGit({ isDraft: true, headSha }) }),
    },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
});

test("forge.markReady throws → emitStatus promote_error; no rethrow; markReady was attempted", async () => {
  const markReady = mock(async () => {
    throw new Error("network error");
  });
  const emitStatus = mock(() => {});
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady, convertToDraft: mock(async () => {}) }) as any,
    prCache: {
      snapshot: () => ({
        s1: baseGit({
          isDraft: true,
          latestReview: { state: "approved", author: "human", submittedAt: 1 },
        }),
      }),
    },
    emitStatus,
  });
  const svc = new DraftReconcileService(d);
  // Should not throw.
  await expect(svc.onGit("s1")).resolves.toBeUndefined();
  expect(markReady.mock.calls.length).toBe(1);
  expect(emitStatus.mock.calls.length).toBe(1);
  expect((emitStatus.mock.calls[0] as any)[0].state).toBe("promote_error");
});

test("forge.convertToDraft throws → emitStatus enforce_error; no rethrow", async () => {
  const convertToDraft = mock(async () => {
    throw new Error("api down");
  });
  const emitStatus = mock(() => {});
  const d = makeDeps({
    resolveForge: () =>
      ({ kind: "github", markReady: mock(async () => {}), convertToDraft }) as any,
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () => ({ draftMode: true, signoffAuthority: "human" }) as any,
      getReview: () => null,
    } as any,
    prCache: { snapshot: () => ({ s1: baseGit({ isDraft: false }) }) },
    emitStatus,
  });
  const svc = new DraftReconcileService(d);
  await expect(svc.onGit("s1")).resolves.toBeUndefined();
  expect(convertToDraft.mock.calls.length).toBe(1);
  expect(emitStatus.mock.calls.length).toBe(1);
  expect((emitStatus.mock.calls[0] as any)[0].state).toBe("enforce_error");
});

test("forge without markReady → graceful no-op on promote", async () => {
  const convertToDraft = mock(async () => {});
  const d = makeDeps({
    // markReady is absent
    resolveForge: () => ({ kind: "github", convertToDraft }) as any,
    prCache: {
      snapshot: () => ({
        s1: baseGit({
          isDraft: true,
          latestReview: { state: "approved", author: "human", submittedAt: 1 },
        }),
      }),
    },
  });
  const svc = new DraftReconcileService(d);
  await expect(svc.onGit("s1")).resolves.toBeUndefined();
  expect(convertToDraft.mock.calls.length).toBe(0);
});

test("forge without convertToDraft → graceful no-op on enforce", async () => {
  const markReady = mock(async () => {});
  const d = makeDeps({
    // convertToDraft is absent
    resolveForge: () => ({ kind: "github", markReady }) as any,
    store: {
      get: () => baseSession() as any,
      list: () => [baseSession() as any],
      getRepoConfig: () => ({ draftMode: true, signoffAuthority: "human" }) as any,
      getReview: () => null,
    } as any,
    prCache: { snapshot: () => ({ s1: baseGit({ isDraft: false }) }) },
  });
  const svc = new DraftReconcileService(d);
  await expect(svc.onGit("s1")).resolves.toBeUndefined();
  expect(markReady.mock.calls.length).toBe(0);
});

test("PR not open → no forge calls", async () => {
  const markReady = mock(async () => {});
  const convertToDraft = mock(async () => {});
  const d = makeDeps({
    resolveForge: () => ({ kind: "github", markReady, convertToDraft }) as any,
    prCache: { snapshot: () => ({ s1: baseGit({ state: "merged" }) }) },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
  expect(convertToDraft.mock.calls.length).toBe(0);
});

test("no PR number → no forge calls", async () => {
  const markReady = mock(async () => {});
  const d = makeDeps({
    resolveForge: () => ({ kind: "github", markReady }) as any,
    prCache: { snapshot: () => ({ s1: baseGit({ number: undefined }) }) },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
});

test("archived session → no forge calls", async () => {
  const markReady = mock(async () => {});
  const d = makeDeps({
    resolveForge: () => ({ kind: "github", markReady }) as any,
    store: {
      get: () => baseSession({ status: "archived" }) as any,
      list: () => [],
      getRepoConfig: () => ({ draftMode: false, signoffAuthority: "human" }) as any,
      getReview: () => null,
    } as any,
    prCache: {
      snapshot: () => ({
        s1: baseGit({
          isDraft: true,
          latestReview: { state: "approved", author: "human", submittedAt: 1 },
        }),
      }),
    },
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
});

test("session not in store → no forge calls", async () => {
  const markReady = mock(async () => {});
  const d = makeDeps({
    resolveForge: () => ({ kind: "github", markReady }) as any,
    store: {
      get: () => undefined as any,
      list: () => [],
      getRepoConfig: () => ({ draftMode: false, signoffAuthority: "human" }) as any,
      getReview: () => null,
    } as any,
  });
  const svc = new DraftReconcileService(d);
  await svc.onGit("s1");
  expect(markReady.mock.calls.length).toBe(0);
});
