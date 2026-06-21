import { test, expect } from "bun:test";
import { SessionStore } from "../src/store";
import type { CapRow, CreditSnapshot } from "../src/usage-limits";

function mk() {
  return new SessionStore(":memory:");
}

const capRow = (over: Partial<CapRow> = {}): CapRow => ({
  window: "session5h",
  cap: 1000,
  resetAt: 2_000_000,
  pct: 40,
  scrapedAt: 1_000_000,
  ...over,
});

const creditRow = (over: Partial<CreditSnapshot> = {}): CreditSnapshot => ({
  spent: 5.0,
  cap: 50.0,
  currency: "€",
  pct: 10,
  resetAt: 3_000_000,
  scrapedAt: 1_000_000,
  ...over,
});

// ── putCap / history append ──────────────────────────────────────────────────

test("putCap: appends a history row; usage_caps holds one row after one call", () => {
  const s = mk();
  s.putCap(capRow({ scrapedAt: 1_000_000 }));
  const caps = s.getCaps();
  expect(caps).toHaveLength(1);
  const hist = s.getCapsHistory(0);
  expect(hist).toHaveLength(1);
  expect(hist[0]!.window).toBe("session5h");
  expect(hist[0]!.scrapedAt).toBe(1_000_000);
});

test("putCap: second call for same window upserts usage_caps (still 1 row) but appends a second history row", () => {
  const s = mk();
  s.putCap(capRow({ scrapedAt: 1_000_000 }));
  s.putCap(capRow({ scrapedAt: 2_000_000, pct: 50 }));
  const caps = s.getCaps();
  expect(caps).toHaveLength(1);
  expect(caps[0]!.pct).toBe(50); // upsert took effect
  const hist = s.getCapsHistory(0);
  expect(hist).toHaveLength(2);
  expect(hist[0]!.scrapedAt).toBe(1_000_000);
  expect(hist[1]!.scrapedAt).toBe(2_000_000);
});

// ── putCreditSnapshot / history append ──────────────────────────────────────

test("putCreditSnapshot: appends a history row; usage_credit holds id=1 after one call", () => {
  const s = mk();
  s.putCreditSnapshot(creditRow({ scrapedAt: 1_000_000 }));
  const snap = s.getCreditSnapshot();
  expect(snap).not.toBeNull();
  const hist = s.getCreditHistory(0);
  expect(hist).toHaveLength(1);
  expect(hist[0]!.spent).toBe(5.0);
  expect(hist[0]!.scrapedAt).toBe(1_000_000);
});

test("putCreditSnapshot: second call upserts usage_credit (id=1 only) but appends another history row", () => {
  const s = mk();
  s.putCreditSnapshot(creditRow({ scrapedAt: 1_000_000, spent: 5.0 }));
  s.putCreditSnapshot(creditRow({ scrapedAt: 2_000_000, spent: 10.0 }));
  // usage_credit still has only id=1
  const snap = s.getCreditSnapshot()!;
  expect(snap.spent).toBe(10.0); // upsert took effect
  const hist = s.getCreditHistory(0);
  expect(hist).toHaveLength(2);
  expect(hist[0]!.scrapedAt).toBe(1_000_000);
  expect(hist[1]!.scrapedAt).toBe(2_000_000);
});

// ── getCapsHistory: since filter + ASC order ─────────────────────────────────

test("getCapsHistory: respects since filter and returns ASC by scrapedAt", () => {
  const s = mk();
  s.putCap(capRow({ scrapedAt: 1_000 }));
  s.putCap(capRow({ scrapedAt: 2_000 }));
  s.putCap(capRow({ scrapedAt: 3_000 }));

  const all = s.getCapsHistory(0);
  expect(all).toHaveLength(3);
  expect(all.map((r) => r.scrapedAt)).toEqual([1_000, 2_000, 3_000]);

  const filtered = s.getCapsHistory(2_000);
  expect(filtered).toHaveLength(2);
  expect(filtered[0]!.scrapedAt).toBe(2_000);
  expect(filtered[1]!.scrapedAt).toBe(3_000);
});

// ── getCreditHistory: since filter + ASC order ───────────────────────────────

test("getCreditHistory: respects since filter and returns ASC by scrapedAt", () => {
  const s = mk();
  s.putCreditSnapshot(creditRow({ scrapedAt: 1_000 }));
  s.putCreditSnapshot(creditRow({ scrapedAt: 2_000 }));
  s.putCreditSnapshot(creditRow({ scrapedAt: 3_000 }));

  const all = s.getCreditHistory(0);
  expect(all).toHaveLength(3);
  expect(all.map((r) => r.scrapedAt)).toEqual([1_000, 2_000, 3_000]);

  const filtered = s.getCreditHistory(2_000);
  expect(filtered).toHaveLength(2);
  expect(filtered[0]!.scrapedAt).toBe(2_000);
  expect(filtered[1]!.scrapedAt).toBe(3_000);
});

// ── pruneUsageHistory ────────────────────────────────────────────────────────

test("pruneUsageHistory: deletes rows with scrapedAt < before from both tables and returns total count", () => {
  const s = mk();
  // 3 cap rows: ts 1000, 2000, 3000
  s.putCap(capRow({ scrapedAt: 1_000 }));
  s.putCap(capRow({ scrapedAt: 2_000 }));
  s.putCap(capRow({ scrapedAt: 3_000 }));
  // 2 credit rows: ts 1000, 4000
  s.putCreditSnapshot(creditRow({ scrapedAt: 1_000 }));
  s.putCreditSnapshot(creditRow({ scrapedAt: 4_000 }));

  // prune before ts=2000 → removes cap@1000 + credit@1000 = 2
  const removed = s.pruneUsageHistory(2_000);
  expect(removed).toBe(2);

  const capsLeft = s.getCapsHistory(0);
  expect(capsLeft.map((r) => r.scrapedAt)).toEqual([2_000, 3_000]);

  const creditsLeft = s.getCreditHistory(0);
  expect(creditsLeft.map((r) => r.scrapedAt)).toEqual([4_000]);
});

test("pruneUsageHistory: rows at/after before survive", () => {
  const s = mk();
  s.putCap(capRow({ scrapedAt: 5_000 }));
  s.putCreditSnapshot(creditRow({ scrapedAt: 5_000 }));

  const removed = s.pruneUsageHistory(5_000); // strict <, so 5000 survives
  expect(removed).toBe(0);
  expect(s.getCapsHistory(0)).toHaveLength(1);
  expect(s.getCreditHistory(0)).toHaveLength(1);
});

test("pruneUsageHistory: returns 0 when nothing to prune", () => {
  const s = mk();
  expect(s.pruneUsageHistory(Date.now())).toBe(0);
});
