import { describe, expect, it } from "vitest";
import { PULL_RELOAD, PULL_SEARCH, PULL_SLOP, pullStage, resist, shouldArm } from "./pull-gesture";

describe("pullStage", () => {
  it("is idle below the search threshold", () => {
    expect(pullStage(0)).toBe("idle");
    expect(pullStage(PULL_SEARCH - 1)).toBe("idle");
  });
  it("is search from the search threshold up to reload", () => {
    expect(pullStage(PULL_SEARCH)).toBe("search");
    expect(pullStage(PULL_RELOAD - 1)).toBe("search");
  });
  it("is reload at and past the reload threshold", () => {
    expect(pullStage(PULL_RELOAD)).toBe("reload");
    expect(pullStage(PULL_RELOAD * 3)).toBe("reload");
  });
});

describe("resist", () => {
  it("is zero for no or negative movement", () => {
    expect(resist(0)).toBe(0);
    expect(resist(-40)).toBe(0);
  });
  it("is monotonic and damped", () => {
    let prev = 0;
    for (const dy of [10, 50, 100, 200, 400, 800]) {
      const r = resist(dy);
      expect(r).toBeGreaterThan(prev);
      expect(r).toBeLessThan(dy);
      prev = r;
    }
  });
  it("lets a comfortable pull reach both stages", () => {
    expect(pullStage(resist(140))).toBe("search");
    expect(pullStage(resist(400))).toBe("reload");
  });
});

describe("shouldArm", () => {
  const ok = { scrollY: 0, dx: 0, dy: PULL_SLOP + 1 };
  it("arms on a downward vertical pull at the top", () => expect(shouldArm(ok)).toBe(true));
  it("rejects a scrolled page", () => expect(shouldArm({ ...ok, scrollY: 1 })).toBe(false));
  it("rejects upward movement", () => expect(shouldArm({ ...ok, dy: -20 })).toBe(false));
  it("rejects horizontal-dominant movement", () =>
    expect(shouldArm({ ...ok, dx: ok.dy + 1 })).toBe(false));
  it("rejects movement within the slop", () =>
    expect(shouldArm({ ...ok, dy: PULL_SLOP })).toBe(false));
});
