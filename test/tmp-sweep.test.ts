import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import {
  worktreeScratchDir,
  worktreeScratchDirCandidates,
  sweepClaudeTmp,
  removeWorktreeScratch,
  reapFallowCaches,
  pruneRepoWorktrees,
  reapAbandonedWorktrees,
  reclaimForkedPnpmStore,
  resolveStoreVersionDirs,
  readTmpInodeUsePct,
  tmpInodeBands,
  TMP_INODE_ERROR_PCT,
  FALLOW_CACHE_PREFIX,
  agentTmpDir,
  agentClaudeTmpRoot,
  legacyClaudeTmpRoot,
  sessionScratchpadDirCandidates,
  existingScratchpadDir,
  scratchpadHasFiles,
} from "../src/tmp-sweep";

/** Minimal `Dirent` fake — the reclaimers only read `.name` + `.isDirectory()`. */
const dirent = (name: string, isDir: boolean): Dirent =>
  ({ name, isDirectory: () => isDir }) as unknown as Dirent;

const uid = (): number => process.getuid?.() ?? 1000;
const nested = `claude-${uid()}`;

// Track temp dirs + env mutations so each test self-cleans (no cross-test bleed).
const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), "tmp-sweep-test-"));
  dirs.push(d);
  return d;
}
function setEnv(key: string, val: string) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = val;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k];
});

// Fake statfs reporting a given inode use ratio. files=total inodes, ffree=free.
function fakeStatfs(files: number, ffree: number) {
  return async () =>
    ({ files, ffree }) as unknown as ReturnType<
      typeof import("node:fs/promises").statfs
    > extends Promise<infer R>
      ? R
      : never;
}

describe("worktreeScratchDir", () => {
  test("produces the exact dashified path under the doubled claude root", () => {
    const root = "/tmp/claude-1000-fake-root";
    setEnv("SHEPHERD_TMP_SWEEP_DIR", root);
    const wt = "/home/patrick/Work/.shepherd-worktrees/x-review-0a928a8b";
    expect(worktreeScratchDir(wt)).toBe(
      join(root, nested, "-home-patrick-Work--shepherd-worktrees-x-review-0a928a8b"),
    );
  });
});

describe("sweepClaudeTmp", () => {
  test("below threshold: sweeps nothing, leaves node-compile-cache intact", async () => {
    const root = mkTmp();
    const ncc = join(root, "node-compile-cache");
    mkdirSync(ncc);
    writeFileSync(join(ncc, "blob.bin"), "x");

    const res = await sweepClaudeTmp({
      root,
      fsOps: {
        statfs: fakeStatfs(1000, 900), // 10% used
        readdir: () => {
          throw new Error("readdir should not be called below threshold");
        },
        stat: (() => {
          throw new Error("stat should not be called");
        }) as never,
        rm: (() => {
          throw new Error("rm should not be called");
        }) as never,
      } as never,
      log: () => {},
    });

    expect(res.swept).toBe(false);
    expect(res.reason).toContain("below-threshold");
    expect(res.removed).toBe(0);
    expect(existsSync(ncc)).toBe(true);
  });

  test("honors a configured 0 threshold (not coerced to the default 80)", async () => {
    // SHEPHERD_TMP_INODE_PCT=0 means "always sweep". With the old `Number(x)||80`
    // parse this 0 was silently coerced back to 80, so a 10%-used fs would NOT sweep.
    setEnv("SHEPHERD_TMP_INODE_PCT", "0");
    const root = mkTmp();
    const ncc = join(root, "node-compile-cache");
    mkdirSync(ncc);
    writeFileSync(join(ncc, "blob.bin"), "x");

    const fsp = await import("node:fs/promises");
    const res = await sweepClaudeTmp({
      root,
      fsOps: {
        statfs: fakeStatfs(1000, 900), // 10% used — below the default 80, at/over 0
        readdir: fsp.readdir,
        stat: fsp.stat,
        rm: fsp.rm,
      } as never,
      log: () => {},
    });

    expect(res.swept).toBe(true);
    expect(existsSync(ncc)).toBe(false); // dropped because threshold 0 was honored
  });

  test("over threshold: node-compile-cache wholesale + stale caches removed, fresh caches + session scratch kept", async () => {
    const root = mkTmp();
    const ncc = join(root, "node-compile-cache");
    mkdirSync(ncc); // freshly created (recent mtime) yet must still be removed wholesale
    writeFileSync(join(ncc, "blob.bin"), "x");

    const staleCache = join(root, "bunx-1000-typescript"); // known regenerable cache, stale → removed
    mkdirSync(staleCache);
    const freshCache = join(root, "fallow-audit-base-cache-abc"); // known cache, fresh → kept
    mkdirSync(freshCache);
    // A still-active session's scratch: NOT a cache name, stale top-level mtime → must be KEPT
    // (only `removeWorktreeScratch` on archival may reclaim it, never this sweep).
    const sessionScratch = join(root, "-home-patrick-Work--shepherd-worktrees-x-review-0a928a8b");
    mkdirSync(sessionScratch);

    const now = Date.now();
    const old = new Date(now - 48 * 3600_000); // 48h ago
    utimesSync(staleCache, old, old);
    utimesSync(sessionScratch, old, old);

    // Fake statfs forces over-threshold deterministically (real tmpfs use varies).
    const fsp = await import("node:fs/promises");
    const res = await sweepClaudeTmp({
      root,
      now,
      fsOps: {
        statfs: fakeStatfs(1000, 100), // 90% used
        readdir: fsp.readdir,
        stat: fsp.stat,
        rm: fsp.rm,
      } as never,
      log: () => {},
    });

    expect(res.swept).toBe(true);
    expect(res.reason).toContain("inode use");
    expect(existsSync(ncc)).toBe(false); // wholesale
    expect(existsSync(staleCache)).toBe(false); // known cache, stale → removed
    expect(existsSync(freshCache)).toBe(true); // known cache, fresh → kept
    expect(existsSync(sessionScratch)).toBe(true); // non-cache scratch → kept despite being stale
    expect(existsSync(root)).toBe(true); // root itself never removed
    expect(res.removed).toBe(2); // ncc + staleCache only
  });

  test("over threshold: a stale NON-cache (session) scratch dir is left in place", async () => {
    const root = mkTmp();
    // Mimics a live long-running session whose top-level mtime is stale (writes go to subdirs).
    const sessionScratch = join(root, "-home-fake-session");
    mkdirSync(sessionScratch);
    mkdirSync(join(sessionScratch, "1778cf88-session-id")); // in-use subdir
    const now = Date.now();
    const old = new Date(now - 72 * 3600_000);
    utimesSync(sessionScratch, old, old);

    const fsp = await import("node:fs/promises");
    const res = await sweepClaudeTmp({
      root,
      now,
      fsOps: {
        statfs: fakeStatfs(1000, 50), // 95% used
        readdir: fsp.readdir,
        stat: fsp.stat,
        rm: fsp.rm,
      } as never,
      log: () => {},
    });

    expect(res.swept).toBe(true);
    expect(res.removed).toBe(0); // nothing eligible — session scratch is not a known cache
    expect(existsSync(sessionScratch)).toBe(true);
  });

  test("nested claude-$uid dir is not wholesale-removed; its stale child is swept", async () => {
    const root = mkTmp();
    const nestedDir = join(root, nested);
    mkdirSync(nestedDir);
    // Make the nested dir itself old to prove it is NOT age-gated as a root entry.
    const now = Date.now();
    const old = new Date(now - 72 * 3600_000);

    const staleCacheChild = join(nestedDir, "bunx-1000-old"); // known cache, stale → swept
    mkdirSync(staleCacheChild);
    const freshChild = join(nestedDir, "bunx-1000-live"); // known cache, fresh → kept
    mkdirSync(freshChild);
    const staleSessionChild = join(nestedDir, "-home-old-worktree"); // session scratch, stale → kept
    mkdirSync(staleSessionChild);
    utimesSync(staleCacheChild, old, old);
    utimesSync(staleSessionChild, old, old);
    utimesSync(nestedDir, old, old);

    const fsp = await import("node:fs/promises");
    const res = await sweepClaudeTmp({
      root,
      now,
      fsOps: {
        statfs: fakeStatfs(1000, 50), // 95% used
        readdir: fsp.readdir,
        stat: fsp.stat,
        rm: fsp.rm,
      } as never,
      log: () => {},
    });

    expect(res.swept).toBe(true);
    expect(existsSync(nestedDir)).toBe(true); // never wholesale-removed
    expect(existsSync(staleCacheChild)).toBe(false); // known cache swept as the second root
    expect(existsSync(freshChild)).toBe(true);
    expect(existsSync(staleSessionChild)).toBe(true); // session scratch preserved even when stale
  });

  test("fail-open: statfs not a function → statfs-unavailable, nothing removed", async () => {
    const root = mkTmp();
    const ncc = join(root, "node-compile-cache");
    mkdirSync(ncc);
    const res = await sweepClaudeTmp({
      root,
      fsOps: {
        statfs: undefined,
        readdir: (() => {
          throw new Error("nope");
        }) as never,
        stat: (() => {
          throw new Error("nope");
        }) as never,
        rm: (() => {
          throw new Error("nope");
        }) as never,
      } as never,
      log: () => {},
    });
    expect(res).toEqual({
      swept: false,
      reason: "statfs-unavailable",
      removed: 0,
    });
    expect(existsSync(ncc)).toBe(true);
  });

  test("statfs that throws → root-missing", async () => {
    const root = mkTmp();
    const res = await sweepClaudeTmp({
      root,
      fsOps: {
        statfs: async () => {
          throw new Error("ENOENT");
        },
        readdir: (() => {}) as never,
        stat: (() => {}) as never,
        rm: (() => {}) as never,
      } as never,
      log: () => {},
    });
    expect(res).toEqual({ swept: false, reason: "root-missing", removed: 0 });
  });

  test("never rejects: rm always throwing still resolves with swept:true", async () => {
    const root = mkTmp();
    mkdirSync(join(root, "node-compile-cache"));
    mkdirSync(join(root, "old"));
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(join(root, "old"), old, old);

    const fsp = await import("node:fs/promises");
    const res = await sweepClaudeTmp({
      root,
      fsOps: {
        statfs: fakeStatfs(1000, 50),
        readdir: fsp.readdir,
        stat: fsp.stat,
        rm: async () => {
          throw new Error("EACCES");
        },
      } as never,
      log: () => {},
    });
    expect(res.swept).toBe(true); // resolved, not rejected
  });

  test("statfs reporting non-finite files → statfs-unavailable", async () => {
    const root = mkTmp();
    const res = await sweepClaudeTmp({
      root,
      fsOps: {
        statfs: async () => ({ files: NaN, ffree: 10 }) as never,
        readdir: (() => {}) as never,
        stat: (() => {}) as never,
        rm: (() => {}) as never,
      } as never,
      log: () => {},
    });
    expect(res).toEqual({
      swept: false,
      reason: "statfs-unavailable",
      removed: 0,
    });
  });

  // Forced sweep (#1862). The Doctor row's one-click fix passes `thresholdPct: 0` to mean "sweep
  // unconditionally". Both `inodeUsePct` failure reasons return BEFORE the threshold is compared,
  // so without the bypass the fix would silently do nothing on exactly the hosts that hit them —
  // a btrfs tmp (reports files: 0) or a host whose claude root doesn't exist yet.
  describe("thresholdPct <= 0 forces a sweep past the gate", () => {
    async function forcedSweepWith(statfs: unknown) {
      const root = mkTmp();
      const ncc = join(root, "node-compile-cache");
      mkdirSync(ncc);
      writeFileSync(join(ncc, "blob.bin"), "x");

      const fsp = await import("node:fs/promises");
      const res = await sweepClaudeTmp({
        root,
        thresholdPct: 0,
        fsOps: {
          statfs,
          readdir: fsp.readdir,
          stat: fsp.stat,
          rm: fsp.rm,
        } as never,
        log: () => {},
      });
      return { res, ncc };
    }

    test("statfs unavailable (would be statfs-unavailable) still sweeps", async () => {
      const { res, ncc } = await forcedSweepWith(undefined);
      expect(res.swept).toBe(true);
      expect(res.reason).toBe("swept forced (gate bypassed)");
      expect(res.removed).toBe(1);
      expect(existsSync(ncc)).toBe(false);
    });

    test("btrfs-style files: 0 (would be statfs-unavailable) still sweeps", async () => {
      const { res, ncc } = await forcedSweepWith(async () => ({ files: 0, ffree: 0 }) as never);
      expect(res.swept).toBe(true);
      expect(res.reason).toBe("swept forced (gate bypassed)");
      expect(existsSync(ncc)).toBe(false);
    });

    test("statfs throwing (would be root-missing) still sweeps", async () => {
      const { res, ncc } = await forcedSweepWith(async () => {
        throw new Error("ENOENT");
      });
      expect(res.swept).toBe(true);
      expect(res.reason).toBe("swept forced (gate bypassed)");
      expect(existsSync(ncc)).toBe(false);
    });

    test("forced path never calls statfs at all — no use% exists to report", async () => {
      let calls = 0;
      await forcedSweepWith(async () => {
        calls += 1;
        return { files: 1000, ffree: 100 } as never;
      });
      expect(calls).toBe(0);
    });
  });

  // The bypass must be scoped to the explicit force. A normal threshold keeps today's fail-open
  // behavior byte-for-byte, including the reason string that quotes the measured use%.
  test("regression: a normal threshold still fails open and still reports the measured use%", async () => {
    const root = mkTmp();
    const ncc = join(root, "node-compile-cache");
    mkdirSync(ncc);

    const bailed = await sweepClaudeTmp({
      root,
      thresholdPct: 80,
      fsOps: {
        statfs: undefined,
        readdir: (() => {}) as never,
        stat: (() => {}) as never,
        rm: (() => {}) as never,
      } as never,
      log: () => {},
    });
    expect(bailed).toEqual({ swept: false, reason: "statfs-unavailable", removed: 0 });
    expect(existsSync(ncc)).toBe(true); // fail-open: nothing touched

    const fsp = await import("node:fs/promises");
    const swept = await sweepClaudeTmp({
      root,
      thresholdPct: 80,
      fsOps: {
        statfs: fakeStatfs(1000, 100), // 90% used
        readdir: fsp.readdir,
        stat: fsp.stat,
        rm: fsp.rm,
      } as never,
      log: () => {},
    });
    expect(swept.swept).toBe(true);
    expect(swept.reason).toBe("swept 90.0% inode use");
  });
});

// readTmpInodeUsePct (#1862) — the value behind the tmp_inodes Diagnose row.
describe("readTmpInodeUsePct", () => {
  test("statfs's tmpdir(), NOT claudeTmpRoot()", async () => {
    // claudeTmpRoot() is <tmpdir>/claude-$uid, which does not exist on a freshly booted host — the
    // root-missing branch would then report "uninspectable" on exactly the hosts with headroom
    // left to protect. tmpdir() is the filesystem actually at risk and is always present.
    const seen: string[] = [];
    await readTmpInodeUsePct((async (p: string) => {
      seen.push(p);
      return { files: 1000, ffree: 100 };
    }) as never);
    expect(seen).toEqual([tmpdir()]);
  });

  test("reports the use percentage", async () => {
    const pct = await readTmpInodeUsePct((async () => ({ files: 1000, ffree: 100 })) as never);
    expect(pct).toBeCloseTo(90);
  });

  test("btrfs-style files: 0 → null, never a bogus percentage", async () => {
    // btrfs allocates inodes dynamically and reports zero total, so a percentage is meaningless.
    expect(await readTmpInodeUsePct((async () => ({ files: 0, ffree: 0 })) as never)).toBeNull();
  });

  test("an unreadable filesystem → null", async () => {
    expect(
      await readTmpInodeUsePct((async () => {
        throw new Error("ENOENT");
      }) as never),
    ).toBeNull();
  });
});

// tmpInodeBands (#1862) — SHEPHERD_TMP_INODE_PCT is a sweep-GATE value being reused as a DISPLAY
// band, and the two disagree at both extremes. Forwarding it raw is a real bug, not a hypothetical.
describe("tmpInodeBands", () => {
  test("default: warns at 80, errors at 95", () => {
    expect(tmpInodeBands()).toEqual({ warnPct: 80, errorPct: TMP_INODE_ERROR_PCT });
  });

  test("an operator-raised threshold moves the warning band", () => {
    setEnv("SHEPHERD_TMP_INODE_PCT", "90");
    expect(tmpInodeBands()).toEqual({ warnPct: 90, errorPct: TMP_INODE_ERROR_PCT });
  });

  test("0 ('always sweep') does NOT become 'always warn'", () => {
    // envNum deliberately honours a configured 0 — it means "always sweep" for the GATE. Forwarded
    // raw as a display band it means usePct >= 0, i.e. a permanent warning on a healthy host that
    // no fix can clear. There is no useful band derivable from it, so fall back to the default.
    setEnv("SHEPHERD_TMP_INODE_PCT", "0");
    expect(tmpInodeBands().warnPct).toBe(80);
  });

  test("a negative threshold likewise falls back", () => {
    setEnv("SHEPHERD_TMP_INODE_PCT", "-5");
    expect(tmpInodeBands().warnPct).toBe(80);
  });

  test("a threshold above the error band raises the error band with it", () => {
    // Otherwise the warning range [warn, error) is empty AND error fires at 95 — below the line the
    // operator explicitly set — alarming about a state they told Shepherd to leave alone.
    setEnv("SHEPHERD_TMP_INODE_PCT", "98");
    expect(tmpInodeBands()).toEqual({ warnPct: 98, errorPct: 98 });
  });

  test("a non-percentage threshold (>100) is misconfiguration, not a disabled row", () => {
    setEnv("SHEPHERD_TMP_INODE_PCT", "150");
    expect(tmpInodeBands()).toEqual({ warnPct: 80, errorPct: TMP_INODE_ERROR_PCT });
  });

  test("the sweep gate starts acting exactly where the row warns", async () => {
    // The row's entire premise. Both consumers now read one shared default, so this can only fail
    // if someone re-hardcodes a literal in either place — which is exactly the drift being guarded.
    const { warnPct } = tmpInodeBands();
    const fsp = await import("node:fs/promises");
    const at = async (usePct: number) => {
      const root = mkTmp();
      const ncc = join(root, "node-compile-cache");
      mkdirSync(ncc);
      // files=10000 so a whole-percent usePct is exact (no rounding at the boundary).
      const res = await sweepClaudeTmp({
        root,
        fsOps: {
          statfs: fakeStatfs(10_000, 10_000 - usePct * 100),
          readdir: fsp.readdir,
          stat: fsp.stat,
          rm: fsp.rm,
        } as never,
        log: () => {},
      });
      return res.swept;
    };
    expect(await at(warnPct - 1)).toBe(false); // below the row's warn band → sweeper idle
    expect(await at(warnPct)).toBe(true); // at the row's warn band → sweeper acts
  });

  test("bands are always ordered and in range — the postcondition classifyTmpInodes relies on", () => {
    for (const v of ["0", "-1", "1", "50", "80", "95", "96", "100", "150", "abc", ""]) {
      setEnv("SHEPHERD_TMP_INODE_PCT", v);
      const { warnPct, errorPct } = tmpInodeBands();
      expect(warnPct).toBeGreaterThan(0);
      expect(warnPct).toBeLessThanOrEqual(100);
      expect(errorPct).toBeGreaterThanOrEqual(warnPct);
    }
  });
});

describe("removeWorktreeScratch", () => {
  test("removes an existing target dir", async () => {
    const dir = mkTmp();
    expect(existsSync(dir)).toBe(true);
    await removeWorktreeScratch("/whatever", { dir });
    expect(existsSync(dir)).toBe(false);
  });

  test("no-op (no throw) when the dir is absent", async () => {
    const dir = join(tmpdir(), "tmp-sweep-absent-" + Math.random());
    await expect(removeWorktreeScratch("/whatever", { dir })).resolves.toBeUndefined();
  });

  test("swallows a throwing rm (resolves)", async () => {
    await expect(
      removeWorktreeScratch("/whatever", {
        dir: "/x",
        rm: async () => {
          throw new Error("EACCES");
        },
      }),
    ).resolves.toBeUndefined();
  });

  test("dual-cleans BOTH the disk and legacy roots (#1875)", async () => {
    setEnv("SHEPHERD_TMP_SWEEP_DIR", "/disk/root"); // claudeTmpRoot() → disk
    setEnv("TMPDIR", "/legacy/base"); // legacyClaudeTmpRoot() → /legacy/base/claude-$uid
    const wt = "/home/u/Work/proj";
    const calls: string[] = [];
    await removeWorktreeScratch(wt, {
      rm: (async (p: string) => {
        calls.push(String(p));
      }) as never,
    });
    // rm is called once per DEDUPED candidate, in order (disk primary, then legacy tmpfs).
    expect(calls).toEqual(worktreeScratchDirCandidates(wt));
    expect(calls.length).toBe(2);
  });

  test("no-override collapses the two roots to a single rm call", async () => {
    setEnv("SHEPHERD_TMP_SWEEP_DIR", legacyClaudeTmpRoot()); // claudeTmpRoot() === legacy
    const calls: string[] = [];
    await removeWorktreeScratch("/home/u/Work/proj", {
      rm: (async (p: string) => {
        calls.push(String(p));
      }) as never,
    });
    expect(calls.length).toBe(1);
  });
});

// ── #1875: disk-backed agent TMPDIR geometry + migration helpers ────────────────
describe("agent tmp dir geometry (#1875)", () => {
  test("agentTmpDir(): default is ~/.cache/shepherd/tmp", () => {
    expect(agentTmpDir()).toBe(join(homedir(), ".cache", "shepherd", "tmp"));
  });

  test("agentTmpDir(): honors an explicit override", () => {
    setEnv("SHEPHERD_AGENT_TMPDIR", "/custom/disk");
    expect(agentTmpDir()).toBe("/custom/disk");
  });

  test("agentTmpDir(): an empty string disables the redirect (null)", () => {
    setEnv("SHEPHERD_AGENT_TMPDIR", "");
    expect(agentTmpDir()).toBeNull();
  });

  test("agentClaudeTmpRoot(): agentTmpDir + claude-$uid, null when disabled", () => {
    setEnv("SHEPHERD_AGENT_TMPDIR", "/custom/disk");
    expect(agentClaudeTmpRoot()).toBe(join("/custom/disk", nested));
    setEnv("SHEPHERD_AGENT_TMPDIR", "");
    expect(agentClaudeTmpRoot()).toBeNull();
  });

  test("legacyClaudeTmpRoot(): <tmpdir>/claude-$uid", () => {
    expect(legacyClaudeTmpRoot()).toBe(join(tmpdir(), nested));
  });

  test("sessionScratchpadDirCandidates: dedupes to one with no override, two under an override", () => {
    setEnv("SHEPHERD_TMP_SWEEP_DIR", legacyClaudeTmpRoot()); // primary === legacy
    expect(sessionScratchpadDirCandidates("/home/u/Work/proj", "sid").length).toBe(1);
    setEnv("SHEPHERD_TMP_SWEEP_DIR", "/disk/root"); // primary !== legacy
    expect(sessionScratchpadDirCandidates("/home/u/Work/proj", "sid").length).toBe(2);
  });

  test("existingScratchpadDir + scratchpadHasFiles: fall back to the legacy tmpfs root", async () => {
    const diskRoot = mkTmp();
    const legacyBase = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", diskRoot); // claudeTmpRoot() → disk (primary, absent)
    setEnv("TMPDIR", legacyBase); // legacyClaudeTmpRoot() → legacyBase/claude-$uid
    const wt = "/home/u/Work/proj";
    const sid = "sess-legacy";
    const dash = wt.replace(/[/.]/g, "-");
    const legacyDir = join(legacyBase, nested, dash, sid, "scratchpad");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "note.txt"), "x");
    // Only the legacy dir exists → resolver falls back to it, and the Files-tab gate lights.
    expect(await existingScratchpadDir(wt, sid)).toBe(legacyDir);
    expect(await scratchpadHasFiles(wt, sid)).toBe(true);
  });

  test("existingScratchpadDir: prefers the disk root when BOTH exist", async () => {
    const diskRoot = mkTmp();
    const legacyBase = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", diskRoot);
    setEnv("TMPDIR", legacyBase);
    const wt = "/home/u/Work/proj";
    const sid = "sess-both";
    const dash = wt.replace(/[/.]/g, "-");
    const primaryDir = join(diskRoot, dash, sid, "scratchpad");
    const legacyDir = join(legacyBase, nested, dash, sid, "scratchpad");
    mkdirSync(primaryDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(primaryDir, "b"), "y");
    writeFileSync(join(legacyDir, "a"), "x");
    expect(await existingScratchpadDir(wt, sid)).toBe(primaryDir);
  });

  test("reapFallowCaches: default set reaps a stale fallow cache at the bare agentTmpDir() root", async () => {
    const agentRoot = mkTmp();
    const claudeRootDir = mkTmp();
    const tmpBase = mkTmp(); // empty — keeps the other default roots (+bare /tmp) out of play
    setEnv("SHEPHERD_AGENT_TMPDIR", agentRoot);
    setEnv("SHEPHERD_TMP_SWEEP_DIR", claudeRootDir);
    setEnv("TMPDIR", tmpBase);
    const dir = join(agentRoot, `${FALLOW_CACHE_PREFIX}bare`);
    mkdirSync(dir);
    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(dir, old, old);
    // NO `roots` override → exercises the DEFAULT computed set, which must include agentTmpDir().
    await reapFallowCaches({ now, staleMs: 24 * 3600_000, fsOps: fsp, log: () => {} });
    expect(existsSync(dir)).toBe(false);
  });

  test("reapFallowCaches: a DISABLED agent tmp dir is not scanned", async () => {
    const agentRoot = mkTmp();
    const claudeRootDir = mkTmp();
    const tmpBase = mkTmp();
    setEnv("SHEPHERD_AGENT_TMPDIR", ""); // disabled
    setEnv("SHEPHERD_TMP_SWEEP_DIR", claudeRootDir);
    setEnv("TMPDIR", tmpBase);
    const dir = join(agentRoot, `${FALLOW_CACHE_PREFIX}x`);
    mkdirSync(dir);
    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(dir, old, old);
    await reapFallowCaches({ now, staleMs: 24 * 3600_000, fsOps: fsp, log: () => {} });
    expect(existsSync(dir)).toBe(true); // survives — bare agent root not in the default set
  });

  test("sweepClaudeTmp: the default (forced) path also sweeps the bare agentTmpDir() root", async () => {
    const agentRoot = mkTmp();
    const claudeRootDir = mkTmp();
    const tmpBase = mkTmp();
    setEnv("SHEPHERD_AGENT_TMPDIR", agentRoot);
    setEnv("SHEPHERD_TMP_SWEEP_DIR", claudeRootDir);
    setEnv("TMPDIR", tmpBase);
    const ncc = join(agentRoot, "node-compile-cache");
    mkdirSync(ncc);
    const staleBunx = join(agentRoot, "bunx-1000-x");
    mkdirSync(staleBunx);
    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(staleBunx, old, old);
    // thresholdPct: 0 forces the sweep (gate bypassed); NO `root` override → default sweepRoots.
    const res = await sweepClaudeTmp({ thresholdPct: 0, now, fsOps: fsp, log: () => {} });
    expect(res.swept).toBe(true);
    expect(existsSync(ncc)).toBe(false); // wholesale, at the bare agent root
    expect(existsSync(staleBunx)).toBe(false); // stale regenerable cache, at the bare agent root
  });
});

describe("reapFallowCaches", () => {
  test("removes a stale fallow dir and its .lock / .last-used sidecars", async () => {
    const root = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", root);

    const name = `${FALLOW_CACHE_PREFIX}abc123`;
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(`${dir}.lock`, "");
    writeFileSync(`${dir}.last-used`, "");

    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(dir, old, old);

    // Injecting the scanned root makes `removed === 1` deterministic regardless of bare-`/tmp`
    // contents or a concurrent test process — env-independent isolation (#817).
    const res = await reapFallowCaches({
      now,
      staleMs: 24 * 3600_000,
      fsOps: fsp,
      log: () => {},
      roots: [root],
    });

    expect(res.removed).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.lock`)).toBe(false);
    expect(existsSync(`${dir}.last-used`)).toBe(false);
  });

  test("keeps a fresh fallow dir", async () => {
    const root = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", root);

    const name = `${FALLOW_CACHE_PREFIX}fresh`;
    const dir = join(root, name);
    mkdirSync(dir);

    // roots: [root] isolates this assertion from foreign fallow-audit-base-cache-* dirs
    // the real fallow tool / a concurrent test process leaves in the system tmpdir (#817).
    const res = await reapFallowCaches({
      now: Date.now(),
      staleMs: 24 * 3600_000,
      fsOps: fsp,
      log: () => {},
      roots: [root],
    });

    expect(res.removed).toBe(0);
    expect(existsSync(dir)).toBe(true);
  });

  test("ignores non-fallow dirs", async () => {
    const root = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", root);

    const otherDir = join(root, "bunx-1000-something");
    mkdirSync(otherDir);
    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(otherDir, old, old);

    // roots: [root] isolates this assertion from foreign fallow-audit-base-cache-* dirs
    // the real fallow tool / a concurrent test process leaves in the system tmpdir (#817).
    const res = await reapFallowCaches({
      now,
      staleMs: 24 * 3600_000,
      fsOps: fsp,
      log: () => {},
      roots: [root],
    });

    expect(res.removed).toBe(0);
    expect(existsSync(otherDir)).toBe(true);
  });

  test("ignores .lock and .last-used sidecar entries in the scan", async () => {
    // Even if a .lock / .last-used entry matches the prefix after stripping, they must not
    // be treated as primary cache dirs — the reaper skips them; they're removed alongside
    // their parent, not independently.
    const root = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", root);

    // Create only sidecars, no parent dir (orphaned sidecars).
    writeFileSync(join(root, `${FALLOW_CACHE_PREFIX}orphan.lock`), "");
    writeFileSync(join(root, `${FALLOW_CACHE_PREFIX}orphan.last-used`), "");

    // roots: [root] isolates this assertion from foreign fallow-audit-base-cache-* dirs
    // the real fallow tool / a concurrent test process leaves in the system tmpdir (#817).
    const res = await reapFallowCaches({
      now: Date.now(),
      staleMs: 24 * 3600_000,
      fsOps: fsp,
      log: () => {},
      roots: [root],
    });

    // sidecars are skipped, so removed count stays 0; the sidecar files themselves stay
    expect(res.removed).toBe(0);
  });

  test("scans the bare tmpdir() root", async () => {
    // Simulate a stale fallow cache landing in the system tmpdir (TMPDIR was system default
    // during the push). We create it under a test-controlled root set as SHEPHERD_TMP_SWEEP_DIR
    // but also verify tmpdir() is in the scan roots by using the real tmpdir.
    const sysTmp = tmpdir();
    const name = `${FALLOW_CACHE_PREFIX}systmp-test-${Math.random().toString(36).slice(2)}`;
    const dir = join(sysTmp, name);
    mkdirSync(dir);
    dirs.push(dir); // cleaned up in afterEach

    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(dir, old, old);

    // Point SHEPHERD_TMP_SWEEP_DIR to a fresh temp dir that has NO fallow caches,
    // so only the systmp root can supply the removed count.
    const cleanRoot = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", cleanRoot);

    await reapFallowCaches({
      now,
      staleMs: 24 * 3600_000,
      fsOps: fsp,
      log: () => {},
    });

    // Count not asserted: under concurrency a different process's reaper may sweep the dir
    // first, leaving removed: 0. The dir's removal proves tmpdir() is in the default scan
    // set (#817) — SHEPHERD_TMP_SWEEP_DIR points to an empty cleanRoot so only the bare
    // tmpdir() root could have removed it.
    expect(existsSync(dir)).toBe(false);
  });

  test("runs without a statfs/inode gate", async () => {
    // reapFallowCaches must work even when statfs would be unavailable (no fsOps.statfs).
    const root = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", root);

    const name = `${FALLOW_CACHE_PREFIX}ungated`;
    const dir = join(root, name);
    mkdirSync(dir);
    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(dir, old, old);

    // Only provide readdir/stat/rm — no statfs property at all.
    // roots: [root] isolates this assertion from foreign fallow-audit-base-cache-* dirs
    // the real fallow tool / a concurrent test process leaves in the system tmpdir (#817).
    const res = await reapFallowCaches({
      now,
      staleMs: 24 * 3600_000,
      fsOps: { readdir: fsp.readdir, stat: fsp.stat, rm: fsp.rm },
      log: () => {},
      roots: [root],
    });

    expect(res.removed).toBe(1);
    expect(existsSync(dir)).toBe(false);
  });

  test("never rejects; per-entry errors are swallowed", async () => {
    const root = mkTmp();
    setEnv("SHEPHERD_TMP_SWEEP_DIR", root);

    const name = `${FALLOW_CACHE_PREFIX}bad`;
    const dir = join(root, name);
    mkdirSync(dir);
    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(dir, old, old);

    // roots: [root] isolates this assertion from foreign fallow-audit-base-cache-* dirs
    // the real fallow tool / a concurrent test process leaves in the system tmpdir (#817).
    const res = await reapFallowCaches({
      now,
      staleMs: 24 * 3600_000,
      fsOps: {
        readdir: fsp.readdir,
        stat: fsp.stat,
        rm: async () => {
          throw new Error("EACCES");
        },
      },
      log: () => {},
      roots: [root],
    });

    // rm threw, so nothing removed — but we did not reject
    expect(res.removed).toBe(0);
  });
});

describe("pruneRepoWorktrees", () => {
  test("invokes git -C <repo> worktree prune once per repo", async () => {
    const calls: Array<{ repo: string; args: string[] }> = [];
    const fakeExecGit = async (repo: string, args: string[]) => {
      calls.push({ repo, args });
    };

    const res = await pruneRepoWorktrees(["/repo/a", "/repo/b"], {
      execGit: fakeExecGit,
      isGitRepo: async () => true,
      log: () => {},
    });

    expect(res.pruned).toBe(2);
    expect(res.failed).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls.at(0)?.args).toEqual(["-C", "/repo/a", "worktree", "prune", "--expire=now"]);
    expect(calls.at(1)?.args).toEqual(["-C", "/repo/b", "worktree", "prune", "--expire=now"]);
  });

  test("a failing repo does not abort the others", async () => {
    const calls: string[] = [];
    const fakeExecGit = async (repo: string) => {
      if (repo === "/repo/bad") throw new Error("not a git repo");
      calls.push(repo);
    };

    const res = await pruneRepoWorktrees(["/repo/bad", "/repo/good"], {
      execGit: fakeExecGit,
      isGitRepo: async () => true,
      log: () => {},
    });

    expect(res.pruned).toBe(1);
    expect(res.failed).toBe(1);
    expect(calls).toEqual(["/repo/good"]);
  });

  test("skips non-git folders silently — no prune, no failure, no log", async () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const res = await pruneRepoWorktrees(["/work/gdpr", "/work/repo"], {
      execGit: async (repo) => {
        calls.push(repo);
      },
      isGitRepo: async (repo) => repo === "/work/repo",
      log: (msg) => logs.push(msg),
    });

    expect(res).toEqual({ pruned: 1, failed: 0 });
    expect(calls).toEqual(["/work/repo"]);
    expect(logs).toEqual([]);
  });

  test("never rejects; empty list returns zeroes", async () => {
    const res = await pruneRepoWorktrees([], { execGit: async () => {}, log: () => {} });
    expect(res).toEqual({ pruned: 0, failed: 0 });
  });
});

// ── reapAbandonedWorktrees ───────────────────────────────────────────────────

describe("reapAbandonedWorktrees", () => {
  const NOW = 1_700_000_000_000;
  // one worktree block; `extra` carries porcelain annotation lines.
  const porc = (path: string, extra: string[] = []) =>
    ["worktree " + path, "HEAD abcdef", "branch refs/heads/feat", ...extra, ""].join("\n");

  // Default: a single stale, clean worktree at /tmp/wt-a, high inode pressure, modern git.
  function reaperOpts(over: Record<string, unknown> = {}) {
    const removed: string[] = [];
    const opts = {
      repoPaths: ["/repo"],
      liveWorktreePaths: [] as string[],
      liveCwds: [] as string[],
      tmpRoots: ["/tmp"],
      now: NOW,
      statfs: fakeStatfs(1000, 100), // 90% used ≥ default 80
      realpath: async (p: string) => p,
      execGit: async (_cwd: string, args: string[]) => {
        if (args[0] === "--version") return "git version 2.54.0";
        if (args[0] === "worktree" && args[1] === "list") return porc("/tmp/wt-a");
        if (args[0] === "status") return ""; // clean
        return "";
      },
      fsOps: {
        readdir: async () => [] as Dirent[], // empty tree → freshness walk finds nothing
        stat: async () => ({ mtimeMs: 0 }) as unknown as Awaited<ReturnType<typeof fsp.stat>>,
      },
      removeWorktree: async (_repo: string, wt: string) => {
        removed.push(wt);
      },
      log: () => {},
      ...over,
    };
    return { opts, removed };
  }

  test("stale + clean + high pressure + modern git → reaped, retained 0", async () => {
    const { opts, removed } = reaperOpts();
    const r = await reapAbandonedWorktrees(opts as never);
    expect(r).toEqual({ reaped: 1, retained: 0 });
    expect(removed).toEqual(["/tmp/wt-a"]);
  });

  test("dirty (git status non-empty) → kept, retained 1", async () => {
    const { opts, removed } = reaperOpts({
      execGit: async (_c: string, args: string[]) => {
        if (args[0] === "--version") return "git version 2.54.0";
        if (args[0] === "worktree" && args[1] === "list") return porc("/tmp/wt-a");
        if (args[0] === "status") return " M file.ts\n"; // dirty
        return "";
      },
    });
    const r = await reapAbandonedWorktrees(opts as never);
    expect(r).toEqual({ reaped: 0, retained: 1 });
    expect(removed).toEqual([]);
  });

  test("git status THROWS → treated as dirty → kept", async () => {
    const { opts } = reaperOpts({
      execGit: async (_c: string, args: string[]) => {
        if (args[0] === "--version") return "git version 2.54.0";
        if (args[0] === "worktree" && args[1] === "list") return porc("/tmp/wt-a");
        if (args[0] === "status") throw new Error("git blew up");
        return "";
      },
    });
    expect(await reapAbandonedWorktrees(opts as never)).toEqual({ reaped: 0, retained: 1 });
  });

  for (const ann of ["locked", "bare", "prunable"]) {
    test(`porcelain '${ann}' annotation → kept`, async () => {
      const { opts, removed } = reaperOpts({
        execGit: async (_c: string, args: string[]) => {
          if (args[0] === "--version") return "git version 2.54.0";
          if (args[0] === "worktree" && args[1] === "list")
            return porc("/tmp/wt-a", [ann === "bare" ? "bare" : `${ann} some reason here`]);
          if (args[0] === "status") return "";
          return "";
        },
      });
      const r = await reapAbandonedWorktrees(opts as never);
      expect(r).toEqual({ reaped: 0, retained: 1 });
      expect(removed).toEqual([]);
    });
  }

  test("Shepherd session worktree marker → kept", async () => {
    const marked = "/tmp/x/.shepherd-worktrees/sess-1";
    const { opts } = reaperOpts({
      execGit: async (_c: string, args: string[]) => {
        if (args[0] === "--version") return "git version 2.54.0";
        if (args[0] === "worktree" && args[1] === "list") return porc(marked);
        if (args[0] === "status") return "";
        return "";
      },
    });
    expect(await reapAbandonedWorktrees(opts as never)).toEqual({ reaped: 0, retained: 1 });
  });

  test("live-session worktreePath → kept", async () => {
    const { opts } = reaperOpts({ liveWorktreePaths: ["/tmp/wt-a"] });
    expect(await reapAbandonedWorktrees(opts as never)).toEqual({ reaped: 0, retained: 1 });
  });

  test("live /proc cwd under the candidate → kept", async () => {
    const { opts } = reaperOpts({ liveCwds: ["/tmp/wt-a/packages/x"] });
    expect(await reapAbandonedWorktrees(opts as never)).toEqual({ reaped: 0, retained: 1 });
  });

  test("fresh (recent mtime) → kept", async () => {
    const { opts } = reaperOpts({
      fsOps: {
        readdir: async () => [] as Dirent[],
        stat: async () => ({ mtimeMs: NOW }) as unknown as Awaited<ReturnType<typeof fsp.stat>>,
      },
    });
    expect(await reapAbandonedWorktrees(opts as never)).toEqual({ reaped: 0, retained: 1 });
  });

  test("below inode threshold → discovered but NOT removed; retained reflects it", async () => {
    const { opts, removed } = reaperOpts({ statfs: fakeStatfs(1000, 900) }); // 10% < 80
    const r = await reapAbandonedWorktrees(opts as never);
    expect(r).toEqual({ reaped: 0, retained: 1 });
    expect(removed).toEqual([]);
  });

  test("git below the 2.38 floor → discovered but NOT removed", async () => {
    const { opts, removed } = reaperOpts({
      execGit: async (_c: string, args: string[]) => {
        if (args[0] === "--version") return "git version 2.35.0";
        if (args[0] === "worktree" && args[1] === "list") return porc("/tmp/wt-a");
        if (args[0] === "status") return "";
        return "";
      },
    });
    expect(await reapAbandonedWorktrees(opts as never)).toEqual({ reaped: 0, retained: 1 });
    expect(removed).toEqual([]);
  });

  test("candidate NOT under any tmp root → not a candidate", async () => {
    const { opts } = reaperOpts({
      execGit: async (_c: string, args: string[]) => {
        if (args[0] === "--version") return "git version 2.54.0";
        if (args[0] === "worktree" && args[1] === "list") return porc("/home/me/work/wt");
        if (args[0] === "status") return "";
        return "";
      },
    });
    expect(await reapAbandonedWorktrees(opts as never)).toEqual({ reaped: 0, retained: 0 });
  });

  test("symlinked tmp root: resolved candidate still segment-aligns and is refused", async () => {
    // Porcelain emits /tmp/wt-a; realpath resolves /tmp → /private/tmp (macOS-style), while
    // tmpRoots + liveCwds arrive in the /private/tmp form. The resolved candidate must still
    // match a tmp root AND the live-cwd, and be kept — a non-match would read as "not protected".
    const realpath = async (p: string) => p.replace(/^\/tmp(\/|$)/, "/private/tmp$1");
    const { opts, removed } = reaperOpts({
      realpath,
      tmpRoots: ["/private/tmp"],
      liveCwds: ["/private/tmp/wt-a/sub"],
    });
    const r = await reapAbandonedWorktrees(opts as never);
    expect(r).toEqual({ reaped: 0, retained: 1 }); // under tmp (so a candidate) AND live-cwd (so kept)
    expect(removed).toEqual([]);
  });
});

// ── resolveStoreVersionDirs ──────────────────────────────────────────────────

describe("resolveStoreVersionDirs", () => {
  test("keeps only /^v\\d+$/ directories", () => {
    const entries = [
      dirent("v10", true),
      dirent("v9", true),
      dirent("v10", false), // a FILE named v10 — excluded (not a dir)
      dirent("index", true),
      dirent("version", true), // not v<digits>
      dirent(".lock", false),
    ];
    expect(resolveStoreVersionDirs(entries)).toEqual(["v10", "v9"]);
  });

  test("empty when nothing matches", () => {
    expect(resolveStoreVersionDirs([dirent("garbage", true)])).toEqual([]);
  });
});

// ── reclaimForkedPnpmStore ───────────────────────────────────────────────────

describe("reclaimForkedPnpmStore", () => {
  const NOW = 1_700_000_000_000;
  const ROOT = "/tmp/.pnpm-store";

  // A removable store: v10 with files/ + index/, all stale, every content file nlink 1.
  function storeHarness() {
    const R: Record<string, Dirent[]> = {
      [ROOT]: [dirent("v10", true)],
      [`${ROOT}/v10`]: [dirent("files", true), dirent("index", true)],
      [`${ROOT}/v10/files`]: [dirent("9f", true)],
      [`${ROOT}/v10/files/9f`]: [dirent("abc", false)],
      [`${ROOT}/v10/index`]: [dirent("meta", false)],
    };
    const mtimes: Record<string, number> = {};
    const nlinks: Record<string, number> = {};
    const removed: string[] = [];
    const opts = {
      storeRoot: ROOT,
      retained: 0,
      now: NOW,
      statfs: fakeStatfs(1000, 100), // 90% ≥ 80
      fsOps: {
        readdir: async (p: string) => {
          const e = R[String(p)];
          if (!e) throw new Error("ENOENT " + p);
          return e;
        },
        stat: async (p: string) =>
          ({
            mtimeMs: mtimes[String(p)] ?? 0,
            nlink: nlinks[String(p)] ?? 1,
          }) as unknown as Awaited<ReturnType<typeof fsp.stat>>,
        rm: async (p: string) => {
          removed.push(String(p));
        },
      },
      log: () => {},
    };
    return { opts, R, mtimes, nlinks, removed };
  }

  test("fully idle + unlinked → removes the whole store root", async () => {
    const { opts, removed } = storeHarness();
    const r = await reclaimForkedPnpmStore(opts as never);
    expect(r.removed).toBe(true);
    expect(removed).toEqual([ROOT]);
  });

  test("retained > 0 → skip", async () => {
    const { opts, removed } = storeHarness();
    opts.retained = 1;
    const r = await reclaimForkedPnpmStore(opts as never);
    expect(r.removed).toBe(false);
    expect(r.reason).toContain("retained");
    expect(removed).toEqual([]);
  });

  test("inode pressure below threshold → skip", async () => {
    const { opts } = storeHarness();
    opts.statfs = fakeStatfs(1000, 900); // 10%
    expect((await reclaimForkedPnpmStore(opts as never)).removed).toBe(false);
  });

  test("missing store dir → no-store", async () => {
    const { opts } = storeHarness();
    opts.fsOps.readdir = async () => {
      throw new Error("ENOENT");
    };
    expect((await reclaimForkedPnpmStore(opts as never)).reason).toBe("no-store");
  });

  test("no v* dir → no-version-dir", async () => {
    const { opts, R } = storeHarness();
    R[ROOT] = [dirent("garbage", true)];
    expect((await reclaimForkedPnpmStore(opts as never)).reason).toBe("no-version-dir");
  });

  test("fresh non-v* sibling → skip", async () => {
    const { opts, R, mtimes } = storeHarness();
    R[ROOT] = [dirent("v10", true), dirent("staging.lock", false)];
    mtimes[`${ROOT}/staging.lock`] = NOW; // fresh
    const r = await reclaimForkedPnpmStore(opts as never);
    expect(r.removed).toBe(false);
    expect(r.reason).toContain("sibling-fresh");
  });

  test("stale but unrecognized non-v* directory sibling → skip", async () => {
    const { opts, R } = storeHarness();
    R[ROOT] = [dirent("v10", true), dirent("staging", true)]; // stale dir, unknown
    const r = await reclaimForkedPnpmStore(opts as never);
    expect(r.removed).toBe(false);
    expect(r.reason).toContain("sibling-unrecognized");
  });

  test("a depth-2 entry with a recent mtime → store-busy (idleness probes at depth 2)", async () => {
    const { opts, mtimes } = storeHarness();
    mtimes[`${ROOT}/v10/files/9f`] = NOW; // a bucket (depth 2) touched recently
    const r = await reclaimForkedPnpmStore(opts as never);
    expect(r.removed).toBe(false);
    expect(r.reason).toContain("store-busy");
  });

  test("any file with nlink > 1 → store-linked (skip)", async () => {
    const { opts, nlinks } = storeHarness();
    nlinks[`${ROOT}/v10/files/9f/abc`] = 2; // a worktree still links it
    const r = await reclaimForkedPnpmStore(opts as never);
    expect(r.removed).toBe(false);
    expect(r.reason).toContain("store-linked");
  });

  test("a bucket unreadable during the nlink walk → keep (not provably unlinked)", async () => {
    // Idleness passes (depth-2 only stats the bucket dir), but the exhaustive nlink walk must
    // descend into it — a readdir error there resolves to keep, never a removal.
    const { opts, R } = storeHarness();
    delete R[`${ROOT}/v10/files/9f`]; // readdir(bucket) throws inside storeVersionDirHasLinks
    const r = await reclaimForkedPnpmStore(opts as never);
    expect(r.removed).toBe(false);
    expect(r.reason).toContain("store-linked-or-unprobed");
  });
});
