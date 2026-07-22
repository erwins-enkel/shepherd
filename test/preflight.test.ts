import { HERDR_LAST_SUPPORTED_VERSION } from "../src/herdr-capabilities";
import { test, expect } from "bun:test";
import {
  HERDR_MISSING_EXIT_CODE,
  HERDR_MISSING_MARKER,
  isBinaryMissingError,
  preflightHerdr,
  herdrMissingBanner,
} from "../src/preflight";

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
  // PINNED, not the latest-only upstream installer (#1896): an operator following the banner must
  // land on a herdr Shepherd can actually drive.
  expect(logs[0]).toContain(`/releases/download/v${HERDR_LAST_SUPPORTED_VERSION}/herdr-`);
  expect(logs[0]).not.toContain("herdr.dev/install.sh");
  expect(logs[0]).toContain(`supports herdr <= ${HERDR_LAST_SUPPORTED_VERSION}`);
});

test("banner falls back to the release-tag page when herdr publishes no binary for the platform", () => {
  // assetKey null (Windows, or an unsupported arch) must never render `undefined` into a URL.
  const banner = herdrMissingBanner(null);
  expect(banner).toContain(`/releases/tag/v${HERDR_LAST_SUPPORTED_VERSION}`);
  expect(banner).not.toContain("undefined");
  expect(banner).not.toContain("/releases/download/");
});

test("banner renders a pinned, copy-pasteable install line for a mapped platform", () => {
  const banner = herdrMissingBanner("linux-x86_64");
  expect(banner).toContain(
    `curl -fsSL -o ~/.local/bin/herdr https://github.com/ogulcancelik/herdr/releases/download/v${HERDR_LAST_SUPPORTED_VERSION}/herdr-linux-x86_64`,
  );
  expect(banner).not.toContain("undefined");
});

test("emitted banner contains the exported HERDR_MISSING_MARKER (no drift for out-of-tree matchers)", () => {
  const logs: string[] = [];
  const { exit } = fakeExit();

  expect(() =>
    preflightHerdr({
      runVersion: () => {
        throw { code: "ENOENT" };
      },
      log: (msg) => logs.push(msg),
      exit,
    }),
  ).toThrow(ExitSentinel);

  // The onboarding harness's fail-fast probe matches on this exported constant, so
  // the banner MUST keep containing it verbatim.
  expect(HERDR_MISSING_MARKER).toBe("herdr not found on PATH");
  expect(logs[0]).toContain(HERDR_MISSING_MARKER);
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
