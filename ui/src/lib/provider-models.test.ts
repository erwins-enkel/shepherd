import { afterEach, describe, expect, it } from "vitest";
import { accountModels } from "#lib/account-models.svelte.js";
import { modelAvailableForProvider, pickerModels } from "#lib/provider-models.js";

const MYTHOS = "claude-mythos-5-2";
const RETIRED = ["claude-mythos-5-1", "claude-fable-5-1"];

afterEach(() => {
  accountModels.mythosAvailable = false;
});

describe("account-gated Mythos", () => {
  it("is hidden and unavailable until the logged-in account has it", () => {
    expect(pickerModels("claude")).not.toContain(MYTHOS);
    expect(modelAvailableForProvider("claude", MYTHOS, true)).toBe(false);
    // Every other Claude model is untouched by the gate.
    expect(pickerModels("claude")).toContain("claude-fable-5-2");
  });

  it("is listed first and available when the account has it", () => {
    accountModels.mythosAvailable = true;
    expect(pickerModels("claude")[0]).toBe(MYTHOS);
    expect(modelAvailableForProvider("claude", MYTHOS, true)).toBe(true);
  });

  it("keeps a saved Mythos value visible so the select never goes blank", () => {
    expect(pickerModels("claude", MYTHOS)).toContain(MYTHOS);
    // …but never leaks into another provider's list.
    expect(pickerModels("codex", MYTHOS)).not.toContain(MYTHOS);
  });
});

describe("retired 5.1 pins", () => {
  it("are no longer offered, even with Mythos access", () => {
    accountModels.mythosAvailable = true;
    for (const model of RETIRED) expect(pickerModels("claude")).not.toContain(model);
    expect(pickerModels("claude").slice(0, 3)).toEqual([
      "claude-mythos-5-2",
      "fable",
      "claude-fable-5-2",
    ]);
  });

  it("stay visible as the current value and remain valid, so a saved 5.1 choice keeps running", () => {
    accountModels.mythosAvailable = true;
    for (const model of RETIRED) {
      expect(pickerModels("claude", model)).toContain(model);
      expect(modelAvailableForProvider("claude", model, true)).toBe(true);
    }
    // Only the current one comes back, not its retired sibling.
    expect(pickerModels("claude", "claude-fable-5-1")).not.toContain("claude-mythos-5-1");
  });
});
