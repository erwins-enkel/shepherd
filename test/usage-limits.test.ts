import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseUsageFrame,
  parseResetLabel,
  parseMonthlyReset,
  parseCredits,
  calibrateDelay,
  CREDIT_WATCH_INTERVAL_MS,
  CALIBRATE_INTERVAL_MS,
  type UsageLimits,
  type UsageProjection,
  UsageLimitsService,
  type CapRow,
  type CapStore,
  type CreditSnapshot,
  type CreditStore,
  type ModelWeekSnapshot,
  type ModelWeekStore,
  MODEL_WEEK_STALE_MS,
  type UsageProbe,
  type UsageProviderSource,
} from "../src/usage-limits";
import { AccountUsageIndex } from "../src/usage";
import { config } from "../src/config";

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

test("parseResetLabel: 'at' separator (current /usage format)", () => {
  const d = new Date(parseResetLabel("Jun11at11pm", NOW)!);
  expect(d.getMonth()).toBe(5); // June
  expect(d.getDate()).toBe(11);
  expect(d.getHours()).toBe(23);
});

test("parseResetLabel: labels always point forward", () => {
  // a time-of-day already past today means tomorrow
  const noon = new Date(NOW);
  noon.setHours(12, 0, 0, 0);
  const t = new Date(parseResetLabel("9:30am", noon.getTime())!);
  expect(t.getTime()).toBeGreaterThan(noon.getTime());
  expect(t.getHours()).toBe(9);
  // a month/day already past means next year (Dec scrape, Jan reset)
  const y = new Date(parseResetLabel("Jan2,5pm", NOW)!);
  expect(y.getFullYear()).toBe(new Date(NOW).getFullYear() + 1);
  expect(y.getMonth()).toBe(0);
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
  // compacting merges frames; the LAST complete render per window wins
  const p = parseUsageFrame(raw, NOW);
  expect(p.session5h?.pct).toBe(8);
  expect(p.week?.pct).toBe(50);
});

test("parseUsageFrame: a truncated section must not steal the next frame's values", () => {
  // frame 1 is cut right after the week header — its pct/reset never rendered. The week
  // window must NOT pick up the session values of frame 2 (the bug that anchored the weekly
  // reset to the session's "9:40am" and took the session pct as the week pct).
  const raw =
    "Current session\n 3% used\nResets 9:40am (Europe/Berlin)\nCurrent week (all models)\n" +
    "\x1b[2JCurrent session\n 24% used\nResets 9:40am (Europe/Berlin)\n" +
    "Current week (all models)\n 7% used\nResets Jun 11 at 11pm (Europe/Berlin)\n" +
    "Current week (Sonnet only)\n 0% used\nResets Jun 11 at 11pm (Europe/Berlin)";
  const p = parseUsageFrame(raw, NOW);
  expect(p.session5h?.pct).toBe(24);
  expect(p.session5h?.resetLabel).toBe("9:40am");
  expect(p.week?.pct).toBe(7); // not 24, not the Sonnet-only 0
  expect(p.week?.resetLabel).toBe("Jun11at11pm");
});

test("parseUsageFrame: a truncated last section must not absorb the trailing panels", () => {
  // the week gauge never rendered; the capture's tail is the chrome below the gauges. Its
  // "% used" must not be read as the week's pct — the section ends at the trailer.
  const raw =
    "Current session\n 24% used\nResets 9:40am (x)\nCurrent week (all models)\n" +
    "Esc to cancel\nUsage credits\n 55% used\nResets Jul 1 (x)";
  const p = parseUsageFrame(raw, NOW);
  expect(p.session5h?.pct).toBe(24);
  expect(p.week).toBeNull();
});

test("parseUsageFrame: model-scoped weekly gauges never override the account cap", () => {
  const raw =
    "Current week (all models)\n 40% used\nResets Jun 11 at 11pm (x)\n" +
    "Current week (Sonnet only)\n 2% used\nResets Jun 11 at 11pm (x)";
  expect(parseUsageFrame(raw, NOW).week?.pct).toBe(40);
});

// ── per-model weekly passthrough (Fable) ─────────────────────────────────────

// Fixture is screenshot-derived (Claude Code /usage, screenshot 3): a genuine ANSI capture
// with the Fable gauge wasn't available; ANSI robustness is already covered by usage-frame.txt,
// and the parser runs on ANSI-stripped/collapsed text — so the collapsed shape is what matters.
// The Fable line renders "0% used" (carries `used`) with NO Resets clause.
test("parseUsageFrame: surfaces the Fable weekly gauge as a per-model passthrough", () => {
  const raw = readFileSync(join(import.meta.dir, "fixtures", "usage-frame-fable.txt"), "utf8");
  const p = parseUsageFrame(raw, NOW);
  // exactly one per-model entry (dedup below covers the multi-redraw case)
  expect(p.perModelWeek).toHaveLength(1);
  const fable = p.perModelWeek[0]!;
  expect(fable.model).toBe("fable");
  expect(fable.pct).toBe(0);
  expect(fable.resetLabel).toBeNull(); // Fable line carried no Resets
  expect(fable.resetAt).toBeNull();
  // the account windows are untouched — "all models" stays WK, Fable does not steal it
  expect(p.week?.pct).toBe(11);
  expect(p.session5h?.pct).toBe(29);
});

test("parseUsageFrame: dedups the per-model gauge across partial redraws (last-wins, prefer reset)", () => {
  // three redraws of the same Fable section: a reset-less partial, then a fuller one WITH a
  // reset label, then another reset-less partial. Exactly one entry; the reset-labelled read wins.
  const raw =
    "Current week (Fable)\n 3% used\n" +
    "\x1b[2JCurrent week (Fable)\n 7% used\nResets Jul 2, 11pm (x)\n" +
    "\x1b[2JCurrent week (Fable)\n 9% used";
  const p = parseUsageFrame(raw, NOW);
  expect(p.perModelWeek).toHaveLength(1);
  expect(p.perModelWeek[0]!.pct).toBe(7); // the render carrying a reset label
  expect(p.perModelWeek[0]!.resetLabel).toBe("Jul2,11pm");
});

test("parseUsageFrame: a mid-redraw partial pct never overrides the finished account window", () => {
  // The shared parseSegment stays STRICT for session5h/week: a bare `2%` before the finished
  // `29%used` must not be read as the value. Guards the partial-frame protection when the
  // lenient (per-model) path is added.
  const raw = "Current session\n 2%\n 29% used\nResets 9:30pm (x)";
  expect(parseUsageFrame(raw, NOW).session5h?.pct).toBe(29);
});

test("parseUsageFrame: the per-model lenient path prefers %used but falls back to a bare pct", () => {
  // a Fable gauge that never rendered the word `used` (bare `4%`) is still surfaced...
  const bare = "Current week (Fable)\n 4%";
  expect(parseUsageFrame(bare, NOW).perModelWeek[0]?.pct).toBe(4);
  // ...but when a finished `%used` is present, it wins over an earlier bare partial.
  const finished = "Current week (Fable)\n 2%\n 8% used";
  expect(parseUsageFrame(finished, NOW).perModelWeek[0]?.pct).toBe(8);
});

// ── usage credits (paid overage) ─────────────────────────────────────────────

// Mid-June 2026, local time (month 0-indexed; June = 5). Jun1 is already past here.
const JUN13 = new Date(2026, 5, 13, 12, 0, 0, 0).getTime();

test("parseUsageFrame parses the credits panel from the captured fixture", () => {
  const raw = readFileSync(join(import.meta.dir, "fixtures", "usage-frame.txt"), "utf8");
  const p = parseUsageFrame(raw, NOW);
  expect(p.credits).not.toBeNull();
  expect(p.credits!.currency).toBe("€");
  expect(p.credits!.spent).toBe(0.29);
  expect(p.credits!.cap).toBe(50);
  expect(p.credits!.pct).toBe(0);
  expect(p.credits!.resetLabel).toBe("Jun1");
});

test("credits: pct rounds to 0 while spend is the real (non-zero) signal", () => {
  const raw = readFileSync(join(import.meta.dir, "fixtures", "usage-frame.txt"), "utf8");
  const c = parseUsageFrame(raw, NOW).credits!;
  expect(c.pct).toBe(0);
  expect(c.spent).toBeGreaterThan(0);
});

test("parseCredits captures $ and £ currency symbols exactly", () => {
  const usd = parseCredits("Usagecredits12%used$3.50/$25.00spent·ResetsJul1(x)", NOW)!;
  expect(usd.currency).toBe("$");
  expect(usd.spent).toBe(3.5);
  expect(usd.cap).toBe(25);
  expect(usd.pct).toBe(12);
  const gbp = parseCredits("Usagecredits0%used£0.99/£10.00spent·ResetsAug2(x)", NOW)!;
  expect(gbp.currency).toBe("£");
  expect(gbp.spent).toBe(0.99);
  expect(gbp.cap).toBe(10);
});

test("parseCredits stops at the Esc-to-cancel chrome and ignores absent section", () => {
  expect(parseCredits("Currentsession3%usedResets9:30pm(x)", NOW)).toBeNull();
  expect(parseUsageFrame("Current session\n3% used\nResets 9:30pm (x)", NOW).credits).toBeNull();
});

test("parseCredits skips the /usage-credits command-menu text and reads the real panel", () => {
  // The probe runs claude in the classic renderer, which accumulates the `/usage` slash-command menu
  // into the buffer. The `/usage-credits` command (renamed from `/extra-usage` in Claude Code
  // v2.1.144) describes itself as "Configure usage credits to keep working when you hit a limit",
  // collapsing to a `Usagecredits…` run with NO spend figure that precedes the actual panel. Reading
  // the first match yielded null and the gauge silently vanished; the parser must skip it.
  const collapsed =
    "/usageShowsessioncost,planusage,andactivitystats" +
    "/usage-creditsConfigureusagecreditstokeepworkingwhenyouhitalimit" +
    "Esctocancel" +
    "Currentweek(allmodels)100%usedResetsJun25,11pm(x)" +
    "Usagecredits65%used€12.34/€80.00spent·ResetsJul1(x)Esctocancel";
  const c = parseCredits(collapsed, NOW)!;
  expect(c).not.toBeNull();
  expect(c.currency).toBe("€");
  expect(c.spent).toBe(12.34);
  expect(c.cap).toBe(80);
  expect(c.pct).toBe(65);
  expect(c.resetLabel).toBe("Jul1");
  // end-to-end: the same menu-poisoned buffer must still surface credits through parseUsageFrame
  expect(parseUsageFrame(collapsed, NOW).credits?.spent).toBe(12.34);
});

test("parseMonthlyReset rolls a past day forward ONE MONTH, not one year", () => {
  // Jun1 is past relative to mid-June → next month, same year (Jul 1), NOT Jun 2027
  const jul1 = new Date(parseMonthlyReset("Jun1", JUN13)!);
  expect(jul1.getFullYear()).toBe(2026);
  expect(jul1.getMonth()).toBe(6); // July
  expect(jul1.getDate()).toBe(1);
  expect(jul1.getHours()).toBe(0); // midnight local
});

test("parseMonthlyReset keeps a future day this month", () => {
  const jun20 = new Date(parseMonthlyReset("Jun20", JUN13)!);
  expect(jun20.getFullYear()).toBe(2026);
  expect(jun20.getMonth()).toBe(5); // June
  expect(jun20.getDate()).toBe(20);
});

test("parseMonthlyReset carries the year on a Dec→Jan wrap", () => {
  const dec15 = new Date(2026, 11, 15, 12, 0, 0, 0).getTime();
  const jan1 = new Date(parseMonthlyReset("Jan1", dec15)!);
  expect(jan1.getFullYear()).toBe(2027);
  expect(jan1.getMonth()).toBe(0);
  expect(jan1.getDate()).toBe(1);
});

test("parseMonthlyReset clamps a day-31 label to the next month's last day (no month skip)", () => {
  // Jan31 near end of Jan 2027 (non-leap) → next occurrence is Feb 28, NOT a March spill-over.
  const jan31 = new Date(2027, 0, 31, 23, 59, 0, 0).getTime();
  const feb = new Date(parseMonthlyReset("Jan31", jan31)!);
  expect(feb.getFullYear()).toBe(2027);
  expect(feb.getMonth()).toBe(1); // February — not skipped to March
  expect(feb.getDate()).toBe(28); // clamped to Feb's last day
  expect(feb.getHours()).toBe(0);
});

test("parseMonthlyReset clamps a day-31 label to Feb 29 in a leap year", () => {
  // 2028 is a leap year → Jan31 rolls to Feb 29.
  const jan31 = new Date(2028, 0, 31, 23, 59, 0, 0).getTime();
  const feb = new Date(parseMonthlyReset("Jan31", jan31)!);
  expect(feb.getMonth()).toBe(1); // February
  expect(feb.getDate()).toBe(29); // leap-year last day
});

test("parseMonthlyReset returns null for an unparseable label", () => {
  expect(parseMonthlyReset("someday", NOW)).toBeNull();
  expect(parseMonthlyReset("9:30pm", NOW)).toBeNull();
});

test("parseUsageFrame: adding credits parsing did not break the week anchor loop", () => {
  // self-truncation regression: the fixture must still yield BOTH a week window AND credits
  const raw = readFileSync(join(import.meta.dir, "fixtures", "usage-frame.txt"), "utf8");
  const p = parseUsageFrame(raw, NOW);
  expect(p.week).not.toBeNull();
  expect(p.credits).not.toBeNull();
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

class MemCredits implements CreditStore {
  snap: CreditSnapshot | null = null;
  getCreditSnapshot(): CreditSnapshot | null {
    return this.snap;
  }
  putCreditSnapshot(row: CreditSnapshot): void {
    this.snap = row;
  }
}

class MemModelWeek implements ModelWeekStore {
  rows = new Map<string, ModelWeekSnapshot>();
  getModelWeekSnapshots(): ModelWeekSnapshot[] {
    return [...this.rows.values()];
  }
  putModelWeekSnapshot(row: ModelWeekSnapshot): void {
    this.rows.set(row.model, row);
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
  const svc = new UsageLimitsService(fakeIndex(100), caps, new StubProbe(raw), new MemCredits());
  expect(await svc.calibrate(NOW)).toBe(true);
  // session: 100 units at 10% → cap 1000 ; week: 100 at 20% → cap 500
  expect(caps.rows.get("session5h")!.cap).toBeCloseTo(1000, 5);
  expect(caps.rows.get("week")!.cap).toBeCloseTo(500, 5);
});

test("low-pct scrape keeps the prior cap (noise guard)", async () => {
  const caps = new MemCaps();
  caps.putCap({ window: "session5h", cap: 1000, resetAt: NOW + 1000, pct: 40, scrapedAt: NOW - 1 });
  const raw = "Current session\n2% used\nResets 9:30pm (x)";
  const svc = new UsageLimitsService(fakeIndex(5), caps, new StubProbe(raw), new MemCredits());
  await svc.calibrate(NOW);
  expect(caps.rows.get("session5h")!.cap).toBe(1000); // unchanged
});

test("unparseable reset label keeps the prior anchor rolled forward, not now+period", async () => {
  const caps = new MemCaps();
  const WEEK = 7 * 24 * 3600_000;
  const priorReset = NOW - 1000; // just expired → rolls forward one period
  caps.putCap({ window: "week", cap: 500, resetAt: priorReset, pct: 20, scrapedAt: NOW - WEEK });
  const raw = "Current week (all models)\n30% used\nResets someday (x)";
  const svc = new UsageLimitsService(fakeIndex(100), caps, new StubProbe(raw), new MemCredits());
  await svc.calibrate(NOW);
  expect(caps.rows.get("week")!.resetAt).toBe(priorReset + WEEK);
});

test("calibrate returns false when the probe fails", async () => {
  const svc = new UsageLimitsService(
    fakeIndex(100),
    new MemCaps(),
    new StubProbe(null),
    new MemCredits(),
  );
  expect(await svc.calibrate(NOW)).toBe(false);
});

test("lastScrapeAt advances on a frame-returning scrape, not on a failed (null) scrape", async () => {
  const raw =
    "Current session\n10% used\nResets 9:30pm (x)\nCurrent week\n20% used\nResets Jun 6 (x)";
  const ok = new UsageLimitsService(
    fakeIndex(100),
    new MemCaps(),
    new StubProbe(raw),
    new MemCredits(),
  );
  expect(ok.lastScrapeAt).toBe(0); // none yet
  await ok.calibrate(NOW);
  expect(ok.lastScrapeAt).toBe(NOW); // a usable frame → stamped

  const fail = new UsageLimitsService(
    fakeIndex(100),
    new MemCaps(),
    new StubProbe(null),
    new MemCredits(),
  );
  await fail.calibrate(NOW);
  expect(fail.lastScrapeAt).toBe(0); // probe failed → never stamped
});

test("a usable frame that writes no cap still stamps lastScrapeAt (degenerate scrape)", async () => {
  // Frame parses but pct is below MIN_CALIBRATION_PCT and there's no prior cap / credits → calibrate
  // returns false (nothing written), yet a real scrape happened: lastScrapeAt must advance so the
  // refresh reads as a success (scraped), not a silent stale.
  const raw = "Current session\n2% used\nResets 9:30pm (x)";
  const svc = new UsageLimitsService(
    fakeIndex(5),
    new MemCaps(),
    new StubProbe(raw),
    new MemCredits(),
  );
  expect(await svc.calibrate(NOW)).toBe(false); // nothing to write
  expect(svc.lastScrapeAt).toBe(NOW); // but a frame WAS scraped
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
  const svc = new UsageLimitsService(fakeIndex(50), caps, new StubProbe(null), new MemCredits());
  const l = svc.limits(NOW);
  expect(l.session5h!.pct).toBe(25); // 50/200
  expect(l.session5h!.resetAt).toBe(NOW - 2 * 3600_000 + 5 * 3600_000);
  expect(l.stale).toBe(false);
});

test("limits reconciles a mid-window weekly reset: a scraped 0% drops the gauge off a stale high local sum", () => {
  const H = 3_600_000;
  const WEEK = 7 * 24 * H;
  const now = NOW;
  const resetAt = now + 2 * H; // the weekly boundary did NOT move — the reset only zeroed the counter
  const windowStart = resetAt - WEEK;
  // Account JSONL still holds ~the whole cap of pre-reset usage inside the (unchanged) window.
  const index = seededIndex([{ ts: windowStart + H, units: 980 }]);
  const caps = new MemCaps();

  // Before the reset: calibrated at 98% (980/1000). The gauge reads 98%.
  caps.putCap({ window: "week", cap: 1000, resetAt, pct: 98, scrapedAt: windowStart + 2 * H });
  const pre = new UsageLimitsService(index, caps, new StubProbe(null), new MemCredits());
  expect(pre.limits(now).week!.pct).toBe(98);

  // The reset scrape lands: 0% < MIN_CALIBRATION_PCT so the cap is unchanged, but the anchor is
  // re-stamped to pct=0 at `now` (same resetAt) — exactly the row calibrateWindow persists.
  caps.putCap({ window: "week", cap: 1000, resetAt, pct: 0, scrapedAt: now });
  const post = new UsageLimitsService(index, caps, new StubProbe(null), new MemCredits());
  // Pre-anchor code returned windowSum/cap = 980/1000 = 98% forever (the reported bug); anchored to
  // the fresh scrape it tracks 0% + (no) post-scrape usage.
  expect(post.limits(now).week!.pct).toBe(0);
});

test("limits clamps to 100 and reports stale when never calibrated", () => {
  const empty = new UsageLimitsService(
    fakeIndex(0),
    new MemCaps(),
    new StubProbe(null),
    new MemCredits(),
  );
  const l = empty.limits(NOW);
  expect(l.session5h).toBeNull();
  expect(l.stale).toBe(true);

  const caps = new MemCaps();
  caps.putCap({ window: "week", cap: 10, resetAt: NOW + 1000, pct: 99, scrapedAt: NOW });
  const over = new UsageLimitsService(fakeIndex(999), caps, new StubProbe(null), new MemCredits());
  expect(over.limits(NOW).week!.pct).toBe(100);
});

test("limits keeps Claude usage when an extra provider throws", () => {
  const caps = new MemCaps();
  caps.putCap({ window: "week", cap: 200, resetAt: NOW + 1000, pct: 20, scrapedAt: NOW });
  const throwingProvider: UsageProviderSource = {
    snapshot: () => {
      throw new Error("provider unavailable");
    },
  };
  const svc = new UsageLimitsService(
    // no post-scrape usage → the gauge shows the scraped anchor pct (20%) verbatim
    seededIndex([]),
    caps,
    new StubProbe(null),
    new MemCredits(),
    new MemModelWeek(),
    [throwingProvider],
  );

  const l = svc.limits(NOW);

  expect(l.week!.pct).toBe(20);
  expect(l.providers).toHaveLength(1);
  expect(l.providers?.[0]?.provider).toBe("claude");
});

// ── credits: calibrate persist + live passthrough ────────────────────────────

test("calibrate persists the parsed credit snapshot with scrapedAt === now", async () => {
  const raw = readFileSync(join(import.meta.dir, "fixtures", "usage-frame.txt"), "utf8");
  const credits = new MemCredits();
  const svc = new UsageLimitsService(fakeIndex(100), new MemCaps(), new StubProbe(raw), credits);
  expect(await svc.calibrate(NOW)).toBe(true);
  const snap = credits.getCreditSnapshot()!;
  expect(snap.spent).toBe(0.29);
  expect(snap.cap).toBe(50);
  expect(snap.currency).toBe("€");
  expect(snap.pct).toBe(0);
  expect(snap.resetAt).toBe(parseMonthlyReset("Jun1", NOW)); // direct passthrough of parsed reset
  expect(snap.scrapedAt).toBe(NOW);
});

test("calibrate with no credits section leaves the prior snapshot untouched", async () => {
  const credits = new MemCredits();
  const prior: CreditSnapshot = {
    spent: 1.5,
    cap: 50,
    currency: "$",
    pct: 3,
    resetAt: NOW + 1000,
    scrapedAt: NOW - 1000,
  };
  credits.putCreditSnapshot({ ...prior });
  // a capture with windows but no Usagecredits panel
  const raw = "Current session\n10% used\nResets 9:30pm (x)";
  const svc = new UsageLimitsService(fakeIndex(100), new MemCaps(), new StubProbe(raw), credits);
  await svc.calibrate(NOW);
  expect(credits.getCreditSnapshot()).toEqual(prior); // never fabricated/cleared
});

test("limits passes a fresh credit snapshot through (incl. pct 0 while spend > 0)", () => {
  const credits = new MemCredits();
  credits.putCreditSnapshot({
    spent: 0.29,
    cap: 50,
    currency: "€",
    pct: 0,
    resetAt: NOW + 7 * 24 * 3600_000,
    scrapedAt: NOW,
  });
  const svc = new UsageLimitsService(fakeIndex(0), new MemCaps(), new StubProbe(null), credits);
  const c = svc.limits(NOW).credits!;
  expect(c.stale).toBe(false);
  expect(c.pct).toBe(0);
  expect(c.spent).toBe(0.29);
  expect(c.cap).toBe(50);
  expect(c.currency).toBe("€");
  expect(c.resetAt).toBe(NOW + 7 * 24 * 3600_000);
  expect(c.scrapedAt).toBe(NOW);
});

test("limits marks a credit snapshot older than 1h as stale", () => {
  const credits = new MemCredits();
  credits.putCreditSnapshot({
    spent: 5,
    cap: 50,
    currency: "€",
    pct: 10,
    resetAt: NOW + 1000,
    scrapedAt: NOW - 2 * 3600_000,
  });
  const svc = new UsageLimitsService(fakeIndex(0), new MemCaps(), new StubProbe(null), credits);
  expect(svc.limits(NOW).credits!.stale).toBe(true);
});

test("limits drops a credit snapshot whose monthly budget already reset", () => {
  const credits = new MemCredits();
  credits.putCreditSnapshot({
    spent: 5,
    cap: 50,
    currency: "€",
    pct: 10,
    resetAt: NOW - 1, // already rolled over
    scrapedAt: NOW,
  });
  const svc = new UsageLimitsService(fakeIndex(0), new MemCaps(), new StubProbe(null), credits);
  expect(svc.limits(NOW).credits).toBeNull();
});

test("limits drops a dead credit snapshot (extra usage turned off) past CREDIT_DROP_MS", () => {
  const credits = new MemCredits();
  const DAY = 24 * 3600_000;
  credits.putCreditSnapshot({
    spent: 46.47,
    cap: 100,
    currency: "€",
    pct: 46,
    resetAt: NOW + 30 * DAY, // monthly reset still ahead → NOT the post-reset drop
    scrapedAt: NOW - 3 * DAY, // 3 days stale: past CREDIT_DROP_MS (2 daily calibrations)
  });
  const svc = new UsageLimitsService(fakeIndex(0), new MemCaps(), new StubProbe(null), credits);
  // Hidden entirely rather than lingered as a stale, un-refreshable "SCRAPED Nd AGO" gauge.
  expect(svc.limits(NOW).credits).toBeNull();
  // The snapshot itself is untouched — recoverable if credits are re-enabled and re-scraped.
  expect(credits.getCreditSnapshot()).not.toBeNull();
});

test("limits keeps a credit snapshot with an unparseable (null) resetAt", () => {
  const credits = new MemCredits();
  credits.putCreditSnapshot({
    spent: 5,
    cap: 50,
    currency: "€",
    pct: 10,
    resetAt: null, // can't be known to have rolled over → not post-reset
    scrapedAt: NOW,
  });
  const svc = new UsageLimitsService(fakeIndex(0), new MemCaps(), new StubProbe(null), credits);
  const c = svc.limits(NOW).credits!;
  expect(c).not.toBeNull();
  expect(c.resetAt).toBeNull();
});

test("limits returns null credits when nothing has been persisted", () => {
  const svc = new UsageLimitsService(
    fakeIndex(0),
    new MemCaps(),
    new StubProbe(null),
    new MemCredits(),
  );
  expect(svc.limits(NOW).credits).toBeNull();
});

const mkLimits = (weekPct: number | null): UsageLimits => ({
  session5h: null,
  week: weekPct === null ? null : { pct: weekPct, resetAt: NOW },
  perModelWeek: [],
  credits: null,
  stale: false,
  calibratedAt: NOW,
  subscriptionOnly: false,
});

test("calibrateDelay: week pct above watch threshold escalates cadence", () => {
  expect(calibrateDelay(mkLimits(95))).toBe(CREDIT_WATCH_INTERVAL_MS);
});

test("calibrateDelay: week pct exactly at threshold escalates (>= boundary)", () => {
  expect(calibrateDelay(mkLimits(90))).toBe(CREDIT_WATCH_INTERVAL_MS);
});

test("calibrateDelay: week pct below threshold stays daily", () => {
  expect(calibrateDelay(mkLimits(50))).toBe(CALIBRATE_INTERVAL_MS);
});

test("calibrateDelay: null week window stays daily", () => {
  expect(calibrateDelay(mkLimits(null))).toBe(CALIBRATE_INTERVAL_MS);
});

// ── per-model weekly passthrough: calibrate persist + live passthrough ────────

test("calibrate persists the parsed per-model gauge and limits() surfaces it fresh", async () => {
  const raw = readFileSync(join(import.meta.dir, "fixtures", "usage-frame-fable.txt"), "utf8");
  const store = new MemModelWeek();
  const svc = new UsageLimitsService(
    fakeIndex(100),
    new MemCaps(),
    new StubProbe(raw),
    new MemCredits(),
    store,
  );
  await svc.calibrate(NOW);
  expect(store.getModelWeekSnapshots()).toHaveLength(1);
  const w = svc.limits(NOW).perModelWeek;
  expect(w).toHaveLength(1);
  expect(w[0]!.model).toBe("fable");
  expect(w[0]!.pct).toBe(0);
  expect(w[0]!.resetAt).toBeNull();
  expect(w[0]!.stale).toBe(false);
});

test("per-model passthrough: reads stale past MODEL_WEEK_STALE_MS (not credits' 1h)", () => {
  const store = new MemModelWeek();
  const svc = new UsageLimitsService(
    fakeIndex(0),
    new MemCaps(),
    new StubProbe(null),
    new MemCredits(),
    store,
  );
  // scraped 2h ago: a 1h credits-style stale would flip; the 48h model-week window must not.
  store.putModelWeekSnapshot({
    model: "fable",
    pct: 5,
    resetAt: null,
    scrapedAt: NOW - 2 * 3600_000,
  });
  expect(svc.limits(NOW).perModelWeek[0]!.stale).toBe(false);
  // just past the model-week window → stale
  const old = svc.limits(NOW + MODEL_WEEK_STALE_MS + 1);
  expect(old.perModelWeek[0]!.stale).toBe(true);
});

test("per-model passthrough: post-reset guard drops a rolled-over snapshot, keeps a null-reset one", () => {
  const store = new MemModelWeek();
  const svc = new UsageLimitsService(
    fakeIndex(0),
    new MemCaps(),
    new StubProbe(null),
    new MemCredits(),
    store,
  );
  // resetAt already in the past → dropped (meaningless until re-scraped)
  store.putModelWeekSnapshot({ model: "sonnet", pct: 80, resetAt: NOW - 1000, scrapedAt: NOW });
  // no reset label (null) → can't be known to have rolled over → passes through
  store.putModelWeekSnapshot({ model: "fable", pct: 4, resetAt: null, scrapedAt: NOW });
  const w = svc.limits(NOW).perModelWeek;
  expect(w.map((x) => x.model)).toEqual(["fable"]);
});

// ── api-key mode: subscription-only flag + probe never spawned ───────────────

/** Probe whose scrape() throws (or increments a call counter) to catch stray spawns. */
class ThrowingProbe implements UsageProbe {
  calls = 0;
  async scrape(): Promise<string | null> {
    this.calls++;
    throw new Error("probe must not be called in api-key mode");
  }
}

test("calibrate short-circuits in api-key mode without calling the probe", async () => {
  const prior = config.authMode;
  try {
    config.authMode = "api-key";
    const probe = new ThrowingProbe();
    const svc = new UsageLimitsService(fakeIndex(100), new MemCaps(), probe, new MemCredits());
    const result = await svc.calibrate(NOW);
    expect(result).toBe(false);
    expect(probe.calls).toBe(0);
  } finally {
    config.authMode = prior;
  }
});

test("limits() subscriptionOnly is true in api-key mode, false in subscription mode", () => {
  const prior = config.authMode;
  try {
    const svc = new UsageLimitsService(
      fakeIndex(0),
      new MemCaps(),
      new StubProbe(null),
      new MemCredits(),
    );

    config.authMode = "api-key";
    expect(svc.limits(NOW).subscriptionOnly).toBe(true);

    config.authMode = "subscription";
    expect(svc.limits(NOW).subscriptionOnly).toBe(false);
  } finally {
    config.authMode = prior;
  }
});

// ── projections() ────────────────────────────────────────────────────────────

/** Range-aware index stub: sums records whose ts falls within [s, e] inclusive. */
function seededIndex(records: { ts: number; units: number }[]): AccountUsageIndex {
  return {
    windowSum: (s: number, e: number) =>
      records.filter((r) => r.ts >= s && r.ts <= e).reduce((a, r) => a + r.units, 0),
  } as unknown as AccountUsageIndex;
}

test("projections: math from seeded records", () => {
  // session5h: period=5h, cap=1000, resetAt=now+3h (windowStart=now-2h)
  // records at now-1.5h (within window, outside 1h lookback) and now-0.5h (within both)
  const H = 3_600_000;
  const now = NOW;
  const resetAt = now + 3 * H;
  const caps = new MemCaps();
  caps.putCap({ window: "session5h", cap: 1000, resetAt, pct: 10, scrapedAt: now });
  const records = [
    { ts: now - 1.5 * H, units: 60 }, // in window (windowStart=now-2h), outside 1h lookback
    { ts: now - 0.5 * H, units: 40 }, // in both window and 1h lookback
  ];
  // recentUnits (last 1h) = 40; burnRatePerHour = round(40/1) = 40
  // curUnits (full window) = 100; hoursToReset = 3
  // projectedPct = round((100 + 40*3)/1000 * 100) = round(22) = 22
  const svc = new UsageLimitsService(
    seededIndex(records),
    caps,
    new StubProbe(null),
    new MemCredits(),
  );
  const proj = svc.projections(now);
  expect(proj).toHaveLength(1);
  const p = proj[0] as UsageProjection;
  expect(p.window).toBe("5H");
  expect(p.burnRatePerHour).toBe(40);
  expect(p.resetAt).toBe(resetAt);
  expect(p.projectedPct).toBe(22);
});

test("projections: will-exceed (projectedPct > 100) is NOT clamped", () => {
  const H = 3_600_000;
  const now = NOW;
  const resetAt = now + 2 * H;
  const caps = new MemCaps();
  // cap=100, windowStart=now-3h; scraped 0% at now-1h so the whole window's burn is post-scrape
  caps.putCap({ window: "session5h", cap: 100, resetAt, pct: 0, scrapedAt: now - H });
  // 200 units in last 0.5h → burnRatePerHour=200, curUnits = 0-anchor + 200 delta = 200, hoursToReset=2
  // projectedPct = round((200 + 200*2)/100 * 100) = 600
  const records = [{ ts: now - 0.5 * H, units: 200 }];
  const svc = new UsageLimitsService(
    seededIndex(records),
    caps,
    new StubProbe(null),
    new MemCredits(),
  );
  const proj = svc.projections(now);
  expect(proj[0]!.projectedPct).toBeGreaterThan(100); // NOT clamped
  expect(proj[0]!.projectedPct).toBe(600);
});

test("projections: just-after-reset boundary excludes pre-reset records", () => {
  const H = 3_600_000;
  const now = NOW;
  // resetAt=now+4.5h → windowStart=now-0.5h (fresh window, only 0.5h old)
  // lookback=1h → now-lookback=now-1h < windowStart (now-0.5h) → Math.max clamps to windowStart
  const resetAt = now + 4.5 * H;
  const caps = new MemCaps();
  caps.putCap({ window: "session5h", cap: 1000, resetAt, pct: 5, scrapedAt: now });
  const records = [
    // pre-reset: 0.75h ago — BEFORE windowStart (0.5h ago) but WITHIN unclamped lookback (1h)
    { ts: now - 0.75 * H, units: 500 },
    // post-reset: 0.25h ago — inside both window and lookback
    { ts: now - 0.25 * H, units: 10 },
  ];
  const svc = new UsageLimitsService(
    seededIndex(records),
    caps,
    new StubProbe(null),
    new MemCredits(),
  );
  const proj = svc.projections(now);
  const p = proj[0]!;
  // (a) curUnits anchored to the scrape (5% of 1000 = 50) + post-scrape delta (windowSum(now,now)=0)
  //     = 50; projectedPct = round((50 + 10*4.5)/1000*100) = round(9.5) = 10
  expect(p.projectedPct).toBe(10);
  // recentUnits clamped to windowStart → only the 0.25h record = 10; burnRatePerHour = 10
  expect(p.burnRatePerHour).toBe(10);
  // (b) non-vacuous: unclamped windowSum(now-1h, now) WOULD include the pre-reset record
  const idx = seededIndex(records);
  const unclampedRecent = idx.windowSum(now - H, now);
  expect(unclampedRecent).toBe(510); // 500 + 10 — proves the clamp matters
});

test("projections: no-cap window skipped / empty caps returns []", () => {
  const caps = new MemCaps();
  // only week cap present → projections returns just the WK entry
  caps.putCap({ window: "week", cap: 500, resetAt: NOW + 3_600_000, pct: 20, scrapedAt: NOW });
  const svc = new UsageLimitsService(fakeIndex(50), caps, new StubProbe(null), new MemCredits());
  const proj = svc.projections(NOW);
  expect(proj).toHaveLength(1);
  expect(proj[0]!.window).toBe("WK");

  // empty caps → []
  const empty = new UsageLimitsService(
    fakeIndex(0),
    new MemCaps(),
    new StubProbe(null),
    new MemCredits(),
  );
  expect(empty.projections(NOW)).toEqual([]);
});
