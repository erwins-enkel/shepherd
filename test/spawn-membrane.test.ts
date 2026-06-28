import { test, expect, describe } from "bun:test";
import {
  resolveBackend,
  resolveMembraneEnv,
  resolveSpawnMembrane,
  foldSpawnPatch,
  resolveAuxSpawn,
  type MembraneEnv,
} from "../src/spawn-membrane";
import { PluginSpawnAborted } from "../src/plugins/types";

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

describe("foldSpawnPatch", () => {
  test("empty patch → patchEnv deep-equals {} and finalArgv === input array (no extraArgs)", () => {
    const innerArgv = ["claude"];
    const { patchEnv, finalArgv } = foldSpawnPatch(innerArgv, {});
    expect(patchEnv).toEqual({});
    expect(finalArgv).toBe(innerArgv);
  });

  test("{ env: { A: '1' } } → patchEnv is { A: '1' }", () => {
    const { patchEnv } = foldSpawnPatch(["claude"], { env: { A: "1" } });
    expect(patchEnv).toEqual({ A: "1" });
  });

  test("credentialDir sugar wins over env.CLAUDE_CONFIG_DIR when both set", () => {
    const { patchEnv } = foldSpawnPatch(["claude"], {
      env: { CLAUDE_CONFIG_DIR: "/from-env" },
      credentialDir: "/from-cred",
    });
    expect(patchEnv.CLAUDE_CONFIG_DIR).toBe("/from-cred");
  });

  test("extraArgs appended to innerArgv", () => {
    const { finalArgv } = foldSpawnPatch(["claude"], { extraArgs: ["--x", "y"] });
    expect(finalArgv).toEqual(["claude", "--x", "y"]);
  });
});

describe("resolveAuxSpawn", () => {
  test("no runSpawnHooks seam → passthrough: wrapped deep-equals input argv, spawnEnv === undefined", async () => {
    const argv = ["claude", "--some-flag"];
    const result = await resolveAuxSpawn({
      argv,
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => null,
        membraneEnv: () => stubEnv,
      },
      descriptor: { sessionId: "s-1", kind: "review" },
    });

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    expect(result.wrapped).toEqual(argv);
    expect(result.spawnEnv).toBeUndefined();
  });

  test("hook fires with the descriptor fields", async () => {
    let recorded: unknown;
    const argv = ["claude", "--x"];
    const result = await resolveAuxSpawn({
      argv,
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => null,
        membraneEnv: () => stubEnv,
        runSpawnHooks: async (d) => {
          recorded = d;
          return {};
        },
      },
      descriptor: { sessionId: "crit-1", kind: "review", parentSessionId: "sess-9", model: "m" },
    });

    expect("aborted" in result).toBe(false);
    const d = recorded as Record<string, unknown>;
    expect(d.sessionId).toBe("crit-1");
    expect(d.kind).toBe("review");
    expect(d.parentSessionId).toBe("sess-9");
    expect(d.repoRoot).toBe("/repo");
    expect(d.isolated).toBe(true);
    expect(d.model).toBe("m");
    expect(typeof d.agentProvider).toBe("string");
    expect((d.agentProvider as string).length).toBeGreaterThan(0);
    expect(d.argv).toEqual(["claude", "--x"]);
  });

  test("patched credentialDir rides the membrane --setenv (backend present)", async () => {
    const result = await resolveAuxSpawn({
      argv: ["claude"],
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => "bwrap",
        membraneEnv: () => stubEnv,
        runSpawnHooks: async () => ({ credentialDir: "/pool/acct-3" }),
      },
      descriptor: { sessionId: "s-1", kind: "review" },
    });

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    expect(result.wrapped[0]).toBe("bwrap");
    const i = result.wrapped.lastIndexOf("CLAUDE_CONFIG_DIR");
    expect(i).toBeGreaterThan(-1);
    expect(result.wrapped[i + 1]).toBe("/pool/acct-3");
  });

  test("patched credentialDir in spawnEnv without a backend (passthrough)", async () => {
    const result = await resolveAuxSpawn({
      argv: ["claude"],
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => null,
        membraneEnv: () => stubEnv,
        runSpawnHooks: async () => ({ credentialDir: "/pool/acct-7" }),
      },
      descriptor: { sessionId: "s-1", kind: "review" },
    });

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    expect(result.wrapped).toEqual(["claude"]);
    expect(result.spawnEnv?.CLAUDE_CONFIG_DIR).toBe("/pool/acct-7");
  });

  test("extraArgs appended (passthrough)", async () => {
    const result = await resolveAuxSpawn({
      argv: ["claude"],
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => null,
        membraneEnv: () => stubEnv,
        runSpawnHooks: async () => ({ extraArgs: ["--mcp-config", "/x.json"] }),
      },
      descriptor: { sessionId: "s-1", kind: "review" },
    });

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    expect(result.wrapped).toEqual(["claude", "--mcp-config", "/x.json"]);
  });

  test("abortSpawn → { aborted } with reason and pluginId", async () => {
    const result = await resolveAuxSpawn({
      argv: ["claude"],
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => null,
        membraneEnv: () => stubEnv,
        runSpawnHooks: async () => {
          throw new PluginSpawnAborted("pool exhausted", "cswap");
        },
      },
      descriptor: { sessionId: "s-1", kind: "review" },
    });

    expect("aborted" in result).toBe(true);
    if (!("aborted" in result)) throw new Error("expected abort");
    expect(result.aborted).toBeInstanceOf(PluginSpawnAborted);
    expect(result.aborted.reason).toBe("pool exhausted");
    expect(result.aborted.pluginId).toBe("cswap");
  });
});
