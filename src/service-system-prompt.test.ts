import { describe, expect, it } from "bun:test";
import { composeSystemPrompt } from "./service";

describe("composeSystemPrompt", () => {
  it("always includes the untrusted-content boundary block", () => {
    const withRules = composeSystemPrompt("<house-rules>x</house-rules>");
    const withoutRules = composeSystemPrompt(null);
    for (const p of [withRules, withoutRules]) {
      expect(p).toContain("<untrusted-content-boundary>");
      expect(p).toContain("EXTERNAL and UNTRUSTED");
    }
  });
});
