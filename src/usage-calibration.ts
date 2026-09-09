import { singleFlight } from "./single-flight";
import { calibrateDelay, type UsageLimits } from "./usage-limits";

export const STARTUP_CALIBRATION_DELAY_MS = 3_000;

export interface UsageCalibrationResult {
  limits: UsageLimits;
  scraped: boolean;
}

export interface UsageCalibrationSource {
  readonly lastScrapeAt: number;
  limits(now: number): UsageLimits;
  calibrate(now: number, refreshIndex?: () => Promise<void>): Promise<boolean>;
}

export interface UsageCalibrationClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UsageCalibrationDeps {
  usage: UsageCalibrationSource;
  refreshIndex(now: number): Promise<unknown>;
  publish(limits: UsageLimits): void;
  maintenanceActive(): boolean;
}

const systemClock: UsageCalibrationClock = {
  now: Date.now,
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Coordinates scheduled and user-requested `/usage` probes through one timer and one flight. */
export class UsageCalibrationCoordinator {
  private timer: unknown | null = null;
  private lastAttemptAt: number | null = null;
  private readonly runSingleFlight: () => Promise<UsageCalibrationResult>;

  constructor(
    private readonly deps: UsageCalibrationDeps,
    private readonly clock: UsageCalibrationClock = systemClock,
  ) {
    this.runSingleFlight = singleFlight(() => this.runAttempt());
  }

  /** Start the background loop with its short boot-time probe. */
  start(): void {
    this.arm(STARTUP_CALIBRATION_DELAY_MS);
  }

  /** Run or join the current probe. Manual calls and timer ticks share this entry point. */
  refresh(): Promise<UsageCalibrationResult> {
    return this.runSingleFlight();
  }

  private async runAttempt(): Promise<UsageCalibrationResult> {
    this.clearTimer();
    const attemptedAt = this.clock.now();
    this.lastAttemptAt = attemptedAt;
    let started = false;

    try {
      if (!this.deps.maintenanceActive()) {
        const pending = this.deps.usage.calibrate(attemptedAt, async () => {
          await this.deps.refreshIndex(attemptedAt);
        });
        // calibrate() marks refresh.inProgress synchronously before its first await.
        const loading = this.deps.usage.limits(this.clock.now());
        started = loading.refresh?.inProgress === true;
        if (started) this.publish(loading);
        try {
          await pending;
        } catch (error) {
          console.warn("[usage] calibration failed:", error);
        }
      }

      const limits = this.deps.usage.limits(this.clock.now());
      if (started) this.publish(limits);
      return {
        limits,
        scraped:
          started &&
          this.deps.usage.lastScrapeAt === attemptedAt &&
          limits.refresh?.failed !== true,
      };
    } finally {
      this.armNext();
    }
  }

  private armNext(): void {
    const now = this.clock.now();
    const limits = this.deps.usage.limits(now);
    const serviceAttempt = limits.refresh?.lastAttemptAt ?? null;
    const lastAttemptAt = Math.max(this.lastAttemptAt ?? -Infinity, serviceAttempt ?? -Infinity);
    const refresh = {
      inProgress: limits.refresh?.inProgress ?? false,
      failed: limits.refresh?.failed ?? false,
      lastAttemptAt: Number.isFinite(lastAttemptAt) ? lastAttemptAt : null,
    };
    this.arm(calibrateDelay({ ...limits, refresh }, now));
  }

  private arm(delay: number): void {
    this.clearTimer();
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      void this.refresh().catch((error) => console.warn("[usage] calibrate failed:", error));
    }, delay);
  }

  private publish(limits: UsageLimits): void {
    try {
      this.deps.publish(limits);
    } catch (error) {
      // A faulty event listener must not release the single-flight guard while the probe runs.
      console.warn("[usage] publish failed:", error);
    }
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }
}
