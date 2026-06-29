import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  resolveBackend,
  resolveMembraneEnv,
  resolveSpawnMembrane,
  foldSpawnPatch,
  resolveAuxSpawn,
  type MembraneEnv,
} from "../src/spawn-membrane";
import { PluginSpawnAborted } from "../src/plugins/types";
import { config } from "../src/config";
import { __setApiKeyConfigDirProvisionForTest } from "../src/spawn-auth";

const stubEnv: MembraneEnv = {
  claudeDir: "/stub/.claude",
  home: "/stub/home",
  nodeBinReal: "/stub/bin/node",
  extraEnv: { LANG: "C.UTF-8" },
  // Active projects dir — distinct from claudeDir so #1213 redirect assertions are unambiguous.
  projectsDir: "/stub/projects",
};

const MIRROR = "/tmp/shepherd-test-apikey-config";
beforeEach(() => {
  __setApiKeyConfigDirProvisionForTest(() => MIRROR);
});
afterEach(() => {
  __setApiKeyConfigDirProvisionForTest(null);
});

/** Run `fn` with `config.authMode`/helper swapped (api-key tests), restored after. */
async function withAuth<T>(
  mode: typeof config.authMode,
  helper: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  const prevMode = config.authMode;
  const prevPath = config.authApiKeyHelperPath;
  config.authMode = mode;
  config.authApiKeyHelperPath = helper;
  try {
    return await fn();
  } finally {
    config.authMode = prevMode;
    config.authApiKeyHelperPath = prevPath;
  }
}

/** Assert `flags` contains the contiguous triple [flag, a, b]. */
function hasTriple(flags: string[], flag: string, a: string, b: string): boolean {
  for (let i = 0; i + 2 < flags.length; i++) {
    if (flags[i] === flag && flags[i + 1] === a && flags[i + 2] === b) return true;
  }
  return false;
}

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

  test("patched credentialDir is BOUND as claudeDir in the membrane, projects source=active (#1213)", async () => {
    const result = await resolveAuxSpawn({
      argv: ["claude"],
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => "bwrap",
        membraneEnv: () => stubEnv,
        pathExists: () => true,
        runSpawnHooks: async () => ({ credentialDir: "/pool/acct-3" }),
      },
      descriptor: { sessionId: "s-1", kind: "review" },
    });

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    const f = result.wrapped;
    expect(f[0]).toBe("bwrap");
    // The pool dir is actually BOUND (the bug: previously only --setenv, never mounted).
    expect(hasTriple(f, "--ro-bind", "/pool/acct-3", "/pool/acct-3")).toBe(true);
    // projects bind SOURCE = active projects dir, DEST = pool projects → readback preserved.
    expect(hasTriple(f, "--bind", "/stub/projects", "/pool/acct-3/projects")).toBe(true);
    // config-dir .claude.json rw-bound so onboarding/project state persists.
    expect(
      hasTriple(f, "--bind-try", "/pool/acct-3/.claude.json", "/pool/acct-3/.claude.json"),
    ).toBe(true);
    // CLAUDE_CONFIG_DIR set from the bind, exactly once (no duplicate from the patch env).
    expect(f.filter((x) => x === "CLAUDE_CONFIG_DIR").length).toBe(1);
    const i = f.lastIndexOf("CLAUDE_CONFIG_DIR");
    expect(f[i + 1]).toBe("/pool/acct-3");
  });

  test("api-key WRAPPED redirect: masks the pool dir, binds helper, projects source=active (#1213)", async () => {
    const result = await withAuth("api-key", "/helper.sh", async () =>
      resolveAuxSpawn({
        argv: ["claude"],
        worktreePath: "/wt/task",
        repoPath: "/repo",
        worktree: worktreeStub(),
        seams: {
          detectBackend: () => "bwrap",
          membraneEnv: () => stubEnv,
          pathExists: () => true,
          runSpawnHooks: async () => ({ credentialDir: "/pool/acct-5" }),
        },
        descriptor: { sessionId: "s-1", kind: "review" },
      }),
    );

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    const f = result.wrapped;
    // maskCredentials path: NO whole-dir RO bind of the pool dir; masked mount point via --dir.
    expect(hasTriple(f, "--ro-bind", "/pool/acct-5", "/pool/acct-5")).toBe(false);
    const di = f.indexOf("--dir");
    expect(f[di + 1]).toBe("/pool/acct-5");
    // No rw credential bind of the pool dir (creds masked absent).
    expect(
      hasTriple(
        f,
        "--bind-try",
        "/pool/acct-5/.credentials.json",
        "/pool/acct-5/.credentials.json",
      ),
    ).toBe(false);
    // api-key helper RO-bound.
    expect(hasTriple(f, "--ro-bind-try", "/helper.sh", "/helper.sh")).toBe(true);
    // projects bind SOURCE = active projects dir (readback preserved even under api-key routing).
    expect(hasTriple(f, "--bind", "/stub/projects", "/pool/acct-5/projects")).toBe(true);
  });

  test("api-key + NO backend: credential-less mirror WINS over a routed credentialDir (#1213)", async () => {
    const result = await withAuth("api-key", "/helper.sh", async () =>
      resolveAuxSpawn({
        argv: ["claude"],
        worktreePath: "/wt/task",
        repoPath: "/repo",
        worktree: worktreeStub(),
        seams: {
          detectBackend: () => null,
          membraneEnv: () => stubEnv,
          pathExists: () => true, // dir EXISTS, yet the mirror must still win (no sandbox to mask).
          runSpawnHooks: async () => ({ credentialDir: "/pool/acct-9" }),
        },
        descriptor: { sessionId: "s-1", kind: "review" },
      }),
    );

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    // The pool dir's real OAuth creds would conflict with the key — the mirror wins.
    expect(result.spawnEnv?.CLAUDE_CONFIG_DIR).toBe(MIRROR);
  });

  test("non-existent credentialDir is ignored → fails open to the active account (#1213)", async () => {
    const prevWarn = console.warn;
    let warned = "";
    console.warn = (...a: unknown[]) => {
      warned += a.map(String).join(" ");
    };
    let result;
    try {
      result = await resolveAuxSpawn({
        argv: ["claude"],
        worktreePath: "/wt/task",
        repoPath: "/repo",
        worktree: worktreeStub(),
        seams: {
          detectBackend: () => "bwrap",
          membraneEnv: () => stubEnv,
          pathExists: () => false, // the patched dir does not exist on host
          runSpawnHooks: async () => ({ credentialDir: "/pool/missing" }),
        },
        descriptor: { sessionId: "s-1", kind: "review" },
      });
    } finally {
      console.warn = prevWarn;
    }

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    const f = result.wrapped;
    // NOT redirected: the missing pool dir is never referenced; the active dir is bound instead.
    expect(f.some((x) => x.includes("/pool/missing"))).toBe(false);
    expect(hasTriple(f, "--ro-bind", "/stub/.claude", "/stub/.claude")).toBe(true);
    expect(warned).toContain("/pool/missing");
  });

  test("redirect to ${home}/.claude with a custom active dir: no CLAUDE_CONFIG_DIR setenv (relies on default) (#1213)", async () => {
    // Edge (reviewer point 4): pool dir == ${home}/.claude while the active config dir is custom.
    // The guard `claudeDir !== ${home}/.claude` (shared by the setenv + the config-dir .claude.json
    // bind) is FALSE → no CLAUDE_CONFIG_DIR is set (Claude defaults to ~/.claude, which IS bound)
    // and no config-dir .claude.json bind is added. Intentional and benign.
    const result = await resolveAuxSpawn({
      argv: ["claude"],
      worktreePath: "/wt/task",
      repoPath: "/repo",
      worktree: worktreeStub(),
      seams: {
        detectBackend: () => "bwrap",
        membraneEnv: () => stubEnv, // claudeDir "/stub/.claude", home "/stub/home"
        pathExists: () => true,
        runSpawnHooks: async () => ({ credentialDir: "/stub/home/.claude" }),
      },
      descriptor: { sessionId: "s-1", kind: "review" },
    });

    expect("aborted" in result).toBe(false);
    if ("aborted" in result) throw new Error("unexpected abort");
    const f = result.wrapped;
    // pool (== ~/.claude) is bound; projects source = active projects dir.
    expect(hasTriple(f, "--ro-bind", "/stub/home/.claude", "/stub/home/.claude")).toBe(true);
    expect(hasTriple(f, "--bind", "/stub/projects", "/stub/home/.claude/projects")).toBe(true);
    // No CLAUDE_CONFIG_DIR setenv (relies on Claude's default) and no config-dir .claude.json bind.
    expect(f.includes("CLAUDE_CONFIG_DIR")).toBe(false);
    expect(
      hasTriple(
        f,
        "--bind-try",
        "/stub/home/.claude/.claude.json",
        "/stub/home/.claude/.claude.json",
      ),
    ).toBe(false);
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
        pathExists: () => true,
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
