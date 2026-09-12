import { test, expect, describe } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

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
});
