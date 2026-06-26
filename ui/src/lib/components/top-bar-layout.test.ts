import { describe, it, expect } from "vitest";
import { badgeCount, type ChromeState } from "./top-bar-layout";

// NOTE: compaction is no longer count-based for ANY mode — it's measurement-driven at
// runtime in TopBar.svelte (desktop AND touch-desktop) and covered by
// TopBar.browser.test.ts; mobile wraps via the component's `mobile` flag. So this pure
// layer no longer has a render-plan to test — only `badgeCount`, the content-change
// signal the measure effect tracks.

// Build every ChromeState from a 6-bit mask over the six badge-presence inputs.
// The halt e-stop is NOT a bar badge (it lives in the gear menu), so it never
// appears here.
const ALL = 0b111111; // all six badges present
function stateFromMask(mask: number): ChromeState {
  return {
    updateAvailable: !!(mask & 1),
    herdrUpdateAvailable: !!(mask & 2),
    needsYou: mask & 4 ? 1 : 0,
    whatsNew: !!(mask & 8),
    learnings: mask & 16 ? 1 : 0,
    held: mask & 32 ? 1 : 0,
  };
}

// Reference implementation the matrix is checked against (mirrors the spec rules).
function expectedCount(s: ChromeState): number {
  return (
    (s.updateAvailable ? 1 : 0) +
    (s.herdrUpdateAvailable ? 1 : 0) +
    (s.needsYou > 0 ? 1 : 0) +
    (s.whatsNew ? 1 : 0) +
    (s.learnings > 0 ? 1 : 0) +
    (s.held > 0 ? 1 : 0)
  );
}

describe("badgeCount", () => {
  it("counts each present badge once across all 64 presence combos", () => {
    for (let mask = 0; mask <= ALL; mask++) {
      const s = stateFromMask(mask);
      expect(badgeCount(s)).toBe(expectedCount(s));
    }
  });

  it("returns 0 for all-zero/all-false state", () => {
    const s: ChromeState = {
      updateAvailable: false,
      herdrUpdateAvailable: false,
      needsYou: 0,
      whatsNew: false,
      learnings: 0,
      held: 0,
    };
    expect(badgeCount(s)).toBe(0);
  });

  it("counts learnings badge: learnings:3 → 1, learnings:0 → 0", () => {
    const withLearnings: ChromeState = {
      updateAvailable: false,
      herdrUpdateAvailable: false,
      needsYou: 0,
      whatsNew: false,
      learnings: 3,
      held: 0,
    };
    expect(badgeCount(withLearnings)).toBe(1);

    const noLearnings: ChromeState = {
      updateAvailable: false,
      herdrUpdateAvailable: false,
      needsYou: 0,
      whatsNew: false,
      learnings: 0,
      held: 0,
    };
    expect(badgeCount(noLearnings)).toBe(0);
  });

  it("sums learnings with another badge: needsYou:1 + learnings:2 → 2", () => {
    const s: ChromeState = {
      updateAvailable: false,
      herdrUpdateAvailable: false,
      needsYou: 1,
      whatsNew: false,
      learnings: 2,
      held: 0,
    };
    expect(badgeCount(s)).toBe(2);
  });

  it("counts held badge: held:2 → 1, held:0 → 0", () => {
    const withHeld: ChromeState = {
      updateAvailable: false,
      herdrUpdateAvailable: false,
      needsYou: 0,
      whatsNew: false,
      learnings: 0,
      held: 2,
    };
    expect(badgeCount(withHeld)).toBe(1);

    const noHeld: ChromeState = { ...withHeld, held: 0 };
    expect(badgeCount(noHeld)).toBe(0);
  });
});
