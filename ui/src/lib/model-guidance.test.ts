import { describe, expect, it } from "vitest";
import { modelGuidance, modelGuidanceAlias, modelOptionLabel } from "./model-guidance";

describe("modelGuidance", () => {
  it("marks Haiku as the cheap classifier fit", () => {
    const guidance = modelGuidance("claude", "haiku", "classifier");

    expect(guidance.costTier).toBe("low");
    expect(guidance.costMark).toBe("$");
    expect(guidance.tag).toBe("budget");
    expect(guidance.contextNote).toContain("Classifier");
  });

  it("marks long-context Claude models as premium or high cost", () => {
    expect(modelGuidance("claude", "opus[1m]").costTier).toBe("premium");
    expect(modelGuidance("claude", "sonnet[1m]").costTier).toBe("high");
  });

  it("adds fit and cost markers to option labels", () => {
    expect(modelOptionLabel("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol · max · $$$$");
    expect(modelOptionLabel("codex", "gpt-5.6-terra")).toBe("gpt-5.6-terra · balanced · $$$");
    expect(modelOptionLabel("codex", "gpt-5.6-luna")).toBe("gpt-5.6-luna · budget · $");
    expect(modelOptionLabel("codex", "gpt-5.3-codex")).toBe("gpt-5.3-codex · balanced · $$");
    expect(modelOptionLabel("claude", "opus[1m]")).toBe("Opus (1M context) · long context · $$$$");
  });

  it("resolves unavailable Fable to Opus 1M for guidance", () => {
    expect(modelGuidanceAlias("fable", false)).toBe("opus[1m]");
    expect(modelGuidanceAlias("fable", true)).toBe("fable");
    expect(modelGuidanceAlias("default", false)).toBe("default");
  });
});
