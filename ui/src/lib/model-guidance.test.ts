import { describe, expect, it } from "vitest";
import { modelGuidance, modelGuidanceAlias, modelOptionLabel } from "./model-guidance";
import { configuredModelLabel, modelLabel } from "./model-label";

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

  it("gives pinned Opus 5 the same tier and fit as the floating alias it pins", () => {
    expect(modelGuidance("claude", "claude-opus-5").costTier).toBe(
      modelGuidance("claude", "opus").costTier,
    );
    expect(modelGuidance("claude", "claude-opus-5").tag).toBe(modelGuidance("claude", "opus").tag);
    expect(modelGuidance("claude", "claude-opus-5[1m]").costTier).toBe("premium");
    expect(modelGuidance("claude", "claude-opus-5[1m]").tag).toBe(
      modelGuidance("claude", "opus[1m]").tag,
    );
    // Not the unknown-model fallback — each pinned entry carries its own guidance detail.
    expect(modelGuidance("claude", "claude-opus-5").detail).not.toBe(
      modelGuidance("claude", "nope").detail,
    );
    expect(modelGuidance("claude", "claude-opus-5[1m]").detail).not.toBe(
      modelGuidance("claude", "nope").detail,
    );
  });

  it("adds fit and cost markers to option labels", () => {
    expect(modelOptionLabel("codex", "gpt-5.6-sol")).toBe("gpt-5.6-sol · max · $$$$");
    expect(modelOptionLabel("codex", "gpt-5.6-terra")).toBe("gpt-5.6-terra · balanced · $$$");
    expect(modelOptionLabel("codex", "gpt-5.6-luna")).toBe("gpt-5.6-luna · budget · $");
    expect(modelOptionLabel("codex", "gpt-5.3-codex")).toBe("gpt-5.3-codex · balanced · $$");
    expect(modelOptionLabel("claude", "opus[1m]")).toBe(
      "Opus (latest, 1M context) · long context · $$$$",
    );
  });

  it("distinguishes the floating and pinned Opus rows in the picker", () => {
    // The whole point of the pinned entries: side by side they share a fit tag and cost
    // mark, so the LABEL is the only thing telling an operator which one drifts.
    expect(modelOptionLabel("claude", "opus")).toBe("Opus (latest) · strong · $$$");
    expect(modelOptionLabel("claude", "claude-opus-5")).toBe("Opus 5 · strong · $$$");
    expect(modelOptionLabel("claude", "opus")).not.toBe(
      modelOptionLabel("claude", "claude-opus-5"),
    );
    expect(modelOptionLabel("claude", "claude-opus-5[1m]")).toBe(
      "Opus 5 (1M context) · long context · $$$$",
    );
  });

  it("resolves unavailable Fable to Opus 1M for guidance", () => {
    expect(modelGuidanceAlias("fable", false)).toBe("opus[1m]");
    expect(modelGuidanceAlias("fable", true)).toBe("fable");
    expect(modelGuidanceAlias("default", false)).toBe("default");
  });
});

describe("record vs configured labels", () => {
  // Guard rail for the deliberate split: the floating aliases must NOT say "latest" on
  // record surfaces (session cards, status bar, viewport …), because an archived session
  // ran whichever Opus was current at spawn time — not today's. Collapsing
  // configuredModelLabel into modelLabel as a "consistency fix" trips this.
  it("keeps floating aliases bare on record surfaces and dated on configured ones", () => {
    expect(modelLabel("opus")).toBe("opus");
    expect(configuredModelLabel("opus")).toBe("Opus (latest)");
    expect(modelLabel("opus[1m]")).toBe("Opus (1M context)");
    expect(configuredModelLabel("opus[1m]")).toBe("Opus (latest, 1M context)");
  });

  it("labels pinned models identically on both surfaces", () => {
    // A pinned name means the same model forever, so there is no tense to disambiguate.
    for (const alias of ["claude-opus-5", "claude-opus-5[1m]"]) {
      expect(configuredModelLabel(alias)).toBe(modelLabel(alias));
    }
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("claude-opus-5[1m]")).toBe("Opus 5 (1M context)");
  });

  it("leaves every other alias untouched on both surfaces", () => {
    for (const alias of ["fable", "sonnet", "sonnet[1m]", "haiku"]) {
      expect(configuredModelLabel(alias)).toBe(modelLabel(alias));
    }
  });
});
