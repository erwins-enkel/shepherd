import { describe, it, expect } from "vitest";
import {
  codexTokenUsage,
  gaugeList,
  hotterGauge,
  overspending,
  providerSnapshots,
  gaugeColor,
} from "./usage-gauges";
import type { UsageLimits, LimitWindow, CreditWindow } from "../types";

function w(pct: number, resetAt = 0): LimitWindow {
  return { pct, resetAt };
}
function limits(over: Partial<UsageLimits>): UsageLimits {
  return {
    session5h: null,
    week: null,
    credits: null,
    stale: false,
    calibratedAt: null,
    subscriptionOnly: false,
    ...over,
  };
}
function credit(over: Partial<CreditWindow>): CreditWindow {
  return {
    pct: 0,
    spent: 0,
    cap: 50,
    currency: "€",
    resetAt: null,
    scrapedAt: 0,
    stale: false,
    ...over,
  };
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

describe("providerSnapshots", () => {
  it("falls back to a Claude provider snapshot for legacy payloads", () => {
    const l = limits({ session5h: w(10), week: w(20) });
    expect(providerSnapshots(l)).toEqual([
      {
        provider: "claude",
        kind: "limits",
        session5h: w(10),
        week: w(20),
        credits: null,
        stale: false,
        calibratedAt: null,
        subscriptionOnly: false,
      },
    ]);
  });

  it("extracts Codex token usage from provider payloads", () => {
    const l = limits({
      providers: [
        {
          provider: "claude",
          kind: "limits",
          session5h: null,
          week: null,
          credits: null,
          stale: false,
          calibratedAt: null,
          subscriptionOnly: false,
        },
        {
          provider: "codex",
          kind: "tokens",
          totalTokens: 12_000,
          session5hTokens: 1_000,
          weekTokens: 9_000,
          updatedAt: 123,
          stale: false,
        },
      ],
    });
    expect(codexTokenUsage(l)?.totalTokens).toBe(12_000);
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

describe("gaugeColor", () => {
  it("0 → muted", () => {
    expect(gaugeColor(0)).toBe("var(--color-muted)");
  });
  it("74 → muted", () => {
    expect(gaugeColor(74)).toBe("var(--color-muted)");
  });
  it("75 → amber", () => {
    expect(gaugeColor(75)).toBe("var(--color-amber)");
  });
  it("90 → amber", () => {
    expect(gaugeColor(90)).toBe("var(--color-amber)");
  });
  it("91 → red", () => {
    expect(gaugeColor(91)).toBe("var(--color-red)");
  });
  it("100 → red", () => {
    expect(gaugeColor(100)).toBe("var(--color-red)");
  });
});

describe("overspending", () => {
  it("is true on a fresh snapshot with real spend (pct may still round to 0)", () => {
    expect(overspending(limits({ credits: credit({ spent: 0.29, pct: 0, stale: false }) }))).toBe(
      true,
    );
  });
  it("is false when the snapshot is stale, even with spend", () => {
    expect(overspending(limits({ credits: credit({ spent: 5, stale: true }) }))).toBe(false);
  });
  it("is false when nothing has been spent", () => {
    expect(overspending(limits({ credits: credit({ spent: 0, stale: false }) }))).toBe(false);
  });
  it("is false when credits is null or limits is null", () => {
    expect(overspending(limits({ credits: null }))).toBe(false);
    expect(overspending(null)).toBe(false);
  });
});
