import { describe, it, expect } from "vitest";
import {
  REVEAL_PX,
  OPEN_RATIO,
  lockAxis,
  clampOffset,
  snapOffset,
  pressDecom,
  paneSwipeOutcome,
  resistOffset,
  PANE_FLICK_VELOCITY,
  isSwipeUp,
  FULL_SWIPE_RATIO,
  fullSwipeThreshold,
  releaseOutcome,
} from "./swipe";

describe("lockAxis", () => {
  it("stays unlocked until movement exceeds slop", () => expect(lockAxis(4, 3, 10)).toBeNull());
  it("locks horizontal when dx dominates past slop", () => expect(lockAxis(20, 3, 10)).toBe("x"));
  it("locks vertical when dy dominates past slop", () => expect(lockAxis(3, 20, 10)).toBe("y"));
  it("a vertical-dominant move never locks to x (scroll wins ties toward y)", () =>
    expect(lockAxis(12, 12, 10)).toBe("y"));
});

describe("clampOffset", () => {
  it("clamps rightward drag (positive) to 0 — left-only reveal", () =>
    expect(clampOffset(40)).toBe(0));
  it("passes a partial left drag through", () => expect(clampOffset(-30)).toBe(-30));
  it("clamps past the reveal width", () => expect(clampOffset(-9999)).toBe(-REVEAL_PX));
  it("clamps to a custom max (full-swipe row width)", () => {
    expect(clampOffset(-200, 360)).toBe(-200);
    expect(clampOffset(-9999, 360)).toBe(-360);
  });
});

describe("fullSwipeThreshold", () => {
  it("is the ratio of the row width", () =>
    expect(fullSwipeThreshold(400)).toBe(400 * FULL_SWIPE_RATIO));
  it("never sits within 40px of the reveal on a narrow row", () =>
    expect(fullSwipeThreshold(150)).toBe(REVEAL_PX + 40));
});

describe("releaseOutcome", () => {
  const W = 400;
  const full = fullSwipeThreshold(W);
  it("closes a short drag", () => expect(releaseOutcome(-10, W)).toBe("closed"));
  it("opens past the open ratio", () =>
    expect(releaseOutcome(-(REVEAL_PX * OPEN_RATIO), W)).toBe("open"));
  it("stays open just under the full-swipe threshold", () =>
    expect(releaseOutcome(-full + 1, W)).toBe("open"));
  it("a cancelled gesture past the threshold settles open, never full", () =>
    expect(releaseOutcome(-W, W, true)).toBe("open"));
  it("decommissions at/after the full-swipe threshold", () => {
    expect(releaseOutcome(-full, W)).toBe("full");
    expect(releaseOutcome(-W, W)).toBe("full");
  });
});

describe("snapOffset", () => {
  it("snaps closed below the open ratio", () =>
    expect(snapOffset(-(REVEAL_PX * OPEN_RATIO) + 1)).toBe(0));
  it("snaps open at/after the open ratio", () =>
    expect(snapOffset(-(REVEAL_PX * OPEN_RATIO))).toBe(-REVEAL_PX));
  it("snaps a full drag open", () => expect(snapOffset(-REVEAL_PX)).toBe(-REVEAL_PX));
});

describe("paneSwipeOutcome (pane swipe: right = list, left = next)", () => {
  const T = 90; // commit threshold (px)
  const V = PANE_FLICK_VELOCITY;
  it("short slow drag in either direction commits to nothing", () => {
    expect(paneSwipeOutcome(40, 0, T, true, true)).toBe("none");
    expect(paneSwipeOutcome(-40, 0, T, true, true)).toBe("none");
  });
  it("rightward past threshold always goes back to the list", () =>
    expect(paneSwipeOutcome(T, 0, T, true, true)).toBe("back"));
  it("rightward no-ops without a back target", () =>
    expect(paneSwipeOutcome(T, 0, T, false, true)).toBe("none"));
  it("leftward past threshold pages to the next agent", () =>
    expect(paneSwipeOutcome(-T, 0, T, true, true)).toBe("next"));
  it("leftward no-ops when there's no agent to page to", () =>
    expect(paneSwipeOutcome(-T, 0, T, true, false)).toBe("none"));
  it("a fast flick commits a short drag", () => {
    expect(paneSwipeOutcome(40, V, T, true, true)).toBe("back");
    expect(paneSwipeOutcome(-40, -V, T, true, true)).toBe("next");
  });
  it("a flick against the drag direction does not commit", () =>
    expect(paneSwipeOutcome(40, -V, T, true, true)).toBe("none"));
  it("a flick under the minimum travel does not commit", () =>
    expect(paneSwipeOutcome(20, V, T, true, true)).toBe("none"));
});

describe("resistOffset", () => {
  it("follows the finger 1:1 up to the soft limit", () => {
    expect(resistOffset(100)).toBe(100);
    expect(resistOffset(-140)).toBe(-140);
  });
  it("damps past the soft limit and keeps the sign", () => {
    expect(resistOffset(240)).toBeCloseTo(175);
    expect(resistOffset(-240)).toBeCloseTo(-175);
  });
});

describe("isSwipeUp (ctrl-row → compose sheet)", () => {
  const T = 36;
  it("recognises a clear upward swipe", () => expect(isSwipeUp(4, -T, T)).toBe(true));
  it("ignores a short upward nudge (a tap on a chip)", () =>
    expect(isSwipeUp(2, -10, T)).toBe(false));
  it("ignores a downward swipe", () => expect(isSwipeUp(0, T, T)).toBe(false));
  it("ignores a mostly-horizontal drag even if it clears threshold vertically", () =>
    expect(isSwipeUp(-80, -T, T)).toBe(false));
});

describe("pressDecom (arm → confirm)", () => {
  it("first press arms, does not fire", () =>
    expect(pressDecom("idle")).toEqual({ state: "armed", fire: false }));
  it("second press (while armed) fires and resets to idle", () =>
    expect(pressDecom("armed")).toEqual({ state: "idle", fire: true }));
});
