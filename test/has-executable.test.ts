/**
 * Unit tests for the PATH probe backing test skip-gates (test/has-executable.ts).
 *
 * Deliberately driven against the REAL `spawnSync`, never a stub: the bug this
 * guards (#1977) WAS a wrong assumption about the real runtime's return shape,
 * so a mocked spawn would have reproduced it just as happily.
 */

import { test, expect } from "bun:test";
import { hasExecutable } from "./has-executable";

test("false when the binary is absent from PATH", () => {
  // The regression case: under Bun a missing binary yields `status: undefined`
  // (Node: `null`), so a `status !== null` guard would return true here.
  expect(hasExecutable("shepherd-no-such-binary-1977")).toBe(false);
});

test("true for a binary that exists", () => {
  // POSIX guarantees `sh` on every host this suite runs on (Linux CI, macOS CI,
  // contributor boxes). `stdio: "ignore"` gives it /dev/null on stdin, so `sh -v`
  // reads EOF and exits instead of blocking.
  expect(hasExecutable("sh")).toBe(true);
});
