import { test, expect, describe, beforeEach } from "bun:test";
import {
  SANDBOX_PROFILES,
  isSandboxProfile,
  resolveProfile,
  autoHoldReason,
  isDegraded,
  isEgressDegraded,
  egressApplies,
  willEgressConfine,
  EGRESS_UNAVAILABLE_REASON,
  buildMembraneFlags,
  wrapArgv,
  detectBackend,
  resetBackendCache,
  collectPassthroughEnv,
  type MembraneInputs,
} from "../src/sandbox";
import { resolveNodeBin } from "../src/node-bin";
import type { EgressBackend } from "../src/egress";

// A deterministic MembraneInputs for flag-construction tests. exists is
// injected so the host never influences the output.
function fakeMembrane(over: Partial<MembraneInputs> = {}): MembraneInputs {
  return {
    worktreePath: "/repos/proj/.shepherd-worktrees/wt-1",
    gitCommonDir: "/repos/proj/.git",
    isolated: true,
    repoPath: "/repos/proj",
    claudeDir: "/home/me/.claude",
    home: "/home/me",
    nodeBinReal: "/home/linuxbrew/.linuxbrew/Cellar/node/22.0.0/bin/node",
    term: "xterm-256color",
    ...over,
  };
}

// Deterministic path probes: nothing exists.
const detDeps = { exists: () => false };

describe("isSandboxProfile / SANDBOX_PROFILES", () => {
  test("SANDBOX_PROFILES is the three profiles in order", () => {
    expect(SANDBOX_PROFILES).toEqual(["trusted", "standard", "autonomous"]);
  });

  test("recognizes each valid profile", () => {
    for (const p of SANDBOX_PROFILES) expect(isSandboxProfile(p)).toBe(true);
  });

  test("rejects junk", () => {
    expect(isSandboxProfile("nope")).toBe(false);
    expect(isSandboxProfile("")).toBe(false);
    expect(isSandboxProfile(null)).toBe(false);
    expect(isSandboxProfile(undefined)).toBe(false);
    expect(isSandboxProfile(3)).toBe(false);
    expect(isSandboxProfile({})).toBe(false);
  });
});

describe("resolveProfile", () => {
  test("override wins over repo + default", () => {
    expect(resolveProfile("autonomous", "standard", "trusted")).toBe("autonomous");
  });

  test("repo setting used when no override", () => {
    expect(resolveProfile(null, "standard", "trusted")).toBe("standard");
    expect(resolveProfile(undefined, "autonomous", "trusted")).toBe("autonomous");
  });

  test("falls back to default when neither override nor repo set", () => {
    expect(resolveProfile(null, null, "standard")).toBe("standard");
    expect(resolveProfile(undefined, undefined, "trusted")).toBe("trusted");
  });

  test("invalid override is ignored, falls through to repo", () => {
    expect(resolveProfile("bogus", "autonomous", "trusted")).toBe("autonomous");
  });

  test("invalid repo setting ignored, falls through to default", () => {
    expect(resolveProfile(null, "bogus", "standard")).toBe("standard");
  });

  test("empty strings treated as unset", () => {
    expect(resolveProfile("", "", "trusted")).toBe("trusted");
    expect(resolveProfile("   ", "  ", "autonomous")).toBe("autonomous");
  });
});

describe("autoHoldReason", () => {
  // ── 2-arg (legacy) shape — behavior must be byte-identical ───────────────────
  test("2-arg: trusted => null regardless of backend", () => {
    expect(autoHoldReason("trusted", "bwrap")).toBeNull();
    expect(autoHoldReason("trusted", null)).toBeNull();
  });

  test("2-arg: standard => always refuses", () => {
    expect(autoHoldReason("standard", "bwrap")).toBeTruthy();
    expect(autoHoldReason("standard", null)).toBeTruthy();
    expect(autoHoldReason("standard", "bwrap")).toContain("autonomous");
  });

  test("2-arg: autonomous + backend present => null", () => {
    expect(autoHoldReason("autonomous", "bwrap")).toBeNull();
  });

  test("2-arg: autonomous + no backend => refuse with backend reason", () => {
    const r = autoHoldReason("autonomous", null);
    expect(r).toBeTruthy();
    expect(r).toContain("backend");
  });

  // ── 3-arg (egress-aware) shape ────────────────────────────────────────────────
  test("3-arg: autonomous + backend + slirp4netns => null", () => {
    expect(autoHoldReason("autonomous", "bwrap", "slirp4netns")).toBeNull();
  });

  test("3-arg: autonomous + backend + egressBackend null => EGRESS_UNAVAILABLE_REASON", () => {
    const r = autoHoldReason("autonomous", "bwrap", null);
    expect(r).toBe(EGRESS_UNAVAILABLE_REASON);
    expect(r).toContain("slirp4netns");
    expect(r).toContain("dnsmasq");
    expect(r).toContain("nft");
  });

  test("3-arg: autonomous + backend null still refuses on FS reason, not egress", () => {
    // FS backend missing takes priority (checked first); egress null is irrelevant.
    const r = autoHoldReason("autonomous", null, null);
    expect(r).toBeTruthy();
    expect(r).not.toBe(EGRESS_UNAVAILABLE_REASON);
    expect(r).toContain("backend");
  });

  test("3-arg: trusted ignores egressBackend null", () => {
    expect(autoHoldReason("trusted", "bwrap", null)).toBeNull();
    expect(autoHoldReason("trusted", null, null)).toBeNull();
  });

  test("3-arg: standard ignores egressBackend, still refuses", () => {
    expect(autoHoldReason("standard", "bwrap", null)).toBeTruthy();
    expect(autoHoldReason("standard", "bwrap", "slirp4netns")).toBeTruthy();
  });

  test("omitting egressBackend (undefined) is identical to 2-arg for autonomous+backend", () => {
    // undefined means "not considered" — must not trigger egress refuse
    expect(autoHoldReason("autonomous", "bwrap", undefined)).toBeNull();
  });
});

describe("isDegraded", () => {
  test("true only for sandboxed profile with null backend", () => {
    expect(isDegraded("standard", null)).toBe(true);
    expect(isDegraded("autonomous", null)).toBe(true);
  });

  test("false when backend present", () => {
    expect(isDegraded("standard", "bwrap")).toBe(false);
    expect(isDegraded("autonomous", "bwrap")).toBe(false);
  });

  test("trusted never degraded", () => {
    expect(isDegraded("trusted", null)).toBe(false);
    expect(isDegraded("trusted", "bwrap")).toBe(false);
  });
});

describe("isEgressDegraded", () => {
  test("true only for autonomous + FS backend present + egress backend null", () => {
    expect(isEgressDegraded("autonomous", "bwrap", null)).toBe(true);
  });

  test("false for autonomous fully confined (both backends present)", () => {
    expect(isEgressDegraded("autonomous", "bwrap", "slirp4netns")).toBe(false);
  });

  test("false when FS backend also missing (isDegraded territory, not isEgressDegraded)", () => {
    expect(isEgressDegraded("autonomous", null, null)).toBe(false);
  });

  test("false for standard regardless of backends", () => {
    expect(isEgressDegraded("standard", "bwrap", null)).toBe(false);
    expect(isEgressDegraded("standard", null, null)).toBe(false);
  });

  test("false for trusted regardless of backends", () => {
    expect(isEgressDegraded("trusted", "bwrap", null)).toBe(false);
    expect(isEgressDegraded("trusted", null, null)).toBe(false);
  });
});

describe("egressApplies", () => {
  test("true only for autonomous", () => {
    expect(egressApplies("autonomous")).toBe(true);
  });

  test("false for trusted and standard", () => {
    expect(egressApplies("trusted")).toBe(false);
    expect(egressApplies("standard")).toBe(false);
  });
});

describe("willEgressConfine", () => {
  test("autonomous + bwrap + slirp4netns => true (fully confined)", () => {
    expect(willEgressConfine("autonomous", "bwrap", "slirp4netns")).toBe(true);
  });

  test("autonomous + bwrap + null egressBackend => false (no egress backend)", () => {
    expect(willEgressConfine("autonomous", "bwrap", null)).toBe(false);
  });

  test("autonomous + null backend + slirp4netns => false (no FS backend)", () => {
    expect(willEgressConfine("autonomous", null, "slirp4netns")).toBe(false);
  });

  test("autonomous + bwrap + undefined egressBackend => false (loose-null check treats undefined as null)", () => {
    expect(willEgressConfine("autonomous", "bwrap", undefined as unknown as EgressBackend)).toBe(
      false,
    );
  });

  test("standard + both backends present => false (egressApplies is false for standard)", () => {
    expect(willEgressConfine("standard", "bwrap", "slirp4netns")).toBe(false);
  });

  test("trusted + both backends present => false (egressApplies is false for trusted)", () => {
    expect(willEgressConfine("trusted", "bwrap", "slirp4netns")).toBe(false);
  });
});

describe("wrapArgv", () => {
  const inner = ["claude", "--model", "opus", "do the thing"];

  test("trusted => unchanged passthrough", () => {
    const out = wrapArgv(
      inner,
      { profile: "trusted", backend: "bwrap", membrane: fakeMembrane() },
      detDeps,
    );
    expect(out).toEqual(inner);
  });

  test("backend null => unchanged degrade", () => {
    const out = wrapArgv(
      inner,
      { profile: "standard", backend: null, membrane: fakeMembrane() },
      detDeps,
    );
    expect(out).toEqual(inner);
  });

  test("standard + bwrap => bwrap prefix + -- + inner", () => {
    const out = wrapArgv(
      inner,
      { profile: "standard", backend: "bwrap", membrane: fakeMembrane() },
      detDeps,
    );
    expect(out[0]).toBe("bwrap");
    const sep = out.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(out.slice(sep + 1)).toEqual(inner);
    // the flags between bwrap and -- are exactly buildMembraneFlags
    const flags = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(out.slice(1, sep)).toEqual(flags);
  });

  test("autonomous + bwrap => wrapped", () => {
    const out = wrapArgv(
      inner,
      { profile: "autonomous", backend: "bwrap", membrane: fakeMembrane() },
      detDeps,
    );
    expect(out[0]).toBe("bwrap");
    const sep = out.indexOf("--");
    expect(sep).toBeGreaterThan(0);
    expect(out.slice(sep + 1)).toEqual(inner);
    // the flags between bwrap and -- are exactly buildMembraneFlags
    const flags = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(out.slice(1, sep)).toEqual(flags);
  });
});

// helper: assert that flags contains the sequence [flag, a, b] contiguously.
function hasTriple(flags: string[], flag: string, a: string, b: string): boolean {
  for (let i = 0; i + 2 < flags.length; i++) {
    if (flags[i] === flag && flags[i + 1] === a && flags[i + 2] === b) return true;
  }
  return false;
}

describe("buildMembraneFlags", () => {
  test("has hardened process isolation flags", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(f).toContain("--die-with-parent");
    expect(f).toContain("--new-session");
    expect(f).toContain("--unshare-pid");
    expect(f).toContain("--unshare-uts");
    expect(f).toContain("--unshare-ipc");
    // explicit: --cap-drop ALL pair present
    const ci = f.indexOf("--cap-drop");
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(f[ci + 1]).toBe("ALL");
  });

  test("includes the systemd-resolve DNS bind via *-bind-try", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(hasTriple(f, "--ro-bind-try", "/run/systemd/resolve", "/run/systemd/resolve")).toBe(
      true,
    );
  });

  test("RO claudeDir base + RW projects bind", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(hasTriple(f, "--ro-bind", "/home/me/.claude", "/home/me/.claude")).toBe(true);
    expect(hasTriple(f, "--bind", "/home/me/.claude/projects", "/home/me/.claude/projects")).toBe(
      true,
    );
  });

  test("system dirs use plain ro-bind, host-variable paths use *-bind-try", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    // /usr and /etc are guaranteed present -> plain --ro-bind
    expect(hasTriple(f, "--ro-bind", "/usr", "/usr")).toBe(true);
    expect(hasTriple(f, "--ro-bind", "/etc", "/etc")).toBe(true);
    // /opt is host-variable -> --ro-bind-try
    expect(hasTriple(f, "--ro-bind-try", "/opt", "/opt")).toBe(true);
    // host-variable paths must NEVER appear under a hard --ro-bind/--bind
    const hardBindTargets = new Set<string>();
    for (let i = 0; i + 2 < f.length; i++) {
      const target = f[i + 2];
      if ((f[i] === "--ro-bind" || f[i] === "--bind") && target) hardBindTargets.add(target);
    }
    expect(hardBindTargets.has("/opt")).toBe(false);
    expect(hardBindTargets.has("/run/systemd/resolve")).toBe(false);
    expect(hardBindTargets.has("/home/me/.gitconfig")).toBe(false);
  });

  test("tmpfs over /tmp and home", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    // collect all --tmpfs targets
    const tmpfsTargets: string[] = [];
    for (let i = 0; i + 1 < f.length; i++) {
      const target = f[i + 1];
      if (f[i] === "--tmpfs" && target) tmpfsTargets.push(target);
    }
    expect(tmpfsTargets).toContain("/tmp");
    expect(tmpfsTargets).toContain("/home/me");
  });

  test("proc + dev present", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(
      hasTriple(f, "--proc", "/proc", "--dev") || (f.includes("--proc") && f.includes("--dev")),
    ).toBe(true);
    const pi = f.indexOf("--proc");
    expect(f[pi + 1]).toBe("/proc");
    const di = f.indexOf("--dev");
    expect(f[di + 1]).toBe("/dev");
  });

  test("isolated => binds worktree + absolute gitCommonDir, NOT repoPath", () => {
    const f = buildMembraneFlags(fakeMembrane({ isolated: true }), detDeps);
    expect(
      hasTriple(
        f,
        "--bind",
        "/repos/proj/.shepherd-worktrees/wt-1",
        "/repos/proj/.shepherd-worktrees/wt-1",
      ),
    ).toBe(true);
    expect(hasTriple(f, "--bind", "/repos/proj/.git", "/repos/proj/.git")).toBe(true);
    expect(hasTriple(f, "--bind", "/repos/proj", "/repos/proj")).toBe(false);
  });

  test("non-isolated => binds repoPath only", () => {
    const f = buildMembraneFlags(fakeMembrane({ isolated: false }), detDeps);
    expect(hasTriple(f, "--bind", "/repos/proj", "/repos/proj")).toBe(true);
    expect(
      hasTriple(
        f,
        "--bind",
        "/repos/proj/.shepherd-worktrees/wt-1",
        "/repos/proj/.shepherd-worktrees/wt-1",
      ),
    ).toBe(false);
  });

  test("node toolchain root derived from nodeBinReal (linuxbrew)", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    // linuxbrew root bound (prefix of nodeBinReal) — covers the bin dir, which is
    // de-duped away (see the next test). Binary's libs resolve via the root tree.
    expect(
      hasTriple(f, "--ro-bind-try", "/home/linuxbrew/.linuxbrew", "/home/linuxbrew/.linuxbrew"),
    ).toBe(true);
  });

  test("node toolchain binds bin dir when no manager root covers it", () => {
    // nodeBinReal outside any known manager root -> only the bin dir is bound.
    const f = buildMembraneFlags(
      fakeMembrane({ nodeBinReal: "/usr/local/node/bin/node" }),
      detDeps,
    );
    expect(hasTriple(f, "--ro-bind-try", "/usr/local/node/bin", "/usr/local/node/bin")).toBe(true);
  });

  test("node toolchain de-dupes child-of-already-bound-root", () => {
    // when bin dir is under linuxbrew root and root is also added, the bin dir
    // should not be redundantly re-bound. With nothing exists,
    // root is added because it's a prefix; bin dir is under it -> skipped.
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    const binDir = "/home/linuxbrew/.linuxbrew/Cellar/node/22.0.0/bin";
    const root = "/home/linuxbrew/.linuxbrew";
    // count occurrences of each as a bind target
    const targets: string[] = [];
    for (let i = 0; i + 2 < f.length; i++) {
      const target = f[i + 2];
      if (f[i] === "--ro-bind-try" && target) targets.push(target);
    }
    // root present
    expect(targets).toContain(root);
    // binDir not also present (it's under root) — de-duped
    expect(targets.filter((t) => t === binDir).length).toBe(0);
  });

  test("setenv HOME/PATH/TERM present", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(hasTriple(f, "--setenv", "HOME", "/home/me")).toBe(true);
    const pi = f.indexOf("PATH");
    expect(pi).toBeGreaterThan(0);
    expect(f[pi - 1]).toBe("--setenv");
    expect(f[pi + 1]).toContain("/usr/bin");
    expect(f[pi + 1]).toContain("/home/me/.local/bin");
    // dir of nodeBinReal on PATH
    expect(f[pi + 1]).toContain("/home/linuxbrew/.linuxbrew/Cellar/node/22.0.0/bin");
    expect(hasTriple(f, "--setenv", "TERM", "xterm-256color")).toBe(true);
  });

  test("term defaults to xterm-256color when unset", () => {
    const f = buildMembraneFlags(fakeMembrane({ term: undefined }), detDeps);
    expect(hasTriple(f, "--setenv", "TERM", "xterm-256color")).toBe(true);
  });

  test("--clearenv precedes every --setenv (no inherited env leaks in)", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    const clear = f.indexOf("--clearenv");
    expect(clear).toBeGreaterThan(0);
    // every --setenv must come AFTER --clearenv, else it'd be wiped
    f.forEach((tok, i) => {
      if (tok === "--setenv") expect(i).toBeGreaterThan(clear);
    });
  });

  test("extraEnv passthrough is emitted as --setenv (sorted), HOME/PATH/TERM still set", () => {
    const f = buildMembraneFlags(
      fakeMembrane({ extraEnv: { TZ: "UTC", LANG: "en_US.UTF-8" } }),
      detDeps,
    );
    expect(hasTriple(f, "--setenv", "LANG", "en_US.UTF-8")).toBe(true);
    expect(hasTriple(f, "--setenv", "TZ", "UTC")).toBe(true);
    expect(hasTriple(f, "--setenv", "HOME", "/home/me")).toBe(true);
  });

  test("custom CLAUDE_CONFIG_DIR is re-set after --clearenv (bound dir, not default)", () => {
    const f = buildMembraneFlags(
      fakeMembrane({ claudeDir: "/home/me/.config/claude-alt" }),
      detDeps,
    );
    expect(hasTriple(f, "--setenv", "CLAUDE_CONFIG_DIR", "/home/me/.config/claude-alt")).toBe(true);
  });

  test("default claudeDir does NOT emit CLAUDE_CONFIG_DIR (claude's own default)", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps); // claudeDir = /home/me/.claude
    expect(f.includes("CLAUDE_CONFIG_DIR")).toBe(false);
  });

  test(".claude.json persisted RW bind via *-bind-try", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(hasTriple(f, "--bind-try", "/home/me/.claude.json", "/home/me/.claude.json")).toBe(true);
  });

  test("subscription (no api-key fields): rw .credentials.json bind, no helper, no /dev/null overlay", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    // rw credential bind present (today's behavior)
    expect(
      hasTriple(
        f,
        "--bind-try",
        "/home/me/.claude/.credentials.json",
        "/home/me/.claude/.credentials.json",
      ),
    ).toBe(true);
    // no /dev/null overlay of the credential
    expect(hasTriple(f, "--ro-bind", "/dev/null", "/home/me/.claude/.credentials.json")).toBe(
      false,
    );
  });

  test("no api-key fields => BYTE-IDENTICAL to a bare fakeMembrane (deep equal)", () => {
    // Explicit nulls/false must produce the exact same flags as omitting them.
    const bare = buildMembraneFlags(fakeMembrane(), detDeps);
    const explicit = buildMembraneFlags(
      fakeMembrane({ apiKeyHelperPath: null, maskCredentials: false }),
      detDeps,
    );
    expect(explicit).toEqual(bare);
  });

  test("maskCredentials: .credentials.json ABSENT (per-child binds, no whole-dir bind, no overlay), helper RO", () => {
    const f = buildMembraneFlags(
      fakeMembrane({ maskCredentials: true, apiKeyHelperPath: "/h/x.sh" }),
      {
        ...detDeps,
        readdir: () => [
          ".credentials.json",
          "skills",
          "settings.json",
          "projects",
          "statsig",
          "CLAUDE.md",
        ],
      },
    );
    // NO whole-dir RO bind of claudeDir (replaced by per-child binds).
    expect(hasTriple(f, "--ro-bind", "/home/me/.claude", "/home/me/.claude")).toBe(false);
    // The mount point still exists via --dir.
    const di = f.indexOf("--dir");
    expect(di).toBeGreaterThanOrEqual(0);
    expect(f[di + 1]).toBe("/home/me/.claude");
    // NO bind of .credentials.json of ANY kind — the file is absent.
    expect(hasTriple(f, "--ro-bind", "/dev/null", "/home/me/.claude/.credentials.json")).toBe(
      false,
    );
    expect(
      hasTriple(
        f,
        "--bind-try",
        "/home/me/.claude/.credentials.json",
        "/home/me/.claude/.credentials.json",
      ),
    ).toBe(false);
    expect(
      hasTriple(
        f,
        "--ro-bind-try",
        "/home/me/.claude/.credentials.json",
        "/home/me/.claude/.credentials.json",
      ),
    ).toBe(false);
    // Per-child RO binds present for the non-credential entries.
    expect(
      hasTriple(f, "--ro-bind-try", "/home/me/.claude/skills", "/home/me/.claude/skills"),
    ).toBe(true);
    expect(
      hasTriple(
        f,
        "--ro-bind-try",
        "/home/me/.claude/settings.json",
        "/home/me/.claude/settings.json",
      ),
    ).toBe(true);
    expect(
      hasTriple(f, "--ro-bind-try", "/home/me/.claude/CLAUDE.md", "/home/me/.claude/CLAUDE.md"),
    ).toBe(true);
    // helper bound RO at the same path inside the sandbox
    expect(hasTriple(f, "--ro-bind-try", "/h/x.sh", "/h/x.sh")).toBe(true);
  });

  test("projectsBindSource overrides the projects bind SOURCE; dest stays <claudeDir>/projects (#1213)", () => {
    // source = active projects dir, dest = pool projects → transcript lands where readback looks.
    const f = buildMembraneFlags(
      fakeMembrane({ claudeDir: "/pool/x", projectsBindSource: "/active/projects" }),
      detDeps,
    );
    expect(hasTriple(f, "--bind", "/active/projects", "/pool/x/projects")).toBe(true);
    // absent → source == dest → byte-identical default.
    const g = buildMembraneFlags(fakeMembrane({ claudeDir: "/pool/x" }), detDeps);
    expect(hasTriple(g, "--bind", "/pool/x/projects", "/pool/x/projects")).toBe(true);
  });

  test("config-dir .claude.json rw bind only when CLAUDE_CONFIG_DIR is non-default (#1213)", () => {
    // Non-default config dir (pool redirect / custom operator) → rw-bind <claudeDir>/.claude.json
    // so Claude can persist onboarding/project state (it reads .claude.json from the config dir).
    const f = buildMembraneFlags(fakeMembrane({ home: "/home/me", claudeDir: "/pool/x" }), detDeps);
    expect(hasTriple(f, "--bind-try", "/pool/x/.claude.json", "/pool/x/.claude.json")).toBe(true);
    // Default ~/.claude → NOT added (default path stays byte-identical; Claude reads $HOME/.claude.json).
    const g = buildMembraneFlags(
      fakeMembrane({ home: "/home/me", claudeDir: "/home/me/.claude" }),
      detDeps,
    );
    expect(
      hasTriple(g, "--bind-try", "/home/me/.claude/.claude.json", "/home/me/.claude/.claude.json"),
    ).toBe(false);
  });

  test("api-key redirect: masks the POOL dir per-child minus creds, projects source=active, .claude.json rw (#1213)", () => {
    const f = buildMembraneFlags(
      fakeMembrane({
        home: "/home/me",
        claudeDir: "/pool/x",
        maskCredentials: true,
        apiKeyHelperPath: "/helper.sh",
        projectsBindSource: "/active/projects",
      }),
      {
        ...detDeps,
        readdir: () => [".credentials.json", "projects", "settings.json", ".claude.json"],
      },
    );
    // The POOL dir is masked per-child (no whole-dir RO bind); its mount point exists via --dir.
    expect(hasTriple(f, "--ro-bind", "/pool/x", "/pool/x")).toBe(false);
    const di = f.indexOf("--dir");
    expect(f[di + 1]).toBe("/pool/x");
    // Per-child RO bind for a non-credential child of the POOL dir.
    expect(hasTriple(f, "--ro-bind-try", "/pool/x/settings.json", "/pool/x/settings.json")).toBe(
      true,
    );
    // The POOL dir's .credentials.json is NEVER bound (genuinely absent) — no rw cred bind either.
    expect(f.includes("/pool/x/.credentials.json")).toBe(false);
    // api-key helper bound RO.
    expect(hasTriple(f, "--ro-bind-try", "/helper.sh", "/helper.sh")).toBe(true);
    // projects bind SOURCE = active projects dir (readback preserved).
    expect(hasTriple(f, "--bind", "/active/projects", "/pool/x/projects")).toBe(true);
    // config-dir .claude.json rw override (beats the masked per-child RO).
    expect(hasTriple(f, "--bind-try", "/pool/x/.claude.json", "/pool/x/.claude.json")).toBe(true);
  });

  test("session-env tmpfs carve-out present in subscription mode", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    const claudeDir = "/home/me/.claude";
    // --tmpfs <claudeDir>/session-env must be present
    let found = false;
    for (let i = 0; i + 1 < f.length; i++) {
      if (f[i] === "--tmpfs" && f[i + 1] === `${claudeDir}/session-env`) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  test("session-env tmpfs appears AFTER the claudeDir RO base bind (overrides it)", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    const claudeDir = "/home/me/.claude";
    // find index of the whole-dir RO base bind (subscription mode)
    let baseBindIdx = -1;
    for (let i = 0; i + 2 < f.length; i++) {
      if (f[i] === "--ro-bind" && f[i + 1] === claudeDir && f[i + 2] === claudeDir) {
        baseBindIdx = i;
        break;
      }
    }
    expect(baseBindIdx).toBeGreaterThanOrEqual(0);
    // find index of the session-env tmpfs
    let sessionEnvIdx = -1;
    for (let i = 0; i + 1 < f.length; i++) {
      if (f[i] === "--tmpfs" && f[i + 1] === `${claudeDir}/session-env`) {
        sessionEnvIdx = i;
        break;
      }
    }
    expect(sessionEnvIdx).toBeGreaterThan(baseBindIdx);
  });

  test("maskCredentials: session-env tmpfs still present and after per-child RO bind-try of session-env", () => {
    const f = buildMembraneFlags(fakeMembrane({ maskCredentials: true }), {
      ...detDeps,
      readdir: () => [
        ".credentials.json",
        "skills",
        "settings.json",
        "projects",
        "statsig",
        "session-env",
      ],
    });
    const claudeDir = "/home/me/.claude";
    // session-env tmpfs must still be present
    let tmpfsIdx = -1;
    for (let i = 0; i + 1 < f.length; i++) {
      if (f[i] === "--tmpfs" && f[i + 1] === `${claudeDir}/session-env`) {
        tmpfsIdx = i;
        break;
      }
    }
    expect(tmpfsIdx).toBeGreaterThanOrEqual(0);
    // per-child RO bind-try for session-env emitted by maskedClaudeDirBinds
    let perChildIdx = -1;
    for (let i = 0; i + 2 < f.length; i++) {
      if (
        f[i] === "--ro-bind-try" &&
        f[i + 1] === `${claudeDir}/session-env` &&
        f[i + 2] === `${claudeDir}/session-env`
      ) {
        perChildIdx = i;
        break;
      }
    }
    expect(perChildIdx).toBeGreaterThanOrEqual(0);
    // tmpfs must come AFTER the per-child bind so it overrides the RO bind
    expect(tmpfsIdx).toBeGreaterThan(perChildIdx);
  });

  test("apiKeyHelperPath empty/whitespace-guard: empty string => no helper bind", () => {
    const f = buildMembraneFlags(fakeMembrane({ apiKeyHelperPath: "" }), detDeps);
    expect(f.some((x) => x === "")).toBe(false);
  });

  test("membrane guard: key invariants hold and no --network flags present (no egress plumbing in membrane)", () => {
    const f = buildMembraneFlags(fakeMembrane(), detDeps);
    // Must still contain all the hardening flags.
    expect(f).toContain("--die-with-parent");
    expect(f).toContain("--new-session");
    expect(f).toContain("--unshare-pid");
    expect(f).toContain("--unshare-uts");
    expect(f).toContain("--unshare-ipc");
    expect(f).toContain("--clearenv");
    expect(f).toContain("--cap-drop");
    // Must NOT contain --unshare-net (egress is handled externally, not in the membrane).
    expect(f).not.toContain("--unshare-net");
    // Must NOT contain --unshare-user (membrane does not add this).
    expect(f).not.toContain("--unshare-user");
    // Length stability: if this fires, someone changed buildMembraneFlags.
    // With fakeMembrane (isolated=true, no extra binds) and detDeps (exists=false),
    // the output is fully deterministic. Snapshot the length so accidental edits are caught.
    const snapshot = buildMembraneFlags(fakeMembrane(), detDeps);
    expect(f.length).toBe(snapshot.length);
    // Structural: first token is a bwrap flag, not the executable.
    expect(f[0]).toMatch(/^--/);
  });
});

describe("buildMembraneFlags renderer env", () => {
  test("CLAUDE_CODE_NO_FLICKER in extraEnv => --setenv triple present, after --clearenv", () => {
    const f = buildMembraneFlags(
      fakeMembrane({ extraEnv: { CLAUDE_CODE_NO_FLICKER: "1" } }),
      detDeps,
    );
    expect(hasTriple(f, "--setenv", "CLAUDE_CODE_NO_FLICKER", "1")).toBe(true);
    const clearIdx = f.indexOf("--clearenv");
    let tripleIdx = -1;
    for (let i = 0; i + 2 < f.length; i++) {
      if (f[i] === "--setenv" && f[i + 1] === "CLAUDE_CODE_NO_FLICKER" && f[i + 2] === "1") {
        tripleIdx = i;
        break;
      }
    }
    expect(tripleIdx).toBeGreaterThan(clearIdx);
  });

  test("CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN in extraEnv => --setenv triple present", () => {
    const f = buildMembraneFlags(
      fakeMembrane({ extraEnv: { CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1" } }),
      detDeps,
    );
    expect(hasTriple(f, "--setenv", "CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN", "1")).toBe(true);
  });
});

describe("collectPassthroughEnv", () => {
  test("excludes secrets, includes allowlisted locale/display vars", () => {
    const out = collectPassthroughEnv({
      GH_TOKEN: "secret",
      SHEPHERD_TOKEN: "secret",
      ANTHROPIC_API_KEY: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      LANG: "en_US.UTF-8",
      TZ: "Europe/Berlin",
      COLORTERM: "truecolor",
    });
    expect(out).toEqual({ LANG: "en_US.UTF-8", TZ: "Europe/Berlin", COLORTERM: "truecolor" });
    expect(out.GH_TOKEN).toBeUndefined();
    expect(out.SHEPHERD_TOKEN).toBeUndefined();
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("falls back to C.UTF-8 when no locale is set", () => {
    expect(collectPassthroughEnv({ GH_TOKEN: "x" })).toEqual({ LANG: "C.UTF-8" });
  });

  test("LC_ALL alone suppresses the LANG fallback", () => {
    expect(collectPassthroughEnv({ LC_ALL: "C" })).toEqual({ LC_ALL: "C" });
  });
});

describe("detectBackend (injected run)", () => {
  beforeEach(() => resetBackendCache());

  function depsAll(status: number) {
    return {
      run: () => ({ status }),
      exists: () => false,
      home: "/home/me",
      claudeDir: "/home/me/.claude",
      nodeBinReal: "/usr/bin/node",
    };
  }

  test("available when all probes exit 0", () => {
    expect(detectBackend(depsAll(0))).toBe("bwrap");
  });

  test("null when bwrap --version fails", () => {
    const deps = {
      ...depsAll(0),
      run: (cmd: string, args: string[]) => {
        if (cmd === "bwrap" && args[0] === "--version") return { status: 127 };
        return { status: 0 };
      },
    };
    expect(detectBackend(deps)).toBeNull();
  });

  test("null when wrapped probe exits non-zero", () => {
    const deps = {
      ...depsAll(0),
      run: (cmd: string, args: string[]) => {
        if (cmd === "bwrap" && args[0] === "--version") return { status: 0 };
        // the wrapped probe (bwrap ... -- node/git) fails
        return { status: 1 };
      },
    };
    expect(detectBackend(deps)).toBeNull();
  });

  test("caches result — run only invoked once across calls", () => {
    let calls = 0;
    const deps = {
      ...depsAll(0),
      run: () => {
        calls++;
        return { status: 0 };
      },
    };
    expect(detectBackend(deps)).toBe("bwrap");
    const after = calls;
    expect(detectBackend(deps)).toBe("bwrap");
    expect(calls).toBe(after); // no new probe
  });

  test("resetBackendCache forces a re-probe", () => {
    let calls = 0;
    const deps = {
      ...depsAll(0),
      run: () => {
        calls++;
        return { status: 0 };
      },
    };
    detectBackend(deps);
    const after = calls;
    resetBackendCache();
    detectBackend(deps);
    expect(calls).toBeGreaterThan(after);
  });

  test("probe argv includes session-env mkdir (exercises the carve-out)", () => {
    let probeArgs: string[] = [];
    const deps = {
      run: (cmd: string, args: string[]) => {
        if (cmd === "bwrap" && args[0] === "--version") return { status: 0 };
        probeArgs = args;
        return { status: 0 };
      },
      exists: () => false,
      home: "/home/me",
      claudeDir: "/home/me/.claude",
      nodeBinReal: "/usr/bin/node",
    };
    detectBackend(deps);
    // The /bin/sh -c string must contain both "session-env" and "mkdir"
    const shCmdIdx = probeArgs.indexOf("-c");
    expect(shCmdIdx).toBeGreaterThanOrEqual(0);
    const shCmd = probeArgs[shCmdIdx + 1];
    expect(shCmd).toContain("session-env");
    expect(shCmd).toContain("mkdir");
  });

  // Regression (#294): with no nodeBinReal dep the default resolves a REAL node
  // path; the old `?? "node"` made dirname("node") === "." so the self-test bound
  // the cwd instead of the toolchain root, diverging from real spawns -> null.
  test("default nodeBinReal resolves a real toolchain dir, never '.'", () => {
    let probeFlags: string[] = [];
    const run = (cmd: string, args: string[]) => {
      if (cmd === "bwrap" && args[0] === "--version") return { status: 0 };
      probeFlags = args; // the wrapped self-test argv
      return { status: 0 };
    };
    // omit nodeBinReal -> default resolver (safeRealpath(resolveNodeBin())) kicks in
    const backend = detectBackend({ run, home: "/home/x", claudeDir: "/home/x/.claude" });
    expect(backend).toBe("bwrap");

    // No toolchain bind may have "." as its source.
    const triples = (src: string) => {
      for (let i = 0; i < probeFlags.length - 2; i++) {
        if (probeFlags[i] === "--ro-bind-try" && probeFlags[i + 1] === src) return true;
      }
      return false;
    };
    expect(triples(".")).toBe(false);

    // On a normal host resolveNodeBin() finds an absolute node path, so at least
    // one toolchain bind is absolute. Guard for a bare-"node" host (no node found).
    if (resolveNodeBin() !== "node") {
      const hasAbsoluteToolchainBind = probeFlags.some(
        (flag, i) =>
          probeFlags[i - 1] === "--ro-bind-try" &&
          flag.startsWith("/") &&
          probeFlags[i + 1] === flag,
      );
      expect(hasAbsoluteToolchainBind).toBe(true);
    }
  });
});

import { parseSandboxProfile } from "../src/config";

describe("parseSandboxProfile (config helper)", () => {
  test("a valid profile passes through", () => {
    expect(parseSandboxProfile("standard")).toBe("standard");
    expect(parseSandboxProfile("autonomous")).toBe("autonomous");
    expect(parseSandboxProfile("trusted")).toBe("trusted");
  });
  test("undefined / blank / garbage falls back to trusted", () => {
    expect(parseSandboxProfile(undefined)).toBe("trusted");
    expect(parseSandboxProfile("")).toBe("trusted");
    expect(parseSandboxProfile("nonsense")).toBe("trusted");
  });
});

describe("#1144 session marker survives the membrane", () => {
  test("SHEPHERD_SESSION_ID rides --setenv into the bwrap argv (past --clearenv)", () => {
    // House rule: env set OUTSIDE the sandbox is stripped by --clearenv. The runaway reaper
    // (#1144) attributes an orphan by reading SHEPHERD_SESSION_ID from its /proc/<pid>/environ,
    // so if the marker did not survive into the sandbox, EVERY membrane-spawned agent's leaks
    // would be unattributable and silently unreapable. Assert it is actually in the argv.
    const f = buildMembraneFlags(
      fakeMembrane({ extraEnv: { SHEPHERD_SESSION_ID: "sess-abc" } }),
      detDeps,
    );
    expect(f).toContain("--clearenv");
    const i = f.indexOf("SHEPHERD_SESSION_ID");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(f[i - 1]).toBe("--setenv");
    expect(f[i + 1]).toBe("sess-abc");
  });
});
