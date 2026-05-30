import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseUsageFrame,
  parseResetLabel,
  UsageLimitsService,
  type CapRow,
  type CapStore,
  type UsageProbe,
} from "../src/usage-limits";
import { AccountUsageIndex } from "../src/usage";

const NOW = Date.parse("2026-05-30T18:00:00.000Z");

test("parseResetLabel: time-of-day", () => {
  const t = parseResetLabel("9:30pm", NOW)!;
  const d = new Date(t);
  expect(d.getHours()).toBe(21);
  expect(d.getMinutes()).toBe(30);
});

test("parseResetLabel: 12-hour edge + month/day", () => {
  expect(new Date(parseResetLabel("12am", NOW)!).getHours()).toBe(0);
  expect(new Date(parseResetLabel("12pm", NOW)!).getHours()).toBe(12);
  const d = new Date(parseResetLabel("Jun6,5pm", NOW)!);
  expect(d.getMonth()).toBe(5); // June
  expect(d.getDate()).toBe(6);
  expect(d.getHours()).toBe(17);
});

test("parseUsageFrame extracts both windows from the captured fixture", () => {
  const raw = readFileSync(join(import.meta.dir, "fixtures", "usage-frame.txt"), "utf8");
  const p = parseUsageFrame(raw, NOW);
  expect(p.session5h?.pct).toBe(3);
  expect(p.week?.pct).toBe(47);
  expect(p.session5h?.resetLabel).toBe("9:30pm");
  expect(p.week?.resetLabel).toBe("Jun6,5pm");
});

test("parseUsageFrame takes the values even with leading ANSI + multiple frames", () => {
  const raw =
    "\x1b[2J\x1b[1;1HCurrent session\n  3% used\nResets 9:30pm (x)\n" +
    "\x1b[2JCurrent session\n  8% used\nResets 10:30pm (x)\nCurrent week\n 50% used\nResets Jun 7 (x)";
  // compacting merges frames; first "%used" after the first "Currentsession" wins
  const p = parseUsageFrame(raw, NOW);
  expect(p.session5h?.pct).toBe(3);
  expect(p.week?.pct).toBe(50);
});

// ── calibration + live limits ───────────────────────────────────────────────

class MemCaps implements CapStore {
  rows = new Map<string, CapRow>();
  getCaps(): CapRow[] {
    return [...this.rows.values()];
  }
  putCap(row: CapRow): void {
    this.rows.set(row.window, row);
  }
}

class StubProbe implements UsageProbe {
  constructor(private raw: string | null) {}
  async scrape(): Promise<string | null> {
    return this.raw;
  }
}

/** An index stub returning a fixed weighted-unit sum regardless of window. */
function fakeIndex(units: number): AccountUsageIndex {
  return { windowSum: () => units } as unknown as AccountUsageIndex;
}

test("calibrate backs out cap = units / (pct/100)", async () => {
  const caps = new MemCaps();
  const raw =
    "Current session\n10% used\nResets 9:30pm (x)\nCurrent week\n20% used\nResets Jun 6 (x)";
  const svc = new UsageLimitsService(fakeIndex(100), caps, new StubProbe(raw));
  expect(await svc.calibrate(NOW)).toBe(true);
  // session: 100 units at 10% → cap 1000 ; week: 100 at 20% → cap 500
  expect(caps.rows.get("session5h")!.cap).toBeCloseTo(1000, 5);
  expect(caps.rows.get("week")!.cap).toBeCloseTo(500, 5);
});

test("low-pct scrape keeps the prior cap (noise guard)", async () => {
  const caps = new MemCaps();
  caps.putCap({ window: "session5h", cap: 1000, resetAt: NOW + 1000, pct: 40, scrapedAt: NOW - 1 });
  const raw = "Current session\n2% used\nResets 9:30pm (x)";
  const svc = new UsageLimitsService(fakeIndex(5), caps, new StubProbe(raw));
  await svc.calibrate(NOW);
  expect(caps.rows.get("session5h")!.cap).toBe(1000); // unchanged
});

test("calibrate returns false when the probe fails", async () => {
  const svc = new UsageLimitsService(fakeIndex(100), new MemCaps(), new StubProbe(null));
  expect(await svc.calibrate(NOW)).toBe(false);
});

test("limits computes pct = units/cap and rolls the reset anchor forward", () => {
  const caps = new MemCaps();
  // anchor reset 2h before now → rolls forward by 5h to 3h after now
  caps.putCap({
    window: "session5h",
    cap: 200,
    resetAt: NOW - 2 * 3600_000,
    pct: 25,
    scrapedAt: NOW,
  });
  const svc = new UsageLimitsService(fakeIndex(50), caps, new StubProbe(null));
  const l = svc.limits(NOW);
  expect(l.session5h!.pct).toBe(25); // 50/200
  expect(l.session5h!.resetAt).toBe(NOW - 2 * 3600_000 + 5 * 3600_000);
  expect(l.stale).toBe(false);
});

test("limits clamps to 100 and reports stale when never calibrated", () => {
  const empty = new UsageLimitsService(fakeIndex(0), new MemCaps(), new StubProbe(null));
  const l = empty.limits(NOW);
  expect(l.session5h).toBeNull();
  expect(l.stale).toBe(true);

  const caps = new MemCaps();
  caps.putCap({ window: "week", cap: 10, resetAt: NOW + 1000, pct: 99, scrapedAt: NOW });
  const over = new UsageLimitsService(fakeIndex(999), caps, new StubProbe(null));
  expect(over.limits(NOW).week!.pct).toBe(100);
});
