import { describe, expect, it } from "vitest";
import { toneColor } from "./tones";

describe("toneColor", () => {
  it("resolves ok to --color-green", () => {
    expect(toneColor("ok")).toBe("var(--color-green)");
  });

  it("resolves warn to --status-warn (cross-family token)", () => {
    expect(toneColor("warn")).toBe("var(--status-warn)");
  });

  it("falls back to --color-muted for unknown string", () => {
    expect(toneColor("bogus")).toBe("var(--color-muted)");
  });

  it("falls back to --color-muted for undefined", () => {
    expect(toneColor(undefined)).toBe("var(--color-muted)");
  });
});
