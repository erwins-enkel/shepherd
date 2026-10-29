import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRevision, isStale } from "../src/heavy-slot-revision";

let dir: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slot-rev-"));
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("captureRevision / isStale", () => {
  test("an untouched worktree is not stale", async () => {
    const a = await captureRevision(dir, dir);
    expect(a.head).toMatch(/^[0-9a-f]{40}$/);
    expect(isStale(a, await captureRevision(dir, dir))).toBe(false);
  });

  test("a tracked edit makes it stale, reverting it makes it current again", async () => {
    const a = await captureRevision(dir, dir);
    writeFileSync(join(dir, "a.txt"), "b\n");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(true);
    writeFileSync(join(dir, "a.txt"), "a\n");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(false);
  });

  test("a new untracked file makes it stale", async () => {
    const a = await captureRevision(dir, dir);
    writeFileSync(join(dir, "new.txt"), "x");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(true);
  });

  test("a new commit makes it stale", async () => {
    const a = await captureRevision(dir, dir);
    writeFileSync(join(dir, "a.txt"), "c\n");
    git("commit", "-qam", "next");
    expect(isStale(a, await captureRevision(dir, dir))).toBe(true);
  });

  test("a non-repository has no head and is always stale", async () => {
    const plain = mkdtempSync(join(tmpdir(), "slot-rev-plain-"));
    try {
      const r = await captureRevision(plain, plain);
      expect(r.head).toBeNull();
      expect(isStale(r, r)).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

test.each(["content", "large", "read-error", "stat-error"])(
  "untracked fingerprint closes the checked inode (%s)",
  async (mode) => {
    const path = join(dir, "new.txt");
    writeFileSync(path, mode === "large" ? "x".repeat(1024 * 1024 + 1) : "original");
    const expected = await captureRevision(dir, dir);
    if (mode.endsWith("error")) {
      expected.treeHash = createHash("sha1").update("new.txt\0gone").digest("hex");
    }
    const output = execFileSync(
      process.execPath,
      [
        "--eval",
        `
    import { mock } from "bun:test";
    import * as fs from "node:fs/promises";
    const path = ${JSON.stringify(path)};
    const { open, stat } = fs;
    let swapped = false, closed = false;
    async function swap() {
      if (swapped) return;
      swapped = true;
      await fs.rename(path, path + ".old");
      await fs.writeFile(path, "replacement");
    }
    mock.module("node:fs/promises", () => ({
      ...fs,
      stat: async (...args) => {
        const value = await stat(...args);
        if (args[0] === path) await swap();
        return value;
      },
      open: async (...args) => {
        const handle = await open(...args);
        if (args[0] === path) {
          const originalStat = handle.stat.bind(handle);
          const originalClose = handle.close.bind(handle);
          handle.stat = async () => {
            const value = await originalStat();
            await swap();
            if (${JSON.stringify(mode)} === "stat-error") throw new Error("stat failed");
            return value;
          };
          if (${JSON.stringify(mode)} === "read-error") handle.readFile = async () => { throw new Error("read failed"); };
          handle.close = async () => { closed = true; return originalClose(); };
        }
        return handle;
      },
    }));
    const { captureRevision } = await import(${JSON.stringify(join(import.meta.dir, "../src/heavy-slot-revision.ts"))});
    const revision = await captureRevision(${JSON.stringify(dir)}, ${JSON.stringify(dir)});
    console.log(JSON.stringify({ revision, swapped, closed }));
  `,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({ revision: expected, swapped: true, closed: true });
  },
);

test.skipIf(process.platform === "win32")(
  "an untracked symlink to a FIFO is classified without blocking on open",
  () => {
    execFileSync("mkfifo", [join(dir, "pipe")]);
    symlinkSync("pipe", join(dir, "pipe-link"));
    const output = execFileSync(
      process.execPath,
      [
        "--eval",
        `
    const { captureRevision } = await import(${JSON.stringify(join(import.meta.dir, "../src/heavy-slot-revision.ts"))});
    console.log(JSON.stringify(await captureRevision(${JSON.stringify(dir)}, ${JSON.stringify(dir)})));
  `,
      ],
      { encoding: "utf8", timeout: 2_000 },
    );
    expect(JSON.parse(output)).toEqual({
      head: git("rev-parse", "HEAD").toString().trim(),
      treeHash: createHash("sha1").update("pipe-link\0dir").digest("hex"),
    });
  },
);
