import { describe, expect, it } from "vitest";
import { applyKey, formatValue } from "./readiness-forge-view";

const W = { on: "on", off: "off", none: "none", unknown: "?" };

describe("formatValue", () => {
  it("renders booleans, lists, empty and unknown", () => {
    expect(formatValue(true, W)).toBe("on");
    expect(formatValue(false, W)).toBe("off");
    expect(formatValue(["merge", "squash"], W)).toBe("merge, squash");
    expect(formatValue([], W)).toBe("none");
    expect(formatValue(null, W)).toBe("?");
  });
});

describe("applyKey", () => {
  it("is distinct per repo and check", () => {
    expect(applyKey("/a", "auto_merge")).not.toBe(applyKey("/b", "auto_merge"));
    expect(applyKey("/a", "auto_merge")).not.toBe(applyKey("/a", "auto_label"));
  });
});
