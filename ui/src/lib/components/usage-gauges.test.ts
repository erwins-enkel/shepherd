import { describe, it, expect } from "vitest";
import { gaugeList, hotterGauge } from "./usage-gauges";
import type { UsageLimits, LimitWindow } from "../types";

function w(pct: number, resetAt = 0): LimitWindow {
  return { pct, resetAt };
}
function limits(over: Partial<UsageLimits>): UsageLimits {
  return { session5h: null, week: null, stale: false, calibratedAt: null, ...over };
}

describe("gaugeList", () => {
  it("is empty when no limits are present", () => {
    expect(gaugeList(null)).toEqual([]);
    expect(gaugeList(limits({}))).toEqual([]);
  });
  it("lists 5H before WK when both present", () => {
    const l = limits({ session5h: w(10), week: w(20) });
    expect(gaugeList(l).map((g) => g.label)).toEqual(["5H", "WK"]);
  });
  it("lists only the present window", () => {
    expect(gaugeList(limits({ week: w(20) })).map((g) => g.label)).toEqual(["WK"]);
    expect(gaugeList(limits({ session5h: w(10) })).map((g) => g.label)).toEqual(["5H"]);
  });
});

describe("hotterGauge", () => {
  it("returns null when nothing is present", () => {
    expect(hotterGauge(null)).toBeNull();
    expect(hotterGauge(limits({}))).toBeNull();
  });
  it("returns 5H when the 5-hour window is closer to its cap", () => {
    const g = hotterGauge(limits({ session5h: w(80), week: w(40) }));
    expect(g?.label).toBe("5H");
  });
  it("returns WK when the weekly window is closer to its cap", () => {
    const g = hotterGauge(limits({ session5h: w(40), week: w(80) }));
    expect(g?.label).toBe("WK");
  });
  it("breaks ties toward WK", () => {
    const g = hotterGauge(limits({ session5h: w(88), week: w(88) }));
    expect(g?.label).toBe("WK");
  });
  it("returns the only present window", () => {
    expect(hotterGauge(limits({ session5h: w(40) }))?.label).toBe("5H");
    expect(hotterGauge(limits({ week: w(40) }))?.label).toBe("WK");
  });
});
