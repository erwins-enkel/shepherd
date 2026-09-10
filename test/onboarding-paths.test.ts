import { expect, test } from "bun:test";
import {
  onboardingLastRunMarker,
  onboardingRunAgeMs,
  onboardingTimerUnit,
} from "../src/onboarding-paths";

test("the run marker sits in the host-global Shepherd state dir, next to the host lock", () => {
  expect(onboardingLastRunMarker({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toBe(
    "/home/x/.shepherd/onboarding-harness.last-run",
  );
});

test("SHEPHERD_STATE_DIR relocates the marker, so writer and reader can be pointed at a temp dir", () => {
  expect(
    onboardingLastRunMarker({ HOME: "/home/x", SHEPHERD_STATE_DIR: "/tmp/s" } as NodeJS.ProcessEnv),
  ).toBe("/tmp/s/onboarding-harness.last-run");
});

test("the timer unit path is the real systemd user unit — its presence is the host gate", () => {
  expect(onboardingTimerUnit({ HOME: "/home/x" } as NodeJS.ProcessEnv)).toBe(
    "/home/x/.config/systemd/user/shepherd-onboarding.timer",
  );
});

test("run age is measured from the marker's ISO timestamp", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  expect(onboardingRunAgeMs("2026-09-09T09:00:00Z", now)).toBe(3 * 60 * 60 * 1000);
  expect(onboardingRunAgeMs("  2026-09-09T09:00:00Z\n", now)).toBe(3 * 60 * 60 * 1000);
});

// An unreadable marker must never pass for a fresh one — that is the whole failure
// being closed here, so it fails towards "tell someone".
test("an absent, empty or corrupt marker reads as no-usable-timestamp, not as fresh", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  expect(onboardingRunAgeMs(null, now)).toBeNull();
  expect(onboardingRunAgeMs("", now)).toBeNull();
  expect(onboardingRunAgeMs("not a date", now)).toBeNull();
});
