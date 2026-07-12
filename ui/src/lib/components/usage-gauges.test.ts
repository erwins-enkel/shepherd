import { describe, it, expect } from "vitest";
import {
  compactUsageViews,
  codexTokenUsage,
  gaugeList,
  hotterGauge,
  overspending,
  providerSnapshots,
  gaugeColor,
  providerCapacityRows,
} from "./usage-gauges";
import type { UsageLimits, LimitWindow, CreditWindow } from "../types";

function w(pct: number, resetAt = 0): LimitWindow {
  return { pct, resetAt };
}
function limits(over: Partial<UsageLimits>): UsageLimits {
  return {
    session5h: null,
    week: null,
    perModelWeek: [],
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

const codexTokens = {
  provider: "codex" as const,
  kind: "tokens" as const,
  totalTokens: 12_000,
  session5hTokens: 1_000,
  weekTokens: 9_000,
  updatedAt: 123,
  stale: false,
  session5h: null,
  week: null,
};

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
        perModelWeek: [],
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
          perModelWeek: [],
          credits: null,
          stale: false,
          calibratedAt: null,
          subscriptionOnly: false,
        },
        codexTokens,
      ],
    });
    expect(codexTokenUsage(l)?.totalTokens).toBe(12_000);
  });
});

describe("compactUsageViews", () => {
  it("returns a Claude limit view for Claude-only normal gauges", () => {
    const views = compactUsageViews({
      gauges: gaugeList(limits({ session5h: w(10), week: w(20) })),
      claudeStale: false,
      perModel: [],
      credits: null,
      codexUsage: null,
    });

    expect(views.map((v) => `${v.provider}:${v.mode}:${v.widthClass}`)).toEqual([
      "claude:limits:bars",
    ]);
  });

  it("marks Claude limit compact views stale when the Claude snapshot is stale", () => {
    const views = compactUsageViews({
      gauges: gaugeList(limits({ session5h: w(10), week: w(20), stale: true })),
      claudeStale: true,
      perModel: [],
      credits: null,
      codexUsage: null,
    });

    expect(views).toMatchObject([{ provider: "claude", mode: "limits", stale: true }]);
  });

  it("returns a Codex limit view when Codex-only has rate-limit windows", () => {
    const views = compactUsageViews({
      gauges: [],
      claudeStale: false,
      perModel: [],
      credits: null,
      codexUsage: { ...codexTokens, session5h: w(7), week: w(9) },
    });

    expect(views.map((v) => `${v.provider}:${v.mode}:${v.widthClass}`)).toEqual([
      "codex:limits:bars",
    ]);
  });

  it("returns a Codex token fallback when Codex-only has no rate-limit windows", () => {
    const views = compactUsageViews({
      gauges: [],
      claudeStale: false,
      perModel: [],
      credits: null,
      codexUsage: codexTokens,
    });

    expect(views).toMatchObject([
      { provider: "codex", mode: "tokens", widthClass: "token", totalTokens: 12_000 },
    ]);
  });

  it("returns Claude plus Codex token fallback for both-provider token-only Codex", () => {
    const views = compactUsageViews({
      gauges: gaugeList(limits({ session5h: w(10), week: w(20) })),
      claudeStale: false,
      perModel: [],
      credits: null,
      codexUsage: codexTokens,
    });

    expect(views.map((v) => `${v.provider}:${v.mode}:${v.widthClass}`)).toEqual([
      "claude:limits:bars",
      "codex:tokens:token",
    ]);
    expect(views.every((v) => v.rotationEligible)).toBe(true);
  });

  it("returns Claude plus Codex limit views when both have rate-limit windows", () => {
    const views = compactUsageViews({
      gauges: gaugeList(limits({ session5h: w(10), week: w(20) })),
      claudeStale: false,
      perModel: [],
      credits: null,
      codexUsage: { ...codexTokens, session5h: w(7), week: w(9) },
    });

    expect(views.map((v) => `${v.provider}:${v.mode}:${v.widthClass}`)).toEqual([
      "claude:limits:bars",
      "codex:limits:bars",
    ]);
  });

  it("preserves the Claude credit compact view when a normal window is capped", () => {
    const views = compactUsageViews({
      gauges: gaugeList(limits({ session5h: w(100), week: w(20) })),
      claudeStale: false,
      perModel: [],
      credits: credit({ spent: 0.29 }),
      codexUsage: null,
    });

    expect(views.map((v) => `${v.provider}:${v.mode}:${v.widthClass}`)).toEqual([
      "claude:credit:credit",
    ]);
  });

  it("preserves the Claude per-model compact view when it is the only Claude signal", () => {
    const views = compactUsageViews({
      gauges: [],
      claudeStale: false,
      perModel: [{ model: "fable", pct: 7, resetAt: null, scrapedAt: 0, stale: false }],
      credits: null,
      codexUsage: null,
    });

    expect(views).toMatchObject([
      { provider: "claude", mode: "model", widthClass: "model", model: { model: "fable" } },
    ]);
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
  it("50 → muted", () => {
    expect(gaugeColor(50)).toBe("var(--color-muted)");
  });
  it("51 → amber", () => {
    expect(gaugeColor(51)).toBe("var(--color-amber)");
  });
  it("80 → amber", () => {
    expect(gaugeColor(80)).toBe("var(--color-amber)");
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

describe("providerCapacityRows", () => {
  it("returns per-window remaining room (5H then WK) for each provider", () => {
    const l = limits({
      session5h: w(30),
      week: w(60),
      providers: [
        {
          provider: "claude",
          kind: "limits",
          session5h: w(30),
          week: w(60),
          perModelWeek: [],
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
          session5h: w(20),
          week: w(80),
        },
      ],
    });

    expect(providerCapacityRows(l)).toEqual([
      {
        provider: "claude",
        windows: [
          { key: "5H", usedPct: 30, remainingPct: 70, resetAt: 0 },
          { key: "WK", usedPct: 60, remainingPct: 40, resetAt: 0 },
        ],
        available: true,
        stale: false,
      },
      {
        provider: "codex",
        windows: [
          { key: "5H", usedPct: 20, remainingPct: 80, resetAt: 0 },
          { key: "WK", usedPct: 80, remainingPct: 20, resetAt: 0 },
        ],
        available: true,
        stale: false,
      },
    ]);
  });

  it("marks Codex unavailable when no rollout limit windows exist", () => {
    const l = limits({
      session5h: w(30),
      week: w(60),
      providers: [
        {
          provider: "claude",
          kind: "limits",
          session5h: w(30),
          week: w(60),
          perModelWeek: [],
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
          session5h: null,
          week: null,
        },
      ],
    });

    expect(providerCapacityRows(l)[1]).toMatchObject({
      provider: "codex",
      available: false,
      windows: [],
    });
  });
});
