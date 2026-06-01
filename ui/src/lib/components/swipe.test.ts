import { describe, it, expect } from "vitest";
import {
  REVEAL_PX,
  OPEN_RATIO,
  lockAxis,
  clampOffset,
  snapOffset,
  pressDecom,
  paneSwipeAction,
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
});

describe("snapOffset", () => {
  it("snaps closed below the open ratio", () =>
    expect(snapOffset(-(REVEAL_PX * OPEN_RATIO) + 1)).toBe(0));
  it("snaps open at/after the open ratio", () =>
    expect(snapOffset(-(REVEAL_PX * OPEN_RATIO))).toBe(-REVEAL_PX));
  it("snaps a full drag open", () => expect(snapOffset(-REVEAL_PX)).toBe(-REVEAL_PX));
});

describe("paneSwipeAction (queue paging swipe)", () => {
  const T = 120; // commit threshold (px)
  it("short drag in either direction commits to nothing", () => {
    expect(paneSwipeAction(40, T, true, 1)).toBe("none");
    expect(paneSwipeAction(-40, T, true, 1)).toBe("none");
  });
  it("leftward past threshold pages to the next agent when a queue exists", () =>
    expect(paneSwipeAction(-T, T, true, 0)).toBe("next"));
  it("leftward no-ops when there's no queue to page", () =>
    expect(paneSwipeAction(-T, T, false, -1)).toBe("none"));
  it("rightward mid-queue pages to the previous agent", () =>
    expect(paneSwipeAction(T, T, true, 2)).toBe("prev"));
  it("rightward at the queue start falls back to the list", () =>
    expect(paneSwipeAction(T, T, true, 0)).toBe("back"));
  it("rightward for a session not in the queue goes back to the list", () =>
    expect(paneSwipeAction(T, T, true, -1)).toBe("back"));
  it("rightward goes back when paging is unavailable", () =>
    expect(paneSwipeAction(T, T, false, -1)).toBe("back"));
});

describe("pressDecom (arm → confirm)", () => {
  it("first press arms, does not fire", () =>
    expect(pressDecom("idle")).toEqual({ state: "armed", fire: false }));
  it("second press (while armed) fires and resets to idle", () =>
    expect(pressDecom("armed")).toEqual({ state: "idle", fire: true }));
});
