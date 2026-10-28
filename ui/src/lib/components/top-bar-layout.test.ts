import { describe, it, expect } from "vitest";
import { badgeCount, usageTextWidthKey, type ChromeState } from "./top-bar-layout";
import type { CompactUsageView, Gauge } from "./usage-gauges";

// NOTE: compaction is no longer count-based for ANY mode — it's measurement-driven at
// runtime in TopBar.svelte (desktop AND touch-desktop) and covered by
// TopBar.browser.test.ts; mobile wraps via the component's `mobile` flag. So this pure
// layer no longer has a render-plan to test — only `badgeCount`, the content-change
// signal the measure effect tracks.

// Build every ChromeState from a 5-bit mask over the five badge-presence inputs.
// The halt e-stop is NOT a bar badge (it lives in the gear menu), so it never
// appears here.
const ALL = 0b11111; // all five badges present
function stateFromMask(mask: number): ChromeState {
  return {
    updateAvailable: !!(mask & 1),
    herdrUpdateAvailable: !!(mask & 2),
    whatsNew: !!(mask & 4),
    held: mask & 8 ? 1 : 0,
    codexUpdateAvailable: !!(mask & 16),
  };
}

// Reference implementation the matrix is checked against (mirrors the spec rules).
function expectedCount(s: ChromeState): number {
  return (
    (s.updateAvailable ? 1 : 0) +
    (s.herdrUpdateAvailable ? 1 : 0) +
    (s.codexUpdateAvailable ? 1 : 0) +
    (s.whatsNew ? 1 : 0) +
    (s.held > 0 ? 1 : 0)
  );
}

describe("badgeCount", () => {
  it("counts each present badge once across all 32 presence combos", () => {
    for (let mask = 0; mask <= ALL; mask++) {
      const s = stateFromMask(mask);
      expect(badgeCount(s)).toBe(expectedCount(s));
    }
  });

  it("returns 0 for all-zero/all-false state", () => {
    const s: ChromeState = {
      updateAvailable: false,
      herdrUpdateAvailable: false,
      codexUpdateAvailable: false,
      whatsNew: false,
      held: 0,
    };
    expect(badgeCount(s)).toBe(0);
  });

  it("counts held badge: held:2 → 1, held:0 → 0", () => {
    const withHeld: ChromeState = {
      updateAvailable: false,
      herdrUpdateAvailable: false,
      codexUpdateAvailable: false,
      whatsNew: false,
      held: 2,
    };
    expect(badgeCount(withHeld)).toBe(1);

    const noHeld: ChromeState = { ...withHeld, held: 0 };
    expect(badgeCount(noHeld)).toBe(0);
  });
});

describe("usageTextWidthKey — the measure effect's usage-text width signal", () => {
  const NOW = 1_700_000_000_000;
  const limitsView = (gauges: Gauge[]): CompactUsageView => ({
    provider: "claude",
    mode: "limits",
    gauges,
    stale: false,
    rotationEligible: false,
    widthClass: "bars",
  });
  const wk = (pct: number): Gauge => ({ label: "WK", w: { pct, resetAt: NOW + 3_600_000 } });

  it("keeps the key across a same-width percentage tick", () => {
    expect(usageTextWidthKey(limitsView([wk(86)]), "", NOW)).toBe(
      usageTextWidthKey(limitsView([wk(85)]), "", NOW),
    );
  });

  it("changes the key when the percentage gains a digit", () => {
    expect(usageTextWidthKey(limitsView([wk(10)]), "", NOW)).not.toBe(
      usageTextWidthKey(limitsView([wk(9)]), "", NOW),
    );
  });

  it("changes the key when an observed window flips to before-reset", () => {
    const observed: Gauge = {
      label: "WK",
      w: { pct: 85, resetAt: NOW + 1_000, scrapedAt: NOW - 1_000 },
    } as Gauge;
    const view = limitsView([observed]);
    expect(usageTextWidthKey(view, "", NOW + 2_000)).not.toBe(usageTextWidthKey(view, "", NOW));
  });

  it("changes the key when the credit amount widens", () => {
    const view: CompactUsageView = {
      provider: "claude",
      mode: "credit",
      stale: false,
      rotationEligible: false,
      widthClass: "credit",
    };
    expect(usageTextWidthKey(view, "$1234.56 / $5000.00", NOW)).not.toBe(
      usageTextWidthKey(view, "$9.99 / $10.00", NOW),
    );
  });

  it("changes the key when the token label widens", () => {
    const tokens = (totalTokens: number | null): CompactUsageView => ({
      provider: "codex",
      mode: "tokens",
      totalTokens,
      stale: false,
      rotationEligible: false,
      widthClass: "token",
    });
    expect(usageTextWidthKey(tokens(950), "", NOW)).not.toBe(
      usageTextWidthKey(tokens(null), "", NOW),
    );
  });
});
