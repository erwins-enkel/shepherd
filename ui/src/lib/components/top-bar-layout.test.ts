import { describe, it, expect } from "vitest";
import { badgeCount, topBarPlan, type Mode, type ChromeState } from "./top-bar-layout";

// NOTE: desktop compaction is no longer count-based — it's measurement-driven at
// runtime in TopBar.svelte and covered by TopBar.browser.test.ts. The pure layer
// here only models touch-desktop (count-based, #322) + mobile; on desktop both
// plan flags are always false.

const MODES: Mode[] = ["mobile", "touch-desktop", "desktop"];

// Build every ChromeState from a 5-bit mask over the five badge-presence inputs.
// The halt e-stop is NOT a bar badge (it lives in the gear menu), so it never
// appears here.
const ALL = 0b11111; // all five badges present
function stateFromMask(mask: number): ChromeState {
  return {
    updateAvailable: !!(mask & 1),
    herdrUpdateAvailable: !!(mask & 2),
    learnings: mask & 4 ? 1 : 0,
    overBudget: 0,
    needsYou: mask & 8 ? 1 : 0,
    whatsNew: !!(mask & 16),
  };
}

// Reference implementation the matrix is checked against (mirrors the spec rules).
function expectedCount(s: ChromeState): number {
  return (
    (s.updateAvailable ? 1 : 0) +
    (s.herdrUpdateAvailable ? 1 : 0) +
    (s.learnings > 0 || s.overBudget > 0 ? 1 : 0) +
    (s.needsYou > 0 ? 1 : 0) +
    (s.whatsNew ? 1 : 0)
  );
}

describe("badgeCount", () => {
  it("counts each present badge once across all 32 presence combos", () => {
    for (let mask = 0; mask <= ALL; mask++) {
      const s = stateFromMask(mask);
      expect(badgeCount(s)).toBe(expectedCount(s));
    }
  });

  it("overBudget alone (no learnings) still counts the learnings badge", () => {
    expect(badgeCount({ ...stateFromMask(0), overBudget: 3 })).toBe(1);
  });
});

describe("topBarPlan — exhaustive 3 modes × 32 presence combos", () => {
  // Desktop compaction is measurement-driven (TopBar.svelte / TopBar.browser.test.ts),
  // so the pure layer always returns false for desktop here.
  it("hideClockTime only on touch-desktop (>=1 badge); desktop + mobile never", () => {
    for (const mode of MODES) {
      for (let mask = 0; mask <= ALL; mask++) {
        const s = stateFromMask(mask);
        const plan = topBarPlan(mode, s);
        const count = badgeCount(s);
        const expected = mode === "touch-desktop" && count > 0;
        expect(plan.hideClockTime).toBe(expected);
      }
    }
  });

  it("compactBadges only on touch-desktop (>=2 badges); desktop + mobile never", () => {
    for (const mode of MODES) {
      for (let mask = 0; mask <= ALL; mask++) {
        const s = stateFromMask(mask);
        const plan = topBarPlan(mode, s);
        const count = badgeCount(s);
        const expected = mode === "touch-desktop" && count >= 2;
        expect(plan.compactBadges).toBe(expected);
      }
    }
  });
});

describe("regression anchors (#322 / #247)", () => {
  it("lone LEARNINGS on touch-desktop drops the clock but does NOT compact", () => {
    const s = stateFromMask(0b00100); // learnings only
    const plan = topBarPlan("touch-desktop", s);
    expect(plan.hideClockTime).toBe(true);
    expect(plan.compactBadges).toBe(false);
  });

  it("two badges on touch-desktop compact the row", () => {
    const s = stateFromMask(0b01100); // learnings + needsYou
    expect(topBarPlan("touch-desktop", s).compactBadges).toBe(true);
  });

  it("desktop never sets crunch flags in the pure layer (measurement-driven instead)", () => {
    // Desktop compaction is decided by runtime pixel measurement in TopBar.svelte
    // (see measureFull/decideFromCache + TopBar.browser.test.ts), so the pure plan
    // is false for desktop at every badge count — including all five badges.
    const all = stateFromMask(ALL);
    const plan = topBarPlan("desktop", all);
    expect(plan.hideClockTime).toBe(false);
    expect(plan.compactBadges).toBe(false);
  });

  it("mobile never sets touch-desktop crunch flags", () => {
    const all = stateFromMask(ALL);
    const plan = topBarPlan("mobile", all);
    expect(plan.hideClockTime).toBe(false);
    expect(plan.compactBadges).toBe(false);
  });
});
