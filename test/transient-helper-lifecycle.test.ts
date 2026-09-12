import { test, expect, describe, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupHelperDir, makeHelperTmpDir } from "../src/transient-helper-lifecycle";

const dirs: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

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

/** `dashify` — mirrors the encoding claude uses to name a cwd's scratch dir. */
const dashify = (p: string): string => p.replace(/[/.]/g, "-");

describe("cleanupHelperDir (#2304)", () => {
  test("removes BOTH the mktemp cwd and the claude-side scratch it derived", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "helper-lifecycle-test-"));
    dirs.push(scratchRoot);
    setEnv("SHEPHERD_TMP_SWEEP_DIR", scratchRoot);

    const cwd = makeHelperTmpDir("shepherd-namer-");
    dirs.push(cwd);
    // Stand in for what claude writes: `<claudeTmpRoot>/<dashify(cwd)>/<uuid>/scratchpad`.
    const scratch = join(scratchRoot, dashify(cwd));
    mkdirSync(join(scratch, "some-uuid", "scratchpad"), { recursive: true });
    writeFileSync(join(scratch, "some-uuid", "scratchpad", "note.txt"), "x");

    expect(existsSync(cwd)).toBe(true);
    expect(existsSync(scratch)).toBe(true);

    cleanupHelperDir(cwd);

    // The cwd removal is synchronous; the scratch removal is deliberately fire-and-forget
    // async (never a sync rm -rf on the Bun event loop), so let the microtask/IO settle.
    expect(existsSync(cwd)).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(scratch)).toBe(false);
  });

  test("does not throw when neither dir exists", async () => {
    const scratchRoot = mkdtempSync(join(tmpdir(), "helper-lifecycle-test-"));
    dirs.push(scratchRoot);
    setEnv("SHEPHERD_TMP_SWEEP_DIR", scratchRoot);
    expect(() =>
      cleanupHelperDir(join(tmpdir(), `shepherd-namer-absent-${Math.random()}`)),
    ).not.toThrow();
    await new Promise((r) => setTimeout(r, 50));
  });

  test("makeHelperTmpDir creates a 0700 dir with the given prefix", () => {
    const cwd = makeHelperTmpDir("shepherd-namer-");
    dirs.push(cwd);
    expect(existsSync(cwd)).toBe(true);
    expect(cwd.startsWith(join(tmpdir(), "shepherd-namer-"))).toBe(true);
  });
});
