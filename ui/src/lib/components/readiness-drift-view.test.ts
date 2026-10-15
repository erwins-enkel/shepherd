import { describe, expect, it } from "vitest";
import type { DriftRow, FrameworkDrift } from "#lib/types.js";
import { behindRows, hasEpicWork, lineLabel } from "./readiness-drift-view";

const row = (o: Partial<DriftRow>): DriftRow => ({
  ecosystem: "npm",
  name: "@sveltejs/kit",
  installed: "2",
  latest: "3.0.1",
  target: "3",
  state: "behind",
  manifests: ["package.json"],
  dependabot: [],
  ...o,
});

const drift = (o: Partial<FrameworkDrift>): FrameworkDrift => ({
  rows: [],
  resolver: "ok",
  epicBranches: [],
  runningEpic: null,
  canCreateStory: true,
  openStory: null,
  ...o,
});

describe("lineLabel", () => {
  it("renders behind, current and unknown rows", () => {
    expect(lineLabel(row({}), "?")).toBe("2 → 3 (3.0.1)");
    expect(lineLabel(row({ installed: "3", state: "ok" }), "?")).toBe("3 (3.0.1)");
    expect(lineLabel(row({ latest: null, target: null, state: "unknown" }), "?")).toBe("2 · ?");
  });
});

describe("behindRows / hasEpicWork", () => {
  it("keeps only behind rows; unknown never counts", () => {
    const d = drift({ rows: [row({}), row({ state: "ok" }), row({ state: "unknown" })] });
    expect(behindRows(d)).toHaveLength(1);
    expect(behindRows(drift({ rows: [row({ state: "unknown" })] }))).toEqual([]);
  });

  it("epic work = a running epic or open epic branches", () => {
    expect(hasEpicWork(drift({}))).toBe(false);
    expect(hasEpicWork(drift({ runningEpic: 3114 }))).toBe(true);
    expect(hasEpicWork(drift({ epicBranches: ["epic/1-x"] }))).toBe(true);
  });
});
