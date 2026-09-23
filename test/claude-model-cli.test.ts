import { describe, expect, it } from "bun:test";
import { CLAUDE_MODEL_MIN_CLI, minCliFor, modelNeedingNewerCli } from "../src/claude-model-cli";

describe("minCliFor", () => {
  it("reports the floor for a model that has one", () => {
    expect(minCliFor("claude-opus-5-5")).toBe("2.1.280");
    expect(minCliFor("claude-opus-5-5[1m]")).toBe("2.1.280");
  });

  it("returns null for models with no floor — floating aliases, older pins, junk", () => {
    for (const model of ["opus", "opus[1m]", "claude-opus-5", "sonnet", "fable", "nonsense"])
      expect(minCliFor(model)).toBeNull();
  });

  it("returns null for non-strings", () => {
    expect(minCliFor(null)).toBeNull();
    expect(minCliFor(undefined)).toBeNull();
  });
});

describe("modelNeedingNewerCli", () => {
  it("reports a model the installed CLI is too old for", () => {
    expect(modelNeedingNewerCli(["claude-opus-5-5"], "2.1.277")).toEqual({
      model: "claude-opus-5-5",
      required: "2.1.280",
    });
  });

  it("stays quiet once the CLI reaches the floor, and above it", () => {
    for (const v of ["2.1.280", "2.1.281", "2.2.0", "3.0.0"])
      expect(modelNeedingNewerCli(["claude-opus-5-5"], v)).toBeNull();
  });

  it("fails OPEN on an unreadable version rather than warning about an unknown one", () => {
    expect(modelNeedingNewerCli(["claude-opus-5-5"], null)).toBeNull();
  });

  it("ignores models with no floor, and nulls in the list", () => {
    expect(modelNeedingNewerCli(["opus", "claude-opus-5", null, undefined], "1.0.0")).toBeNull();
  });

  it("skips past models with no floor to reach a stale one", () => {
    expect(
      modelNeedingNewerCli(["opus", null, "claude-opus-5", "claude-opus-5-5"], "2.1.277"),
    ).toEqual({ model: "claude-opus-5-5", required: "2.1.280" });
  });

  it("reports the FIRST stale model — one CLI upgrade fixes them all", () => {
    expect(modelNeedingNewerCli(["claude-opus-5-5[1m]", "claude-opus-5-5"], "2.1.277")?.model).toBe(
      "claude-opus-5-5[1m]",
    );
  });

  it("keys the [1m] variant off the same floor as its base model", () => {
    expect(CLAUDE_MODEL_MIN_CLI["claude-opus-5-5[1m]"]).toBe(
      CLAUDE_MODEL_MIN_CLI["claude-opus-5-5"]!,
    );
  });
});
