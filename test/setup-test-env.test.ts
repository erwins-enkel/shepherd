import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

// #1862: 144 files under `test/` mkdtemp into `tmpdir()` and most never clean up, which leaked
// ~2.0M inodes into the shared temp root. The preload (`test/setup-test-env.ts`, wired via
// bunfig.toml) redirects the whole run into one throwaway dir it drops on exit. These assert the
// harness itself — if the redirect silently stops working, the leak comes back unnoticed.
describe("per-run TMPDIR", () => {
  test("the run is redirected into its own throwaway root", () => {
    expect(process.env.TMPDIR).toBeDefined();
    expect(basename(process.env.TMPDIR as string)).toStartWith("shepherd-test-run-");
    expect(existsSync(process.env.TMPDIR as string)).toBe(true);
  });

  test("os.tmpdir() follows it, so every existing mkdtemp call site relocates", () => {
    // The load-bearing premise: `os.tmpdir()` re-reads TMPDIR per call rather than caching it at
    // startup. Without this, redirecting the env would move nothing.
    expect(tmpdir()).toBe(process.env.TMPDIR as string);
    const d = mkdtempSync(join(tmpdir(), "preload-probe-"));
    expect(d).toStartWith(process.env.TMPDIR as string);
  });

  test("TMP and TEMP agree, for tools that read those instead", () => {
    expect(process.env.TMP).toBe(process.env.TMPDIR as string);
    expect(process.env.TEMP).toBe(process.env.TMPDIR as string);
  });

  // The three tests above cover the REDIRECT. This one covers the CLEANUP, which is the half that
  // cannot be observed from inside the run it belongs to — and the half that was derived
  // empirically: Bun fires neither `exit` nor `beforeExit` from a preload, so the preload-level
  // `afterAll` is the only hook that runs. Delete that hook and all of the above stays green while
  // every run leaks a whole root permanently. So assert it from a CHILD run, which is the only
  // vantage point from which "the run ended and its root is gone" is a statement you can make.
  //
  // The child runs with `cwd` in a scratch dir, deliberately NOT the repo: Bun discovers
  // `bunfig.toml` from the cwd, so an in-repo child would apply the bunfig preload AND the
  // explicit `--preload` and create two roots. `--preload` points at the real shipped file, not a
  // copy. (bunfig's own wiring needs no separate guard: drop `preload` from it and the three tests
  // above fail at once.) The raised timeout is for the second `bun test` process — the default 5s
  // is tight for a cold start on CI.
  test("the preload removes its run root when the run ends", () => {
    const cwd = mkdtempSync(join(tmpdir(), "preload-cleanup-"));
    try {
      writeFileSync(
        join(cwd, "probe.test.ts"),
        `import { test, expect } from "bun:test";
test("probe", () => {
  console.log("RUNROOT=" + process.env.TMPDIR);
  expect(1).toBe(1);
});
`,
      );

      const r = spawnSync(
        process.execPath, // this bun, not whichever one is on PATH
        ["test", "--preload", resolve(import.meta.dir, "setup-test-env.ts"), "./probe.test.ts"],
        { cwd, encoding: "utf8" },
      );

      // Bun writes `console.log` from a test to stderr, but don't depend on which: read both.
      const runRoot = /^RUNROOT=(.+)$/m.exec(`${r.stdout ?? ""}\n${r.stderr ?? ""}`)?.[1]?.trim();

      // Assert the child actually ran and reported a root BEFORE asserting the root is gone —
      // otherwise an unparseable or crashed child reads as a clean cleanup and this guard rots
      // into a test that can no longer fail.
      expect(r.status).toBe(0);
      expect(runRoot).toBeDefined();
      expect(basename(runRoot as string)).toStartWith("shepherd-test-run-");
      // Created directly under OUR root (the child inherits our TMPDIR), so it did exist.
      // Compared as a path segment, not a string prefix: a sibling `<tmpdir>x/…` would satisfy
      // `toStartWith` and let a root that was never ours pass as one that was cleaned up.
      expect(dirname(runRoot as string)).toBe(process.env.TMPDIR as string);

      expect(existsSync(runRoot as string)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
