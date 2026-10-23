import { describe, it, expect } from "vitest";
import { railEpicChild, railEpicStopped } from "./epic-rail";
import type { DrainStatus } from "#lib/types.js";

const drain = (over: Partial<DrainStatus> = {}): DrainStatus => ({
  repoPath: "/r",
  enabled: false,
  paused: false,
  reason: null,
  detail: null,
  queued: 0,
  inFlight: 0,
  max: 1,
  epicParent: null,
  ...over,
});

describe("railEpicChild", () => {
  it("reads the stamp, else a legacy epic/<#> base, else null", () => {
    expect(railEpicChild(67, "shepherd/stacked")).toEqual({ epic: 67, branch: "shepherd/stacked" });
    expect(railEpicChild(null, "epic/67-x")).toEqual({ epic: 67, branch: "epic/67-x" });
    expect(railEpicChild(null, "main")).toBeNull();
  });
});

describe("railEpicStopped", () => {
  const child = { epic: 67, branch: "epic/67-x" };
  it("null for a non-child or while the drain acts", () => {
    expect(railEpicStopped(null, drain())).toBeNull();
    expect(railEpicStopped(child, drain({ enabled: true }))).toBeNull();
  });
  it("the child's own epic when nothing leads (or no drain status)", () => {
    expect(railEpicStopped(child, drain())).toEqual({ epic: 67, paused: false });
    expect(railEpicStopped(child, null)).toEqual({ epic: 67, paused: false });
  });
  it("a paused leader when one leads", () => {
    const d = drain({ runSummary: { leadingEpic: 80 } as DrainStatus["runSummary"] });
    expect(railEpicStopped(child, d)).toEqual({ epic: 80, paused: true });
  });
});
