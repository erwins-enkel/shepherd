import { test, expect } from "bun:test";
import { HERDR_MISSING_EXIT_CODE, isBinaryMissingError, preflightHerdr } from "../src/preflight";

// ── isBinaryMissingError ─────────────────────────────────────────────────────

test("isBinaryMissingError: true for Node ENOENT shape", () => {
  expect(isBinaryMissingError({ code: "ENOENT" })).toBe(true);
});

test("isBinaryMissingError: true for Bun's thrown Os NotFound shape", () => {
  const err = new Error("Failed to spawn: herdr\nCaused by: Os { code: 2, kind: NotFound }");
  expect(isBinaryMissingError(err)).toBe(true);
});

test("isBinaryMissingError: true for a raw 'No such file or directory' message", () => {
  expect(isBinaryMissingError(new Error("spawn herdr ENOENT: No such file or directory"))).toBe(
    true,
  );
});

test("isBinaryMissingError: false for an unrelated error code (EACCES)", () => {
  expect(isBinaryMissingError({ code: "EACCES" })).toBe(false);
});

test("isBinaryMissingError: false for a plain unrelated error", () => {
  expect(isBinaryMissingError(new Error("boom"))).toBe(false);
});

test("isBinaryMissingError: false for null/undefined", () => {
  expect(isBinaryMissingError(null)).toBe(false);
  expect(isBinaryMissingError(undefined)).toBe(false);
});

// ── preflightHerdr ───────────────────────────────────────────────────────────

class ExitSentinel extends Error {
  constructor(public code: number) {
    super(`exit(${code})`);
  }
}

function fakeExit(): { calls: number[]; exit: (code: number) => never } {
  const calls: number[] = [];
  const exit = (code: number): never => {
    calls.push(code);
    throw new ExitSentinel(code);
  };
  return { calls, exit };
}

test("preflightHerdr: missing binary → logs one banner and exits 78", () => {
  const logs: string[] = [];
  const { calls, exit } = fakeExit();

  expect(() =>
    preflightHerdr({
      runVersion: () => {
        throw { code: "ENOENT" };
      },
      log: (msg) => logs.push(msg),
      exit,
    }),
  ).toThrow(ExitSentinel);

  expect(calls).toEqual([HERDR_MISSING_EXIT_CODE]);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("herdr not found on PATH");
  expect(logs[0]).toContain("https://herdr.dev/install.sh");
});

test("preflightHerdr: success → neither log nor exit called", () => {
  const logs: string[] = [];
  const { calls, exit } = fakeExit();

  preflightHerdr({
    runVersion: () => "herdr 0.9.0",
    log: (msg) => logs.push(msg),
    exit,
  });

  expect(logs).toHaveLength(0);
  expect(calls).toHaveLength(0);
});

test("preflightHerdr: present-but-broken failure fails open (no exit)", () => {
  const logs: string[] = [];
  const { calls, exit } = fakeExit();

  preflightHerdr({
    runVersion: () => {
      throw { code: "EACCES" };
    },
    log: (msg) => logs.push(msg),
    exit,
  });

  expect(calls).toHaveLength(0);
});
