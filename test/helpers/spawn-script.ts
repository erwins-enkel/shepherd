import { expect } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Darwin's tty canonical-mode input limit (`MAX_INPUT`, ~1024 bytes) — the bar issue #1967 overran.
 * Pinned in test code rather than production: nothing branches on it, because the ≥0.7.5 spawn
 * transport is short on EVERY platform by construction. These assertions are what keep it that way.
 */
export const DARWIN_MAX_INPUT = 1024;

/**
 * Both ≥0.7.5 drivers type `'sh' '<path>'` into the pane and let the script carry the real command
 * (#1967). Asserts the typed line is that short form and fits `MAX_INPUT`, then returns the script
 * body so callers can assert on the command that will actually run.
 */
export function readTypedScript(cmdline: string | undefined): string {
  expect(cmdline).toMatch(/^'sh' '.*\.sh'$/);
  expect(Buffer.byteLength(cmdline!, "utf8")).toBeLessThan(DARWIN_MAX_INPUT);
  return readFileSync(/^'sh' '(.*)'$/.exec(cmdline!)![1]!, "utf8");
}
