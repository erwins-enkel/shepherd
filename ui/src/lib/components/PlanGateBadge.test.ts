import { describe, it, expect } from "vitest";
import { planGateChip, canRelease } from "./plan-gate-badge";
import type { PlanGate, Session } from "$lib/types";

const baseGate: PlanGate = {
  sessionId: "s1",
  planHash: "h",
  decision: "changes_requested",
  summary: "",
  body: "",
  findings: [],
  round: 1,
  cap: 3,
  approved: false,
  plan: "",
  updatedAt: 1_000_000,
};
const gate = (p: Partial<PlanGate>): PlanGate => ({ ...baseGate, ...p });
const sess = (planPhase: Session["planPhase"]): Pick<Session, "planPhase"> => ({ planPhase });

describe("planGateChip", () => {
  it("hides when planPhase is null", () => {
    expect(planGateChip(sess(null), undefined, false).kind).toBe("none");
  });

  it("shows view chip when executing with a persisted gate (issue #809)", () => {
    expect(planGateChip(sess("executing"), gate({ approved: true }), false)).toEqual({
      kind: "view",
    });
  });

  it("shows view chip when executing even if changes_requested verdict in gate cache (reconnect scenario)", () => {
    // Simulates a client that reconnected after planPhase flipped to "executing":
    // the gate cache is repopulated with a stale changes_requested verdict, but
    // planPhase is persisted as "executing" — the signed-off plan is still viewable
    // read-only (issue #809).
    const staleGate = gate({ decision: "changes_requested", round: 2, cap: 3, approved: false });
    expect(planGateChip(sess("executing"), staleGate, false)).toEqual({ kind: "view" });
  });

  it("hides when executing with no gate", () => {
    expect(planGateChip(sess("executing"), undefined, false)).toEqual({ kind: "none" });
    // ...regardless of allowView — there's nothing to view.
    expect(planGateChip(sess("executing"), undefined, false, { allowView: false })).toEqual({
      kind: "none",
    });
  });

  it("suppresses the executing view chip when allowView is false (dense list surfaces)", () => {
    // UnitRow/UnitTile pass allowView:false so the read-only PLAN chip stays off the
    // crowded session cards; it then lives only in the per-session top bar.
    expect(
      planGateChip(sess("executing"), gate({ approved: true }), false, { allowView: false }),
    ).toEqual({ kind: "none" });
    // explicit allowView:true matches the default (top-bar) behavior.
    expect(
      planGateChip(sess("executing"), gate({ approved: true }), false, { allowView: true }),
    ).toEqual({ kind: "view" });
  });

  it("allowView only affects the executing view chip, not lifecycle states", () => {
    // A list surface still shows pre-execution lifecycle states even with allowView:false.
    expect(
      planGateChip(sess("planning"), gate({ approved: true, decision: "approved" }), false, {
        allowView: false,
      }).kind,
    ).toBe("ready");
    expect(
      planGateChip(
        sess("planning"),
        gate({ decision: "changes_requested", round: 1, cap: 3 }),
        false,
        {
          allowView: false,
        },
      ).kind,
    ).toBe("changes");
  });

  it("reviewing wins over a stale verdict", () => {
    const chip = planGateChip(sess("planning"), gate({ approved: true }), true);
    expect(chip.kind).toBe("reviewing");
  });

  it("changes_requested surfaces the round/cap counter", () => {
    const chip = planGateChip(
      sess("planning"),
      gate({ decision: "changes_requested", round: 2, cap: 4 }),
      false,
    );
    expect(chip).toEqual({ kind: "changes", round: 2, cap: 4 });
  });

  it("approved + planning → ready", () => {
    const chip = planGateChip(
      sess("planning"),
      gate({ approved: true, decision: "approved" }),
      false,
    );
    expect(chip.kind).toBe("ready");
  });

  it("error verdict → error", () => {
    const chip = planGateChip(
      sess("planning"),
      gate({ decision: "error", approved: false }),
      false,
    );
    expect(chip.kind).toBe("error");
  });

  it("planning with no gate yet → planning", () => {
    expect(planGateChip(sess("planning"), undefined, false).kind).toBe("planning");
  });
});

describe("canRelease", () => {
  it("true only when approved and still planning", () => {
    expect(canRelease(sess("planning"), gate({ approved: true }))).toBe(true);
  });
  it("false when not approved", () => {
    expect(canRelease(sess("planning"), gate({ approved: false }))).toBe(false);
  });
  it("false when no gate", () => {
    expect(canRelease(sess("planning"), undefined)).toBe(false);
  });
  it("false once executing", () => {
    expect(canRelease(sess("executing"), gate({ approved: true }))).toBe(false);
  });
});
