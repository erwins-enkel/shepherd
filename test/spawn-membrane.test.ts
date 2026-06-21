import { test, expect, describe } from "bun:test";
import {
  resolveBackend,
  resolveMembraneEnv,
  resolveSpawnMembrane,
  type MembraneEnv,
} from "../src/spawn-membrane";

const stubEnv: MembraneEnv = {
  claudeDir: "/stub/.claude",
  home: "/stub/home",
  nodeBinReal: "/stub/bin/node",
  extraEnv: { LANG: "C.UTF-8" },
};

function worktreeStub(gitCommonDirCalls?: string[]) {
  return {
    gitCommonDir: (p: string) => {
      if (gitCommonDirCalls) gitCommonDirCalls.push(p);
      return `${p}/.git`;
    },
  };
}

describe("resolveBackend", () => {
  test("PRESENCE-CHECK REGRESSION: seam returning null returns null, NOT real probe", () => {
    // This is the critical regression guard: if `??` were used instead of a presence-check,
    // `() => null` would fall through to the real backend probe. It must NOT.
    const result = resolveBackend({ detectBackend: () => null });
    expect(result).toBeNull();
  });

  test("seam returning 'bwrap' returns 'bwrap'", () => {
    const result = resolveBackend({ detectBackend: () => "bwrap" });
    expect(result).toBe("bwrap");
  });
});

describe("resolveMembraneEnv", () => {
  test("honors injected membraneEnv seam, returns stub verbatim", () => {
    const result = resolveMembraneEnv({ membraneEnv: () => stubEnv });
    expect(result).toBe(stubEnv);
  });
});

describe("resolveSpawnMembrane", () => {
  const argv = ["claude", "--some-flag"];

  test("backend null → passthrough (wrapped deep-equals input argv), gitCommonDir called with worktreePath", () => {
    const calls: string[] = [];
    const { wrapped, backend } = resolveSpawnMembrane({
      argv,
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(calls),
      seams: {
        detectBackend: () => null,
        membraneEnv: () => stubEnv,
      },
    });

    expect(backend).toBeNull();
    expect(wrapped).toEqual(argv);
    expect(calls).toContain("/wt/task");
  });

  test("backend 'bwrap' → wrapped[0] === 'bwrap', original argv tokens preserved after '--'", () => {
    const { wrapped, backend } = resolveSpawnMembrane({
      argv,
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => "bwrap",
        membraneEnv: () => stubEnv,
      },
    });

    expect(backend).toBe("bwrap");
    expect(wrapped[0]).toBe("bwrap");

    // inner argv preserved after the last `--` separator
    const lastSep = wrapped.lastIndexOf("--");
    expect(lastSep).toBeGreaterThan(0);
    const innerArgv = wrapped.slice(lastSep + 1);
    expect(innerArgv).toEqual(argv);
  });
});
