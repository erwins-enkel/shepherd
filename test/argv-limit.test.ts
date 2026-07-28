import { test, expect, describe } from "bun:test";
import {
  LINUX_PAGE_SIZE_BYTES,
  OversizedArgvError,
  argvElementLimit,
  assertArgvWithinLimit,
  hostArgvBudget,
  hostArgvElementLimit,
  joinedElementBytes,
  oversizedFromArgv,
  posixShellJoin,
  spawnFootprintBytes,
} from "../src/argv-limit";
import { sanitizePromptArg } from "../src/transient-agent-argv";

describe("argvElementLimit", () => {
  test("linux → PAGE_SIZE * 32", () => {
    expect(argvElementLimit("linux", 4096)).toBe(131072);
    expect(argvElementLimit("linux", 16384)).toBe(524288);
    expect(argvElementLimit("linux", 65536)).toBe(2097152);
  });

  test("NON-LINUX → Infinity, so nothing is ever clamped there", () => {
    // Darwin caps only the WHOLE argv (kern.argmax), never a single element. If this returned a
    // finite number the ladder would start truncating prompts on macOS for no reason.
    for (const platform of ["darwin", "win32", "freebsd", "sunos"]) {
      expect(argvElementLimit(platform, 4096)).toBe(Number.POSITIVE_INFINITY);
      expect(argvElementLimit(platform)).toBe(Number.POSITIVE_INFINITY);
    }
  });

  test("defaults the page size to the pinned 4096 when the caller passes none", () => {
    expect(argvElementLimit("linux")).toBe(argvElementLimit("linux", LINUX_PAGE_SIZE_BYTES));
    expect(LINUX_PAGE_SIZE_BYTES).toBe(4096);
  });
});

// ── The load-bearing assertion (#1944) ────────────────────────────────────────
//
// Every other test in this file INJECTS a page size. If the production entry point resolved to
// Infinity — the failure mode of an optional-and-nullable `pageSize` with no production source —
// the whole guard would be dead on Linux and every one of those tests would still pass. This is
// the only test that can catch that, so it must not inject anything.
describe("the PRODUCTION call site", () => {
  test.skipIf(process.platform !== "linux")("computes 131072 on linux, NOT Infinity", () => {
    expect(hostArgvElementLimit()).toBe(131072);
    expect(Number.isFinite(hostArgvElementLimit())).toBe(true);
    expect(hostArgvBudget()).toBe(131071);
  });

  test.skipIf(process.platform === "linux")("is Infinity off linux", () => {
    expect(hostArgvElementLimit()).toBe(Number.POSITIVE_INFINITY);
    expect(hostArgvBudget()).toBe(Number.POSITIVE_INFINITY);
  });

  test("budget sits exactly one byte under the limit when finite", () => {
    const limit = hostArgvElementLimit();
    if (!Number.isFinite(limit)) {
      expect(hostArgvBudget()).toBe(limit);
      return;
    }
    expect(hostArgvBudget()).toBe(limit - 1);
  });
});

describe("joinedElementBytes", () => {
  test("counts the two wrapping quotes posixShellJoin adds", () => {
    expect(joinedElementBytes("abc")).toBe(5); // 'abc'
    expect(joinedElementBytes("")).toBe(2); // ''
  });

  test("counts the +3 each apostrophe costs as '\\''", () => {
    // A naive Buffer.byteLength would say 4 for "it's". The shipped form is 'it'\''s' = 9.
    expect(joinedElementBytes("it's")).toBe(9);
    const naive = Buffer.byteLength("a'b'c'd", "utf8");
    expect(joinedElementBytes("a'b'c'd")).toBe(naive + 2 + 3 * 3);
  });

  test("counts the +1 each NUL costs as \\0 after sanitizePromptArg", () => {
    expect(joinedElementBytes("a\0b")).toBe(joinedElementBytes("a\\0b"));
    expect(joinedElementBytes("\0")).toBe(4); // '\0'
  });

  test("counts real UTF-8 width, not code units", () => {
    expect(joinedElementBytes("é")).toBe(4); // 2 bytes + 2 quotes
    expect(joinedElementBytes("🐑")).toBe(6); // 4 bytes + 2 quotes
  });

  test("is exactly the byte length of what posixShellJoin actually emits", () => {
    for (const s of ["plain", "it's", "a\0b", "🐑 é", "", "'''"]) {
      expect(joinedElementBytes(s)).toBe(
        Buffer.byteLength(posixShellJoin([sanitizePromptArg(s)]), "utf8"),
      );
    }
  });
});

describe("spawnFootprintBytes", () => {
  test("equals the byte length of the joined command line the pane actually receives", () => {
    const argv = ["env", "NODE_COMPILE_CACHE=/x", "claude", "-p", "it's a plan"];
    expect(spawnFootprintBytes(argv)).toBe(Buffer.byteLength(posixShellJoin(argv), "utf8"));
  });

  test("includes the separating spaces", () => {
    expect(spawnFootprintBytes(["a", "b", "c"])).toBe(3 * 3 + 2);
  });

  test("a single token costs no separator", () => {
    expect(spawnFootprintBytes(["abc"])).toBe(joinedElementBytes("abc"));
  });

  test("an empty argv is zero, not negative", () => {
    expect(spawnFootprintBytes([])).toBe(0);
  });
});

describe("oversizedFromArgv", () => {
  test("maps a kernel E2BIG and names the cause", () => {
    const err = Object.assign(new Error("spawn herdr E2BIG"), { code: "E2BIG" });
    const mapped = oversizedFromArgv(err, ["claude", "-p", "x".repeat(200_000)]);
    expect(mapped).toBeInstanceOf(OversizedArgvError);
    expect(mapped?.message).toContain("per-argument limit");
    expect(mapped?.cause).toBe(err);
    expect(mapped?.bytes).toBeGreaterThan(200_000);
  });

  test("returns null for EVERY other error, so nothing else is reclassified", () => {
    for (const code of ["ENOENT", "EACCES", "ETIMEDOUT", undefined]) {
      const err = Object.assign(new Error("nope"), code ? { code } : {});
      expect(oversizedFromArgv(err, ["claude"])).toBeNull();
    }
    expect(oversizedFromArgv(null, ["claude"])).toBeNull();
    expect(oversizedFromArgv("a string", ["claude"])).toBeNull();
  });
});

describe("assertArgvWithinLimit", () => {
  test.skipIf(process.platform !== "linux")("throws on an over-limit element", () => {
    expect(() => assertArgvWithinLimit(["claude", "x".repeat(200_000)], "ctx")).toThrow(
      OversizedArgvError,
    );
  });

  test("passes an argv at the limit and below", () => {
    expect(() => assertArgvWithinLimit(["claude", "-p", "small"], "ctx")).not.toThrow();
    // At the BUDGET, not the raw limit: the kernel counts the NUL terminator, so an element of
    // exactly `limit` bytes already fails (see test/spawn-e2big.test.ts).
    const budget = hostArgvBudget();
    if (Number.isFinite(budget)) {
      expect(() => assertArgvWithinLimit(["x".repeat(budget)], "ctx")).not.toThrow();
      expect(() => assertArgvWithinLimit(["x".repeat(budget + 1)], "ctx")).toThrow(
        OversizedArgvError,
      );
    }
  });

  test.skipIf(process.platform === "linux")("never throws off linux", () => {
    expect(() => assertArgvWithinLimit(["x".repeat(5_000_000)], "ctx")).not.toThrow();
  });
});
