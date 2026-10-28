import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findReal, main, shellQuote } from "../scripts/slot-shim.mjs";
import { isHeavyCommand } from "../scripts/tool-guard.mjs";
import { ensureSlotShims, SLOT_SHIM_TOOLS } from "../src/slot-shims";

// The Codex PATH shim (#3550): heavy → the slot runner, everything else → the real binary, and
// it never wraps itself twice.

const SESSION_ENV = {
  PATH: "/shim:/usr/bin",
  SHEPHERD_SESSION_ID: "s1",
  SHEPHERD_AGENT_API_URL: "http://x",
  SHEPHERD_INGRESS_HEADER_FILE: "/h",
};

function run(env: Record<string, string>, heavy: boolean, argv = ["bun", "run", "test"]) {
  const calls: { slot: string[][]; real: string[][] } = { slot: [], real: [] };
  const code = main(argv, env, {
    shimDir: "/shim",
    findReal: () => "/usr/bin/real",
    isHeavy: () => heavy,
    runSlot: async (a) => (calls.slot.push(a), 75),
    execReal: async (file, args) => (calls.real.push([file, ...args]), 0),
  });
  return { code, calls };
}

describe("slot-shim main", () => {
  test("a heavy command goes through the slot runner and passes its exit code through", async () => {
    const { code, calls } = run(SESSION_ENV, true);
    expect(await code).toBe(75);
    expect(calls.slot).toEqual([["--", "bun run test"]]);
    expect(calls.real).toEqual([]);
  });

  test("a light command execs the real binary", async () => {
    const { code, calls } = run(SESSION_ENV, false, ["cargo", "fmt"]);
    expect(await code).toBe(0);
    expect(calls.real).toEqual([["/usr/bin/real", "fmt"]]);
    expect(calls.slot).toEqual([]);
  });

  test("inside a running job (SHEPHERD_HEAVY_JOB) it never wraps again", async () => {
    const { code, calls } = run({ ...SESSION_ENV, SHEPHERD_HEAVY_JOB: "j1" }, true);
    expect(await code).toBe(0);
    expect(calls.slot).toEqual([]);
    expect(calls.real).toHaveLength(1);
  });

  test("without ingress coordinates it runs the real binary", async () => {
    const { code, calls } = run({ PATH: "/shim:/usr/bin" }, true);
    expect(await code).toBe(0);
    expect(calls.slot).toEqual([]);
  });

  test("a throwing detection fails open to the real binary", async () => {
    const calls: string[][] = [];
    const code = await main(["bun", "test"], SESSION_ENV, {
      shimDir: "/shim",
      findReal: () => "/usr/bin/real",
      isHeavy: () => {
        throw new Error("boom");
      },
      execReal: async (file, args) => (calls.push([file, ...args]), 0),
    });
    expect(code).toBe(0);
    expect(calls).toEqual([["/usr/bin/real", "test"]]);
  });

  test("the real binary is looked up without the shim dir, and the child PATH lacks it", async () => {
    let seenEnv: Record<string, string | undefined> = {};
    await main(["bun", "x"], SESSION_ENV, {
      shimDir: "/shim",
      findReal: () => "/usr/bin/real",
      isHeavy: () => false,
      execReal: async (_f, _a, env) => ((seenEnv = env), 0),
    });
    expect(seenEnv.PATH).toBe("/usr/bin");
  });

  test("no real binary → 127", async () => {
    const code = await main(["bun"], SESSION_ENV, { shimDir: "/shim", findReal: () => null });
    expect(code).toBe(127);
  });
});

describe("slot-shim helpers", () => {
  test("shellQuote leaves plain words and quotes the rest", () => {
    expect(shellQuote("run")).toBe("run");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test("findReal skips the shim dir and non-executables", () => {
    const root = mkdtempSync(join(tmpdir(), "shim-find-"));
    const shim = join(root, "shim");
    const real = join(root, "real");
    for (const d of [shim, real]) mkdirSync(d);
    for (const d of [shim, real]) {
      writeFileSync(join(d, "bun"), "#!/bin/sh\n");
      chmodSync(join(d, "bun"), 0o755);
    }
    expect(findReal("bun", `${shim}:${real}`, shim)).toBe(join(real, "bun"));
    expect(findReal("nope", `${shim}:${real}`, shim)).toBeNull();
  });
});

describe("ensureSlotShims", () => {
  test("writes one executable shim per tool, idempotently", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "shims-")), "slot-shims");
    expect(await ensureSlotShims(dir, "/usr/bin/node", "/etc/hostname")).toBe(dir);
    expect(await ensureSlotShims(dir, "/usr/bin/node", "/etc/hostname")).toBe(dir);
    const body = await Bun.file(join(dir, "bun")).text();
    expect(body).toContain("exec '/usr/bin/node' '/etc/hostname' bun \"$@\"");
    expect(body).toContain(`SHEPHERD_SLOT_SHIM_DIR='${dir}'`);
    for (const t of SLOT_SHIM_TOOLS) expect(await Bun.file(join(dir, t)).exists()).toBe(true);
  });

  test("returns null when the shim script is unreachable", async () => {
    expect(
      await ensureSlotShims("/nonexistent-x/y", "node", "/nonexistent/slot-shim.mjs"),
    ).toBeNull();
  });

  test("every shimmed tool is one the guard can call heavy, and the guard and shim agree", () => {
    const deps = { readText: () => null };
    expect(isHeavyCommand("cargo clippy", "/", deps)).toBe(true);
    expect(isHeavyCommand("cargo fmt", "/", deps)).toBe(false);
    expect(isHeavyCommand("vitest run", "/", deps)).toBe(true);
    expect(isHeavyCommand("bun --version", "/", deps)).toBe(false);
    expect(isHeavyCommand("bun test", "/", deps)).toBe(true);
  });
});
