import { describe, expect, it } from "vitest";
import {
  bothAgentProvidersReady,
  capacitySuggestedProvider,
  claudeUsageHoldLikely,
  providerFailoverOffer,
  readyAgentProviders,
  weeklyFreePct,
} from "./provider-capacity";
import type { AgentProvider, DiagnosticsSnapshot, UsageLimits } from "./types";

function limits(session5hPct: number | null, weekPct: number | null): UsageLimits {
  return {
    session5h: session5hPct === null ? null : { pct: session5hPct, resetAt: 0 },
    week: weekPct === null ? null : { pct: weekPct, resetAt: 0 },
    perModelWeek: [],
    credits: null,
    stale: false,
    calibratedAt: 0,
    subscriptionOnly: false,
  };
}

function diagnostics(states: Partial<Record<AgentProvider, "ok" | "optional" | "error">>) {
  return {
    checks: [
      { id: "claude", state: states.claude ?? "error", hintKey: "x" },
      { id: "codex", state: states.codex ?? "error", hintKey: "x" },
    ],
    generatedAt: 0,
    overall: "ok",
  } satisfies DiagnosticsSnapshot;
}

describe("claudeUsageHoldLikely", () => {
  it("trips when either Claude usage window reaches the hold threshold", () => {
    expect(claudeUsageHoldLikely(limits(81, 20), true, 80)).toBe(true);
    expect(claudeUsageHoldLikely(limits(20, 81), true, 80)).toBe(true);
  });

  it("stays false when disabled, below threshold, or usage is unknown", () => {
    expect(claudeUsageHoldLikely(limits(90, 90), false, 80)).toBe(false);
    expect(claudeUsageHoldLikely(limits(79, 20), true, 80)).toBe(false);
    expect(claudeUsageHoldLikely(null, true, 80)).toBe(false);
  });
});

describe("capacitySuggestedProvider", () => {
  it("switches from a held Claude default to Codex when both CLIs are ready", () => {
    expect(
      capacitySuggestedProvider(
        "claude",
        diagnostics({ claude: "ok", codex: "ok" }),
        new Set(["claude"]),
      ),
    ).toBe("codex");
  });

  it("switches from a held Codex default to Claude when both CLIs are ready", () => {
    expect(
      capacitySuggestedProvider(
        "codex",
        diagnostics({ claude: "ok", codex: "ok" }),
        new Set(["codex"]),
      ),
    ).toBe("claude");
  });

  it("keeps the default when the alternate CLI is not ready", () => {
    expect(
      capacitySuggestedProvider(
        "claude",
        diagnostics({ claude: "ok", codex: "optional" }),
        new Set(["claude"]),
      ),
    ).toBe("claude");
  });

  it("keeps the default when it is not currently held", () => {
    expect(
      capacitySuggestedProvider("claude", diagnostics({ claude: "ok", codex: "ok" }), new Set()),
    ).toBe("claude");
  });
});

describe("bothAgentProvidersReady", () => {
  it("requires both provider checks to be ok", () => {
    expect(bothAgentProvidersReady(diagnostics({ claude: "ok", codex: "ok" }))).toBe(true);
    expect(bothAgentProvidersReady(diagnostics({ claude: "ok", codex: "optional" }))).toBe(false);
  });
});

describe("readyAgentProviders", () => {
  it("returns every provider whose diagnostics check is ok", () => {
    expect(readyAgentProviders(diagnostics({ claude: "ok", codex: "ok" }))).toEqual([
      "claude",
      "codex",
    ]);
    expect(readyAgentProviders(diagnostics({ claude: "ok", codex: "optional" }))).toEqual([
      "claude",
    ]);
    expect(readyAgentProviders(diagnostics({ claude: "error", codex: "ok" }))).toEqual(["codex"]);
    expect(readyAgentProviders(diagnostics({ claude: "error", codex: "optional" }))).toEqual([]);
  });
});

// The same case table the server runs in test/provider-failover.test.ts. Both must agree —
// this is the prediction, that one is the decision.
function failoverLimits(free: { claude: number | null; codex: number | null }): UsageLimits {
  const week = (f: number | null) => (f === null ? null : { pct: 100 - f, resetAt: 0 });
  return {
    ...limits(null, null),
    week: week(free.claude),
    providers: [
      {
        provider: "claude",
        kind: "limits",
        session5h: null,
        week: week(free.claude),
        perModelWeek: [],
        credits: null,
        stale: false,
        calibratedAt: 0,
        subscriptionOnly: false,
      },
      {
        provider: "codex",
        kind: "tokens",
        totalTokens: 0,
        session5hTokens: 0,
        weekTokens: 0,
        updatedAt: null,
        stale: false,
        session5h: null,
        week: week(free.codex),
      },
    ],
  };
}

const READY = diagnostics({ claude: "ok", codex: "ok" });

describe("weeklyFreePct", () => {
  it("prefers the provider-confirmed observation over the computed window", () => {
    const l = failoverLimits({ claude: 79, codex: 23 });
    l.observed = { session5h: null, week: { pct: 90, resetAt: 0, scrapedAt: 0 } };
    expect(weeklyFreePct(l, "claude")).toBe(10);
  });

  it("reads codex from its provider snapshot", () => {
    expect(weeklyFreePct(failoverLimits({ claude: 79, codex: 23 }), "codex")).toBe(23);
  });

  it("is null when the provider has no weekly window", () => {
    expect(weeklyFreePct(failoverLimits({ claude: null, codex: 23 }), "claude")).toBeNull();
    expect(weeklyFreePct(null, "claude")).toBeNull();
  });
});

describe("providerFailoverOffer", () => {
  it("offers the counterpart when the default is out of weekly headroom", () => {
    expect(
      providerFailoverOffer(failoverLimits({ claude: 79, codex: 23 }), "codex", READY),
    ).toEqual({ from: "codex", to: "claude", fromFreePct: 23, toFreePct: 79 });
  });

  it("makes no offer when the default already is the cool provider", () => {
    expect(
      providerFailoverOffer(failoverLimits({ claude: 79, codex: 23 }), "claude", READY),
    ).toBeNull();
  });

  it("makes no offer when both are exhausted", () => {
    expect(
      providerFailoverOffer(failoverLimits({ claude: 23, codex: 23 }), "codex", READY),
    ).toBeNull();
  });

  it("makes no offer when either side is unmeasured", () => {
    expect(
      providerFailoverOffer(failoverLimits({ claude: null, codex: 23 }), "codex", READY),
    ).toBeNull();
    expect(
      providerFailoverOffer(failoverLimits({ claude: 79, codex: null }), "codex", READY),
    ).toBeNull();
  });

  it("treats the floor as room for the counterpart but not as exhaustion for the default", () => {
    expect(
      providerFailoverOffer(failoverLimits({ claude: 30, codex: 23 }), "codex", READY),
    ).not.toBeNull();
    expect(
      providerFailoverOffer(failoverLimits({ claude: 79, codex: 30 }), "codex", READY),
    ).toBeNull();
  });

  it("makes no offer when the counterpart is not ready", () => {
    expect(
      providerFailoverOffer(
        failoverLimits({ claude: 79, codex: 23 }),
        "codex",
        diagnostics({ claude: "error", codex: "ok" }),
      ),
    ).toBeNull();
  });

  it("still decides on stale readings (staleness dims, it never reroutes)", () => {
    const l = failoverLimits({ claude: 79, codex: 23 });
    l.stale = true;
    expect(providerFailoverOffer(l, "codex", READY)).not.toBeNull();
  });
});
