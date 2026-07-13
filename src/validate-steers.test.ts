import { describe, expect, it } from "bun:test";
import { validateSteers } from "./validate";

const base = {
  id: "s1",
  label: "Run",
  text: "Do it",
  inSteerBar: true,
  onIssues: false,
};

describe("validateSteers provider constraints", () => {
  it("keeps single-provider constraints", () => {
    expect(validateSteers([{ ...base, agentProviders: ["codex"] }])).toEqual([
      { ...base, agentProviders: ["codex"] },
    ]);
  });

  it("normalizes both providers and missing providers to universal", () => {
    expect(validateSteers([{ ...base, agentProviders: ["claude", "codex"] }])).toEqual([base]);
    expect(validateSteers([base])).toEqual([base]);
  });

  it("rejects unknown providers", () => {
    expect(validateSteers([{ ...base, agentProviders: ["other"] }])).toBeNull();
  });
});
