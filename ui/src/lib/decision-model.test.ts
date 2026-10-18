import { describe, it, expect } from "vitest";
import {
  activeFeatureCount,
  decisionModelState,
  decisionModelSummary,
  formatUsd,
  keyRejection,
  type DecisionModelFeatures,
} from "./decision-model";
import type { JudgeConnectionStatus } from "./types";

const OFF: DecisionModelFeatures = {
  judgeEnabled: false,
  upNextReadiness: false,
  blockJudgeMode: "off",
};
const ON: DecisionModelFeatures = {
  judgeEnabled: true,
  upNextReadiness: false,
  blockJudgeMode: "off",
};

function status(over: Partial<JudgeConnectionStatus> = {}): JudgeConnectionStatus {
  return {
    keySource: "stored",
    keyLast4: "cdef",
    keySavedAt: 1,
    staleKeyHost: null,
    lastVerify: { result: "ok", at: 100, status: null },
    models: [],
    model: "jev-1.13.0",
    baseUrl: "https://api.typesafe.ai",
    timeoutMs: 8000,
    defaults: { model: "jev-1.13.0", baseUrl: "https://api.typesafe.ai", timeoutMs: 8000 },
    env: { key: false, model: false, baseUrl: false, timeoutMs: false },
    authFailure: null,
    lastOkAt: null,
    today: { day: "2026-10-18", calls: 3, usd: 0.14, ceilingUsd: 1 },
    ...over,
  };
}

describe("decisionModelState", () => {
  it("is not connected without a status or without a key", () => {
    expect(decisionModelState(null, ON)).toBe("notConnected");
    expect(decisionModelState(status({ keySource: "none" }), ON)).toBe("notConnected");
  });

  it("is ready with a key and nothing switched on, active once something is", () => {
    expect(decisionModelState(status(), OFF)).toBe("ready");
    expect(decisionModelState(status(), ON)).toBe("active");
    expect(decisionModelState(status(), { ...OFF, blockJudgeMode: "shadow" })).toBe("active");
  });

  it("reports the limit only while something would spend against it", () => {
    const spent = status({ today: { day: "d", calls: 9, usd: 1, ceilingUsd: 1 } });
    expect(decisionModelState(spent, ON)).toBe("limitReached");
    expect(decisionModelState(spent, OFF)).toBe("ready");
  });

  it("puts a rejected key before everything else but a missing one", () => {
    const refused = status({
      authFailure: { status: 401, at: 200 },
      today: { day: "d", calls: 9, usd: 1, ceilingUsd: 1 },
    });
    expect(decisionModelState(refused, ON)).toBe("keyRejected");
    expect(decisionModelState({ ...refused, keySource: "none" }, ON)).toBe("notConnected");
  });
});

describe("keyRejection", () => {
  it("takes the newest refusal, from a real call or from a check", () => {
    expect(keyRejection(status({ authFailure: { status: 401, at: 200 } }))).toEqual({
      at: 200,
      status: 401,
    });
    expect(
      keyRejection(status({ lastVerify: { result: "rejected", at: 300, status: 403 } })),
    ).toEqual({ at: 300, status: 403 });
  });

  it("clears once something succeeded after it", () => {
    expect(
      keyRejection(status({ authFailure: { status: 401, at: 200 }, lastOkAt: 250 })),
    ).toBeNull();
    expect(
      keyRejection(
        status({
          authFailure: { status: 401, at: 200 },
          lastVerify: { result: "ok", at: 400, status: null },
        }),
      ),
    ).toBeNull();
  });

  it("does not read an unreachable check as a rejected key", () => {
    expect(
      keyRejection(status({ lastVerify: { result: "unreachable", at: 300, status: null } })),
    ).toBeNull();
  });
});

describe("activeFeatureCount", () => {
  it("counts Up Next readiness only while the stop classifier carries it", () => {
    expect(activeFeatureCount({ ...OFF, upNextReadiness: true })).toBe(0);
    expect(activeFeatureCount({ ...ON, upNextReadiness: true })).toBe(2);
    expect(
      activeFeatureCount({ judgeEnabled: true, upNextReadiness: true, blockJudgeMode: "armed" }),
    ).toBe(3);
  });
});

describe("summary and money", () => {
  it("names JEV in every mobile summary", () => {
    for (const [s, f] of [
      [null, OFF],
      [status(), OFF],
      [status(), ON],
      [status({ authFailure: { status: 401, at: 900 } }), ON],
    ] as const) {
      expect(decisionModelSummary(s, f)).toContain("JEV");
    }
    expect(decisionModelSummary(status(), ON)).toContain("$0.14");
  });

  it("shows sub-cent spend instead of rounding it to nothing", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.00056)).toBe("$0.0006");
    expect(formatUsd(1)).toBe("$1.00");
  });
});
