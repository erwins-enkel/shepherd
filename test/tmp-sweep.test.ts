import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeScratchDir, sweepClaudeTmp, removeWorktreeScratch } from "../src/tmp-sweep";

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
function setEnv(key: string, val: string | undefined) {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
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

  test("over threshold: removes node-compile-cache wholesale + stale entries, keeps fresh", async () => {
    const root = mkTmp();
    const ncc = join(root, "node-compile-cache");
    mkdirSync(ncc); // freshly created (recent mtime) yet must still be removed wholesale
    writeFileSync(join(ncc, "blob.bin"), "x");

    const stale = join(root, "stale-scratch");
    mkdirSync(stale);
    const fresh = join(root, "fresh-scratch");
    mkdirSync(fresh);

    const now = Date.now();
    const old = new Date(now - 48 * 3600_000); // 48h ago
    utimesSync(stale, old, old);

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
    expect(existsSync(ncc)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(root)).toBe(true); // root itself never removed
    expect(res.removed).toBe(2);
  });

  test("over threshold via fake statfs removes only stale, keeps fresh", async () => {
    const root = mkTmp();
    const ncc = join(root, "node-compile-cache");
    mkdirSync(ncc);
    const stale = join(root, "stale");
    mkdirSync(stale);
    const fresh = join(root, "fresh");
    mkdirSync(fresh);
    const now = Date.now();
    const old = new Date(now - 48 * 3600_000);
    utimesSync(stale, old, old);

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
    expect(existsSync(ncc)).toBe(false);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(root)).toBe(true);
  });

  test("nested claude-$uid dir is not wholesale-removed; its stale child is swept", async () => {
    const root = mkTmp();
    const nestedDir = join(root, nested);
    mkdirSync(nestedDir);
    // Make the nested dir itself old to prove it is NOT age-gated as a root entry.
    const now = Date.now();
    const old = new Date(now - 72 * 3600_000);

    const staleChild = join(nestedDir, "old-session");
    mkdirSync(staleChild);
    const freshChild = join(nestedDir, "live-session");
    mkdirSync(freshChild);
    utimesSync(staleChild, old, old);
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
    expect(existsSync(staleChild)).toBe(false); // swept as the second root
    expect(existsSync(freshChild)).toBe(true);
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
});
