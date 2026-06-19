import { describe, it, expect } from "vitest";
import { resolveFableArrival } from "./fable-arrival";

describe("resolveFableArrival", () => {
  it("shows once when eligible, unseen, and fable available", () => {
    expect(resolveFableArrival(true, false, true)).toEqual({ eligible: false, show: true });
  });

  it("treats undefined fableAvailable as available (no-flag default)", () => {
    expect(resolveFableArrival(true, false, undefined)).toEqual({ eligible: false, show: true });
  });

  it("does not show when fable is unavailable", () => {
    expect(resolveFableArrival(true, false, false)).toEqual({ eligible: false, show: false });
  });

  it("does not show when already seen/dismissed", () => {
    expect(resolveFableArrival(true, true, true)).toEqual({ eligible: false, show: false });
  });

  it("does nothing when not eligible", () => {
    expect(resolveFableArrival(false, false, true)).toEqual({ eligible: false, show: false });
  });

  // Regression: loadSettings() re-fires on tab return. The decision must be
  // one-shot so a second resolve (after the first showed + user dismissed →
  // seen=true) never re-shows the hero.
  it("is one-shot: a re-fire after dismissal does not re-show", () => {
    const first = resolveFableArrival(true, false, true);
    expect(first.show).toBe(true);
    // caller assigns eligible = first.eligible (false); user dismisses → seen = true
    const second = resolveFableArrival(first.eligible, true, true);
    expect(second).toEqual({ eligible: false, show: false });
  });

  // Even if the caller's flag somehow stayed eligible, a re-fire after the hero
  // was seen must still not re-show.
  it("never re-shows a seen arrival even if still flagged eligible", () => {
    expect(resolveFableArrival(true, true, true).show).toBe(false);
  });
});
