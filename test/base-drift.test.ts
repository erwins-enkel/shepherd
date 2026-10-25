import { test, expect } from "bun:test";
import {
  BaseDriftService,
  baseMovedSteer,
  MAX_LISTED,
  THROTTLE_MS,
  type BaseDriftDeps,
} from "../src/base-drift";
import type { Session } from "../src/types";

const session = (over: Partial<Session> = {}) =>
  ({
    id: "s1",
    desig: "TASK-01",
    repoPath: "/r",
    baseBranch: "main",
    baseCommit: "base0",
    branch: "shepherd/x",
    worktreePath: "/r/wt",
    isolated: true,
    status: "idle",
    planPhase: null,
    mergingSince: null,
    ...over,
  }) as Session;

function harness(
  sessions: Session[],
  opts: {
    tip?: string | null;
    total?: number;
    delivered?: boolean;
    /** Runs while the commit log is read — the window a session can change in. */
    onMissing?: () => void;
    /** Runs on the pre-steer PR re-poll. */
    onRefresh?: (id: string) => void;
  } = {},
) {
  const notices = new Map<string, { sha: string; notifiedAt: number | null }>();
  const steers: { id: string; text: string }[] = [];
  const fetches: string[] = [];
  const missingCalls: { tip: string; exclude: string | null }[] = [];
  let now = 1_000_000;
  const total = opts.total ?? 2;
  const owned = new Set<string>();
  const prStates = new Map<string, "open" | "merged" | "closed">();
  const refreshed: string[] = [];
  const deps: BaseDriftDeps = {
    store: {
      get: (id) => sessions.find((x) => x.id === id) ?? null,
      list: () => sessions,
      getBaseNotice: (id) => notices.get(id) ?? null,
      setBaseNotice: (id, sha, at) =>
        void notices.set(id, { sha, notifiedAt: at ?? notices.get(id)?.notifiedAt ?? null }),
    },
    git: {
      baseTip: async (repo, base) => {
        fetches.push(`${repo}:${base}`);
        return opts.tip === undefined ? "tip1" : opts.tip;
      },
      missing: async (_s, tip, exclude) => {
        missingCalls.push({ tip, exclude });
        opts.onMissing?.();
        return {
          total,
          lines: Array.from({ length: Math.min(total, 3) }, (_, i) => `c${i} m${i}`),
        };
      },
    },
    steer: async (id, text) => {
      steers.push({ id, text });
      return opts.delivered ?? true;
    },
    rebaseOwned: (s) => owned.has(s.id),
    prState: (id) => prStates.get(id),
    refreshPr: async (id) => {
      refreshed.push(id);
      opts.onRefresh?.(id);
    },
    now: () => now,
  };
  return {
    svc: new BaseDriftService(deps),
    notices,
    steers,
    fetches,
    missingCalls,
    owned,
    prStates,
    refreshed,
    advance: (ms: number) => (now += ms),
  };
}

test("idle session behind its base gets one fenced notice and the anchor advances", async () => {
  const h = harness([session()]);
  await h.svc.sweep();
  expect(h.steers).toHaveLength(1);
  expect(h.steers[0]!.text).toContain("origin/main has 2 new commit(s)");
  expect(h.steers[0]!.text).toContain("⟦UNTRUSTED:base commits:");
  expect(h.steers[0]!.text).toContain("never merge it in");
  expect(h.missingCalls[0]).toEqual({ tip: "tip1", exclude: "base0" });
  expect(h.notices.get("s1")).toEqual({ sha: "tip1", notifiedAt: 1_000_000 });
});

test("no notice while tip equals the anchor", async () => {
  const h = harness([session()], { tip: "base0" });
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
  expect(h.missingCalls).toHaveLength(0);
});

test("running, planning, terminal, non-isolated and rebase-owned sessions are skipped", async () => {
  const sessions = [
    session({ id: "run", status: "running" }),
    session({ id: "plan", planPhase: "planning" }),
    session({ id: "term", terminal: true }),
    session({ id: "shared", isolated: false }),
    session({ id: "nobase", baseCommit: null }),
    session({ id: "owned" }),
  ];
  const h = harness(sessions);
  h.owned.add("owned");
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
  expect(h.fetches).toHaveLength(0);
});

test("a running session is told once it goes idle", async () => {
  const s = session({ status: "running" });
  const h = harness([s]);
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
  s.status = "idle";
  await h.svc.sweep();
  expect(h.steers).toHaveLength(1);
});

test("throttle: at most one notice per 30 min, then the next batches since the last tip", async () => {
  const h = harness([session()]);
  await h.svc.sweep();
  h.advance(THROTTLE_MS - 1);
  await h.svc.sweep();
  expect(h.steers).toHaveLength(1);
  h.advance(1);
  await h.svc.sweep();
  // Same tip as already told → nothing to say.
  expect(h.steers).toHaveLength(1);
});

test("commits already in HEAD advance the anchor silently", async () => {
  const h = harness([session()], { total: 0 });
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
  expect(h.notices.get("s1")).toEqual({ sha: "tip1", notifiedAt: null });
});

test("one fetch per (repo, base) per sweep", async () => {
  const h = harness([
    session({ id: "a" }),
    session({ id: "b" }),
    session({ id: "c", baseBranch: "dev" }),
  ]);
  await h.svc.sweep();
  expect(h.fetches.sort()).toEqual(["/r:dev", "/r:main"]);
  expect(h.steers).toHaveLength(3);
});

test("an undelivered steer keeps the notice pending", async () => {
  const h = harness([session()], { delivered: false });
  await h.svc.sweep();
  expect(h.steers).toHaveLength(1);
  expect(h.notices.get("s1")).toBeUndefined();
});

test("baseMovedSteer truncates the list and counts the rest", () => {
  const lines = Array.from({ length: MAX_LISTED }, (_, i) => `c${i} subject`);
  const text = baseMovedSteer("dev", MAX_LISTED + 5, lines);
  expect(text).toContain("origin/dev has 25 new commit(s)");
  expect(text).toContain("…and 5 more");
});

test("a session whose PR merged or closed is never told to rebase (#2589)", async () => {
  const h = harness([
    session({ id: "merged" }),
    session({ id: "closed" }),
    session({ id: "open" }),
  ]);
  h.prStates.set("merged", "merged");
  h.prStates.set("closed", "closed");
  h.prStates.set("open", "open");
  await h.svc.sweep();
  expect(h.steers.map((s) => s.id)).toEqual(["open"]);
});

test("a PR the cache still reads open is re-polled; merged meanwhile → no steer, nothing recorded", async () => {
  const live = harness([session()], { onRefresh: (id) => live.prStates.set(id, "merged") });
  live.prStates.set("s1", "open");
  await live.svc.sweep();
  expect(live.refreshed).toEqual(["s1"]);
  expect(live.steers).toHaveLength(0);
  expect(live.notices.get("s1")).toBeUndefined();
});

test("a session that starts a turn or is archived while the log is read is not steered", async () => {
  const s = session();
  const h = harness([s], { onMissing: () => (s.status = "running") });
  await h.svc.sweep();
  expect(h.steers).toHaveLength(0);
  const a = session();
  const gone = harness([a], { onMissing: () => (a.status = "archived") });
  await gone.svc.sweep();
  expect(gone.steers).toHaveLength(0);
});
