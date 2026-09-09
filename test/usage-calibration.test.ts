import { expect, spyOn, test } from "bun:test";
import {
  STARTUP_CALIBRATION_DELAY_MS,
  UsageCalibrationCoordinator,
  type UsageCalibrationClock,
  type UsageCalibrationSource,
} from "../src/usage-calibration";
import type { UsageLimits, UsageRefreshStatus } from "../src/usage-limits";

const MINUTE = 60_000;

class FakeClock implements UsageCalibrationClock {
  nowMs = 1_000_000;
  private nextId = 1;
  private timers = new Map<number, { at: number; callback: () => void }>();

  now = () => this.nowMs;

  setTimeout = (callback: () => void, delay: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.nowMs + delay, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  get pendingCount(): number {
    return this.timers.size;
  }

  get nextDelay(): number | null {
    const next = [...this.timers.values()].sort((a, b) => a.at - b.at)[0];
    return next ? next.at - this.nowMs : null;
  }

  fireNext(at = [...this.timers.values()].sort((a, b) => a.at - b.at)[0]?.at): void {
    if (at == null) throw new Error("no pending timer");
    this.nowMs = at;
    const due = [...this.timers.entries()]
      .filter(([, timer]) => timer.at <= at)
      .sort((a, b) => a[1].at - b[1].at)[0];
    if (!due) throw new Error("no timer due");
    this.timers.delete(due[0]);
    due[1].callback();
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function snapshot(refresh: UsageRefreshStatus, resetAt: number | null = null): UsageLimits {
  return {
    observed: {
      session5h:
        resetAt == null ? null : { pct: 25, resetAt, scrapedAt: refresh.lastAttemptAt ?? 0 },
      week: null,
    },
    refresh,
    session5h: null,
    week: null,
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
  };
}

class FakeUsage implements UsageCalibrationSource {
  refresh: UsageRefreshStatus = { inProgress: false, failed: false, lastAttemptAt: null };
  resetAt: number | null = null;
  lastScrapeAt = 0;
  attempts: number[] = [];
  run: (now: number) => Promise<void> = async () => {
    this.lastScrapeAt = this.refresh.lastAttemptAt ?? 0;
  };

  limits = () => snapshot(this.refresh, this.resetAt);

  async calibrate(now: number, refreshIndex?: () => Promise<void>): Promise<boolean> {
    this.attempts.push(now);
    this.refresh = { inProgress: true, failed: false, lastAttemptAt: now };
    try {
      await refreshIndex?.();
      await this.run(now);
      return true;
    } catch (error) {
      this.refresh = { ...this.refresh, failed: true };
      throw error;
    } finally {
      this.refresh = { ...this.refresh, inProgress: false };
    }
  }
}

function coordinator(
  usage: FakeUsage,
  clock: FakeClock,
  options: {
    publish?: (limits: UsageLimits) => void;
    refreshIndex?: (now: number) => Promise<void>;
    maintenanceActive?: () => boolean;
  } = {},
) {
  return new UsageCalibrationCoordinator(
    {
      usage,
      refreshIndex: options.refreshIndex ?? (async () => {}),
      publish: options.publish ?? (() => {}),
      maintenanceActive: options.maintenanceActive ?? (() => false),
    },
    clock,
  );
}

test("usage calibration: startup waits three seconds, then regular probes stay five minutes apart", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  const scheduler = coordinator(usage, clock);

  scheduler.start();
  expect(clock.nextDelay).toBe(STARTUP_CALIBRATION_DELAY_MS);

  clock.fireNext();
  await flush();
  expect(usage.attempts).toEqual([1_003_000]);
  expect(clock.nextDelay).toBe(5 * MINUTE);
  expect(clock.pendingCount).toBe(1);
});

test("usage calibration: near a reset it probes each minute and a late timer still probes the crossed boundary", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  usage.resetAt = clock.nowMs + 2 * MINUTE;
  const scheduler = coordinator(usage, clock);

  await scheduler.refresh();
  expect(clock.nextDelay).toBe(MINUTE);

  clock.fireNext(clock.nowMs + 3 * MINUTE);
  await flush();
  expect(usage.attempts).toEqual([1_000_000, 1_180_000]);
  expect(clock.nextDelay).toBe(MINUTE);
  expect(clock.pendingCount).toBe(1);
});

test("usage calibration: a manual refresh and timer tick coalesce onto one probe", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  let release!: () => void;
  usage.run = async () => new Promise<void>((resolve) => (release = resolve));
  const scheduler = coordinator(usage, clock);

  scheduler.start();
  clock.fireNext();
  await flush();
  const manual = scheduler.refresh();
  expect(usage.attempts).toHaveLength(1);

  release();
  await manual;
  expect(clock.pendingCount).toBe(1);
});

test("usage calibration: a throwing publisher cannot release the flight before the probe settles", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  let release!: () => void;
  usage.run = async () => new Promise<void>((resolve) => (release = resolve));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const scheduler = coordinator(usage, clock, {
    publish: () => {
      throw new Error("listener failed");
    },
  });

  const first = scheduler.refresh();
  await flush();
  const second = scheduler.refresh();
  expect(usage.attempts).toHaveLength(1);

  release();
  await Promise.all([first, second]);
  warn.mockRestore();
  expect(clock.pendingCount).toBe(1);
});

test("usage calibration: manual completion replaces a stale long timer after the observed reset moves closer", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  const scheduler = coordinator(usage, clock);

  const initial = await scheduler.refresh();
  expect(initial.scraped).toBe(true);
  expect(clock.nextDelay).toBe(5 * MINUTE);

  clock.nowMs += 10_000;
  usage.run = async () => {
    usage.lastScrapeAt = usage.refresh.lastAttemptAt!;
    usage.resetAt = clock.nowMs + 2 * MINUTE;
  };
  await scheduler.refresh();

  expect(clock.nextDelay).toBe(MINUTE);
  expect(clock.pendingCount).toBe(1);
});

test("usage calibration: a failed refresh publishes its loading and failed states and retries on a bounded cadence", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  usage.resetAt = clock.nowMs - 1;
  const published: UsageLimits[] = [];
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const scheduler = coordinator(usage, clock, {
    publish: (limits) => published.push(limits),
    refreshIndex: async () => {
      throw new Error("index unavailable");
    },
  });

  const result = await scheduler.refresh();
  warn.mockRestore();

  expect(published.map((limits) => limits.refresh)).toEqual([
    { inProgress: true, failed: false, lastAttemptAt: 1_000_000 },
    { inProgress: false, failed: true, lastAttemptAt: 1_000_000 },
  ]);
  expect(result.scraped).toBe(false);
  expect(clock.nextDelay).toBe(MINUTE);
  expect(clock.pendingCount).toBe(1);
});

test("usage calibration: maintenance skips are throttled even though the usage service records no attempt", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  usage.resetAt = clock.nowMs - 1;
  const scheduler = coordinator(usage, clock, { maintenanceActive: () => true });

  const result = await scheduler.refresh();

  expect(result.scraped).toBe(false);
  expect(usage.attempts).toEqual([]);
  expect(clock.nextDelay).toBe(MINUTE);
  expect(clock.pendingCount).toBe(1);
});

test("usage calibration: scraped requires this attempt's frame and a non-failed final refresh", async () => {
  const clock = new FakeClock();
  const usage = new FakeUsage();
  usage.lastScrapeAt = clock.nowMs;
  usage.run = async () => {
    usage.lastScrapeAt = usage.refresh.lastAttemptAt!;
    usage.refresh = { ...usage.refresh, failed: true };
  };
  const scheduler = coordinator(usage, clock);

  const result = await scheduler.refresh();

  expect(result.scraped).toBe(false);
});
