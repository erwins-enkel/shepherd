import { describe, expect, it } from "vitest";
import {
  bothAgentProvidersReady,
  capacitySuggestedProvider,
  claudeUsageHoldLikely,
} from "./provider-capacity";
import type { AgentProvider, DiagnosticsSnapshot, UsageLimits } from "./types";

function limits(session5hPct: number | null, weekPct: number | null): UsageLimits {
  return {
    session5h: session5hPct === null ? null : { pct: session5hPct, resetAt: 0 },
    week: weekPct === null ? null : { pct: weekPct, resetAt: 0 },
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
