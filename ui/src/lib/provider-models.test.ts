import { afterEach, describe, expect, it } from "vitest";
import { accountModels } from "#lib/account-models.svelte.js";
import { modelAvailableForProvider, pickerModels } from "#lib/provider-models.js";

const MYTHOS = "claude-mythos-5-1";

afterEach(() => {
  accountModels.mythosAvailable = false;
});

describe("account-gated Mythos", () => {
  it("is hidden and unavailable until the logged-in account has it", () => {
    expect(pickerModels("claude")).not.toContain(MYTHOS);
    expect(modelAvailableForProvider("claude", MYTHOS, true)).toBe(false);
    // Every other Claude model is untouched by the gate.
    expect(pickerModels("claude")).toContain("claude-fable-5-1");
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
