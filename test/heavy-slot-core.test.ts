import { describe, expect, test } from "bun:test";
import {
  BRAKE_OFF,
  HeavyLedger,
  OFFER_TTL_MS,
  RUNNING_GRACE_MS,
  buildSnapshot,
  defaultHeavySlotBudget,
  estimateWaits,
  heavyEtaKey,
  nextBrake,
  normalizeCommand,
  offerSteer,
  queuedMessage,
  type HeavyJob,
  type HeavySlotBudget,
  type LedgerContext,
} from "../src/heavy-slot-core";

// The pure core of the host-wide heavy-check slot (#3181): who runs, who waits, when the slot is
// released, when the pressure brake lets go, and what the agent is told.

const GIB = 1024 ** 3;
const BUDGET: HeavySlotBudget = {
  slots: 1,
  minAvailableBytes: 4 * GIB,
  psiFullMax: 20,
  releaseHoldMs: 30_000,
};

function ctx(now: number, over: Partial<LedgerContext> = {}): LedgerContext {
  return { now, budget: BUDGET, brakeEngaged: false, ...over };
}

function req(id: string, sessionId: string, command = "bun run test") {
  return { id, sessionId, command, cwd: "/wt", etaKey: `k:${command}` };
}

describe("defaultHeavySlotBudget", () => {
  test("one slot on a 16-core / 30 GiB host, brake at 4 GiB / PSI 20 / 30 s", () => {
    expect(defaultHeavySlotBudget({ cpus: 16, memTotalBytes: 30 * GIB })).toEqual({
      slots: 1,
      minAvailableBytes: 4 * GIB,
      psiFullMax: 20,
      releaseHoldMs: 30_000,
    });
  });

  test("a slot per 16 cores AND 32 GiB, never fewer than one", () => {
    expect(defaultHeavySlotBudget({ cpus: 32, memTotalBytes: 64 * GIB }).slots).toBe(2);
    expect(defaultHeavySlotBudget({ cpus: 64, memTotalBytes: 64 * GIB }).slots).toBe(2);
    expect(defaultHeavySlotBudget({ cpus: 4, memTotalBytes: 8 * GIB }).slots).toBe(1);
  });

  test("a small host brakes at 15 % of its RAM", () => {
    expect(defaultHeavySlotBudget({ cpus: 8, memTotalBytes: 16 * GIB }).minAvailableBytes).toBe(
      Math.floor(16 * GIB * 0.15),
    );
  });

  test("a positive integer override wins; anything else falls back", () => {
    const hw = { cpus: 16, memTotalBytes: 30 * GIB };
    expect(defaultHeavySlotBudget(hw, 3).slots).toBe(3);
    expect(defaultHeavySlotBudget(hw, 0).slots).toBe(1);
    expect(defaultHeavySlotBudget(hw, 1.5).slots).toBe(1);
    expect(defaultHeavySlotBudget(hw, null).slots).toBe(1);
  });
});

describe("nextBrake", () => {
  const ok = { availableBytes: 10 * GIB, psiFullAvg10: 1 };

  test("engages on low MemAvailable or high PSI full, stays off otherwise", () => {
    expect(nextBrake(BRAKE_OFF, ok, BUDGET, 0).engaged).toBe(false);
    const low = nextBrake(BRAKE_OFF, { availableBytes: 2 * GIB, psiFullAvg10: 0 }, BUDGET, 0);
    expect(low).toMatchObject({ engaged: true, reason: "memory_available" });
    const psi = nextBrake(BRAKE_OFF, { availableBytes: 10 * GIB, psiFullAvg10: 41 }, BUDGET, 0);
    expect(psi).toMatchObject({ engaged: true, reason: "memory_pressure" });
  });

  test("lets go only after both values stayed under the limits for the hold", () => {
    let b = nextBrake(BRAKE_OFF, { availableBytes: 2 * GIB, psiFullAvg10: 0 }, BUDGET, 0);
    b = nextBrake(b, ok, BUDGET, 5_000);
    expect(b.engaged).toBe(true);
    b = nextBrake(b, ok, BUDGET, 20_000);
    expect(b.engaged).toBe(true);
    b = nextBrake(b, ok, BUDGET, 35_000);
    expect(b).toMatchObject({ engaged: false, reason: null, clearSince: null });
  });

  test("a single bad sample during the hold restarts it", () => {
    let b = nextBrake(BRAKE_OFF, { availableBytes: 2 * GIB, psiFullAvg10: 0 }, BUDGET, 0);
    b = nextBrake(b, ok, BUDGET, 5_000);
    b = nextBrake(b, { availableBytes: 10 * GIB, psiFullAvg10: 25 }, BUDGET, 20_000);
    b = nextBrake(b, ok, BUDGET, 36_000);
    expect(b.engaged).toBe(true);
    b = nextBrake(b, ok, BUDGET, 66_000);
    expect(b.engaged).toBe(false);
  });

  test("unreadable values never engage it (no PSI on macOS)", () => {
    const none = { availableBytes: null, psiFullAvg10: null };
    expect(nextBrake(BRAKE_OFF, none, BUDGET, 0).engaged).toBe(false);
  });
});

describe("HeavyLedger", () => {
  test("first request runs, a second session's request queues at place 1", () => {
    const l = new HeavyLedger();
    const a = l.acquire(req("j1", "s1"), ctx(1000));
    expect(a.kind).toBe("run");
    const b = l.acquire(req("j2", "s2", "cargo clippy"), ctx(2000));
    expect(b).toMatchObject({
      kind: "queued",
      position: 1,
      total: 1,
      reason: "slot",
      repeat: false,
    });
    expect(l.active().map((j) => j.id)).toEqual(["j1"]);
  });

  test("asking again while queued refreshes the one entry instead of adding another", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    const again = l.acquire(req("j3", "s2", "bun run check"), ctx(2));
    expect(again).toMatchObject({ kind: "queued", position: 1, repeat: true });
    expect(l.queue().map((j) => [j.id, j.command])).toEqual([["j2", "bun run check"]]);
  });

  test("the brake queues a request even with a free slot, with the pressure reason", () => {
    const l = new HeavyLedger();
    const out = l.acquire(req("j1", "s1"), ctx(0, { brakeEngaged: true }));
    expect(out).toMatchObject({ kind: "queued", reason: "pressure" });
    expect(l.fill(ctx(1, { brakeEngaged: true }))).toEqual([]);
    expect(l.fill(ctx(2)).map((j) => j.id)).toEqual(["j1"]);
  });

  test("no barging: a newcomer queues behind a waiting job even when a slot just freed", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    l.finish("j1", "s1", 0, false, 2);
    const late = l.acquire(req("j3", "s3"), ctx(3));
    expect(late).toMatchObject({ kind: "queued", position: 2 });
  });

  test("finish without leftovers releases; fill offers the head for the TTL", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    expect(l.finish("j1", "s1", 0, false, 10)).toBe(true);
    const offered = l.fill(ctx(10));
    expect(offered.map((j) => [j.id, j.state, j.offerExpiresAt])).toEqual([
      ["j2", "offered", 10 + OFFER_TTL_MS],
    ]);
    expect(l.fill(ctx(11))).toEqual([]);
  });

  test("finish with leftovers lingers and keeps the slot; the scan releases it later", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    l.finish("j1", "s1", 1, true, 10);
    expect(l.get("j1")).toMatchObject({ state: "lingering", exitCode: 1, finishedAt: 10 });
    expect(l.fill(ctx(10))).toEqual([]);
    l.reconcile(
      20,
      () => true,
      () => true,
    );
    expect(l.get("j1")?.state).toBe("lingering");
    l.reconcile(
      30,
      () => false,
      () => true,
    );
    expect(l.get("j1")).toBeNull();
    expect(l.fill(ctx(30)).map((j) => j.id)).toEqual(["j2"]);
  });

  test("the offered session claims its slot with any heavy command", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    l.finish("j1", "s1", 0, false, 2);
    l.fill(ctx(2));
    expect(l.waiting("s2")).toBe(true);
    const claim = l.acquire(req("j9", "s2", "bun run check"), ctx(3, { brakeEngaged: true }));
    expect(claim.kind).toBe("run");
    expect(l.get("j2")).toMatchObject({ state: "running", command: "bun run check", startedAt: 3 });
    expect(l.waiting("s2")).toBe(false);
  });

  test("an expired offer is dropped and the next session is offered", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    l.acquire(req("j3", "s3"), ctx(2));
    l.finish("j1", "s1", 0, false, 3);
    l.fill(ctx(3));
    l.takeDirty();
    l.reconcile(
      3 + OFFER_TTL_MS + 1,
      () => null,
      () => true,
    );
    expect(l.takeDirty().map((j) => [j.id, j.state, j.dropReason])).toEqual([
      ["j2", "dropped", "expired"],
    ]);
    expect(l.fill(ctx(3 + OFFER_TTL_MS + 1)).map((j) => j.id)).toEqual(["j3"]);
  });

  test("a running job whose runner died is released after the grace, never before", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.reconcile(
      RUNNING_GRACE_MS - 1,
      () => false,
      () => true,
    );
    expect(l.get("j1")?.state).toBe("running");
    l.reconcile(
      RUNNING_GRACE_MS + 1,
      () => null,
      () => true,
    );
    expect(l.get("j1")?.state).toBe("running");
    l.reconcile(
      RUNNING_GRACE_MS + 1,
      () => true,
      () => true,
    );
    expect(l.get("j1")?.state).toBe("running");
    l.reconcile(
      RUNNING_GRACE_MS + 2,
      () => false,
      () => true,
    );
    expect(l.get("j1")).toBeNull();
  });

  test("an archived session's waiting jobs are dropped; its running job stays bound", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    l.reconcile(
      2,
      () => true,
      () => false,
    );
    expect(l.get("j1")?.state).toBe("running");
    expect(l.get("j2")).toBeNull();
  });

  test("operator release frees a lingering slot; queued jobs cannot be released", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    l.finish("j1", "s1", 0, true, 2);
    expect(l.release("j2", 3)).toBeNull();
    expect(l.release("j1", 3)).toMatchObject({ state: "dropped", dropReason: "released" });
    expect(l.fill(ctx(3)).map((j) => j.id)).toEqual(["j2"]);
  });

  test("a session cannot report on another session's job", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    expect(l.finish("j1", "s2", 0, false, 1)).toBe(false);
    expect(l.started("j1", "s2", 42)).toBe(false);
    expect(l.started("j1", "s1", 42)).toBe(true);
    expect(l.get("j1")).toMatchObject({ state: "running", pgid: 42 });
  });

  test("restart: a ledger rebuilt from persisted rows keeps the queue order", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(5));
    l.acquire(req("j3", "s3"), ctx(6));
    const rows = l.takeDirty();
    const again = new HeavyLedger(rows);
    expect(again.queue().map((j) => j.id)).toEqual(["j2", "j3"]);
    expect(again.active().map((j) => j.id)).toEqual(["j1"]);
  });

  test("two slots run two jobs at once", () => {
    const l = new HeavyLedger();
    const two = ctx(0, { budget: { ...BUDGET, slots: 2 } });
    expect(l.acquire(req("j1", "s1"), two).kind).toBe("run");
    expect(l.acquire(req("j2", "s2"), two).kind).toBe("run");
    expect(l.acquire(req("j3", "s3"), two).kind).toBe("queued");
  });
});

describe("estimateWaits", () => {
  function job(id: string, over: Partial<HeavyJob>): HeavyJob {
    return {
      id,
      sessionId: id,
      command: "c",
      cwd: null,
      etaKey: "k",
      state: "queued",
      enqueuedAt: 0,
      offerExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      releasedAt: null,
      exitCode: null,
      pgid: null,
      dropReason: null,
      ...over,
    };
  }

  test("each queued job waits for the slot its predecessors leave", () => {
    const hist = new Map([["k", [60_000, 120_000, 180_000]]]);
    const active = [job("a", { state: "running", startedAt: 0 })];
    const queue = [job("b", {}), job("c", {})];
    const waits = estimateWaits(active, queue, hist, 1, false, 30_000);
    expect(waits.get("b")).toBe(90_000);
    expect(waits.get("c")).toBe(210_000);
  });

  test("an overrunning holder reads as finishing now, not in the past", () => {
    const hist = new Map([["k", [60_000]]]);
    const waits = estimateWaits(
      [job("a", { state: "running", startedAt: 0 })],
      [job("b", {})],
      hist,
      1,
      false,
      100_000,
    );
    expect(waits.get("b")).toBe(0);
  });

  test("no history, a lingering holder or the brake make the estimate unknown", () => {
    const hist = new Map([["k", [60_000]]]);
    const running = job("a", { state: "running", startedAt: 0 });
    expect(estimateWaits([running], [job("b", {})], new Map(), 1, false, 0).get("b")).toBeNull();
    expect(
      estimateWaits([job("a", { state: "lingering" })], [job("b", {})], hist, 1, false, 0).get("b"),
    ).toBeNull();
    expect(estimateWaits([running], [job("b", {})], hist, 1, true, 0).get("b")).toBeNull();
  });

  test("an unknown job poisons every estimate after it", () => {
    const hist = new Map([["k", [60_000]]]);
    const waits = estimateWaits(
      [],
      [job("b", { etaKey: "unknown" }), job("c", {})],
      hist,
      1,
      false,
      0,
    );
    expect(waits.get("b")).toBe(0);
    expect(waits.get("c")).toBeNull();
  });
});

describe("text and keys", () => {
  test("the queued message says NOT RUN, place, wait and what to do", () => {
    const text = queuedMessage("bun run test", {
      position: 2,
      total: 3,
      etaMs: 200_000,
      reason: "pressure",
      repeat: false,
    });
    expect(text).toContain("NOT RUN");
    expect(text).toContain("place 2 of 3, estimated wait ~4 min");
    expect(text).toContain("memory pressure");
    expect(text).toContain("Do not retry, poll, or skip this check");
    expect(
      queuedMessage("x", { position: 1, total: 1, etaMs: null, reason: "slot", repeat: true }),
    ).toContain("Still queued for the heavy-check slot: place 1 of 1, wait unknown.");
  });

  test("the offer steer names the command and the deadline", () => {
    const text = offerSteer({ command: "cargo clippy" } as HeavyJob);
    expect(text).toContain("`cargo clippy`");
    expect(text).toContain("within 5 minutes");
  });

  test("eta key: repo, cwd relative to the worktree, normalized command", () => {
    expect(heavyEtaKey("/r", "/wt", "/wt/ui", "bun  run\ntest")).toBe(
      "/r\u0000ui\u0000bun run test",
    );
    expect(heavyEtaKey("/r", "/wt", "/wt", "x")).toBe("/r\u0000.\u0000x");
    expect(heavyEtaKey("/r", "/wt", "/elsewhere", "x")).toBe("/r\u0000?\u0000x");
    expect(normalizeCommand("a".repeat(600))).toHaveLength(500);
  });

  test("snapshot lists holders first, then the queue with places and reasons", () => {
    const l = new HeavyLedger();
    l.acquire(req("j1", "s1"), ctx(0));
    l.acquire(req("j2", "s2"), ctx(1));
    const snap = buildSnapshot(l, {
      enabled: true,
      budget: BUDGET,
      brake: { ...BRAKE_OFF, engaged: true, reason: "memory_pressure" },
      waits: new Map([["j2", null]]),
      procs: new Map([["j1", { count: 3, rssBytes: 1.4 * GIB }]]),
    });
    expect(snap.jobs.map((j) => [j.id, j.state, j.position, j.processCount, j.waitReason])).toEqual(
      [
        ["j1", "running", null, 3, null],
        ["j2", "queued", 1, null, "pressure"],
      ],
    );
    expect(snap.brake).toMatchObject({ engaged: true, reason: "memory_pressure", psiFullMax: 20 });
  });
});
