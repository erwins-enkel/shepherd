import { describe, it, expect } from "vitest";
import { chipFor, progress, stateLabel } from "./epic-panel";

describe("epic-panel helpers", () => {
  it("chipFor maps state → tone", () => {
    expect(chipFor("merged").tone).toBe("done");
    expect(chipFor("ready").tone).toBe("ready");
    expect(chipFor("blocked").tone).toBe("muted");
    expect(chipFor("in-review").tone).toBe("review");
    expect(chipFor("running").tone).toBe("running");
  });
  it("progress counts merged/total", () => {
    expect(progress([{ state: "merged" }, { state: "ready" }] as never)).toEqual({
      merged: 1,
      total: 2,
    });
  });
  it("stateLabel returns a non-empty string for all 5 states", () => {
    const states = ["merged", "in-review", "running", "ready", "blocked"] as const;
    for (const s of states) {
      expect(stateLabel(s)).toBeTruthy();
    }
  });
});
