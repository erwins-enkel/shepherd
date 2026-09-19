import { test, expect } from "bun:test";
import { JudgeSpendLedger, dayKey, dayKeyBefore } from "../src/judge-spend";
import { SessionStore } from "../src/store";

function ledger(opts: { ceiling?: number; now?: () => number } = {}) {
  const store = new SessionStore(":memory:");
  const notices: { spent: number; ceiling: number }[] = [];
  const l = new JudgeSpendLedger({
    store,
    ceilingUsd: () => opts.ceiling ?? 1,
    onCeilingReached: (spent, ceiling) => notices.push({ spent, ceiling }),
    now: opts.now ?? (() => Date.UTC(2026, 8, 19, 12)),
  });
  return { store, ledger: l, notices };
}

test("dayKey is the LOCAL calendar day, so 'today' means the same thing as the nightly sweeps", () => {
  const noon = new Date(2026, 8, 19, 12, 0, 0).getTime();
  expect(dayKey(noon)).toBe("2026-09-19");
  // Zero-padded so the keys sort lexicographically — which is what the prune's `day < ?` relies on.
  expect(dayKey(new Date(2026, 0, 5, 12).getTime())).toBe("2026-01-05");
  expect(dayKeyBefore(noon, 90)).toBe("2026-06-21");
  expect(dayKeyBefore(noon, 90) < dayKey(noon)).toBe(true);
});

test("an unspent day allows calls and reports zeroes rather than a missing row", () => {
  const { ledger: l } = ledger();
  expect(l.allow()).toBe(true);
  expect(l.today()).toEqual({ day: "2026-09-19", calls: 0, usd: 0, ceilingUsd: 1 });
});

test("spend accumulates per call and is visible to the usage surface", () => {
  const { ledger: l } = ledger();
  l.record(0.00008);
  l.record(0.00012);
  const today = l.today();
  expect(today.calls).toBe(2);
  expect(today.usd).toBeCloseTo(0.0002, 10);
});

test("reaching the ceiling blocks further calls and notifies EXACTLY once", () => {
  const { ledger: l, notices } = ledger({ ceiling: 0.001 });
  l.record(0.0004);
  expect(l.allow()).toBe(true); // under
  l.record(0.0007); // now at 0.0011, over
  expect(l.allow()).toBe(false);
  expect(l.allow()).toBe(false);
  expect(l.allow()).toBe(false);
  expect(notices).toEqual([{ spent: 0.0011, ceiling: 0.001 }]);
});

test("the once-per-day notice latch lives in the DB, so a restart inside a breached day cannot re-notify", () => {
  const store = new SessionStore(":memory:");
  const notices: number[] = [];
  const build = () =>
    new JudgeSpendLedger({
      store,
      ceilingUsd: () => 0.001,
      onCeilingReached: (spent) => notices.push(spent),
      now: () => Date.UTC(2026, 8, 19, 12),
    });

  store.addJudgeSpend(dayKey(Date.UTC(2026, 8, 19, 12)), 0.002);
  expect(build().allow()).toBe(false);
  // A fresh ledger is what a process restart produces. An in-memory latch would notify again here,
  // which is the whole reason the latch is a column.
  expect(build().allow()).toBe(false);
  expect(notices).toHaveLength(1);
});

test("the day rolls over: yesterday's breach does not block today", () => {
  const store = new SessionStore(":memory:");
  let now = new Date(2026, 8, 19, 12).getTime();
  const l = new JudgeSpendLedger({
    store,
    ceilingUsd: () => 0.001,
    onCeilingReached: () => {},
    now: () => now,
  });

  l.record(0.005);
  expect(l.allow()).toBe(false);

  now = new Date(2026, 8, 20, 12).getTime();
  expect(l.allow()).toBe(true);
  expect(l.today()).toMatchObject({ day: "2026-09-20", calls: 0, usd: 0 });
});

test("a zero ceiling disarms by refusing every call — an off switch that spends nothing", () => {
  const { ledger: l } = ledger({ ceiling: 0 });
  expect(l.allow()).toBe(false);
});

test("the prune drops days past the retention window and keeps the rest", () => {
  const store = new SessionStore(":memory:");
  store.addJudgeSpend("2026-06-01", 1);
  store.addJudgeSpend("2026-09-18", 2);
  store.addJudgeSpend("2026-09-19", 3);

  expect(store.pruneJudgeSpend("2026-09-18")).toBe(1);
  expect(store.getJudgeSpend("2026-06-01")).toBeNull();
  expect(store.getJudgeSpend("2026-09-18")).toEqual({ calls: 1, usd: 2 });
  expect(store.getJudgeSpend("2026-09-19")).toEqual({ calls: 1, usd: 3 });
});

test("claiming the notice on a day with no spend row still latches", () => {
  // The ceiling can be lowered below an already-spent amount, or set to zero, so the claim must not
  // assume `addJudgeSpend` ran first.
  const store = new SessionStore(":memory:");
  expect(store.claimJudgeCeilingNotice("2026-09-19", 1)).toBe(true);
  expect(store.claimJudgeCeilingNotice("2026-09-19", 2)).toBe(false);
  // And the latch must not have invented spend.
  expect(store.getJudgeSpend("2026-09-19")).toEqual({ calls: 0, usd: 0 });
});
