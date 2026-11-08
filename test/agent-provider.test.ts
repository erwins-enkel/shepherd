import { describe, expect, test } from "bun:test";
import {
  clampRunDefaultsToCli,
  normalizeRepoAgentProviderSetting,
  repoEffortFitsProvider,
  repoModelFitsProvider,
  resolveSpawnAgentProvider,
} from "../src/agent-provider";

describe("normalizeRepoAgentProviderSetting", () => {
  test("accepts inherit and each provider", () => {
    for (const v of ["inherit", "claude", "codex"])
      expect(normalizeRepoAgentProviderSetting(v)).toBe(v as "inherit");
  });
  test("rejects anything else", () => {
    for (const v of ["", "gemini", null, undefined, 1])
      expect(normalizeRepoAgentProviderSetting(v)).toBeNull();
  });
});

describe("resolveSpawnAgentProvider (#3441: explicit → repo → global)", () => {
  test("an explicit choice (task pick / epic CLI) beats the repo and the global default", () => {
    expect(resolveSpawnAgentProvider("claude", "codex", "codex")).toBe("claude");
    expect(resolveSpawnAgentProvider("codex", "inherit", "claude")).toBe("codex");
  });
  test("a repo's own CLI beats the global default", () => {
    expect(resolveSpawnAgentProvider(undefined, "codex", "claude")).toBe("codex");
    expect(resolveSpawnAgentProvider(null, "claude", "codex")).toBe("claude");
  });
  test("inherit / unset / invalid follow whatever the global default is now", () => {
    expect(resolveSpawnAgentProvider(undefined, "inherit", "claude")).toBe("claude");
    expect(resolveSpawnAgentProvider(undefined, "inherit", "codex")).toBe("codex");
    expect(resolveSpawnAgentProvider(undefined, undefined, "codex")).toBe("codex");
    expect(resolveSpawnAgentProvider(undefined, "bogus", "claude")).toBe("claude");
  });
});

describe("repo run-default fit", () => {
  test("sentinels fit every CLI; an alias only its own", () => {
    for (const v of ["inherit", "auto", "default"]) {
      expect(repoModelFitsProvider(v, "claude")).toBe(true);
      expect(repoModelFitsProvider(v, "codex")).toBe(true);
    }
    expect(repoModelFitsProvider("opus", "claude")).toBe(true);
    expect(repoModelFitsProvider("opus", "codex")).toBe(false);
    expect(repoModelFitsProvider("gpt-5.4", "codex")).toBe(true);
    expect(repoModelFitsProvider("gpt-5.4", "claude")).toBe(false);
  });
  test("ultra is Codex-only", () => {
    expect(repoEffortFitsProvider("ultra", "claude")).toBe(false);
    expect(repoEffortFitsProvider("ultra", "codex")).toBe(true);
    expect(repoEffortFitsProvider("max", "claude")).toBe(true);
    expect(repoEffortFitsProvider("inherit", "claude")).toBe(true);
    expect(repoEffortFitsProvider("default", "codex")).toBe(true);
  });
});

describe("clampRunDefaultsToCli (#3441 write-time clamp)", () => {
  const stored = { defaultModel: "opus", defaultEffort: "ultra" };
  test("an edit that leaves the CLI alone changes nothing", () => {
    expect(clampRunDefaultsToCli(stored, { defaultModel: "sonnet" }, "codex")).toEqual({});
  });
  test("switching to Codex drops a Claude model, keeps a Codex-capable effort", () => {
    expect(clampRunDefaultsToCli(stored, { agentProvider: "codex" }, "claude")).toEqual({
      defaultModel: "inherit",
    });
  });
  test("switching to Claude drops ultra, keeps a Claude model", () => {
    expect(clampRunDefaultsToCli(stored, { agentProvider: "claude" }, "codex")).toEqual({
      defaultEffort: "inherit",
    });
  });
  test("inherit is judged against the global default", () => {
    expect(clampRunDefaultsToCli(stored, { agentProvider: "inherit" }, "codex")).toEqual({
      defaultModel: "inherit",
    });
  });
  test("a co-patched value is the one checked", () => {
    expect(
      clampRunDefaultsToCli(stored, { agentProvider: "codex", defaultModel: "gpt-5.4" }, "claude"),
    ).toEqual({});
    expect(
      clampRunDefaultsToCli(
        { defaultModel: "inherit", defaultEffort: "inherit" },
        { agentProvider: "codex", defaultModel: "opus" },
        "claude",
      ),
    ).toEqual({ defaultModel: "inherit" });
  });
});
