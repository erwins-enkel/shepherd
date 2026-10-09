import { describe, expect, it } from "vitest";
import { tooltipText } from "./content";

describe("tooltipText", () => {
  it("flattens sections and their rows into plain text", () => {
    expect(
      tooltipText({
        title: "T",
        summary: "S",
        sections: [
          { label: "A", text: "one" },
          { label: "B", text: "", rows: [{ text: "x", aside: "1:00", tone: "ok" }, { text: "y" }] },
        ],
      }),
    ).toBe("T\n\nS\n\nA: one\n\nB:\n- x (1:00)\n- y");
  });

  it("flattens the timeline's labels, a section note and the footer", () => {
    expect(
      tooltipText({
        title: "T",
        summary: "S",
        timeline: {
          segments: [{ from: 0, to: 0.5, tone: "done" }],
          start: "10:21",
          end: "~20:00",
          now: { at: 0.25, label: "now 12:43" },
          legend: [{ tone: "done", label: "merged" }],
        },
        sections: [
          {
            label: "B",
            text: "",
            rows: [{ text: "x", aside: "low", meter: { value: 1, max: 3 } }],
            note: "basis",
          },
        ],
        footer: ["f1", "f2"],
      }),
    ).toBe("T\n\nS\n\n10:21 → now 12:43 → ~20:00\n\nB:\n- x (low)\nbasis\n\nf1\nf2");
  });
});
