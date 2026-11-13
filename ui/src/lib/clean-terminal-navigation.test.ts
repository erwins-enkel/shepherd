import { describe, expect, it } from "vitest";
import { wheelLines, absolutePoint } from "./clean-terminal-navigation";

describe("clean shell history coordinates", () => {
  it("normalizes pixel, line and page wheels without discarding small trackpad deltas", () => {
    expect(wheelLines(-2, 0, 20, 30)).toBe(0.1);
    expect(wheelLines(-3, 1, 20, 30)).toBe(3);
    expect(wheelLines(1, 2, 20, 30)).toBe(-30);
  });
  it("anchors in retained history rather than the currently painted xterm buffer", () => {
    expect(
      absolutePoint(
        { max_offset_from_bottom: 270, offset_from_bottom: 90, viewport_rows: 30 },
        4,
        7,
      ),
    ).toEqual({ row: 184, col: 7 });
    expect(
      absolutePoint(
        { max_offset_from_bottom: 270, offset_from_bottom: 270, viewport_rows: 30 },
        0,
        0,
      ),
    ).toEqual({ row: 0, col: 0 });
  });
});
