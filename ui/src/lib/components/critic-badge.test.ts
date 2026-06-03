import { describe, it, expect } from "vitest";
import { criticBadgeLabel, addressRoundInfo } from "./critic-badge";
import type { ReviewVerdict } from "../types";

const v = (
  decision: ReviewVerdict["decision"],
  over: Partial<ReviewVerdict> = {},
): ReviewVerdict => ({
  sessionId: "s",
  headSha: "h",
  decision,
  summary: "",
  body: "",
  findings: [],
  addressRound: 0,
  addressCap: 3,
  updatedAt: 0,
  ...over,
});

describe("criticBadgeLabel", () => {
  it("returns null when there is no verdict", () => expect(criticBadgeLabel(undefined)).toBeNull());
  it("maps changes_requested", () =>
    expect(criticBadgeLabel(v("changes_requested"))).not.toBeNull());
  it("maps commented", () => expect(criticBadgeLabel(v("commented"))).not.toBeNull());
  it("maps error", () => expect(criticBadgeLabel(v("error"))).not.toBeNull());
});

describe("addressRoundInfo", () => {
  it("is null with no verdict", () => expect(addressRoundInfo(undefined)).toBeNull());
  it("is null when no auto-address round is in progress", () =>
    expect(addressRoundInfo(v("commented", { addressRound: 0 }))).toBeNull());
  it("reports the round while addressing under the cap", () => {
    const info = addressRoundInfo(v("changes_requested", { addressRound: 1, findings: ["x"] }));
    expect(info).toEqual({ round: 1, cap: 3, stalled: false });
  });
  it("flags stalled when the round hits the cap with findings still open", () => {
    const info = addressRoundInfo(
      v("changes_requested", { addressRound: 3, addressCap: 3, findings: ["still broken"] }),
    );
    expect(info?.stalled).toBe(true);
  });
  it("reads the cap off the verdict, not a hardcoded mirror", () => {
    // a deployment with a wider cap surfaces it on the verdict — badge math follows
    const info = addressRoundInfo(
      v("changes_requested", { addressRound: 4, addressCap: 5, findings: ["x"] }),
    );
    expect(info).toEqual({ round: 4, cap: 5, stalled: false });
  });
});
