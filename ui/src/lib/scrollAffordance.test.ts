import { describe, it, expect } from "vitest";
import { isScrolledAwayFromBottom, SCROLL_UP_PX } from "./scrollAffordance";

const base = {
  agentOwnsScroll: false,
  scrollDepth: 0,
  contentBelowScroll: false,
  viewportOffsetLines: 0,
};

describe("isScrolledAwayFromBottom — xterm owns the scrollback", () => {
  it("pinned to the bottom → no button", () => {
    expect(isScrolledAwayFromBottom({ ...base, viewportOffsetLines: 0 })).toBe(false);
  });

  it("scrolled up any whole line → button", () => {
    expect(isScrolledAwayFromBottom({ ...base, viewportOffsetLines: 1 })).toBe(true);
  });

  it("ignores the gesture accumulator in this regime", () => {
    // scrollDepth is only fed while the agent owns the scroll; here it stays 0
    expect(isScrolledAwayFromBottom({ ...base, viewportOffsetLines: 0, scrollDepth: 999 })).toBe(
      false,
    );
  });
});

describe("isScrolledAwayFromBottom — agent owns the scroll", () => {
  const agent = { ...base, agentOwnsScroll: true };

  it("pinned to the bottom → no button", () => {
    expect(isScrolledAwayFromBottom({ ...agent, scrollDepth: 0 })).toBe(false);
  });

  it("deliberate scroll past the threshold → button immediately", () => {
    expect(isScrolledAwayFromBottom({ ...agent, scrollDepth: SCROLL_UP_PX + 1 })).toBe(true);
  });

  it("a sub-threshold nudge alone → no button (anti-flicker on a quiet pane)", () => {
    expect(isScrolledAwayFromBottom({ ...agent, scrollDepth: 12 })).toBe(false);
  });

  it("the reported bug: nudged up a hair, then new content arrives below → button", () => {
    expect(isScrolledAwayFromBottom({ ...agent, scrollDepth: 12, contentBelowScroll: true })).toBe(
      true,
    );
  });

  it("content-below only counts while scrolled up — back at the bottom re-arms it", () => {
    // caller clears contentBelowScroll once scrollDepth returns to 0
    expect(isScrolledAwayFromBottom({ ...agent, scrollDepth: 0, contentBelowScroll: false })).toBe(
      false,
    );
  });
});
