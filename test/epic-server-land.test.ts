/**
 * Tests for POST /api/epics/completed/land
 *
 * Mirrors the style of epic-server.test.ts (completedHarness pattern).
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { makeApp, type AppDeps } from "../src/server";
import { SessionStore } from "../src/store";
import { EventHub } from "../src/events";
import { config } from "../src/config";
import type { PrStatus } from "../src/forge/types";

let tmpRoot: string;
let repoDir: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(config.repoRoot, "shepherd-land-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir);
});
afterEach(() => rmSync(tmpRoot, { recursive: true, force: true }));

type FakeMergeInput = { prNumber: number; method: string; deleteBranch: boolean };

function makeForge(opts?: {
  prStatusResult?: PrStatus;
  prStatusThrows?: Error;
  mergeThrows?: Error;
}): {
  forge: any;
  mergeCalls: FakeMergeInput[];
} {
  const mergeCalls: FakeMergeInput[] = [];
  const defaultPrStatus: PrStatus = {
    state: "open",
    checks: "success",
    mergeable: true,
    mergeStateStatus: "clean",
    deployConfigured: false,
  };
  const forge: any = {
    // Host-configured merge method — set to "squash" so the happy-path test proves the handler
    // uses forge.mergeMethod (not a hardcoded "merge", which would 405 on a squash-only repo).
    mergeMethod: "squash",
    prStatus: async () => {
      if (opts?.prStatusThrows) throw opts.prStatusThrows;
      return opts?.prStatusResult ?? defaultPrStatus;
    },
    merge: async (prNumber: number, o: { method: string; deleteBranch: boolean }) => {
      if (opts?.mergeThrows) throw opts.mergeThrows;
      mergeCalls.push({ prNumber, method: o.method, deleteBranch: o.deleteBranch });
    },
  };
  return { forge, mergeCalls };
}

function landHarness(resolveForge?: AppDeps["resolveForge"]): {
  app: ReturnType<typeof makeApp>;
  store: SessionStore;
  epicCompletedEmitted: unknown[];
} {
  const store = new SessionStore(":memory:");
  const epicCompletedEmitted: unknown[] = [];
  const events = new EventHub();
  events.subscribe((event, data) => {
    if (event === "epic:completed") epicCompletedEmitted.push(data);
  });

  const drain: AppDeps["drain"] = {
    snapshot: async () => [],
    queue: async () => [],
    retainClaim: () => {},
    buildEpic: async () => null,
    diagnoseEpic: async () => null,
    approveEpicNext: () => {},
    tick: async () => {},
  };

  const deps: AppDeps = {
    store,
    service: {} as AppDeps["service"],
    events,
    usageLimits: { limits: () => ({}) } as any,
    drain,
    resolveForge,
  };
  return { app: makeApp(deps), store, epicCompletedEmitted };
}

function seedCompletedEpic(
  store: SessionStore,
  dir: string,
  parent: number,
  landingState: "pending" | "open" | "merged" | "none" | "error" = "open",
  prNumber: number | null = 77,
) {
  store.recordEpicCompleted({
    repoPath: dir,
    parentIssueNumber: parent,
    parentTitle: `Epic #${parent}`,
    completedAt: 1000,
    childrenJson: JSON.stringify([
      {
        number: 1,
        title: "C1",
        url: "u1",
        prNumber: 10,
        prUrl: "pu10",
        mergedAt: 900,
        integrated: true,
      },
    ]),
  });
  if (landingState !== "pending" || prNumber !== null) {
    store.setEpicLandingPr(dir, parent, {
      state: landingState,
      prNumber,
      prUrl: prNumber ? `https://example/pr/${prNumber}` : null,
      attempts: 0,
    });
  }
}

// ── POST /api/epics/completed/land ────────────────────────────────────────────

describe("POST /api/epics/completed/land", () => {
  test("invalid repo → 400", async () => {
    const { app } = landHarness();
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: "/nope/not/here", parent: 5 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("non-positive parent → 400", async () => {
    const { app } = landHarness();
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 0 }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("non-integer parent → 400", async () => {
    const { app } = landHarness();
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: "abc" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("missing row → 409 no completed epic", async () => {
    const { app } = landHarness(() => null);
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no completed epic" });
  });

  test("landingState=pending → 409 landing not open", async () => {
    const { app, store } = landHarness(() => null);
    seedCompletedEpic(store, repoDir, 42, "pending", null);
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "landing not open" });
  });

  test("landingState=merged → 409 landing not open", async () => {
    const { app, store } = landHarness(() => null);
    seedCompletedEpic(store, repoDir, 42, "merged", 77);
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "landing not open" });
  });

  test("no forge → 409 no forge", async () => {
    const { app, store } = landHarness(() => null);
    seedCompletedEpic(store, repoDir, 42, "open", 77);
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no forge" });
  });

  test("no integration branch pinned → 409", async () => {
    const { forge } = makeForge();
    const { app, store } = landHarness(() => forge);
    seedCompletedEpic(store, repoDir, 42, "open", 77);
    // No epic_branch row seeded → getEpicIntegrationBranch returns null
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no integration branch" });
  });

  test("PR not ready (blocked mergeStateStatus) → 409, forge.merge NOT called", async () => {
    const { forge, mergeCalls } = makeForge({
      prStatusResult: {
        state: "open",
        checks: "success",
        mergeable: true,
        mergeStateStatus: "blocked",
        deployConfigured: false,
      },
    });
    const { app, store } = landHarness(() => forge);
    seedCompletedEpic(store, repoDir, 42, "open", 77);
    store.getOrInitEpicIntegrationBranch(repoDir, 42, "epic/42-my-epic");
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "landing PR not ready" });
    expect(mergeCalls).toHaveLength(0);
  });

  test("prStatus throws → 502 with a generic message, not the raw error (CodeQL #14)", async () => {
    const { forge } = makeForge({ prStatusThrows: new Error("network failure at 10.0.0.5:6443") });
    const { app, store } = landHarness(() => forge);
    seedCompletedEpic(store, repoDir, 42, "open", 77);
    store.getOrInitEpicIntegrationBranch(repoDir, 42, "epic/42-my-epic");
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("landing PR status check failed");
    expect(body.error).not.toContain("10.0.0.5"); // raw error/stack never leaks to the client
  });

  test("forge.merge throws → 502 with a generic message, not the raw error (CodeQL #14)", async () => {
    const { forge } = makeForge({
      mergeThrows: new Error("merge commits disabled at /srv/secret"),
    });
    const { app, store } = landHarness(() => forge);
    seedCompletedEpic(store, repoDir, 42, "open", 77);
    store.getOrInitEpicIntegrationBranch(repoDir, 42, "epic/42-my-epic");
    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("landing merge failed");
    expect(body.error).not.toContain("/srv/secret"); // raw error/stack never leaks to the client
  });

  test("happy path: forge.merge called with the host mergeMethod + deleteBranch, setEpicLandingPr state merged, epic:completed emitted, 200 ok", async () => {
    const { forge, mergeCalls } = makeForge();
    const { app, store, epicCompletedEmitted } = landHarness(() => forge);
    seedCompletedEpic(store, repoDir, 42, "open", 77);
    store.getOrInitEpicIntegrationBranch(repoDir, 42, "epic/42-my-epic");

    const res = await app.fetch(
      new Request("http://x/api/epics/completed/land", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo: repoDir, parent: 42 }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // merge was called with the host-configured method (forge.mergeMethod = "squash"), not a hardcoded "merge"
    expect(mergeCalls).toHaveLength(1);
    expect(mergeCalls[0]).toEqual({ prNumber: 77, method: "squash", deleteBranch: true });

    // store updated to merged
    const updated = store.listEpicCompleted(repoDir).find((r) => r.parentIssueNumber === 42);
    expect(updated?.landingState).toBe("merged");

    // epic:completed emitted
    expect(epicCompletedEmitted).toHaveLength(1);
    const emitted = epicCompletedEmitted[0] as any;
    expect(emitted.landingState).toBe("merged");
    expect(emitted.parentIssueNumber).toBe(42);
  });
});
