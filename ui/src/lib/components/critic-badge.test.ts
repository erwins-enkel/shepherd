import { describe, it, expect } from "vitest";
import { criticBadgeLabel, addressRoundInfo } from "./critic-badge";
import type { ReviewVerdict } from "$lib/types";

const base: ReviewVerdict = {
  sessionId: "s1",
  headSha: "abc",
  decision: "changes_requested",
  summary: "",
  body: "",
  findings: ["x"],
  addressRound: 0,
  addressCap: 3,
  finalRoundPending: false,
  finalRoundTimeoutMs: 900_000,
  updatedAt: 1_000_000,
};
const v = (p: Partial<ReviewVerdict>): ReviewVerdict => ({ ...base, ...p });

describe("criticBadgeLabel", () => {
  it("returns null when there is no verdict", () => expect(criticBadgeLabel(undefined)).toBeNull());
  it("maps changes_requested", () =>
    expect(criticBadgeLabel(v({ decision: "changes_requested" }))).not.toBeNull());
  it("maps commented", () => expect(criticBadgeLabel(v({ decision: "commented" }))).not.toBeNull());
  it("maps error", () => expect(criticBadgeLabel(v({ decision: "error" }))).not.toBeNull());
});

describe("addressRoundInfo", () => {
  it("returns null when no streak is in progress", () => {
    expect(addressRoundInfo(v({ addressRound: 0 }), 2_000_000)).toBeNull();
  });
  it("below the cap is an in-progress round", () => {
    expect(addressRoundInfo(v({ addressRound: 2 }), 2_000_000)).toEqual({
      round: 2,
      cap: 3,
      status: "round",
    });
  });
  it("at the cap but pending (within timeout) is the dimmed final round", () => {
    expect(
      addressRoundInfo(
        v({ addressRound: 3, finalRoundPending: true, updatedAt: 1_000_000 }),
        1_000_000 + 60_000,
      ),
    ).toEqual({ round: 3, cap: 3, status: "final" });
  });
  it("at the cap, held (not pending) is a confirmed stall", () => {
    expect(addressRoundInfo(v({ addressRound: 3, finalRoundPending: false }), 2_000_000)).toEqual({
      round: 3,
      cap: 3,
      status: "stalled",
    });
  });
  it("a pending final round past its timeout escalates to stalled", () => {
    expect(
      addressRoundInfo(
        v({ addressRound: 3, finalRoundPending: true, updatedAt: 1_000_000 }),
        1_000_000 + 900_000 + 1,
      ),
    ).toEqual({ round: 3, cap: 3, status: "stalled" });
  });
});
