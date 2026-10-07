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
});
