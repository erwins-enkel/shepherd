import { describe, expect, it } from "vitest";
import manifest from "../manifest.config";

describe("manifest permissions", () => {
  it("relies on activeTab, not the broad tabs permission (#2109)", () => {
    const m = (typeof manifest === "function" ? manifest({} as never) : manifest) as {
      permissions?: string[];
    };
    expect(m.permissions).toContain("activeTab");
    expect(m.permissions).not.toContain("tabs");
  });
});
