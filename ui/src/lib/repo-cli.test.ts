import { describe, it, expect } from "vitest";
import {
  effectiveRepoProvider,
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
