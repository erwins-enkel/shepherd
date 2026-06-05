import { describe, expect, it } from "vitest";
import { summarizeAxeResults } from "../src/lib/a11y";

describe("summarizeAxeResults", () => {
  it("maps violations, counts nodes, samples ≤3 selectors, sorts critical→minor", () => {
    const out = summarizeAxeResults({
      violations: [
        {
          id: "label",
          impact: "minor",
          help: "Form elements must have labels",
          nodes: [{ target: ["#a"] }],
        },
        {
          id: "color-contrast",
          impact: "serious",
          help: "Elements must have sufficient contrast",
          nodes: [{ target: [".x"] }, { target: [".y"] }, { target: [".z"] }, { target: [".w"] }],
        },
      ],
    });
    expect(out.map((f) => f.id)).toEqual(["color-contrast", "label"]); // serious before minor
    expect(out[0]).toEqual({
      id: "color-contrast",
      impact: "serious",
      help: "Elements must have sufficient contrast",
      nodeCount: 4,
      sampleSelectors: [".x", ".y", ".z"], // capped at 3
    });
  });

  it("defaults a missing/unknown impact to 'unknown' and tolerates empty input", () => {
    expect(summarizeAxeResults({})).toEqual([]);
    const [f] = summarizeAxeResults({ violations: [{ id: "x", help: "h", nodes: [] }] });
    expect(f.impact).toBe("unknown");
    expect(f.nodeCount).toBe(0);
    expect(f.sampleSelectors).toEqual([]);
  });

  it("caps at 20 findings", () => {
    const violations = Array.from({ length: 25 }, (_, i) => ({
      id: `r${i}`,
      impact: "moderate",
      help: "h",
      nodes: [{ target: [`#n${i}`] }],
    }));
    expect(summarizeAxeResults({ violations })).toHaveLength(20);
  });
});
