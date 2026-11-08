import { describe, it, expect } from "vitest";
import {
  effectiveRepoProvider,
  ownRunDefaults,
  repoEffortFitsProvider,
  repoModelFitsProvider,
  repoPinnedProvider,
} from "./repo-cli";

describe("repo coding CLI (#3441)", () => {
  it("a pinned CLI wins; inherit / unknown follow the global default", () => {
    expect(effectiveRepoProvider("codex", "claude")).toBe("codex");
    expect(effectiveRepoProvider("inherit", "codex")).toBe("codex");
    expect(effectiveRepoProvider(undefined, "claude")).toBe("claude");
    expect(repoPinnedProvider("claude")).toBe("claude");
    expect(repoPinnedProvider("inherit")).toBeNull();
    expect(repoPinnedProvider(undefined)).toBeNull();
  });

  it("models fit only their own CLI; sentinels fit both", () => {
    for (const v of ["inherit", "auto", "default"]) {
      expect(repoModelFitsProvider(v, "claude")).toBe(true);
      expect(repoModelFitsProvider(v, "codex")).toBe(true);
    }
    expect(repoModelFitsProvider("opus", "claude")).toBe(true);
    expect(repoModelFitsProvider("opus", "codex")).toBe(false);
    expect(repoModelFitsProvider("gpt-5.4", "codex")).toBe(true);
    expect(repoModelFitsProvider("gpt-5.4", "claude")).toBe(false);
  });

  it("ultra fits Codex only", () => {
    expect(repoEffortFitsProvider("ultra", "claude")).toBe(false);
    expect(repoEffortFitsProvider("ultra", "codex")).toBe(true);
    expect(repoEffortFitsProvider("max", "claude")).toBe(true);
    expect(repoEffortFitsProvider("inherit", "claude")).toBe(true);
  });
});

describe("ownRunDefaults (#3447)", () => {
  const row = (over: Partial<Parameters<typeof ownRunDefaults>[0][number]> = {}) => ({
    repoPath: "/r/app",
    agentProvider: "inherit" as const,
    defaultModel: "inherit",
    defaultEffort: "inherit",
    defaultExecutionEffort: "inherit",
    ...over,
  });

  it("keeps a pinned CLI and an own execution effort", () => {
    expect(ownRunDefaults([row({ agentProvider: "codex" })], "claude")).toHaveLength(1);
    expect(ownRunDefaults([row({ defaultExecutionEffort: "high" })], "claude")).toHaveLength(1);
  });

  it("a model or effort the effective CLI cannot run reads inherit", () => {
    const [r] = ownRunDefaults(
      [row({ agentProvider: "codex", defaultModel: "opus", defaultEffort: "low" })],
      "claude",
    );
    expect(r).toMatchObject({
      agentProvider: "codex",
      defaultModel: "inherit",
      defaultEffort: "low",
    });
    const [u] = ownRunDefaults(
      [row({ defaultEffort: "ultra", defaultExecutionEffort: "high" })],
      "claude",
    );
    expect(u?.defaultEffort).toBe("inherit");
  });

  it("drops a repo left with nothing of its own", () => {
    expect(ownRunDefaults([row({ defaultModel: "opus" })], "codex")).toEqual([]);
    expect(ownRunDefaults([row({ defaultModel: "opus" })], "claude")).toHaveLength(1);
    expect(ownRunDefaults([row()], "claude")).toEqual([]);
  });
});
