import { describe, it, expect } from "vitest";
import {
  effectiveRepoProvider,
  ownRunDefaults,
  repoEffortFitsProvider,
  repoModelFitsProvider,
  repoPinnedProvider,
  reposStayingOn,
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

describe("reposStayingOn (#3448)", () => {
  const repo = (repoPath: string, agentProvider: "inherit" | "claude" | "codex") => ({
    repoPath,
    name: repoPath.slice(1),
    agentProvider,
  });
  const live = (repoPath: string, n: number, status: "running" | "idle" | "archived" = "running") =>
    Array.from({ length: n }, () => ({ repoPath, status }));

  it("names a repo pinned to the exhausted CLI with its session count", () => {
    expect(reposStayingOn([repo("/app", "claude")], live("/app", 2), "claude")).toEqual([
      { repoPath: "/app", name: "app", agentProvider: "claude", sessions: 2 },
    ]);
  });

  it("drops a pinned repo without sessions, archived ones not counting", () => {
    expect(reposStayingOn([repo("/app", "claude")], [], "claude")).toEqual([]);
    expect(reposStayingOn([repo("/app", "claude")], live("/app", 3, "archived"), "claude")).toEqual(
      [],
    );
    const [r] = reposStayingOn(
      [repo("/app", "claude")],
      [...live("/app", 1, "idle"), ...live("/app", 1, "archived")],
      "claude",
    );
    expect(r?.sessions).toBe(1);
  });

  it("never names a repo that inherits or is pinned to the target CLI", () => {
    const sessions = [...live("/inh", 2), ...live("/cdx", 2)];
    expect(
      reposStayingOn([repo("/inh", "inherit"), repo("/cdx", "codex")], sessions, "claude"),
    ).toEqual([]);
  });

  it("counts only the repo's own sessions and keeps the rows' order", () => {
    const rows = [repo("/b", "claude"), repo("/a", "claude")];
    const out = reposStayingOn(
      rows,
      [...live("/a", 1), ...live("/b", 2), ...live("/c", 5)],
      "claude",
    );
    expect(out.map((r) => [r.repoPath, r.sessions])).toEqual([
      ["/b", 2],
      ["/a", 1],
    ]);
  });
});
