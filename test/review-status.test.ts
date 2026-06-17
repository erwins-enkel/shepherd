import { describe, it, expect } from "bun:test";
import { addressStallStatus } from "../src/review-status";
import type { ReviewVerdict } from "../src/types";

/** Minimal ReviewVerdict fixture; only the fields addressStallStatus inspects. */
function makeVerdict(overrides: Partial<ReviewVerdict> = {}): ReviewVerdict {
  return {
    sessionId: "s1",
    headSha: "abc123",
    patchId: "p1",
    decision: "changes_requested",
    summary: "test",
    body: "body",
    findings: ["finding 1"],
    addressRound: 1,
    addressCap: 3,
    streakReviews: 1,
    reviewedPatchIds: [],
    errorRound: 0,
    finalRoundPending: false,
    finalRoundTimeoutMs: 15 * 60 * 1000,
    seenNoteIds: [],
    updatedAt: Date.now(),
    ...overrides,
  };
}

const NOW = 1_000_000_000_000;

describe("addressStallStatus", () => {
  it('returns "round" when round < cap', () => {
    const v = makeVerdict({ addressRound: 1, addressCap: 3, findings: ["f1"], updatedAt: NOW });
    expect(addressStallStatus(v, NOW)).toBe("round");
  });

  it('returns "stalled" when at cap with findings and finalRoundPending=false', () => {
    const v = makeVerdict({
      addressRound: 3,
      addressCap: 3,
      findings: ["f1"],
      finalRoundPending: false,
      updatedAt: NOW,
    });
    expect(addressStallStatus(v, NOW)).toBe("stalled");
  });

  it('returns "final" when at cap, finalRoundPending=true, and updatedAt is recent', () => {
    const v = makeVerdict({
      addressRound: 3,
      addressCap: 3,
      findings: ["f1"],
      finalRoundPending: true,
      finalRoundTimeoutMs: 15 * 60 * 1000,
      updatedAt: NOW - 60_000, // 1 minute ago — well within timeout
    });
    expect(addressStallStatus(v, NOW)).toBe("final");
  });

  it('returns "stalled" when at cap, finalRoundPending=true, but updatedAt older than finalRoundTimeoutMs', () => {
    const v = makeVerdict({
      addressRound: 3,
      addressCap: 3,
      findings: ["f1"],
      finalRoundPending: true,
      finalRoundTimeoutMs: 15 * 60 * 1000,
      updatedAt: NOW - 20 * 60 * 1000, // 20 minutes ago — timed out
    });
    expect(addressStallStatus(v, NOW)).toBe("stalled");
  });

  it('returns "round" when at cap but findings is empty (transient error case)', () => {
    const v = makeVerdict({
      addressRound: 3,
      addressCap: 3,
      findings: [],
      finalRoundPending: false,
      updatedAt: NOW,
    });
    expect(addressStallStatus(v, NOW)).toBe("round");
  });

  it("clamps round to cap when addressRound exceeds cap", () => {
    // addressRound=4, cap=3 → clamped round=3 which equals cap, so escalates
    const v = makeVerdict({
      addressRound: 4,
      addressCap: 3,
      findings: ["f1"],
      finalRoundPending: false,
      updatedAt: NOW,
    });
    expect(addressStallStatus(v, NOW)).toBe("stalled");
  });
});
