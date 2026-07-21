import { describe, it, expect } from "vitest";
import {
  preselectModel,
  preselectEffort,
  reseedRunConfig,
  normalizeRunConfig,
  modelForManualProviderChange,
  type ReseedInput,
  type NormalizeInput,
} from "./run-config";
import type { ProviderTokenConstraint } from "$lib/types";

function reseedInput(over: Partial<ReseedInput> = {}): ReseedInput {
  return {
    provider: "claude",
    modelTouched: false,
    effortTouched: false,
    hasInitialModel: false,
    hasInitialEffort: false,
    effectiveModelSetting: "opus",
    effectiveEffortSetting: "default",
    fableAvailable: true,
    ...over,
  };
}

function normalizeInput(over: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    provider: "claude",
    model: "opus",
    effort: "default",
    fableAvailable: true,
    constraint: null,
    claudeModelSetting: "opus",
    codexModelSetting: "gpt-5.5",
    ...over,
  };
}

const codexOnly: ProviderTokenConstraint = {
  id: "codex:review",
  token: "$review",
  providers: ["codex"],
  label: "review",
};

describe("preselect", () => {
  it("explicit settings win; fable falls back when unavailable", () => {
    expect(preselectModel("opus", "claude", true)).toBe("opus");
    expect(preselectModel("fable", "claude", false)).toBe("default");
    expect(preselectModel("auto", "codex", true)).toBe("default");
  });

  it("effort maps default/inherit/absent to the no-flag value", () => {
    expect(preselectEffort("high")).toBe("high");
    expect(preselectEffort("default")).toBe("default");
    expect(preselectEffort("inherit")).toBe("default");
    expect(preselectEffort(undefined)).toBe("default");
  });
});

// The model-transition table from the plan, pinned row by row.
describe("reseedRunConfig (untouched-reseed rule)", () => {
  it("untouched repo switch reseeds model + effort from the setting chain", () => {
    expect(
      reseedRunConfig(
        reseedInput({ effectiveModelSetting: "sonnet", effectiveEffortSetting: "high" }),
      ),
    ).toEqual({ model: "sonnet", effort: "high" });
  });

  it("a touched model survives a repo switch (no reseed field emitted)", () => {
    const out = reseedRunConfig(reseedInput({ modelTouched: true }));
    expect(out.model).toBeUndefined();
    expect(out.effort).toBe("default");
  });

  it("an explicit initialModel pins the picker (CTA seed)", () => {
    const out = reseedRunConfig(reseedInput({ hasInitialModel: true }));
    expect(out.model).toBeUndefined();
  });

  it("fable-unavailable falls back to default in the reseed path", () => {
    expect(
      reseedRunConfig(reseedInput({ effectiveModelSetting: "fable", fableAvailable: false })).model,
    ).toBe("default");
  });
});

describe("normalizeRunConfig (validity correction, touched or not)", () => {
  it("a constraint-excluded provider flips to the constraint's first allowed provider", () => {
    const out = normalizeRunConfig(normalizeInput({ constraint: codexOnly }));
    expect(out.provider).toBe("codex");
    // …and the now-invalid Claude model snaps to the Codex default.
    expect(out.model).toBe("gpt-5.5");
  });

  it("a touched-but-invalid model snaps to the provider default after a provider flip", () => {
    const out = normalizeRunConfig(
      normalizeInput({ provider: "codex", model: "opus", codexModelSetting: "gpt-5.5" }),
    );
    expect(out.model).toBe("gpt-5.5");
  });

  it("a valid model passes through untouched", () => {
    expect(normalizeRunConfig(normalizeInput()).model).toBe("opus");
  });

  it("fable snaps to default when fableAvailable flips false", () => {
    const out = normalizeRunConfig(
      normalizeInput({ model: "fable", fableAvailable: false, claudeModelSetting: "auto" }),
    );
    expect(out.model).toBe("default");
  });

  it("an unsupported effort tier snaps to default on Codex (xhigh)", () => {
    const out = normalizeRunConfig(normalizeInput({ provider: "codex", effort: "xhigh" }));
    expect(out.effort).toBe("default");
  });

  it("a supported effort tier passes through", () => {
    expect(normalizeRunConfig(normalizeInput({ effort: "xhigh" })).effort).toBe("xhigh");
  });
});

describe("modelForManualProviderChange (today's unconditional reset, preserved)", () => {
  it("resets to the new provider's default regardless of touched state", () => {
    expect(modelForManualProviderChange("codex", "gpt-5.5", true)).toBe("gpt-5.5");
    expect(modelForManualProviderChange("claude", "opus", true)).toBe("opus");
  });

  it("falls back to 'default' when the setting resolves to an unavailable model", () => {
    expect(modelForManualProviderChange("claude", "fable", false)).toBe("default");
  });
});
