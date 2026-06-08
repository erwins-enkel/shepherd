import { describe, it, expect } from "vitest";
import { criticBadgeLabel, addressRoundInfo, criticChip } from "./critic-badge";
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
  it("a transient error verdict mid-streak keeps showing the in-progress round (no flicker)", () => {
    // error verdict holds the round (addressRound > 0) but carries no findings
    expect(addressRoundInfo(v({ addressRound: 2, findings: [] }), 2_000_000)).toEqual({
      round: 2,
      cap: 3,
      status: "round",
    });
  });
  it("a transient error verdict AT the cap is not mis-escalated to stalled", () => {
    expect(
      addressRoundInfo(v({ addressRound: 3, findings: [], finalRoundPending: false }), 2_000_000),
    ).toEqual({ round: 3, cap: 3, status: "round" });
  });
  it("clamps the displayed round to the cap when the cap was lowered mid-streak", () => {
    // operator dropped the global cap to 2 while a round-3 streak was in flight: the
    // verdict holds addressRound=3 against the new addressCap=2 — show "2/2", not "3/2".
    expect(
      addressRoundInfo(v({ addressRound: 3, addressCap: 2, finalRoundPending: false }), 2_000_000),
    ).toEqual({ round: 2, cap: 2, status: "stalled" });
  });
});

describe("criticChip", () => {
  it("reviewing wins over a verdict; body present → findings readable", () => {
    expect(criticChip(v({ decision: "changes_requested", body: "## findings" }), true)).toEqual({
      kind: "reviewing",
      hasFindings: true,
    });
  });
  it("reviewing with a verdict but no body → no findings to read", () => {
    expect(criticChip(v({ decision: "changes_requested", body: "" }), true)).toEqual({
      kind: "reviewing",
      hasFindings: false,
    });
  });
  it("reviewing with no verdict at all → reviewing, no findings", () => {
    expect(criticChip(undefined, true)).toEqual({ kind: "reviewing", hasFindings: false });
  });
  it("not reviewing with a verdict → the verdict chip", () => {
    expect(criticChip(v({ decision: "changes_requested", body: "x" }), false)).toEqual({
      kind: "verdict",
      decision: "changes_requested",
      label: criticBadgeLabel(v({ decision: "changes_requested" })),
    });
  });
  it("not reviewing with no verdict → none", () => {
    expect(criticChip(undefined, false)).toEqual({ kind: "none" });
  });
  it("not reviewing with an error verdict → the verdict chip", () => {
    expect(criticChip(v({ decision: "error", body: "x" }), false)).toEqual({
      kind: "verdict",
      decision: "error",
      label: criticBadgeLabel(v({ decision: "error" })),
    });
  });
});
